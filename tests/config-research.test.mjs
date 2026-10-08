import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BOB_CONFIG, canonicalStringify, clone, diffConfig, hashValue, validateConfig } from '../src/config.mjs';
import { ResearchStore } from '../src/research-store.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-demo-research-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function session(overrides = {}) {
  return { id: 'fictional-session', epoch: 1, mode: 'controlled', researchConsent: true, consentVersion: 'research-v1', scenarioVersion: 'synthetic-calendar-v1', configRevision: 1, startedAt: Date.now(), ...overrides };
}

test('baseline and arbitrary legal synthetic research configurations remain editable without mutation', () => {
  assert.equal(validateConfig(DEFAULT_BOB_CONFIG).valid, true);
  const config = clone(DEFAULT_BOB_CONFIG);
  config.data.availableTimes = [{ day: 'Tue', time: '08:00-08:10', label: 'short synthetic interval' }];
  config.data.brief = { newResearchField: { nested: ['synthetic', 'values'] } };
  config.permissions.recipients = ['FutureDemoPeer'];
  config.permissions.fields = ['newResearchField'];
  config.permissions.resources = ['new_synthetic_resource'];
  config.tools.capabilities = ['future_tool'];
  config.extensions.futureCondition = { enabled: true };
  config.futureTopLevel = { version: 2 };
  const before = canonicalStringify(config);
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  assert.equal(canonicalStringify(config), before);
  const copied = clone(config);
  assert.deepEqual(copied.futureTopLevel, { version: 2 });
  assert.deepEqual(copied.data.brief, config.data.brief);
  copied.extensions.futureCondition.enabled = false;
  assert.equal(config.extensions.futureCondition.enabled, true);
});

test('known schema rejects legacy time strings, malformed times, non-synthetic data and invalid bounds', () => {
  for (const [change, expectedPath] of [
    [config => { config.data.availableTimes = ['Thu 15:00']; }, '$.data.availableTimes[0]'],
    [config => { config.data.availableTimes = [{ day: 'Thursday', time: '15:00–15:30' }]; }, '$.data.availableTimes[0].day'],
    [config => { config.data.availableTimes[0].time = '25:00–25:30'; }, '$.data.availableTimes[0].time'],
    [config => { config.data.availableTimes[0].time = '15:30–15:00'; }, '$.data.availableTimes[0].time'],
    [config => { config.data.synthetic = false; }, '$.data.synthetic'],
    [config => { config.permissions.maxUses = 0; }, '$.permissions.maxUses'],
    [config => { config.permissions.maxUses = 1.5; }, '$.permissions.maxUses'],
    [config => { config.permissions.expiryMinutes = 1441; }, '$.permissions.expiryMinutes'],
    [config => { config.runtime.timeoutSeconds = -1; }, '$.runtime.timeoutSeconds']
  ]) {
    const config = clone(DEFAULT_BOB_CONFIG);
    change(config);
    const result = validateConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === expectedPath), JSON.stringify(result.errors));
  }
});

test('unsafe keys, credentials, cycles and non-JSON values are rejected without invoking getters', () => {
  const cases = [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { extensions: { constructor: {} } },
    { extensions: { api_key: 'must-not-save' } },
    { extensions: { OPENAI_API_KEY: 'must-not-save' } },
    { extensions: { AGENT_DEMO_ADMIN_PIN: 'must-not-save' } },
    { extensions: { nested: { accessToken: 'must-not-save' } } },
    { extensions: { number: NaN } },
    { extensions: { missing: undefined } },
    { extensions: { bigint: 1n } },
    { extensions: { date: new Date() } },
    { extensions: { sparse: new Array(2) } }
  ];
  const cycle = {};
  cycle.self = cycle;
  cases.push({ extensions: cycle });
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { invoked = true; throw new Error('getter must not execute'); } });
  cases.push({ extensions: accessor });
  for (const input of cases) assert.equal(validateConfig(input).valid, false);
  assert.equal(invoked, false);
  assert.equal({}.polluted, undefined);
  assert.throws(() => canonicalStringify(cycle), /Cyclic/);
  assert.throws(() => canonicalStringify({ value: undefined }), /JSON/);
});

test('canonical hashing and config diffs preserve unknown fields and array order', () => {
  assert.equal(canonicalStringify({ z: 1, a: { d: 2, b: 3 } }), '{"a":{"b":3,"d":2},"z":1}');
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  assert.notEqual(hashValue(['Thu', 'Fri']), hashValue(['Fri', 'Thu']));
  const before = { extensions: { a: 1, removed: 3 }, fields: ['day'] };
  const after = { fields: ['day', 'time'], extensions: { a: 2, added: false } };
  assert.deepEqual(diffConfig(before, after), [
    { path: 'extensions.a', before: 1, after: 2 },
    { path: 'extensions.added', before: undefined, after: false },
    { path: 'extensions.removed', before: 3, after: undefined },
    { path: 'fields', before: ['day'], after: ['day', 'time'] }
  ]);
});

