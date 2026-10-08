import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionEngine } from '../src/session-engine.mjs';
import { createRuntimeManager } from '../src/runtime-manager.mjs';
import { ProfileStore } from '../src/profile-store.mjs';
import { ResearchStore } from '../src/research-store.mjs';
import { createDemoServer } from '../src/server.mjs';
import { resolveConditions } from '../src/condition-service.mjs';
import { hashValue } from '../src/config.mjs';

async function fixture(t, persist = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-conditions-trace-'));
  const runtime = createRuntimeManager({ bobUrl: '', modelBaseUrl: '', modelName: '' });
  await runtime.start();
  const profiles = new ProfileStore({ directory, persist }); await profiles.init();
  const research = new ResearchStore({ directory: path.join(directory, 'research'), persist }); await research.init();
  const engine = new SessionEngine({ runtime, profiles, research });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, runtime, profiles, research, directory };
}
async function choose(engine, session, stage, choice) {
  const preview = await engine.preview(session, { stage, choice });
  return engine.action(session, { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
    previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() });
}

test('custom initial fixtures affect actual isolated projections and receipt-backed knowledge with capped fields/days', async t => {
  const { engine, research } = await fixture(t);
  const calendar = [
    { day: 'Tue', time: '08:00–08:30', status: 'Free', title: 'Alice synthetic private sentinel', note: 'own only' },
    { day: 'Wed', time: '10:00–10:30', status: 'Free', title: 'Outside allowed day', note: '' }
  ];
  const created = await engine.create({ initialConditions: { custom: { Alice: {
    data: { calendar }, kg: { nodes: [{ id: 'private', label: 'Alice own knowledge sentinel', type: 'concept' }], edges: [] },
    authorization: { fields: ['day', 'time', 'status'], windows: ['Tue'], maxUses: 1 }
  } } } });
  const session = engine.get(created.state.session.id);
  assert.deepEqual(created.state.alice.calendar, calendar);
  assert.equal(JSON.stringify(created.state.agentStates.Bob).includes('sentinel'), false);
  const preview = await engine.preview(session, { stage: 'initial', choice: 'full' });
  assert.deepEqual(preview.fields, ['day', 'time', 'status']);
  assert.deepEqual(preview.window, ['Tue']);
  assert.deepEqual(preview.rows, [{ day: 'Tue', time: '08:00–08:30', status: 'Free' }]);
  const state = (await choose(engine, session, 'initial', 'full')).state;
  assert.deepEqual(state.receipts.aliceToBob[0].rows, preview.rows);
  assert.equal(state.agentStates.Bob.stats.receipts, 1);
  assert.equal(JSON.stringify(state.agentStates.Bob).includes('sentinel'), false);
  assert.equal(state.agentStates.Alice.authorization.cards[0].remaining, 0);
  await assert.rejects(choose(engine, session, 'additional', 'narrow'), { code: 'ALICE_AUTH_LIMIT' });
  assert.equal((await choose(engine, session, 'additional', 'keep')).state.task.outcome, 'boundary_kept');
  assert.deepEqual(research.list().runs, []);
});

test('disabled sending and reading skills are enforced by workers and controller, while declining remains available', async t => {
  const { engine } = await fixture(t);
  const created = await engine.create({ initialConditions: { custom: { Alice: { skills: ['read_synthetic_calendar', 'preview_scoped_calendar'] } } } });
  const session = engine.get(created.state.session.id);
  assert.equal((await engine.preview(session, { stage: 'initial', choice: 'free' })).rows.length, 2);
  await assert.rejects(choose(engine, session, 'initial', 'free'), { code: 'TOOL_DISABLED' });
  assert.equal((await choose(engine, session, 'initial', 'none')).state.task.outcome, 'declined');
  const bob = await engine.create({ initialConditions: { custom: { Bob: { skills: ['send_scoped_reply'] } } } });
  const bobSession = engine.get(bob.state.session.id);
  const result = await choose(engine, bobSession, 'initial', 'free');
  assert.equal(result.state.session.paused, true);
  assert.equal(result.state.receipts.aliceToBob.length, 1);
  assert.equal(result.state.receipts.bobToAlice.length, 0);
});

test('v2 research trace reconstructs initialization, receipt, refusal and final state after restart; detects edited history', async t => {
  const { engine, research, directory } = await fixture(t, true);
  const created = await engine.create({ researchConsent: true });
  const session = engine.get(created.state.session.id);
  await choose(engine, session, 'initial', 'free');
  await choose(engine, session, 'additional', 'keep');
  await engine.action(session, { action: 'end', requestId: randomUUID(), expectedVersion: session.version });
  const run = research.list().runs[0];
  assert.equal(run.consentVersion, 'research-v2');
  assert.equal(run.trace[0].snapshot.agentStates.Bob.stats.receipts, 0);
  assert.equal(run.trace.find(step => step.kind === 'delivery').snapshot.agentStates.Bob.stats.receipts, 1);
  assert.equal(run.trace.at(-1).snapshot.ended, true);
  assert.equal(run.trace.at(-1).snapshot.agentStates.Bob.stats.receipts, 1);
  assert.equal(run.trace.at(-1).snapshot.task.outcome, 'boundary_kept');
  assert.equal(run.conditionsHash, hashValue(run.initialConditions));
  assert.equal(run.trace.at(-1).snapshot.version, session.version);
  const disk = await readFile(path.join(directory, 'research', 'runs.json'), 'utf8');
  for (const field of ['tokenHash', 'privateKey', 'reasoning_content', 'apiKey', 'rawChat', 'messages', 'runtimecontext']) assert.equal(disk.includes('"' + field + '"'), false, field);
  const restored = new ResearchStore({ directory: path.join(directory, 'research') });
  await restored.init();
  assert.deepEqual(restored.list(), research.list());
  assert.ok(restored.export('jsonl').includes('agent-trace-v1'));
  const edited = JSON.parse(disk);
  edited.runs[0].trace[2].snapshot.stopped = true;
  await writeFile(path.join(directory, 'research', 'runs.json'), JSON.stringify(edited));
  const checked = new ResearchStore({ directory: path.join(directory, 'research') }); await checked.init();
  assert.ok(checked.list().runs[0].quality.includes('trace_integrity_failed'));
  assert.equal(checked.list().runs[0].trace.length, 2);
});

