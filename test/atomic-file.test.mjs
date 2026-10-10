import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameAtomicFile } from '../src/atomic-file.mjs';
import { ProfileStore } from '../src/profile-store.mjs';
import { DEFAULT_BOB_CONFIG } from '../src/config.mjs';

const oldContent = JSON.stringify({ revision: 1, data: 'previous committed snapshot' });
const newContent = JSON.stringify({ revision: 2, data: 'new prepared snapshot' });
const fileError = code => Object.assign(new Error('Fixture rename failure.'), { code, syscall: 'rename' });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-atomic-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'prepared.tmp'), destination = path.join(directory, 'state.json');
  await writeFile(source, newContent);
  await writeFile(destination, oldContent);
  return { directory, source, destination };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows ${code} retries only rename and leaves the old snapshot intact until actual replacement`, async t => {
    const { source, destination } = await fixture(t);
    let calls = 0;
    const waits = [];
    await renameAtomicFile(source, destination, {
      platform: 'win32',
      renameOperation: async (from, to) => {
        assert.equal(from, source); assert.equal(to, destination);
        assert.equal(await readFile(destination, 'utf8'), oldContent);
        assert.equal(await readFile(source, 'utf8'), newContent);
        if (++calls <= 2) throw fileError(code);
        await rename(from, to);
      },
      wait: async ms => {
        waits.push(ms);
        assert.equal(await readFile(destination, 'utf8'), oldContent);
      },
    });
    // Actual Win32 rename can also transiently refuse; it shares the same bound.
    assert.ok(calls >= 3 && calls <= 5);
    assert.deepEqual(waits, [25, 50, 100, 200].slice(0, calls - 1));
    assert.equal(await readFile(destination, 'utf8'), newContent);
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  });
}

test('exhausted Windows rename attempts preserve both files and return the original failure', async t => {
  const { source, destination } = await fixture(t);
  const error = fileError('EPERM'), waits = [];
  let calls = 0;
  await assert.rejects(renameAtomicFile(source, destination, { platform: 'win32',
    renameOperation: async () => { calls++; throw error; }, wait: async ms => {
      waits.push(ms); assert.equal(await readFile(destination, 'utf8'), oldContent);
    },
  }), actual => actual === error);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [25, 50, 100, 200]);
  assert.equal(await readFile(destination, 'utf8'), oldContent);
  assert.equal(await readFile(source, 'utf8'), newContent);
});

test('non-transient rename failures are never retried on Windows', async t => {
  const { source, destination } = await fixture(t);
  for (const code of ['ENOENT', 'ENOTDIR', 'EISDIR', 'EXDEV', 'EINVAL']) {
    const error = fileError(code);
    let calls = 0, waits = 0;
    await assert.rejects(renameAtomicFile(source, destination, { platform: 'win32',
      renameOperation: async () => { calls++; throw error; }, wait: async () => { waits++; },
    }), actual => actual === error);
    assert.equal(calls, 1); assert.equal(waits, 0);
    assert.equal(await readFile(destination, 'utf8'), oldContent);
    assert.equal(await readFile(source, 'utf8'), newContent);
  }
});

test('non-Windows rename failures are never retried even for the Windows transient codes', async t => {
  const { source, destination } = await fixture(t);
  for (const platform of ['linux', 'darwin']) for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const error = fileError(code);
    let calls = 0, waits = 0;
    await assert.rejects(renameAtomicFile(source, destination, { platform,
      renameOperation: async () => { calls++; throw error; }, wait: async () => { waits++; },
    }), actual => actual === error);
    assert.equal(calls, 1); assert.equal(waits, 0);
    assert.equal(await readFile(destination, 'utf8'), oldContent);
    assert.equal(await readFile(source, 'utf8'), newContent);
  }
});

test('ProfileStore cleans its exact temporary file and rolls back state after exhausted replacement', async t => {
  const { directory } = await fixture(t);
  const store = await new ProfileStore({ directory }).init();
  await store.saveProfile('Existing profile', DEFAULT_BOB_CONFIG);
  const destination = path.join(directory, 'config.json');
  const committed = await readFile(destination, 'utf8');
  const state = { profiles: store.list(), revision: store.revision, templateRevision: store.templateRevision };
  const save = store.save;
  const error = fileError('EACCES');
  let calls = 0, generatedTemporary;
  t.mock.method(store, 'save', function() {
    return save.call(this, { renameFile: (source, target) => renameAtomicFile(source, target, { platform: 'win32',
      renameOperation: async (from, to) => {
        generatedTemporary = from;
        assert.equal(to, destination);
        assert.match(path.basename(from), /^\.config-[0-9a-f-]+\.tmp$/);
        assert.equal(await readFile(destination, 'utf8'), committed);
        assert.ok((await readFile(from, 'utf8')).includes('Uncommitted profile'));
        calls++; throw error;
      }, wait: async () => {},
    }) });
  });
  await assert.rejects(store.saveProfile('Uncommitted profile', DEFAULT_BOB_CONFIG), actual => actual === error);
  assert.equal(calls, 5);
  assert.equal(await readFile(destination, 'utf8'), committed);
  assert.deepEqual(store.list(), state.profiles);
  assert.equal(store.revision, state.revision);
  assert.equal(store.templateRevision, state.templateRevision);
  await assert.rejects(readFile(generatedTemporary), { code: 'ENOENT' });
  assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'prepared.tmp', 'state.json']);
});
