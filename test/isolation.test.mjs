import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from '../src/runtime-client.mjs';
import { RuntimeError } from '../src/runtime-helpers.mjs';

test('both real worker launches deny network, writes, child/worker/addon/inspector and outside reads', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'agent-permission-test-'));
  const outsideFile = join(outside, 'sentinel');
  await writeFile(outsideFile, 'NO_PARENT_DATA_READ');
  t.after(() => rm(outside, { recursive: true, force: true }));
  const previous = process.env.AGENT_DEMO_PARENT_SENTINEL;
  process.env.AGENT_DEMO_PARENT_SENTINEL = 'not-in-workers';
  t.after(() => { if (previous === undefined) delete process.env.AGENT_DEMO_PARENT_SENTINEL; else process.env.AGENT_DEMO_PARENT_SENTINEL = previous; });
  const options = { workerFile: new URL('../scripts/fixtures/permission-probe.mjs', import.meta.url),
    codeFiles: [fileURLToPath(new URL('../src/agent-worker.mjs', import.meta.url))] };
  const a = new WorkerClient('Alice', { apiKey: 'PROVIDER_SECRET_NEVER_IN_WORKER', baseUrl: 'https://private-provider.invalid', name: 'M3' }, options);
  const b = new WorkerClient('Bob', {}, options);
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.start(), b.start()]);
  assert.notEqual(a.cwd, b.cwd);
  assert.notEqual(a.cwd, process.cwd());
  for (const [client, other] of [[a, b], [b, a]]) {
    assert.equal((await stat(client.cwd)).mode & 0o777, 0o700);
    const result = await client.call('probe', { outsideFile, otherCwd: other.cwd });
    assert.equal(result.cwd, client.cwd);
    assert.equal(result.readOwnCode, true);
    assert.equal(result.readOutside, false);
    assert.equal(result.readOtherCwd, false);
    for (const [scope, allowed] of Object.entries(result.permission)) assert.equal(allowed, false, scope);
    for (const name of ['read', 'write', 'child', 'worker', 'inspector', 'net']) assert.equal(result.denied[name], 'ERR_ACCESS_DENIED', name);
    assert.equal(result.denied.addon, 'ERR_DLOPEN_DISABLED');
    assert(result.flags.includes('--permission'));
    assert(!result.flags.some(flag => /^--allow-(net|fs-write|child-process|worker|addons|inspector)/.test(flag)));
    assert(!result.envKeys.includes('HOME'));
    assert(!result.envKeys.includes('PATH'));
    assert(!result.envKeys.includes('NODE_OPTIONS'));
    assert(!result.envKeys.includes('AGENT_DEMO_PARENT_SENTINEL'));
    assert(!JSON.stringify(result.modelMetadata).includes('PROVIDER_SECRET'));
    assert(!JSON.stringify(result.modelMetadata).includes('private-provider'));
    assert.deepEqual(await readdir(client.cwd), []);
  }
  const dirs = [a.cwd, b.cwd];
  await a.close();
  await b.close();
  for (const directory of dirs) await assert.rejects(access(directory), { code: 'ENOENT' });
});

async function liveAlice(t, onModelCall, settings) {
  const alice = new WorkerClient('Alice', { available: true, name: 'M3', timeoutMs: 1000 }, { onModelCall });
  const bob = new WorkerClient('Bob');
  t.after(async () => { await alice.close(); await bob.close(); });
  const [a, b] = await Promise.all([alice.start(), bob.start()]);
  const ref = { sessionId: t.name, epoch: 1 };
  await alice.call('initialize', { ...ref, mode: 'live', configRevision: 1,
    aliceData: [{ day: 'Thu', time: '15:00–15:30', status: 'Free', title: 'Fictional own title', note: '' }],
    peerPublicKey: b.publicKey, modelRevision: 7, ...(settings ? { modelSettings: settings } : {}) });
  return { alice, bob, ref, identity: a.publicKey };
}

test('network-denied live worker uses only a signed parent broker and preserves the active model snapshot', async t => {
  const calls = [];
  const { alice, ref } = await liveAlice(t, async request => { calls.push(request); return { message: 'Parent-broker model proposal.' }; },
    { model: 'M3', temperature: 0.25, maxTokens: 100, timeoutSeconds: 1, retryLimit: 0, thinking: false });
  await alice.call('configureModel', { available: false, model: null, timeoutMs: 10 });
  assert.equal((await alice.call('status')).live.available, false);
  const result = await alice.call('planAlice', { ...ref, purpose: 'intro', mode: 'live' });
  assert.equal(result.message, 'Parent-broker model proposal.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'Alice');
  assert.equal(calls[0].sessionId, ref.sessionId);
  assert.equal(calls[0].epoch, 1);
  assert.equal(calls[0].modelRevision, 7);
  assert.equal(calls[0].legacyRuntime.temperature, 0.25);
  assert(!calls[0].signal.aborted);
  assert.equal(alice.isolation.network, false);
});

test('clear cancels the parent broker call and discards the late response', async t => {
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let brokerSignal;
  const { alice, ref } = await liveAlice(t, async request => {
    brokerSignal = request.signal;
    enteredResolve();
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    return { message: 'Late result must be discarded.' };
  });
  const pending = assert.rejects(alice.call('planAlice', { ...ref, purpose: 'intro', mode: 'live' }), { code: 'STALE_EPOCH' });
  await entered;
  await alice.call('clear', ref);
  await pending;
  assert.equal(brokerSignal.aborted, true);
  assert.equal(alice.modelPending.size, 0);
});

test('per-round model timeout and retry settings control broker attempts without widening any action', async t => {
  let attempts = 0;
  const { alice, ref } = await liveAlice(t, async () => {
    attempts++;
    if (attempts < 3) throw new RuntimeError('MODEL_PROVIDER_ERROR', 'Fixture provider is unavailable.', 502);
    return { message: 'Third authorized planning attempt.' };
  }, { model: 'M3', timeoutSeconds: 1, retryLimit: 2 });
  assert.equal((await alice.call('planAlice', { ...ref, purpose: 'intro', mode: 'live' })).message, 'Third authorized planning attempt.');
  assert.equal(attempts, 3);
});

test('unexpected worker exit also removes its private working directory', async () => {
  const worker = new WorkerClient('Alice');
  await worker.start();
  const directory = worker.cwd;
  const exited = new Promise(resolve => worker.child.once('exit', resolve));
  worker.child.kill('SIGKILL');
  await exited;
  await assert.rejects(access(directory), { code: 'ENOENT' });
  await worker.close();
});
