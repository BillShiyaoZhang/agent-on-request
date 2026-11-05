import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
  && !base.username && !base.password, 'The smoke test only sends requests to the local demo.');
const decision = process.env.SMOKE_APPROVAL || 'allow_once';
assert(['allow_once', 'deny'].includes(decision), 'SMOKE_APPROVAL must be allow_once or deny.');

async function api(route, { body, token, expected = 200 } = {}) {
  const response = await fetch(new URL(route, base), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${route}: ${result.error?.code || response.status} ${result.error?.message || ''}`);
  return result;
}

const meta = await api('/api/meta');
assert.equal(meta.openControls, true, 'This smoke script expects the local open-controls demo.');
assert.equal(meta.live?.harness, 'hermes');
assert.equal(meta.live?.available, true);
const runtime = await api('/api/admin/runtime');
assert.equal(runtime.alice?.transport, 'agent-comm-direct');
assert.equal(runtime.bob?.transport, 'agent-comm-direct');
assert.equal(runtime.peerTransport?.online, true);
const { Alice, Bob } = runtime.peerTransport.addresses;
assert.match(Alice, /\/tcp\/\d+$/);
assert.match(Bob, /\/tcp\/\d+$/);
assert.notEqual(Alice, Bob);

const round = await api('/api/sessions', { expected: 201, body: {
  mode: 'live', alignmentReview: true, researchConsent: false, task: { type: 'schedule', durationMinutes: 30 },
} });
const token = round.token;
const id = round.state.session.id;
const sessionRoute = `/api/sessions/${id}`;
let state = round.state;

async function action(action, fields = {}) {
  ({ state } = await api(`${sessionRoute}/actions`, { token, body: {
    action, requestId: randomUUID(), expectedVersion: state.session.version, ...fields,
  } }));
}

function assertStage(stage) {
  assert.equal(state.session.stage, stage, `Unexpected session stage: ${state.waiting?.reason || state.waiting?.code || state.session.stage}`);
}

async function choose(stage, choice) {
  const count = state.receipts.aliceToBob.length;
  const preview = await api(`${sessionRoute}/preview`, { token, body: { stage, choice } });
  assert.equal((await api(sessionRoute, { token })).receipts.aliceToBob.length, count, 'Preview must not send data.');
  await action(stage === 'initial' ? 'share_initial' : 'respond_additional', { choice, previewHash: preview.payloadHash });
  assert.equal(state.receipts.aliceToBob.length, count + 1);
  const receipt = state.receipts.aliceToBob.at(-1);
  for (const key of ['payloadHash', 'fields', 'rows', 'window']) assert.deepEqual(receipt[key], preview[key]);
}

try {
  assertStage('alignment');
  await action('alignment_decision', { decision: 'accept', expectedAlignmentVersion: state.ontology.revision });
  assertStage('initial');
  assert.equal(state.ontology.status, 'accepted');
  assert.equal(state.ontology.proposal.source, 'model');
  assert(state.ontology.protocol.some(event => event.from === 'Alice' && event.verified));
  assert(state.ontology.protocol.some(event => event.from === 'Bob' && event.verified));

  await choose('initial', 'free');
  assertStage('additional');
  await choose('additional', 'narrow');
  assertStage('waiting_admin');
  const approval = (await api(`/api/admin/sessions/${id}/approvals`)).approvals.find(item => item.status === 'pending');
  assert.equal(approval?.resource, 'meeting_brief');
  assert(approval.fields.includes('topic') && approval.fields.includes('agenda'));
  const before = state.receipts.bobToAlice.length;
  ({ state } = await api(`/api/admin/approvals/${approval.id}/decision`, { body: {
    decision, expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash,
    ...(decision === 'allow_once' ? { fields: ['topic'] } : {}),
  } }));
  assertStage('complete');
  assert.equal(state.task.outcome, 'arranged');
  assert.deepEqual(state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
  assert.equal(state.receipts.bobToAlice.length, before + (decision === 'allow_once' ? 1 : 0));
  if (decision === 'allow_once') {
    const receipt = state.receipts.bobToAlice.at(-1);
    assert.deepEqual(receipt.fields, ['topic']);
    assert.deepEqual(receipt.values, { topic: approval.values.topic });
  }
  const receipts = state.receipts;
  await action('stop_sharing');
  assert.equal(state.alice.stopped, true);
  assert.deepEqual(state.receipts, receipts);
  console.log(`Hermes Live smoke passed (${decision}): model alignment, exact direct receipts, owner approval, and stop sharing.`);
} finally {
  if (!state.session.ended) {
    state = await api(sessionRoute, { token });
    await action('end');
    assert.equal(state.session.ended, true);
  }
}
