import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationHistory, describeActivity } from '../public/research-conversation.js';
import { ResearchEngine } from '../src/research-engine.mjs';

const intent = overrides => ({ taskId: 'task-current', action: 'reservation.submit', recipient: 'conference-reservations',
  resourceId: 'booking-draft', resourceVersion: '1', fields: ['agenda', 'venueId'],
  values: { agenda: 'Discuss semantic mapping review', venueId: 'Seminar Room A' }, purpose: 'academic-collaboration', ...overrides });
const request = overrides => ({ id: 'request-current', owner: 'workspace:Alice', status: 'pending', revision: 1,
  intent: intent(), payloadHash: 'original-payload-hash', createdAt: 1794045600000, ...overrides });
const entry = overrides => ({ id: 'event-request', sequence: 1, taskId: 'task-current', role: 'Alice', kind: 'approval',
  direction: 'outgoing', from: 'Alice', to: 'owner:Alice', name: 'authorization_request', status: 'pending',
  requestId: 'request-current', revision: 1, at: '2026-11-07T10:00:00.000Z', details: request(), ...overrides });
const decisionEvent = overrides => entry({ id: 'event-decision', sequence: 2, direction: 'incoming', from: 'owner:Alice',
  to: 'Alice', name: 'owner_decision', status: 'denied', revision: undefined,
  at: '2026-11-07T10:01:00.000Z', details: { requestId: 'request-current', decision: 'deny', approvedIntent: null }, ...overrides });
const ledgerDecision = overrides => ({ id: 'decision-current', owner: 'workspace:Alice', requestId: 'request-current',
  requestRevision: 1, decision: 'deny', fields: ['agenda', 'venueId'], originalPayloadHash: 'original-payload-hash',
  approvedPayloadHash: null, at: 1794045660000, source: 'authenticated_owner', ...overrides });
const copy = result => `${result.title}\n${result.body}`;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function engineFixture(t) {
  const engine = new ResearchEngine({ persist: false });
  await engine.init();
  t.after(() => engine.close());
  const created = await engine.create();
  return { engine, workspaceId: created.workspaceId };
}
async function decide(engine, workspaceId, pending, decision, fields) {
  return engine.decide(workspaceId, 'Alice', pending.id, { decision, expectedRevision: pending.revision,
    expectedPayloadHash: pending.payloadHash, ...(fields ? { fields } : {}) });
}

test('real declined booking updates its original approval message and retains the reviewed snapshot', async t => {
  const { engine, workspaceId } = await engineFixture(t);
  let state = await engine.start(workspaceId, { type: 'prepare_discussion' });
  state = await decide(engine, workspaceId, state.authorizations.requests.find(item => item.status === 'pending'), 'deny');
  const booking = state.authorizations.requests.find(item => item.status === 'pending' && item.intent.action === 'reservation.submit');
  assert.ok(booking);
  const original = state.activity.find(item => item.name === 'authorization_request' && item.requestId === booking.id);
  const before = structuredClone(original);
  const waiting = authorizationHistory(original, { owner: 'Alice', entries: state.activity, authorizations: state.authorizations });
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.canReview, true);
  state = await decide(engine, workspaceId, booking, 'deny');
  const history = authorizationHistory(original, { owner: 'Alice', entries: state.activity, authorizations: state.authorizations });
  assert.equal(history.status, 'denied');
  assert.equal(history.isRequest, true);
  assert.equal(history.canReview, true, 'A decided request remains inspectable');
  assert.equal(history.revision, booking.revision);
  assert.deepEqual(history.request.intent, booking.intent);
  assert.equal(history.request.payloadHash, booking.payloadHash);
  assert.equal(history.decision.decision, 'deny');
  assert.equal(history.decision.requestRevision, booking.revision);
  assert.equal(state.authorizations.requests.find(item => item.id === booking.id).revision, booking.revision + 1);
  assert.equal(state.tasks.at(-1).result.outcome, 'prepared_not_submitted');
  for (const lang of ['zh', 'en']) {
    const summary = copy(describeActivity(original, { lang, authorization: history }));
    assert.match(summary, lang === 'zh' ? /已拒绝|拒绝了/ : /declined|denied/i);
    assert.doesNotMatch(summary, /正在等待|等待主人决定|is waiting for|waiting for.*decision/i);
    assert.doesNotMatch(summary, /场地已确认|booking confirmed|venue confirmed/i);
  }
  assert.deepEqual(original, before, 'Presentation state must not rewrite the original activity record');
});

test('narrowed permission history retains the requested fields separately from the exact approved scope', async t => {
  const { engine, workspaceId } = await engineFixture(t);
  let state = await engine.start(workspaceId, { type: 'prepare_discussion' });
  const pending = state.authorizations.requests.find(item => item.status === 'pending');
  const original = state.activity.find(item => item.name === 'authorization_request' && item.requestId === pending.id);
  assert.ok(pending.intent.fields.length > 1);
  state = await decide(engine, workspaceId, pending, 'allow', ['summary']);
  const history = authorizationHistory(original, { owner: 'Alice', entries: state.activity, authorizations: state.authorizations });
  assert.equal(history.status, 'approved');
  assert.deepEqual(history.request.intent.fields, pending.intent.fields);
  assert.deepEqual(history.request.intent.values, pending.intent.values);
  assert.deepEqual(history.decision.fields, ['summary']);
  assert.equal(history.decision.originalPayloadHash, pending.payloadHash);
  assert.notEqual(history.decision.approvedPayloadHash, pending.payloadHash);
  const summary = copy(describeActivity(original, { authorization: history }));
  assert.match(summary, /已批准|已授权/);
  assert.doesNotMatch(summary, /正在等待|等待主人决定|(?:已经|已)(?:发送|交付|分享)/);
});