test('no consent and replay create no run, no directory, no events and no replay history', async t => {
  const directory = path.join(await temporary(t), 'absent-research-directory');
  const store = new ResearchStore({ directory });
  await store.init();
  for (const input of [session({ researchConsent: false }), session({ mode: 'replay' }), session({ mode: 'replay', researchConsent: false })]) {
    assert.equal(await store.start(input), null);
    assert.equal(await store.append(input, { kind: 'sharing_choice', choice: 'full', rows: [{ name: 'do not log' }] }), false);
    assert.equal(await store.finish(input, 'declined'), false);
  }
  assert.deepEqual(store.list(), { runs: [], summary: { runs: 0, completed: 0, taskCompleted: 0, runsPendingClose: 0, affectedByTechnical: 0, stopped: 0, technical: 0, replayExcluded: 0 } });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.equal(store.export('jsonl'), '');
});

test('consented records whitelist event metadata, retain technical codes, reload and export only actual runs', async t => {
  const directory = path.join(await temporary(t), 'research');
  const store = new ResearchStore({ directory });
  await store.init();
  const input = session();
  const runId = await store.start(input);
  assert.equal(await store.start(input), runId);
  await store.append(input, {
    kind: 'sharing_choice', stage: 'initial', choice: 'free', fields: ['day', 'time', 'status'], window: 'Tue–Wed',
    elapsedMs: 25, decisionMs: 20, adminWaitMs: 5, configRevision: 1,
    rows: [{ title: 'raw-calendar-never-persist' }], rawChat: 'raw-dialogue-never-persist', name: 'real-person-never-persist', ip: '192.0.2.1', values: { agenda: 'raw-brief-never-persist' }, unknown: 'raw-unknown-never-persist'
  });
  await store.append(input, { kind: 'prediction', questionId: 'received_scope', answer: 'approved_snapshot' });
  await store.append(input, { kind: 'prediction', questionId: 'withdrawal', answer: 'delete_received' });
  await store.append(input, { kind: 'prediction', questionId: 'received_scope', answer: 'Person Name must not be logged' });
  await store.append(input, { kind: 'provider_failure', code: 'MODEL_TIMEOUT', reason: 'contains raw exception body and personal information' });
  await store.append(input, { kind: 'admin_intervention', action: 'retry', actor: 'admin' });
  await store.finish(input, 'declined', ['assisted']);
  assert.equal(await store.append(input, { kind: 'sharing_choice', choice: 'week' }), false);
  assert.equal(await store.start(input), runId, 'finished sessions must not create duplicate runs');
  const first = store.list();
  assert.equal(first.runs.length, 1);
  assert.equal(first.summary.completed, 1, 'declining is a valid complete outcome');
  assert.equal(first.runs[0].events[0].window, 'Tue–Wed');
  assert.equal(first.runs[0].events[3].answer, undefined);
  assert.equal(first.runs[0].events[4].code, 'MODEL_TIMEOUT');
  assert.equal(first.runs[0].events[4].reason, undefined);
  assert.deepEqual(first.runs[0].quality, ['admin_intervention', 'assisted']);
  const disk = await readFile(path.join(directory, 'runs.json'), 'utf8');
  for (const forbidden of ['raw-calendar', 'raw-dialogue', 'real-person', '192.0.2.1', 'raw-brief', 'raw-unknown', 'Person Name', 'fictional-session']) assert.equal(disk.includes(forbidden), false, forbidden);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'runs.json'))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(directory), ['runs.json']);
  const restored = new ResearchStore({ directory });
  await restored.init();
  assert.deepEqual(restored.list(), first);
  assert.equal(JSON.parse(restored.export('jsonl')).runId, runId);
  assert.ok(restored.export('csv').includes('MODEL_TIMEOUT'));
  assert.equal(restored.export('csv').includes('raw-dialogue'), false);
  assert.throws(() => restored.export('xlsx'), /format/);
  first.runs[0].events[0].choice = 'full';
  assert.equal(store.list().runs[0].events[0].choice, 'free', 'list returns detached records');
});

test('serialized updates, epoch isolation, nested session support and admin deletion persist correctly', async t => {
  const directory = path.join(await temporary(t), 'research');
  const store = new ResearchStore({ directory });
  const input = { session: session(), bob: { configRevision: 2 } };
  const runId = await store.start(input);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.append(input, { kind: 'technical', code: `RECOVERY_${i}` })));
  assert.deepEqual(store.list().runs[0].events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(await store.append({ session: { ...input.session, epoch: 2 } }, { kind: 'sharing_choice', choice: 'week' }), false);
  await store.finish(input, 'technical');
  assert.equal(store.list().summary.technical, 1);
  assert.equal(await store.deleteRun('missing'), false);
  assert.equal(await store.deleteRun(runId), true);
  assert.equal(store.list().summary.runs, 0);
  const restored = new ResearchStore({ directory });
  await restored.init();
  assert.equal(restored.list().summary.runs, 0);
});

