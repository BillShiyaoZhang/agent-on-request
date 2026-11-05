import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';
import { resolveConditions } from '../src/condition-service.mjs';
import { AppError } from '../src/errors.mjs';

const clone = value => structuredClone(value);
const roles = ['Alice', 'Bob'];

// This durable-source fixture exercises controller boundaries. The Docker smoke
// separately checks native corrections and actual Neo4j records through KG-plugin.
function knowledgeFixture() {
  const source = {
    conditions: resolveConditions(),
    rounds: new Map(),
    receipts: new Map(),
    failDefaults: false,
    failReceipts: 0,
    async initialize() { return this.defaults(); },
    async defaults() {
      if (this.failDefaults) throw new AppError('KG_UNAVAILABLE', 'The native source is unavailable.', 503);
      return { conditions: clone(this.conditions), revisions: { Alice: 'native-a', Bob: 'native-b' } };
    },
    async begin({ sessionId, epoch, conditions }) {
      const key = sessionId + ':' + epoch;
      const existing = this.rounds.get(key);
      if (existing) assert.deepEqual(existing.conditions, conditions);
      else this.rounds.set(key, { sessionId, epoch, conditions: clone(conditions), result: null });
      return this.snapshots({ sessionId, epoch });
    },
    async recordReceipt({ sessionId, epoch, direction, receipt }) {
      if (this.failReceipts) {
        this.failReceipts--;
        throw new AppError('KG_UNAVAILABLE', 'The native receipt write is unavailable.', 503);
      }
      assert.equal(receipt.status, 'received');
      assert(['aliceToBob', 'bobToAlice'].includes(direction));
      const key = [sessionId, epoch, direction, receipt.operationId].join(':');
      const existing = this.receipts.get(key);
      const entry = { sessionId, epoch, direction, receipt: clone(receipt) };
      if (existing) assert.deepEqual(existing, entry, 'A retry must retain the exact committed receipt.');
      else this.receipts.set(key, entry);
      return { ok: true };
    },
    async finish({ sessionId, epoch, result }) {
      const round = this.rounds.get(sessionId + ':' + epoch);
      assert(round, 'Results belong to an initialized native round.');
      round.result = clone(result);
      return this.snapshots({ sessionId, epoch });
    },
    async snapshots({ sessionId, epoch }) {
      const round = this.rounds.get(sessionId + ':' + epoch);
      assert(round);
      return Object.fromEntries(roles.map(role => {
        const incoming = [...this.receipts.values()].filter(entry => entry.sessionId === sessionId && entry.epoch === epoch
          && entry.direction === (role === 'Alice' ? 'bobToAlice' : 'aliceToBob')).map(entry => clone(entry.receipt));
        const namespace = 'urn:native-test:' + role.toLowerCase() + ':';
        return [role, { role, namespace, sessionId, epoch, profile: clone(round.conditions.agents[role]),
          receipts: incoming, result: clone(round.result),
          provenance: { provider: 'kg', namespace, profileUri: namespace + 'round-' + sessionId, revision: 'snapshot-v1' },
          graph: { nodes: [{ id: namespace + 'round-' + sessionId, label: role + ' native round', type: 'concept', origin: 'own', details: [] },
            ...incoming.map(receipt => ({ id: namespace + 'receipt-' + receipt.operationId, label: 'Confirmed receipt', type: 'snapshot',
              origin: 'received', details: [], provenance: { operationId: receipt.operationId, payloadHash: receipt.payloadHash } }))], edges: [] } }];
      }));
    },
  };
  return source;
}

async function application(t, knowledge) {
  const app = await createDemoServer({ knowledge, persist: false });
  t.after(() => app.close());
  return app;
}

async function choose(engine, session, stage, choice) {
  const preview = await engine.preview(session, { stage, choice });
  return engine.action(session, { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
    requestId: randomUUID(), expectedVersion: preview.sessionVersion, previewHash: preview.payloadHash });
}