test('different request revisions do not borrow a previous one-time decision', () => {
  const original = entry();
  const allowed = ledgerDecision({ decision: 'allow', approvedPayloadHash: 'original-payload-hash' });
  const granted = decisionEvent({ status: 'approved', details: { requestId: original.requestId, decision: 'allow', approvedIntent: intent() } });
  const renewed = entry({ id: 'event-renewed', sequence: 3, revision: 3, details: request({ revision: 3 }) });
  const entries = freeze([original, granted, renewed]);
  const authorizations = freeze({ requests: [request({ revision: 3 })], decisions: [allowed] });
  const oldHistory = authorizationHistory(original, { owner: 'Alice', entries, authorizations });
  const newHistory = authorizationHistory(renewed, { owner: 'Alice', entries, authorizations });
  assert.equal(oldHistory.status, 'approved');
  assert.equal(oldHistory.revision, 1);
  assert.equal(oldHistory.decision.requestRevision, 1);
  assert.equal(newHistory.status, 'pending');
  assert.equal(newHistory.revision, 3);
  assert.equal(newHistory.decision, null);
  assert.equal(newHistory.canReview, true);
});

test('request identifiers are scoped to the role and task when matching owner decision events', () => {
  const original = entry();
  const wrongTask = decisionEvent({ taskId: 'task-other' });
  const wrongRole = decisionEvent({ role: 'Bob', from: 'owner:Bob', to: 'Bob' });
  const history = authorizationHistory(original, { owner: 'Alice', entries: [original, wrongTask, wrongRole] });
  assert.equal(history.status, 'pending');
  assert.equal(history.decision, null);
  assert.equal(history.canReview, true);
  const denied = authorizationHistory(original, { owner: 'Alice', entries: [original, wrongTask, wrongRole, decisionEvent()] });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.decision.decision, 'deny');
});

test('a ledger request belonging to another task cannot supply a decision for this message', () => {
  const original = entry();
  const authorizations = { owner: 'workspace:Alice', requests: [request({ intent: intent({ taskId: 'task-other' }),
    revision: 2, status: 'denied', decisionId: 'decision-current' })], decisions: [ledgerDecision()] };
  const history = authorizationHistory(original, { owner: 'Alice', entries: [original], authorizations });
  assert.equal(history.status, 'pending');
  assert.equal(history.decision, null);
  assert.deepEqual(history.request.intent, original.details.intent);
});

test('redacted or other-owner history may show the public outcome but never recovers private review contents', () => {
  const original = entry();
  const authorizations = { requests: [request({ status: 'denied', revision: 2, decisionId: 'decision-current' })], decisions: [ledgerDecision()] };
  for (const [subject, owner] of [[{ ...original, redacted: true, details: undefined }, 'Alice'], [original, 'Bob']]) {
    const history = authorizationHistory(subject, { owner, entries: [original, decisionEvent()], authorizations });
    assert.equal(history.status, 'denied');
    assert.equal(history.request, null);
    assert.equal(history.decision, null);
    assert.equal(history.canReview, false);
    assert.doesNotMatch(JSON.stringify(history), /Seminar Room A|Discuss semantic mapping review|original-payload-hash/);
    assert.doesNotMatch(copy(describeActivity(subject, { authorization: history })), /正在等待|is waiting/i);
  }
});

test('policy proposal messages resolve their own confirmation history while preserving the proposed rule', () => {
  const policy = { effect: 'allow', actions: ['peer.send'], fields: ['summary'], recipients: ['Bob'] };
  const candidate = { id: 'policy-current', taskId: 'task-current', status: 'pending', policy, hash: 'policy-hash' };
  const original = entry({ requestId: candidate.id, revision: undefined, name: 'authorization_propose_policy', details: candidate });
  const deniedEvent = decisionEvent({ requestId: candidate.id, name: 'owner_policy_decision', details: { decision: 'deny', policyId: null, policy } });
  const current = { ...candidate, status: 'denied', decidedAt: deniedEvent.at };
  const history = authorizationHistory(original, { owner: 'Alice', entries: [original, deniedEvent], policyCandidates: [current] });
  assert.equal(history.status, 'denied');
  assert.equal(history.isRequest, true);
  assert.equal(history.canReview, true);
  assert.deepEqual(history.request.policy, policy);
  assert.equal(history.decision.decision, 'deny');
  assert.doesNotMatch(copy(describeActivity(original, { authorization: history })), /需要主人确认|等待主人/);
});

test('non-approval events and approval records without a request reference have no review history', () => {
  assert.equal(authorizationHistory({ ...entry(), kind: 'tool' }), null);
  assert.equal(authorizationHistory(entry({ requestId: undefined, details: {} })), null);
  assert.equal(authorizationHistory(), null);
});