test('task outcome and research closure are distinct; optional answers remain recordable before closure', async t => {
  const directory = path.join(await temporary(t), 'research');
  const store = new ResearchStore({ directory });
  const input = session();
  await store.start(input);
  assert.equal(store.list().summary.taskCompleted, 0);
  await store.append(input, { kind: 'stage', stage: 'complete', status: 'boundary_kept' });
  assert.equal(store.list().runs[0].status, 'active');
  assert.equal(store.list().summary.taskCompleted, 1);
  assert.equal(store.list().summary.runsPendingClose, 1);
  assert.equal(store.list().summary.completed, 0);
  assert.equal(await store.append(input, { kind: 'prediction', questionId: 'withdrawal', answer: 'future_only', correct: true }), true);
  await store.finish(input, 'boundary_kept');
  assert.equal(store.list().summary.completed, 1);
  assert.equal(store.list().summary.taskCompleted, 1);
  assert.equal(store.list().summary.runsPendingClose, 0);
  assert.equal(await store.append(input, { kind: 'prediction', questionId: 'received_scope', answer: 'approved_snapshot' }), false);
  const restored = new ResearchStore({ directory });
  await restored.init();
  assert.deepEqual(restored.list().summary, store.list().summary);
});

test('persistent restart closes orphaned active records without inventing behavior or losing task outcome facts', async t => {
  const directory = path.join(await temporary(t), 'research');
  const before = new ResearchStore({ directory });
  const input = session();
  const runId = await before.start(input);
  await before.append(input, { kind: 'stage', stage: 'complete', status: 'arranged' });
  await before.append(input, { kind: 'prediction', questionId: 'received_scope', answer: 'approved_snapshot' });
  assert.equal(before.list().summary.runsPendingClose, 1);
  const after = new ResearchStore({ directory });
  await after.init();
  const recovered = after.list();
  assert.equal(recovered.runs[0].runId, runId);
  assert.equal(recovered.runs[0].status, 'incomplete');
  assert.deepEqual(recovered.runs[0].quality, ['process_interrupted']);
  assert.deepEqual(recovered.runs[0].events, before.list().runs[0].events);
  assert.equal(recovered.runs[0].endedAt, undefined, 'the unknown actual end time is not invented');
  assert.equal(recovered.summary.taskCompleted, 1);
  assert.equal(recovered.summary.completed, 0);
  assert.equal(recovered.summary.runsPendingClose, 0);
  assert.equal(await after.append(input, { kind: 'prediction', questionId: 'withdrawal', answer: 'future_only' }), false);
  const disk = JSON.parse(await readFile(path.join(directory, 'runs.json'), 'utf8'));
  assert.equal(disk.runs[0].status, 'incomplete');
  const again = new ResearchStore({ directory });
  await again.init();
  assert.deepEqual(again.list(), recovered, 'recovery is durable and idempotent');
  assert.deepEqual(await readdir(directory), ['runs.json']);
});

test('technical impact includes recovered faults and CSV carries analyzable understanding metadata', async () => {
  const store = new ResearchStore({ persist: false });
  const recovered = session({ id: 'recovered' });
  await store.start(recovered);
  await store.append(recovered, { kind: 'technical', code: 'MODEL_TIMEOUT' });
  await store.append(recovered, { kind: 'prediction', questionId: 'withdrawal', answer: 'future_only', correct: true });
  await store.finish(recovered, 'arranged');
  const flagged = session({ id: 'flagged' });
  await store.start(flagged);
  await store.finish(flagged, 'ended', ['technical_issue']);
  const clear = session({ id: 'clear' });
  await store.start(clear);
  await store.finish(clear, 'declined');
  await store.append(session({ researchConsent: false }), { kind: 'technical', code: 'NOT_COLLECTED' });
  const summary = store.list().summary;
  assert.equal(summary.runs, 3);
  assert.equal(summary.affectedByTechnical, 2);
  assert.equal(summary.technical, 0, 'recovered issues are distinct from technical terminal statuses');
  const csv = store.export('csv').trim().split('\r\n');
  const header = csv[0].split(',');
  const answerRow = csv.find(row => row.includes('"prediction"')).split(',');
  assert.equal(answerRow[header.indexOf('"correct"')], '"true"');
  assert.equal(answerRow[header.indexOf('"answer"')], '"future_only"');
});

test('in-memory mode never writes and symlinked research stores are rejected', async t => {
  const directory = await temporary(t);
  const memory = new ResearchStore({ directory: path.join(directory, 'memory'), persist: false });
  await memory.init();
  const input = session();
  await memory.start(input);
  await memory.append(input, { kind: 'technical', code: 'NO_DISK' });
  await memory.finish(input, 'ended');
  assert.equal(memory.list().summary.stopped, 1);
  await assert.rejects(stat(path.join(directory, 'memory')), { code: 'ENOENT' });
  const target = path.join(directory, 'existing.json');
  await writeFile(target, '{"schemaVersion":1,"runs":[]}');
  const symlinkDirectory = path.join(directory, 'linked-dir');
  await symlink(directory, symlinkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ResearchStore({ directory: symlinkDirectory }).init(), /real directory/);
  try { await symlink(target, path.join(directory, 'runs.json')); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('File-symlink check requires Windows symlink privilege; directory link rejection passed.'); return; } throw error; }
  await assert.rejects(new ResearchStore({ directory }).init());
});
