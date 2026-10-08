import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConditionStore } from '../src/condition-store.mjs';
import { conditionBobConfig, resolveConditions } from '../src/condition-service.mjs';
import { DEFAULT_BOB_CONFIG, hashValue } from '../src/config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-condition-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await new ConditionStore({ directory }).init() };
}

test('initialization does not save participant defaults; explicit researcher saves persist exact reusable fixtures', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await readdir(directory), []);
  const saved = await store.save({ name: 'Availability study', input: { presetId: 'minimal' } });
  assert.equal(saved.revision, 1);
  assert.equal(saved.hash, hashValue(saved.conditions));
  assert.deepEqual(saved.conditions, resolveConditions({ presetId: 'minimal' }));
  assert.deepEqual(await readdir(directory), ['conditions.json']);
  const disk = JSON.parse(await readFile(path.join(directory, 'conditions.json'), 'utf8'));
  assert.deepEqual(disk, { schemaVersion: 1, bundles: [saved] });
  const reopened = await new ConditionStore({ directory }).init();
  assert.deepEqual(reopened.list(), [saved]);
  assert.deepEqual(resolveConditions(reopened.list()[0].conditions), saved.conditions);
  assert.deepEqual(conditionBobConfig(saved.conditions).data, conditionBobConfig(resolveConditions({ presetId: 'minimal' })).data);
});

test('save updates use name and optimistic revision while preserving ID and creation time', async t => {
  const { store } = await fixture(t);
  const saved = await store.save({ name: '  Study pack  ', input: { presetId: 'conference' }, expectedRevision: 0 });
  assert.equal(saved.name, 'Study pack');
  await assert.rejects(store.save({ name: 'Study pack', input: { presetId: 'minimal' } }), { code: 'STALE_CONDITION_BUNDLE', status: 409 });
  await assert.rejects(store.save({ name: 'Study pack', input: { presetId: 'minimal' }, expectedRevision: 0 }), { code: 'STALE_CONDITION_BUNDLE' });
  const updated = await store.save({ name: 'Study pack', input: { presetId: 'minimal' }, expectedRevision: saved.revision });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.createdAt);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.hash, saved.hash);
  await assert.rejects(store.save({ name: 'Uncreated pack', input: {}, expectedRevision: 7 }), { code: 'STALE_CONDITION_BUNDLE' });
  assert.equal(store.list().length, 1);
});

test('concurrent saves to the same revision allow one update and reject the stale update', async t => {
  const { store } = await fixture(t);
  const saved = await store.save({ name: 'Concurrent', input: {} });
  const results = await Promise.allSettled([
    store.save({ name: 'Concurrent', input: { presetId: 'minimal' }, expectedRevision: saved.revision }),
    store.save({ name: 'Concurrent', input: { presetId: 'shared-context' }, expectedRevision: saved.revision })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_CONDITION_BUNDLE');
  assert.equal(store.list()[0].revision, 2);
});

test('deletion requires a current revision and survives restart', async t => {
  const { directory, store } = await fixture(t);
  const saved = await store.save({ name: 'Delete me', input: {} });
  await assert.rejects(store.delete(saved.id), { code: 'CONDITION_REVISION' });
  await assert.rejects(store.delete(saved.id, 2), { code: 'STALE_CONDITION_BUNDLE' });
  assert.deepEqual(await store.delete(saved.id, 1), { id: saved.id, deleted: true, revision: 1 });
  assert.deepEqual((await new ConditionStore({ directory }).init()).list(), []);
  await assert.rejects(store.delete(saved.id, 1), { code: 'CONDITION_NOT_FOUND' });
});

test('invalid conditions, unsafe credentials and unknown bundle fields never reach disk', async t => {
  const { directory, store } = await fixture(t);
  await assert.rejects(store.save({ name: 'Unsafe', input: { custom: { Bob: { apiKey: 'secret' } } } }), { code: 'INVALID_CONDITIONS', status: 422 });
  await assert.rejects(store.save({ name: 'Bad graph', input: { custom: { Alice: { kg: { nodes: [], edges: [{ id: 'e', source: 'gone', target: 'gone', label: 'links' }] } } } } }), { code: 'INVALID_CONDITIONS' });
  await assert.rejects(store.save({ name: 'Pack', input: {}, credentials: 'bad' }), { code: 'CONDITION_BUNDLE' });
  await assert.rejects(store.save({ name: 'Bearer 1234567890abcdefghijkl', input: {} }), { code: 'CONDITION_NAME' });
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await readdir(directory), []);
});

test('returns are immutable copies and full resolved input preserves exact conditions', async t => {
  const { store } = await fixture(t);
  const conditions = resolveConditions({ presetId: 'shared-context' });
  const saved = await store.save({ name: 'Copies', input: conditions });
  const original = structuredClone(saved);
  saved.conditions.agents.Alice.data.calendar.length = 0;
  conditions.agents.Bob.data.brief.topic = 'Changed after save';
  const listed = store.list(); listed[0].conditions.agents.Bob.skills.length = 0;
  assert.deepEqual(store.list(), [original]);
});

test('owner-specific safe labels and extensible brief remain intact after restart', async t => {
  const { directory, store } = await fixture(t);
  const template = structuredClone(DEFAULT_BOB_CONFIG);
  template.data.brief.context = { study: 'Fictional lab', room: 7 };
  template.tools.capabilities.push('owner_synthetic_label');
  template.permissions.fields.push('context');
  template.permissions.resources.push('meeting_brief');
  const saved = await store.save({ name: 'Owner condition', input: {} }, template);
  assert.deepEqual((await new ConditionStore({ directory }).init()).list(), [saved]);
});

test('corrupt, tampered or credential-bearing persisted bundles fail validation', async t => {
  const { directory, store } = await fixture(t);
  const saved = await store.save({ name: 'Verified', input: {} });
  const filename = path.join(directory, 'conditions.json');
  const tampered = structuredClone(saved); tampered.conditions.agents.Alice.authorization.maxUses = 999;
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, bundles: [tampered] }));
  await assert.rejects(new ConditionStore({ directory }).init(), { code: 'CONDITION_FILE' });
  const secret = structuredClone(saved); secret.conditions.agents.Bob.data.brief.apiKey = 'secret'; secret.hash = hashValue(secret.conditions);
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, bundles: [secret] }));
  await assert.rejects(new ConditionStore({ directory }).init(), { code: 'CONDITION_FILE' });
  await writeFile(filename, '{bad JSON');
  await assert.rejects(new ConditionStore({ directory }).init(), { code: 'CONDITION_FILE' });
});

