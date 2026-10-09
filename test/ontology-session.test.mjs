import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';
import { ALICE_CALENDAR } from '../src/scenario.mjs';
import { sanitizeTraceSnapshot } from '../src/agent-observability.mjs';
import { resolveOntologyDialogue, startOntologyDialogue } from '../src/ontology-dialogue.mjs';

async function fixture(t) {
  const app = await createDemoServer({ port: 0, persist: false, minimaxApiKey: '', environmentApiKey: '', adminPin: 'ontology-session-test-pin' });
  await app.listen(); t.after(() => app.close());
  return app;
}
async function decision(app, session, decision, extra = {}) {
  return app.engine.action(session, { action: 'alignment_decision', decision, requestId: randomUUID(),
    expectedVersion: session.version, expectedAlignmentVersion: session.ontology.revision, ...extra });
}
async function share(app, session, stage, choice) {
  const preview = await app.engine.preview(session, { stage, choice });
  const result = await app.engine.action(session, { action: stage === 'initial' ? 'share_initial' : 'respond_additional',
    choice, previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() });
  return { preview, state: result.state };
}

test('staged ontology review blocks data exchange; accepted mapping is independent from sharing permission', async t => {
  const app = await fixture(t);
  const created = await app.engine.create({ alignmentReview: true, researchConsent: true });
  const session = app.engine.get(created.state.session.id);
  assert.equal(session.stage, 'alignment');
  assert.equal(session.ontology.registry.mappings.length, 0);
  await assert.rejects(app.engine.preview(session, { stage: 'initial', choice: 'free' }), { code: 'STALE_STAGE' });
  await assert.rejects(decision(app, session, 'accept', { expectedAlignmentVersion: 999 }), { code: 'STALE_ALIGNMENT' });
  await decision(app, session, 'accept');
  assert.equal(session.stage, 'initial');
  assert.equal(session.ontology.status, 'accepted');
  assert.equal(session.ontology.interpretation.authorizesDisclosure, false);
  assert(session.ontology.protocol.length >= 5, 'actual signed worker protocol is available');
  assert.deepEqual(session.receipts, { aliceToBob: [], bobToAlice: [] });
  assert.equal(session.aliceUses, 0);
  await share(app, session, 'initial', 'free');
  assert.equal(session.ontology.registry.facts.length, 2);
  const fact = session.ontology.registry.facts[0];
  assert.deepEqual(Object.keys(fact.values).sort(), ['bookable', 'endMinute', 'startMinute', 'weekday']);
  assert.equal(fact.receiptId, session.receipts.aliceToBob[0].operationId);
  assert.equal(fact.mappingVersion, session.ontology.registry.mappingVersion);
  assert.equal(session.receipts.aliceToBob[0].mappingVersion, fact.mappingVersion);
  assert.equal(session.receipts.aliceToBob[0].ontologyTask, 'schedule');
  const run = app.research.list().runs[0];
  assert(run.trace.some(step => step.snapshot.ontology?.registry.facts.length === 2));
  const finalSnapshot = run.trace.at(-1).snapshot;
  assert.deepEqual(sanitizeTraceSnapshot(finalSnapshot), finalSnapshot, 'new state traces survive their strict reload whitelist');
  const corruptSnapshot = structuredClone(finalSnapshot);
  corruptSnapshot.ontology.registry.mappingVersion = '0'.repeat(64);
  assert.equal(sanitizeTraceSnapshot(corruptSnapshot), null, 'corrupt semantic evidence cannot break trace reload or be accepted');
});

test('ambiguous occupancy requires explicit owner clarification; rejection finishes without calendar disclosure', async t => {
  const app = await fixture(t);
  const created = await app.engine.create({ alignmentReview: true, ontologyScenario: 'ambiguous' });
  const session = app.engine.get(created.state.session.id);
  await assert.rejects(decision(app, session, 'accept'), { code: 'ONTOLOGY_CLARIFICATION_REQUIRED' });
  const revision = session.ontology.revision;
  await decision(app, session, 'clarify');
  assert.equal(session.ontology.status, 'needs_clarification');
  assert(session.ontology.revision > revision);
  await decision(app, session, 'accept', { calendarFreeMeansBookable: false });
  assert.equal(session.task.outcome, 'boundary_kept');
  assert.equal(session.task.reason, 'alignment_rejected');
  assert.equal(session.ontology.registry.mappings.length, 0);
  assert.equal(session.receipts.aliceToBob.length, 0);
});

test('narrow additional requests follow actual Friday conditions and preserve field minimization', async t => {
  const app = await fixture(t);
  const created = await app.engine.create({ initialConditions: { presetId: 'conference', custom: {
    Alice: { data: { calendar: [...ALICE_CALENDAR, { day: 'Fri', time: '13:00–14:00', status: 'Free', title: '', note: '' }] },
      authorization: { windows: ['Tue', 'Wed', 'Thu', 'Fri'] } },
    Bob: { data: { availableTimes: [{ day: 'Fri', time: '13:00–14:00' }], brief: {} }, authorization: { window: 'Mon–Sun' } }
  } } });
  const session = app.engine.get(created.state.session.id);
  await share(app, session, 'initial', 'free');
  assert.deepEqual(session.additionalRequest.days, ['Fri']);
  const result = await share(app, session, 'additional', 'narrow');
  assert(result.preview.rows.every(row => row.day === 'Fri'));
  assert.deepEqual(result.preview.fields, ['day', 'time', 'status']);
  const optional = session.approvals.find(item => item.status === 'pending' && item.resource === 'meeting_brief');
  if (optional) await app.engine.decide(optional.id, { decision: 'deny', expectedPolicyRevision: optional.policyRevision, expectedPayloadHash: optional.payloadHash });
  assert.equal(session.task.outcome, 'arranged', JSON.stringify({ stage: session.stage, waiting: session.waiting, approvals: session.approvals, policy: session.config.permissions }));
  assert.equal(session.task.meeting.day, 'Fri');
  assert.equal(session.task.reason, 'meeting_confirmed');
});