test('native KG and native skill changes become next-round input while initialized snapshots remain fixed', async t => {
  const knowledge = knowledgeFixture();
  knowledge.conditions.agents.Alice.data.calendar[0].time = '10:00–10:45';
  knowledge.conditions.agents.Alice.kg.nodes[0].label = 'Alice native concept';
  knowledge.conditions.agents.Alice.kg.nodes[0].properties = { description: 'A role-local planning fact', priority: 2, tags: ['scheduling'] };
  knowledge.conditions.agents.Alice.skillDefinitions = [{ id: 'read_synthetic_calendar', label: 'Native calendar skill', description: 'Read only the role-local calendar.' }];
  knowledge.conditions.agents.Bob.kg.nodes[0].label = 'Bob native concept';
  knowledge.conditions.agents.Bob.data.brief.topic = 'Native KG meeting topic';
  knowledge.conditions.agents.Bob.skillDefinitions = [{ id: 'share_brief', label: 'Native brief skill', description: 'Share only the owner-approved topic.' }];
  const { engine } = await application(t, knowledge);
  const { state: first } = await engine.create();
  const session = engine.get(first.session.id);
  assert.equal(first.alice.calendar[0].time, '10:00–10:45');
  assert.equal(first.initialConditions.agents.Alice.kg.nodes[0].label, 'Alice native concept');
  assert.deepEqual(first.initialConditions.agents.Alice.kg.nodes[0].properties,
    { description: 'A role-local planning fact', priority: 2, tags: ['scheduling'] });
  assert.equal(first.initialConditions.agents.Alice.skillDefinitions[0].label, 'Native calendar skill');
  assert.equal(first.initialConditions.agents.Bob.kg.nodes[0].label, 'Bob native concept');
  assert.equal(first.initialConditions.agents.Bob.data.brief.topic, 'Native KG meeting topic');
  assert.equal(first.initialConditions.agents.Bob.skillDefinitions[0].label, 'Native brief skill');
  assert(first.agentStates.Alice.kg.nodes.some(node => node.id.startsWith('urn:native-test:alice:')));
  assert(first.agentStates.Bob.kg.nodes.some(node => node.id.startsWith('urn:native-test:bob:')));
  const preview = await engine.preview(session, { stage: 'initial', choice: 'free' });
  assert.equal(preview.rows[0].time, '10:00–10:45');
  assert.equal(knowledge.receipts.size, 0, 'Preview must not create a native received record.');

  knowledge.conditions.agents.Alice.data.calendar[0].time = '10:15–10:45';
  knowledge.conditions.agents.Alice.skills = knowledge.conditions.agents.Alice.skills.filter(id => id !== 'send_scoped_snapshot');
  const { state: second } = await engine.create();
  assert.equal(second.alice.calendar[0].time, '10:15–10:45');
  assert(!second.initialConditions.agents.Alice.skills.includes('send_scoped_snapshot'));
  const secondSession = engine.get(second.session.id);
  const blockedPreview = await engine.preview(secondSession, { stage: 'initial', choice: 'free' });
  await assert.rejects(engine.action(secondSession, { action: 'share_initial', choice: 'free', requestId: randomUUID(),
    expectedVersion: blockedPreview.sessionVersion, previewHash: blockedPreview.payloadHash }), error => error.code === 'TOOL_DISABLED');
  assert.equal(engine.view(session).alice.calendar[0].time, '10:00–10:45');
  assert(engine.view(session).initialConditions.agents.Alice.skills.includes('send_scoped_snapshot'));
  await assert.rejects(engine.create({ initialConditions: resolveConditions({ presetId: 'minimal' }) }),
    error => error.status === 409 || error.status === 422);
});