test('persisted custom briefs preserve accepted long strings and wide nested JSON with the exact reviewed hash', async t => {
  const { engine, research, directory } = await fixture(t, true);
  const conditions = resolveConditions();
  conditions.agents.Bob.data.brief = {
    ...Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`finding_${index}`, `Synthetic ${index}`])),
    longText: 'Synthetic study. '.repeat(1500),
    observations: Array.from({ length: 3000 }, (_, index) => ({ index, value: `Synthetic ${index}` }))
  };
  const expectedHash = hashValue(conditions);
  const created = await engine.create({ researchConsent: true, initialConditions: conditions, expectedConditionsHash: expectedHash });
  const session = engine.get(created.state.session.id);
  await engine.action(session, { action: 'end', requestId: randomUUID(), expectedVersion: session.version });
  const run = research.list().runs[0];
  assert.deepEqual(run.initialConditions, conditions);
  assert.equal(run.conditionsHash, expectedHash);
  assert.ok(run.trace.length > 1);
  for (const step of run.trace) {
    assert.equal(hashValue(step.snapshot.conditions), expectedHash);
    assert.deepEqual(step.snapshot.config.data.brief, conditions.agents.Bob.data.brief);
  }
  const restored = new ResearchStore({ directory: path.join(directory, 'research') });
  await restored.init();
  assert.deepEqual(restored.list(), research.list());
  assert.equal(JSON.parse(restored.export('jsonl')).conditionsHash, expectedHash);
});

test('condition APIs preview without mutation and require owner authority only for actual Bob changes', async t => {
  const app = await createDemoServer({ port: 0, adminPin: 'conditions-admin-pin', persist: false });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, input, token) => {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Researcher-Token': token } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const catalog = (await call('/api/conditions/catalog')).body;
  assert.ok(catalog.presets.length >= 4); assert.ok(catalog.components.length >= 12);
  assert.ok((await call('/api/conditions/schema')).body);
  const input = { presetId: 'minimal' };
  const preview = (await call('/api/conditions/resolve', input)).body;
  assert.equal(preview.requiresResearcher, true);
  assert.equal(preview.agentStates.Bob.stats.receipts, 0);
  assert.equal((await call('/api/sessions', { initialConditions: input })).status, 401);
  const admin = (await call('/api/admin/login', { pin: 'conditions-admin-pin' })).body.token;
  const created = await call('/api/sessions', { initialConditions: input, expectedConditionsHash: preview.hash }, admin);
  assert.equal(created.status, 201);
  assert.equal(created.body.state.conditionsHash, preview.hash);
  const aliceOnly = { custom: { Alice: { authorization: { maxUses: 2 } } } };
  assert.equal((await call('/api/conditions/resolve', aliceOnly)).body.requiresResearcher, false);
  assert.equal((await call('/api/sessions', { initialConditions: aliceOnly })).status, 201);
  const before = app.engine.sessions.size;
  const stale = await call('/api/sessions', { initialConditions: aliceOnly, expectedConditionsHash: '0'.repeat(64),
    previousSessionId: created.body.state.session.id, previousToken: created.body.token });
  assert.equal(stale.status, 409);
  assert.equal(app.engine.sessions.size, before);
  const invalid = await call('/api/conditions/resolve', { custom: { Alice: { kg: { nodes: [], edges: [{ id: 'bad', source: 'missing', target: 'missing', label: 'bad' }] } } } });
  assert.equal(invalid.status, 422);
});

test('expired Alice authorization never starts an unconfirmed retry after a connection pause', async t => {
  const { engine, runtime } = await fixture(t);
  const created = await engine.create(); const session = engine.get(created.state.session.id);
  await engine.intervene(session, { action: 'disconnect_bob' });
  await choose(engine, session, 'initial', 'free');
  assert.equal(session.paused, true);
  assert.equal(session.aliceUses, 1);
  session.pendingDelivery.expiresAt = Date.now() - 1;
  let sends = 0; const send = runtime.deliverToBob.bind(runtime);
  runtime.deliverToBob = request => { sends++; return send(request); };
  await engine.intervene(session, { action: 'restore_bob' });
  const result = await engine.intervene(session, { action: 'retry' });
  assert.equal(sends, 0);
  assert.equal(result.state.session.paused, true);
  assert.equal(result.state.receipts.aliceToBob.length, 0);
});
