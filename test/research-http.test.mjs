import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const app = await createDemoServer({ port: 0, host: '127.0.0.1', adminPin: 'research-http-test-pin', persist: false, minimaxApiKey: '', ...options });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, token, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders,
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  }
  return { app, call };
}
const approvalInput = (request, decision = 'allow', fields) => ({ decision, expectedRevision: request.revision, expectedPayloadHash: request.payloadHash, ...(fields ? { fields } : {}) });

test('research HTTP separates owner authority, operator access, peer knowledge and exact approvals', async t => {
  const { app, call } = await fixture(t);
  const catalog = await call('/api/research/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.tasks, ['schedule', 'select_presentation', 'prepare_discussion']);
  assert.ok(catalog.data.profiles.Alice.ontology.modules.some(m => m.id === 'alice:semantics'));
  assert.ok(catalog.data.profiles.Bob.ontology.modules.some(m => m.id === 'bob:study'));
  const created = await call('/api/research/workspaces', null, {});
  assert.equal(created.status, 201);
  const id = created.data.workspaceId, alice = created.data.token, root = `/api/research/workspaces/${id}`;
  assert.equal((await call(root)).status, 401);
  const admin = (await call('/api/admin/login', null, { pin: 'research-http-test-pin' })).data.token;
  assert.equal((await call(root, admin)).status, 401);
  const claim = `/api/admin/research/workspaces/${id}/claim/Bob`;
  assert.equal((await call(claim, alice, {})).status, 401);
  const bob = (await call(claim, admin, {})).data.token;
  assert.ok(bob);
  assert.equal((await call(`${root}/tasks`, bob, { type: 'schedule' })).status, 403);
  assert.equal((await call(`${root}/tasks`, alice, { type: 'schedule' }, { Origin: 'https://outside.invalid' })).status, 403);
  const start = await call(`${root}/tasks`, alice, { type: 'prepare_discussion' });
  assert.equal(start.status, 201);
  const request = start.data.authorizations.requests.find(r => r.status === 'pending');
  assert.equal(request.intent.action, 'peer.send');
  const decisionURL = `${root}/decisions/${request.id}`;
  assert.equal((await call(decisionURL, admin, approvalInput(request))).status, 401);
  assert.equal((await call(decisionURL, bob, approvalInput(request))).status, 404);
  assert.equal((await call(decisionURL, alice, { ...approvalInput(request), expectedPayloadHash: 'changed' })).status, 409);
  const before = await call(root, bob);
  assert.equal(before.data.owner, 'Bob');
  assert.ok(!before.data.messages.some(m => m.resourceId === 'alice:research-brief'));
  assert.ok(!JSON.stringify(before.data).includes('0.82'));
  const approved = await call(decisionURL, alice, approvalInput(request, 'allow', ['summary']));
  assert.equal(approved.status, 200);
  const after = await call(root, bob);
  const received = after.data.messages.find(m => m.resourceId === 'alice:research-brief');
  assert.deepEqual(Object.keys(received.payload), ['summary']);
  assert.equal(received.receipt.status, 'received');
  assert.equal((await call(decisionURL, alice, approvalInput(request))).status, 409);
  const booking = approved.data.authorizations.requests.find(r => r.status === 'pending');
  assert.equal(booking.intent.action, 'reservation.submit');
  assert.equal((await call(`${root}/decisions/${booking.id}`, bob, approvalInput(booking))).status, 404);
  const denied = await call(`${root}/decisions/${booking.id}`, alice, approvalInput(booking, 'deny'));
  assert.equal(denied.status, 200);
  assert.equal(denied.data.tasks.at(-1).result.outcome, 'prepared_not_submitted');
  assert.equal(app.collaboration.get(id).reservations.length, 0);
  const aliceQuery = await call(`${root}/query`, alice, { ids: ['alice:claim'], hops: 2 });
  assert.ok(aliceQuery.data.nodes.some(n => n.id === 'alice:claim'));
  const bobQuery = await call(`${root}/query`, bob, { ids: ['alice:claim'], hops: 2 });
  assert.equal(bobQuery.data.nodes.length, 0);
  const other = await call('/api/research/workspaces', null, {});
  assert.equal((await call(`/api/research/workspaces/${other.data.workspaceId}`, alice)).status, 401);
});

test('native gateway derives role from its credential and cannot sign owner decisions or change assignments', async t => {
  const keys = { Alice: 'alice-agent-key-for-http-fixture-12345', Bob: 'bob-agent-key-for-http-fixture-1234567' };
  const { app, call } = await fixture(t, { researchAgentTokens: keys });
  const created = (await call('/api/research/workspaces', null, {})).data;
  const state = (await call(`/api/research/workspaces/${created.workspaceId}/tasks`, created.token, { type: 'prepare_discussion' })).data;
  const taskId = state.tasks.at(-1).id;
  const assignment = { assignmentId: 'fixture-assignment', workspaceId: created.workspaceId, taskId, role: 'Alice', toolBudget: 10 };
  app.collaboration.assignments.set('Alice', assignment);
  assert.equal((await call('/api/research/agent-context', created.token)).status, 401);
  assert.equal((await call('/api/research/agent-context', keys.Alice)).data.role, 'Alice');
  assert.equal((await call('/api/research/agent-context', keys.Bob)).status, 409);
  assert.equal((await call('/api/research/agent-tools', keys.Alice, { assignmentId: 'stale', name: 'knowledge_search', arguments: {} })).status, 409);
  const own = await call('/api/research/agent-tools', keys.Alice, { assignmentId: assignment.assignmentId, name: 'knowledge_search', role: 'Bob', arguments: { role: 'Bob', ids: ['alice:claim'] } });
  assert.equal(own.status, 200);
  assert.equal(own.data.owner, 'Alice');
  assert.ok(own.data.nodes.some(n => n.id === 'alice:claim'));
  const request = state.authorizations.requests.find(r => r.status === 'pending');
  assert.equal((await call(`/api/research/workspaces/${created.workspaceId}/decisions/${request.id}`, keys.Alice, approvalInput(request))).status, 401);
  assert.equal((await call('/api/research/agent-tools', keys.Alice, { assignmentId: assignment.assignmentId, name: 'authorization_decide', arguments: { decision: 'allow', requestId: request.id } })).status, 404);
  assert.equal(app.collaboration.ledger(app.collaboration.get(created.workspaceId), 'Alice').pendingRequests().length, 1);
});

test('private research goals, candidate rule confirmation and ending identities preserve HTTP owner boundaries', async t => {
  const invocations = [];
  const { app, call } = await fixture(t, { researchNative: { run: async value => { invocations.push(value); return { status: 'completed' }; } } });
  const created = (await call('/api/research/workspaces', null, {})).data;
  const id = created.workspaceId, alice = created.token, root = `/api/research/workspaces/${id}`;
  const admin = (await call('/api/admin/login', null, { pin: 'research-http-test-pin' })).data.token;
  const bob = (await call(`/api/admin/research/workspaces/${id}/claim/Bob`, admin, {})).data.token;
  const started = await call(`${root}/research-task`, bob, { goal: 'PRIVATE-BOB-OWNER-GOAL: 以后允许向 Alice 分享我指定的研究简报，先请我确认规则。' });
  assert.equal(started.status, 201);
  const taskId = started.data.tasks.at(-1).id;
  assert.equal(started.data.owner, 'Bob');
  assert.ok(!JSON.stringify((await call(root, alice)).data).includes('PRIVATE-BOB-OWNER-GOAL'));
  assert.equal((await call(`${root}/tasks/${taskId}/resume`, alice, {})).status, 403);
  const w = app.collaboration.get(id), ledger = app.collaboration.ledger(w, 'Bob');
  const candidate = await app.collaboration.tool(id, taskId, 'Bob', 'authorization_propose_policy', { effect: 'allow', actions: ['peer.send'], resources: ['bob:research-brief'], recipients: ['Alice'], purposes: ['academic_coordination'] });
  const beforePolicies = ledger.list().policies.length;
  const route = `${root}/policy-candidates/${candidate.id}/decision`;
  assert.equal((await call(route, admin, { decision: 'allow', expectedHash: candidate.hash })).status, 401);
  assert.equal((await call(route, alice, { decision: 'allow', expectedHash: candidate.hash })).status, 409);
  assert.equal((await call(route, bob, { decision: 'allow', expectedHash: 'changed' })).status, 409);
  assert.equal(ledger.list().policies.length, beforePolicies);
  assert.equal((await call(route, bob, { decision: 'allow', expectedHash: candidate.hash })).status, 200);
  assert.equal(ledger.list().policies.length, beforePolicies + 1);
  assert.equal((await call(route, bob, { decision: 'allow', expectedHash: candidate.hash })).status, 409);
  assert.ok(invocations.length > 0);
  assert.ok(invocations.every(value => value.role === 'Bob'));
  assert.equal((await call(`${root}/end`, bob, {})).status, 403);
  assert.equal((await call(`${root}/end`, alice, {})).status, 200);
  assert.equal((await call(`${root}/tasks`, alice, { type: 'schedule' })).status, 409);
  assert.equal((await call(`${root}/research-task`, bob, { goal: 'A new goal after end.' })).status, 409);
  assert.equal((await call(`${root}/tasks/${taskId}/resume`, bob, {})).status, 409);
  assert.equal((await call(root, bob)).status, 200);
});
