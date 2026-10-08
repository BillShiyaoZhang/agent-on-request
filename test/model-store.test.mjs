import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clone } from '../src/config.mjs';
import { DEFAULT_MODEL_CONFIG, ModelStore, diffModelConfig, validateModelConfig } from '../src/model-store.mjs';

// These are deliberately fictional test strings, never actual credentials.
const FIRST_KEY = 'sk-cp-fictional-test-key-one';
const SECOND_KEY = 'sk-cp-fictional-test-key-two';
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-demo-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function compatible(baseUrl = 'http://127.0.0.1:8181/v1') {
  const config = clone(DEFAULT_MODEL_CONFIG);
  config.provider = 'openai_compatible';
  config.baseUrl = baseUrl;
  config.agents.Alice.model = 'local-fixture-model';
  config.agents.Bob.model = 'local-fixture-model';
  return config;
}
function noKeyEcho(error, value) {
  assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(value), false);
  return true;
}

test('default MiniMax model settings are valid, redacted and do not create storage without a key', async t => {
  assert.deepEqual(validateModelConfig(DEFAULT_MODEL_CONFIG), { valid: true, errors: [] });
  const directory = path.join(await temporary(t), 'absent');
  const store = new ModelStore({ directory });
  await store.init();
  assert.deepEqual(store.view(), { config: DEFAULT_MODEL_CONFIG, revision: 1, keyConfigured: false });
  assert.equal(store.snapshot().apiKey, '');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const view = store.view();
  view.config.agents.Alice.model = 'mutated-view';
  assert.equal(store.view().config.agents.Alice.model, 'MiniMax-M3');
  assert.equal(Object.hasOwn(view, 'apiKey'), false);
});

test('provider URLs allow CN trailing slash and local-compatible HTTP, while rejecting credential escape paths', () => {
  const trailing = clone(DEFAULT_MODEL_CONFIG);
  trailing.baseUrl += '/';
  assert.equal(validateModelConfig(trailing).valid, true);
  for (const url of ['https://example.test/v1', 'http://localhost:8181/v1', 'http://127.0.0.2:8181/v1', 'http://[::1]:8181/v1']) assert.equal(validateModelConfig(compatible(url)).valid, true, url);
  for (const url of ['http://example.test/v1', 'http://192.168.1.1/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?apiKey=fictional', 'https://example.test/v1#fictional', 'file:///private/tmp/model', 'https://example.test/v1\n']) assert.equal(validateModelConfig(compatible(url)).valid, false, 'invalid URL must be rejected');
  const wrongChina = clone(DEFAULT_MODEL_CONFIG);
  wrongChina.baseUrl = 'https://api.minimax.io/v1';
  assert.equal(validateModelConfig(wrongChina).valid, false);
});

test('model config schema rejects credentials, prototype keys and malformed nested options without echoing values', () => {
  const modifications = [
    config => { config.apiKey = FIRST_KEY; },
    config => { config.agents.Alice.apiKey = FIRST_KEY; },
    config => { config.agents.Eve = clone(config.agents.Alice); },
    config => { delete config.agents.Bob; },
    config => { config.agents.Bob.model = 'model\r\nheader'; },
    config => { config.agents.Bob.model = 'x'.repeat(129); },
    config => { config.agents.Bob.maxTokens = 127; },
    config => { config.agents.Bob.maxTokens = 32769; },
    config => { config.agents.Bob.maxTokens = 128.5; },
    config => { config.agents.Bob.timeoutSeconds = 0; },
    config => { config.agents.Bob.retryLimit = 4; },
    config => { config.agents.Bob.temperature = NaN; },
    config => { config.agents.Bob.thinking = 'hidden'; },
    config => { config[FIRST_KEY] = true; }
  ];
  for (const mutate of modifications) {
    const config = clone(DEFAULT_MODEL_CONFIG);
    mutate(config);
    const result = validateModelConfig(config);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes(FIRST_KEY), false);
  }
  assert.equal(validateModelConfig(JSON.parse('{"__proto__":{"polluted":true}}')).valid, false);
  const cycle = clone(DEFAULT_MODEL_CONFIG);
  cycle.agents.Alice.loop = cycle;
  assert.equal(validateModelConfig(cycle).valid, false);
  assert.equal({}.polluted, undefined);
});

test('apply persists only current secret with private permissions and saved values override legacy inputs', async t => {
  const directory = path.join(await temporary(t), 'models');
  const store = new ModelStore({ directory });
  await store.init();
  const snapshotBefore = store.snapshot();
  const draft = clone(DEFAULT_MODEL_CONFIG);
  draft.agents.Bob.temperature = 0.4;
  const result = await store.apply({ config: draft, apiKey: FIRST_KEY, expectedRevision: 1 });
  assert.equal(result.keyConfigured, true);
  assert.equal(result.revision, 2);
  assert.equal(JSON.stringify(result).includes(FIRST_KEY), false);
  assert.equal(JSON.stringify(store).includes(FIRST_KEY), false, 'serializing the store itself cannot expose the private secret');
  assert.equal(store.snapshot().apiKey, FIRST_KEY);
  assert.equal(snapshotBefore.apiKey, '', 'existing round snapshots do not change');
  assert.equal(snapshotBefore.config.agents.Bob.temperature, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'models.json'))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(directory), ['models.json']);
  const changed = clone(draft);
  changed.agents.Alice.maxTokens = 2048;
  await store.apply({ config: changed, apiKey: SECOND_KEY, expectedRevision: 2 });
  const disk = await readFile(path.join(directory, 'models.json'), 'utf8');
  assert.equal(disk.includes(FIRST_KEY), false);
  assert.equal(JSON.parse(disk).apiKey, SECOND_KEY);
  assert.equal(Object.hasOwn(JSON.parse(disk), 'history'), false);
  const loaded = new ModelStore({ directory, initialConfig: compatible(), apiKey: 'legacy-ignored-key' });
  await loaded.init();
  assert.equal(loaded.snapshot().apiKey, SECOND_KEY);
  assert.equal(loaded.view().config.provider, 'minimax_cn_token_plan');
  assert.equal(loaded.view().revision, 3);
  assert.equal(loaded.view().config.agents.Alice.maxTokens, 2048);
});