test('a clarified ambiguous calendar retains its scenario when the authorized brief task is aligned', async t => {
  const app = await fixture(t);
  const created = await app.engine.create({ alignmentReview: true, ontologyScenario: 'ambiguous' });
  const session = app.engine.get(created.state.session.id);
  await decision(app, session, 'accept', { calendarFreeMeansBookable: true });
  await share(app, session, 'initial', 'free');
  await share(app, session, 'additional', 'narrow');
  const optional = session.approvals.find(item => item.status === 'pending' && item.resource === 'meeting_brief');
  assert(optional);
  await app.engine.decide(optional.id, { decision: 'allow_once', fields: ['topic'], expectedPolicyRevision: optional.policyRevision, expectedPayloadHash: optional.payloadHash });
  assert.equal(session.task.outcome, 'arranged');
  assert.equal(session.briefOntology.scenario, 'ambiguous');
  assert.equal(session.briefOntology.status, 'accepted');
  assert.deepEqual(session.briefOntology.task.fields, ['topic']);
  assert.equal(session.receipts.bobToAlice.at(-1).mappingVersion, session.briefOntology.registry.mappingVersion);
  assert.equal(session.receipts.bobToAlice.at(-1).ontologyTask, 'brief');
  assert.deepEqual(Object.keys(session.receipts.bobToAlice.at(-1).values), ['topic']);
});

test('a refused optional brief alignment retains the confirmed meeting without sending raw brief data', async t => {
  const app = await fixture(t);
  const created = await app.engine.create();
  const session = app.engine.get(created.state.session.id);
  await share(app, session, 'initial', 'free');
  await share(app, session, 'additional', 'narrow');
  const optional = session.approvals.find(item => item.status === 'pending' && item.resource === 'meeting_brief');
  const negotiate = app.runtime.negotiateOntology.bind(app.runtime);
  app.runtime.negotiateOntology = async args => args.dialogue.task.type === 'brief'
    ? { dialogue: resolveOntologyDialogue(startOntologyDialogue({ scenario: args.dialogue.scenario, task: args.dialogue.task }), { decision: 'reject' }), protocol: [] } : negotiate(args);
  await app.engine.decide(optional.id, { decision: 'allow_once', expectedPolicyRevision: optional.policyRevision, expectedPayloadHash: optional.payloadHash });
  assert.equal(session.briefOntology.status, 'rejected');
  assert.equal(session.task.outcome, 'arranged');
  assert.equal(session.paused, false);
  assert.equal(session.pendingDelivery, null);
  assert(!session.receipts.bobToAlice.some(receipt => receipt.fields.includes('topic')));
});

test('owner HTTP responses omit Bob private values; observer access is explicit and authenticated', async t => {
  const app = await fixture(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, token, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const admin = (await call('/api/admin/login', null, { pin: 'ontology-session-test-pin' })).data.token;
  const created = await call('/api/sessions', null, { alignmentReview: true });
  assert.equal(created.status, 201);
  const id = created.data.state.session.id, token = created.data.token;
  const route = `/api/sessions/${id}`;
  assert.equal(created.data.state.perspective, 'owner');
  assert.equal(created.data.state.agentStates.Bob, null);
  assert.equal(created.data.state.initialConditions.agents.Bob, undefined);
  assert.equal((await call(`${route}?perspective=observer`, token)).status, 401);
  const observed = await call(`${route}?perspective=observer`, admin);
  assert.equal(observed.status, 200);
  assert(observed.data.agentStates.Bob.data.some(card => card.kind === 'brief'));
  const session = app.engine.get(id);
  const action = await call(`${route}/actions`, token, { action: 'alignment_decision', decision: 'accept',
    requestId: randomUUID(), expectedVersion: session.version, expectedAlignmentVersion: session.ontology.revision });
  assert.equal(action.status, 200);
  assert.equal(action.data.state.agentStates.Bob, null);
  assert.equal(action.data.state.perspective, 'owner');
});

test('task duration changes executable eligibility and ontology understanding remains optional', async t => {
  const app = await fixture(t);
  const created = await app.engine.create({ task: { type: 'schedule', durationMinutes: 60 }, researchConsent: true });
  const session = app.engine.get(created.state.session.id);
  await share(app, session, 'initial', 'free');
  await share(app, session, 'additional', 'narrow');
  assert.equal(session.task.reason, 'no_common_time', 'a 30-minute overlap cannot satisfy the registered 60-minute task');
  for (const [action, answer] of [['answer_alignment', 'mapping_not_permission'], ['answer_module', 'task_subset']]) {
    await app.engine.action(session, { action, answer, requestId: randomUUID(), expectedVersion: session.version });
  }
  const run = app.research.list().runs[0];
  assert.equal(run.events.filter(event => event.kind === 'prediction' && event.correct).length, 2);
  assert.deepEqual(run.events.filter(event => event.kind === 'prediction').map(event => event.questionId), ['ontology_alignment', 'task_module']);
});