test('failed persistence leaves committed in-memory bundles unchanged and queue usable', async t => {
  const { store } = await fixture(t);
  const saved = await store.save({ name: 'Stable', input: {} });
  const persist = store.persistSnapshot.bind(store);
  store.persistSnapshot = async () => { throw new Error('Simulated storage failure'); };
  await assert.rejects(store.save({ name: 'Stable', input: { presetId: 'minimal' }, expectedRevision: 1 }), /storage failure/);
  await assert.rejects(store.delete(saved.id, 1), /storage failure/);
  assert.deepEqual(store.list(), [saved]);
  store.persistSnapshot = persist;
  assert.equal((await store.save({ name: 'Stable', input: { presetId: 'minimal' }, expectedRevision: 1 })).revision, 2);
});

test('memory-only stores never create persistence directories', async () => {
  const store = await new ConditionStore({ persist: false }).init();
  const saved = await store.save({ name: 'In memory', input: {} });
  assert.deepEqual(store.list(), [saved]);
  await store.delete(saved.id, 1);
  assert.deepEqual(store.list(), []);
});

test('symbolic-link bundle files and directories are rejected without changing their targets', async t => {
  const { directory, store } = await fixture(t);
  const target = path.join(directory, 'outside.json');
  await writeFile(target, 'Do not modify');
  try { await symlink(target, path.join(directory, 'conditions.json')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This host does not grant symbolic-link creation.'); return; } throw error; }
  await assert.rejects(new ConditionStore({ directory }).init(), { code: 'CONDITION_FILE' });
  await assert.rejects(store.save({ name: 'Safe', input: {} }), { code: 'CONDITION_FILE' });
  assert.equal(await readFile(target, 'utf8'), 'Do not modify');
  assert.deepEqual(store.list(), []);
  const linked = path.join(directory, 'linked');
  await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ConditionStore({ directory: linked }).init(), { code: 'CONDITION_FILE' });
});

test('directory links and missing descendants cannot redirect bundle creation', async t => {
  const { directory } = await fixture(t);
  const linked = path.join(directory, 'linked-directory');
  try { await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This host does not grant directory-link creation.'); return; } throw error; }
  await assert.rejects(new ConditionStore({ directory: linked }).init(), { code: 'CONDITION_FILE' });
  const nested = await new ConditionStore({ directory: path.join(linked, 'nested') }).init();
  await assert.rejects(nested.save({ name: 'Redirected', input: {} }), { code: 'CONDITION_FILE' });
  assert.deepEqual(nested.list(), []);
  assert.deepEqual(await readdir(directory), ['linked-directory']);
});

test('many individually valid large fixtures remain saveable, listable and reusable beyond the per-fixture JSON budget', async t => {
  const { directory, store } = await fixture(t);
  const input = { custom: { Alice: { data: { calendar: Array.from({ length: 500 }, (_, index) => ({
    day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][index % 5], time: '10:00–10:30', status: 'Free', title: `Fictional slot ${index}`, note: 'Synthetic fixture only'
  })) } } } };
  const resolved = resolveConditions(input);
  for (let index = 0; index < 8; index++) await store.save({ name: `Large study ${index}`, input: resolved });
  assert.equal(store.list().length, 8);
  const restored = await new ConditionStore({ directory }).init();
  assert.deepEqual(restored.list(), store.list());
  assert.deepEqual(resolveConditions(restored.list()[7].conditions), resolved);
  const selected = restored.list()[0];
  const updated = await restored.save({ name: selected.name, input: { presetId: 'minimal' }, expectedRevision: selected.revision });
  assert.equal(updated.revision, 2);
  assert.equal(restored.list().length, 8);
  await restored.delete(updated.id, updated.revision);
  assert.equal(restored.list().length, 7);
});