test('native receipt persistence retries the confirmed operation and preserves narrowed approval and round isolation', async t => {
  const knowledge = knowledgeFixture();
  const { engine } = await application(t, knowledge);
  const { state: created } = await engine.create();
  const session = engine.get(created.session.id);
  knowledge.failReceipts = 1;
  const { state: paused } = await choose(engine, session, 'initial', 'free');
  assert.equal(paused.session.paused, true);
  assert.equal(paused.session.stage, 'paused', 'A recovered storage checkpoint must not advance the business plan automatically.');
  assert.equal(knowledge.receipts.size, 1, 'The checkpoint may persist the already-confirmed receipt while the original plan stays paused.');
  const operationId = session.pendingDelivery?.operationId;
  assert(operationId, 'The same operation remains available for explicit reconciliation.');
  const { state: resumed } = await engine.intervene(session, { action: 'retry' });
  assert.equal(resumed.receipts.aliceToBob.length, 1);
  assert.equal(resumed.receipts.aliceToBob[0].operationId, operationId);
  assert.equal(knowledge.receipts.size, 1);
  assert.deepEqual(resumed.receipts.aliceToBob[0].fields, ['day', 'time', 'status']);
  assert(resumed.receipts.aliceToBob[0].rows.every(row => !Object.hasOwn(row, 'title') && !Object.hasOwn(row, 'note')));

  await choose(engine, session, 'additional', 'narrow');
  const approval = engine.approvals(session.id).find(item => item.status === 'pending');
  assert(approval);
  assert.equal(knowledge.receipts.size, 3, 'A pending brief is absent from Alice’s received KG.');
  const { state: done } = await engine.decide(approval.id, { decision: 'allow_once', fields: ['topic'],
    expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assert.equal(done.task.outcome, 'arranged');
  const snapshots = await knowledge.snapshots({ sessionId: session.id, epoch: session.epoch });
  assert.deepEqual(snapshots.Bob.receipts, done.receipts.aliceToBob);
  assert.deepEqual(snapshots.Alice.receipts, done.receipts.bobToAlice);
  assert.deepEqual(snapshots.Alice.receipts.at(-1).values, { topic: approval.values.topic });
  assert.equal(JSON.stringify(snapshots.Alice.receipts).includes(approval.values.agenda), false);
  assert.deepEqual(snapshots.Alice.result.task, done.task);
  assert.deepEqual(snapshots.Alice.result.messages, done.messages);
  const owner = engine.view(session, { perspective: 'owner' });
  assert.equal(owner.agentStates.Bob, null);
  assert.equal(owner.initialConditions.agents.Bob, undefined);

  const { state: next } = await engine.create();
  assert.deepEqual(next.receipts, { aliceToBob: [], bobToAlice: [] });
  const newSnapshots = await knowledge.snapshots({ sessionId: next.session.id, epoch: next.session.epoch });
  assert.deepEqual(newSnapshots.Alice.receipts, []);
  assert.deepEqual(newSnapshots.Bob.receipts, []);
  assert.equal(knowledge.receipts.size, 4, 'Earlier confirmed records remain durable in their own round.');
});

test('native KG unavailability prevents creating a round from an unrelated local fixture', async t => {
  const knowledge = knowledgeFixture();
  const { engine } = await application(t, knowledge);
  knowledge.failDefaults = true;
  await assert.rejects(engine.create(), error => error.code === 'KG_UNAVAILABLE');
  assert.equal(engine.sessions.size, 0);
});

test('native graph properties preserve useful values while credentials and unsafe keys fail before a round exists', async t => {
  const knowledge = knowledgeFixture();
  const { engine } = await application(t, knowledge);
  for (const properties of [
    { apiKey: 'synthetic-key-must-stay-out-of-conditions' },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { description: 'Bearer synthetic-private-credential-12345' },
  ]) {
    knowledge.conditions.agents.Alice.kg.nodes[0].properties = properties;
    await assert.rejects(engine.create(), error => error.code === 'INVALID_CONDITIONS');
    assert.equal(engine.sessions.size, 0);
    assert.equal(knowledge.rounds.size, 0);
  }
});

test('native management links stay operator-only and local fixture writes cannot replace the native source', async t => {
  const knowledge = knowledgeFixture();
  const nativeInterfaces = Object.fromEntries(roles.map(role => [role, {
    kgUrl: 'http://127.0.0.1:' + (role === 'Alice' ? 8765 : 8766) + '/#token=synthetic-native-' + role.toLowerCase() + '-credential',
    hermesUrl: 'http://127.0.0.1:' + (role === 'Alice' ? 9119 : 9121),
  }]));
  const app = await createDemoServer({ knowledge, nativeInterfaces, persist: false, host: '127.0.0.1', port: 0,
    adminPin: 'native-management-fixture-pin' });
  await app.listen();
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const publicMeta = await (await fetch(base + '/api/meta')).json();
  assert.deepEqual(publicMeta.knowledge, { provider: 'kg-plugin', persistent: true });
  assert.equal(JSON.stringify(publicMeta).includes('synthetic-native-'), false);
  assert.equal((await fetch(base + '/api/admin/native')).status, 401);
  const login = await (await fetch(base + '/api/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'native-management-fixture-pin' }) })).json();
  const headers = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const links = await (await fetch(base + '/api/admin/native', { headers })).json();
  assert.equal(links.enabled, true);
  assert.deepEqual(links.agents, nativeInterfaces);
  for (const route of ['/api/admin/conditions/default', '/api/admin/config/apply', '/api/admin/profiles']) {
    const response = await fetch(base + route, { method: route.endsWith('/default') ? 'PUT' : 'POST', headers, body: '{}' });
    assert.equal(response.status, 409, route);
  }
});