test('blank key keeps the current key, endpoint changes require explicit replacement or clearing', async () => {
  const store = new ModelStore({ persist: false, apiKey: FIRST_KEY });
  await store.init();
  const trailing = clone(DEFAULT_MODEL_CONFIG);
  trailing.baseUrl += '/';
  await store.apply({ config: trailing, apiKey: '', expectedRevision: 1 });
  assert.equal(store.snapshot().apiKey, FIRST_KEY, 'equivalent trailing slash does not change credential destination');
  const endpoint = compatible('https://example.test/v1');
  await assert.rejects(store.apply({ config: endpoint, apiKey: '', expectedRevision: 2 }), error => error.code === 'MODEL_KEY_RECONFIRM' && noKeyEcho(error, FIRST_KEY));
  assert.equal(store.view().revision, 2);
  assert.equal(store.snapshot().config.provider, 'minimax_cn_token_plan');
  await store.apply({ config: endpoint, clearKey: true, expectedRevision: 2 });
  assert.equal(store.snapshot().apiKey, '');
  assert.equal(store.view().keyConfigured, false);
  await store.apply({ config: endpoint, apiKey: 'fictional-compatible-key', expectedRevision: 3 });
  const moved = compatible('https://another.example.test/v1');
  await assert.rejects(store.apply({ config: moved, expectedRevision: 4 }), { code: 'MODEL_KEY_RECONFIRM' });
  await store.apply({ config: moved, apiKey: 'fictional-explicit-new-key', expectedRevision: 4 });
  assert.equal(store.snapshot().config.baseUrl, moved.baseUrl);
});

test('invalid keys, stale revisions and conflicting intents do not mutate settings or disclose secrets', async t => {
  const directory = path.join(await temporary(t), 'models');
  const store = new ModelStore({ directory });
  await store.init();
  for (const key of ['fictional-paygo-key', 'sk-cp-short', 'sk-cp-fictional\r\nheader-injection']) {
    await assert.rejects(store.apply({ config: DEFAULT_MODEL_CONFIG, apiKey: key, expectedRevision: 1 }), error => error.code === 'MODEL_KEY_INVALID' && noKeyEcho(error, key));
  }
  assert.equal(store.view().revision, 1);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await store.apply({ config: DEFAULT_MODEL_CONFIG, apiKey: FIRST_KEY, expectedRevision: 1 });
  await assert.rejects(store.apply({ config: DEFAULT_MODEL_CONFIG, apiKey: SECOND_KEY, expectedRevision: 1 }), error => error.code === 'STALE_MODEL_CONFIG' && noKeyEcho(error, SECOND_KEY));
  await assert.rejects(store.apply({ config: DEFAULT_MODEL_CONFIG, apiKey: SECOND_KEY, clearKey: true, expectedRevision: 2 }), error => error.code === 'MODEL_KEY_CONFLICT' && noKeyEcho(error, SECOND_KEY));
  assert.equal(store.snapshot().apiKey, FIRST_KEY);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf8')).apiKey, FIRST_KEY);
});

test('validation and diffs include model settings but never a secret field or value', async () => {
  const store = new ModelStore({ persist: false, apiKey: FIRST_KEY });
  await store.init();
  const draft = clone(DEFAULT_MODEL_CONFIG);
  draft.agents.Alice.model = 'another-fictional-model';
  const expected = [{ path: 'agents.Alice.model', before: 'MiniMax-M3', after: 'another-fictional-model' }];
  assert.deepEqual(diffModelConfig(DEFAULT_MODEL_CONFIG, draft), expected);
  assert.deepEqual(store.validate(draft), { valid: true, errors: [], diff: expected });
  draft.apiKey = FIRST_KEY;
  const invalid = store.validate(draft);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.diff, []);
  assert.equal(JSON.stringify(invalid).includes(FIRST_KEY), false);
});

test('model persistence rejects symlinks and corrupt files; memory-compatible providers can omit a key', async t => {
  const directory = await temporary(t);
  const noKey = new ModelStore({ persist: false, initialConfig: compatible() });
  await noKey.init();
  assert.equal(noKey.view().keyConfigured, false);
  const target = path.join(directory, 'target.json');
  await writeFile(target, '{}');
  let fileLink = true;
  try { await symlink(target, path.join(directory, 'models.json')); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { fileLink = false; t.diagnostic('File-symlink check requires Windows symlink privilege.'); } else throw error; }
  if (fileLink) {
    await assert.rejects(new ModelStore({ directory }).init(), { code: 'MODEL_STORAGE' });
    await rm(path.join(directory, 'models.json'));
  }
  await writeFile(path.join(directory, 'models.json'), 'null');
  await assert.rejects(new ModelStore({ directory }).init(), { code: 'MODEL_STORAGE' });
  const linked = path.join(directory, 'linked');
  await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ModelStore({ directory: linked }).init(), { code: 'MODEL_STORAGE' });
});
