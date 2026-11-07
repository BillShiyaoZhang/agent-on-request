import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEngine } from '../src/research-engine.mjs';
import { researchProfile } from '../src/research-profiles.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('an unavailable KG projection cannot hold standing authorization or actual collaboration hostage', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const knowledge = { initialize: async () => {}, profile: async role => researchProfile(role), project: async () => gate };
  const engine = await new ResearchEngine({ persist: false, knowledge }).init();
  t.after(async () => { release(); await engine.close(); });
  let timer;
  const created = await Promise.race([engine.create(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('KG projection blocked local authorization')), 2000); })]);
  clearTimeout(timer);
  const state = await engine.start(created.workspaceId, { type: 'schedule' });
  assert.equal(state.tasks.at(-1).result.outcome, 'common_time_found');
  const w = engine.get(created.workspaceId);
  assert(engine.ledger(w, 'Alice').pendingOutbox().length > 0, 'undelivered projections remain retryable');
  assert.equal(state.messages.length, 2, 'actual signed delivery works while indexing is unavailable');
  release();
  await engine.projectionRuns.get(w.id);
  engine.projectOutbox(w); await engine.projectionRuns.get(w.id);
  assert.equal(engine.ledger(w, 'Alice').pendingOutbox().length, 0);
});

test('peer schemas remain unknown until actual delivery and only the disclosed working subset becomes visible', async t => {
  const engine = await new ResearchEngine({ persist: false, nativeClient: { run: async () => ({ status: 'completed' }) } }).init(); t.after(() => engine.close());
  const created = await engine.create();
  assert.equal(created.state.peer.ontology, null);
  assert.deepEqual(created.state.peer.skills, []);
  assert(created.state.profile.ontology.modules.length > 0);
  const state = await engine.start(created.workspaceId, { type: 'schedule', mode: 'native' });
  await Promise.allSettled([...engine.running]);
  const w = engine.get(created.workspaceId), taskId = state.tasks.at(-1).id;
  assert.equal(engine.view(w, 'Alice').peer.ontology, null);
  const before = await engine.tool(w.id, taskId, 'Alice', 'peer_describe');
  assert.deepEqual(before, { role: 'Bob', known: false, ontology: null, skills: [], sources: [] });
  await engine.tool(w.id, taskId, 'Alice', 'peer_send', { resourceId: 'working-ontology' });
  assert.equal(engine.view(w, 'Alice').peer.ontology, null, 'Own disclosure cannot manufacture reception of the peer definition.');
  const bobKnows = await engine.tool(w.id, taskId, 'Bob', 'peer_describe');
  assert.equal(bobKnows.known, true);
  assert.ok(bobKnows.sources.every(id => w.messages.some(message => message.id === id && message.to === 'Bob')));
  await engine.tool(w.id, taskId, 'Bob', 'peer_send', { resourceId: 'working-ontology' });
  const after = engine.view(w, 'Alice');
  assert(after.peer.ontology.modules.length > 0);
  assert(!after.peer.ontology.modules.flatMap(m => m.concepts).some(c => c.id === 'bob:Finding'));
  assert.deepEqual(after.peer.skills, [], 'Definitions do not implicitly disclose executable skills.');
});

test('a confirmed standing rule can remember summary-only sharing without granting the other fields', async t => {
  const engine = await new ResearchEngine({ persist: false, nativeClient: { run: async () => ({ status: 'completed' }) } }).init(); t.after(() => engine.close());
  const created = await engine.create(); const w = engine.get(created.workspaceId);
  await engine.start(w.id, { type: 'research_work', mode: 'native', goal: '以后仅允许向 Bob 分享研究简报的 summary，其他字段继续询问。' });
  const task = w.tasks.at(-1);
  const candidate = await engine.tool(w.id, task.id, 'Alice', 'authorization_propose_policy', { effect: 'allow', actions: ['peer.send'],
    resources: ['alice:research-brief'], fields: ['summary'], recipients: ['Bob'], purposes: ['academic_coordination'] });
  const summary = engine.intent(w, task, 'Alice', { resourceId: 'alice:research-brief', fields: ['summary'] });
  assert.equal(engine.ledger(w, 'Alice').check(summary).status, 'needs_approval');
  await engine.decidePolicy(w.id, 'Alice', candidate.id, { decision: 'allow', expectedHash: candidate.hash });
  assert.equal(engine.ledger(w, 'Alice').check({ ...summary, taskId: 'a-later-task' }).status, 'allowed');
  const method = engine.intent(w, task, 'Alice', { resourceId: 'alice:research-brief', fields: ['method'] });
  assert.equal(engine.ledger(w, 'Alice').check(method).status, 'needs_approval');
});

test('invalid reservation form shapes are rejected before a human is asked to authorize them', async t => {
  const engine = await new ResearchEngine({ persist: false }).init(); t.after(() => engine.close());
  const created = await engine.create(); await engine.start(created.workspaceId, { type: 'prepare_discussion' });
  const w = engine.get(created.workspaceId), task = w.tasks.at(-1);
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'reservation', title: 'Malformed form', sourceRefs: [], fields: { meeting: 'Thursday after the report' } }),
    error => error.code === 'RESERVATION_FIELDS');
  assert.equal(engine.ledger(w, 'Alice').pendingRequests().filter(r => r.intent.action === 'reservation.submit').length, 0);
});

test('the service stops a native run at an owner checkpoint even when the model never ends voluntarily', async t => {
  let engine;
  const token = 'a-native-owner-checkpoint-service-token';
  const nativeClient = { run: async ({ signal }) => {
    const assignment = engine.agentContext(token);
    await engine.agentTool(token, { assignmentId: assignment.assignmentId, name: 'authorization_request',
      arguments: { action: 'peer.send', resourceId: 'alice:research-brief', fields: ['summary'] } });
    await new Promise((resolve, reject) => {
      const cancelled = () => reject(Object.assign(new Error('native cancellation confirmed'), { code: 'MODEL_CANCELLED' }));
      if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
    });
  } };
  engine = await new ResearchEngine({ persist: false, nativeClient, agentTokens: { Alice: token } }).init(); t.after(() => engine.close());
  const created = await engine.create(); const w = engine.get(created.workspaceId);
  await engine.start(w.id, { type: 'research_work', mode: 'native', goal: '分享这段摘要之前请问我。' });
  const deadline = Date.now() + 2000;
  while (engine.running.size > 0 && Date.now() < deadline) await delay(5);
  assert.equal(engine.running.size, 0);
  assert.equal(w.tasks.at(-1).status, 'needs_owner');
  assert.equal(w.tasks.at(-1).error, null);
  assert.equal(engine.ledger(w, 'Alice').pendingRequests().length, 1);
  assert.equal(w.messages.length, 0);
  assert(w.events.some(e => e.kind === 'native_run_checkpoint' && e.status === 'owner_decision_required'));
});
