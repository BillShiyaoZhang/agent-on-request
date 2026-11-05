import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthorizationLedger, canonicalIntent, hashIntent } from '../src/authorization-ledger.mjs';

const intent = overrides => ({ taskId: 'discussion-1', projectId: 'conference-2026', action: 'peer.send', resourceId: 'alice:research-summary', resourceVersion: 'v1',
  resourceClass: 'private', recipient: 'Bob', purpose: 'academic-discussion', fields: ['method', 'results'], values: { method: 'A reviewed matching procedure.', results: 'Unpublished synthetic scores.' }, ...overrides });
const publicIntent = overrides => intent({ resourceId: 'alice:public-profile', resourceClass: 'public', fields: ['introduction'], values: { introduction: 'A fictional semantic technology researcher.' }, ...overrides });
const policy = overrides => ({ effect: 'allow', actions: ['peer.send'], resourceClass: 'public', recipients: ['Bob'], purposes: ['academic-discussion'], projectId: 'conference-2026', ...overrides });
function ledger(t, options = {}) { const value = new AuthorizationLedger({ owner: 'Alice', ...options }); t.after(() => value.close()); return value; }
function approve(value, action = intent(), options = {}) {
  const request = value.request(action);
  return value.decide(request.id, { decision: 'allow', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash, ...options });
}

test('standing rules persist across tasks, while exact grants and disclosure scopes do not expand', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'alice.sqlite');
  let value = new AuthorizationLedger({ filename, owner: 'Alice' });
  const rule = value.policy(policy());
  const decision = approve(value, intent(), { fields: ['method'] });
  const approved = decision.request.approvedIntent;
  assert.deepEqual(approved.values, { method: 'A reviewed matching procedure.' });
  assert.equal(value.check(intent()).status, 'needs_approval');
  assert.equal(value.check(approved).status, 'allowed');
  assert.equal(value.check({ ...approved, taskId: 'discussion-2' }).status, 'needs_approval');
  assert.equal(value.check({ ...approved, resourceVersion: 'v2' }).status, 'needs_approval');
  value.close();
  value = new AuthorizationLedger({ filename, owner: 'Alice' });
  try {
    assert.equal(value.check(publicIntent({ taskId: 'discussion-2' })).status, 'allowed');
    assert.equal(value.check(publicIntent({ projectId: 'another-project' })).status, 'needs_approval');
    assert.equal(value.check(publicIntent({ recipient: 'Carol' })).status, 'needs_approval');
    assert.equal(value.check(approved).basisId, decision.grant.id);
    assert.equal(value.list().policies[0].id, rule.id);
    assert.equal(value.list().decisions[0].source, 'authenticated_owner');
  } finally { value.close(); }
  assert.throws(() => new AuthorizationLedger({ filename, owner: 'Bob' }), { code: 'AUTHORIZATION_OWNER' });
});

test('owner decisions bind the displayed content, revision and authenticated owner', t => {
  const value = ledger(t), request = value.request(intent());
  assert.throws(() => value.decide(request.id, { decision: 'allow', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash }, 'Bob'), { code: 'AUTHORIZATION_OWNER' });
  assert.throws(() => value.decide(request.id, { decision: 'allow', expectedRevision: request.revision + 1, expectedPayloadHash: request.payloadHash }), { code: 'AUTHORIZATION_STALE' });
  assert.throws(() => value.decide(request.id, { decision: 'allow', expectedRevision: request.revision, expectedPayloadHash: 'changed' }), { code: 'AUTHORIZATION_STALE' });
  assert.throws(() => value.decide(request.id, { decision: 'allow', fields: ['secret'], expectedRevision: request.revision, expectedPayloadHash: request.payloadHash }), { code: 'AUTHORIZATION_WIDENING' });
  const result = value.decide(request.id, { decision: 'allow', fields: ['method'], expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  assert.equal(result.grant.payloadHash, hashIntent(result.grant.intent));
  assert.equal(value.check({ ...result.grant.intent, values: { method: 'Changed after approval.' } }).status, 'needs_approval');
  assert.throws(() => value.decide(request.id, { decision: 'deny', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash }), { code: 'AUTHORIZATION_STALE' });
  assert.throws(() => value.policy(policy(), 'Bob'), { code: 'AUTHORIZATION_OWNER' });
  assert.throws(() => canonicalIntent({ ...intent(), owner: 'Alice' }), { code: 'AUTHORIZATION_INPUT' });
});

test('denials are remembered without duplicate prompts and cannot be bypassed by a broad standing allow', t => {
  const value = ledger(t), action = publicIntent(), request = value.request(action);
  value.decide(request.id, { decision: 'deny', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  value.policy(policy());
  assert.equal(value.check(action).status, 'denied');
  assert.equal(value.request(action).id, request.id);
  assert.equal(value.pendingRequests().length, 0);
  assert.equal(value.list().decisions.length, 1);
  assert.equal(value.check({ ...action, taskId: 'new-task' }).status, 'allowed');
  const prohibition = value.policy(policy({ effect: 'deny', resources: [action.resourceId], resourceClass: undefined }));
  assert.equal(value.check({ ...action, taskId: 'new-task' }).basisId, prohibition.id);
  assert.equal(value.check({ ...action, taskId: 'new-task' }).status, 'denied');
});

test('a single-use grant is reserved atomically across two database connections and dispatched only once', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-auth-quota-'));
  const filename = path.join(directory, 'alice.sqlite');
  const first = ledger(t, { filename }), second = ledger(t, { filename });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const action = approve(first).grant.intent;
  const op = first.prepare('op-1', action);
  assert.equal(op.status, 'prepared');
  assert.throws(() => second.prepare('op-2', action), { code: 'AUTHORIZATION_REQUIRED' });
  assert.deepEqual(second.prepare('op-1', action), op);
  assert.throws(() => second.prepare('op-1', { ...action, purpose: 'another-purpose' }), { code: 'AUTHORIZATION_OPERATION_CONFLICT' });
  assert.equal(second.dispatch('op-1').status, 'dispatching');
  assert.equal(first.dispatch('op-1').status, 'dispatching');
  const receipt = { id: 'receipt-1', operationId: 'op-1', status: 'received' };
  first.complete('op-1', { receipt });
  second.complete('op-1', { receipt });
  assert.equal(first.list().grants[0].uses, 1);
  assert.equal(first.list().grants[0].reserved, 0);
  assert.equal(first.list().grants[0].remaining, 0);
  assert.throws(() => second.complete('op-1', { receipt: { operationId: 'another-operation' } }), { code: 'AUTHORIZATION_RECEIPT' });
  assert.throws(() => second.complete('op-1', { receipt: { ...receipt, id: 'different' } }), { code: 'AUTHORIZATION_RECEIPT_CONFLICT' });
});

test('revocation and expiry after preparation block dispatch and are retained in history', t => {
  let clock = 1000;
  const value = ledger(t, { clock: () => clock });
  const approval = approve(value, intent(), { expiresAt: 5000 });
  value.prepare('revoked-op', approval.grant.intent);
  value.revoke(approval.grant.id, { expectedRevision: 1 });
  assert.throws(() => value.dispatch('revoked-op'), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(value.getOperation('revoked-op').status, 'blocked');
  assert.equal(value.check(approval.grant.intent).status, 'denied');
  const another = intent({ taskId: 'new-task' });
  approve(value, another, { expiresAt: 5000 });
  value.prepare('expired-op', another);
  clock = 5000;
  assert.throws(() => value.dispatch('expired-op'), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(value.check(another).reason, 'grant_expired');
  assert.ok(value.list({ includeInactive: true }).grants.some(item => item.status === 'expired'));
});

test('uncertain operations keep their reservation and survive restart for receipt reconciliation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-auth-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'alice.sqlite');
  let value = new AuthorizationLedger({ filename, owner: 'Alice' });
  const action = approve(value).grant.intent;
  value.prepare('recovery-op', action); value.dispatch('recovery-op');
  value.complete('recovery-op', { status: 'uncertain' }); value.close();
  value = new AuthorizationLedger({ filename, owner: 'Alice' });
  try {
    assert.equal(value.getOperation('recovery-op').status, 'uncertain');
    assert.equal(value.list().grants[0].reserved, 1);
    assert.throws(() => value.prepare('duplicate-op', action), { code: 'AUTHORIZATION_REQUIRED' });
    const receipt = { operationId: 'recovery-op', status: 'confirmed' };
    value.complete('recovery-op', { receipt });
    assert.equal(value.getOperation('recovery-op').status, 'succeeded');
    assert.equal(value.list().grants[0].uses, 1);
  } finally { value.close(); }
});

test('KG projection outbox is durable, acknowledged idempotently, and never feeds permission checks', t => {
  const value = ledger(t);
  value.policy(policy()); approve(value);
  const records = value.pendingOutbox();
  assert.ok(records.some(item => item.topic === 'policy'));
  assert.ok(records.some(item => item.topic === 'decision'));
  assert.ok(records.some(item => item.topic === 'grant'));
  const forged = records.find(item => item.topic === 'grant');
  forged.record.intent.recipient = 'Carol'; forged.record.remaining = 500;
  assert.equal(value.check(intent({ recipient: 'Carol' })).status, 'needs_approval');
  value.acknowledgeOutbox(records[0].id); value.acknowledgeOutbox(records[0].id);
  assert.equal(value.pendingOutbox().length, records.length - 1);
  assert.equal(value.list({ taskId: 'unrelated-task' }).grants.length, 0);
});

test('standing policy quotas are retained across revision and revocation wins over other allows', t => {
  const value = ledger(t), rule = value.policy(policy({ maxUses: 1 })), action = publicIntent();
  value.prepare('policy-op', action); value.dispatch('policy-op'); value.complete('policy-op', { receipt: { operationId: 'policy-op' } });
  assert.equal(value.check(action).status, 'needs_approval');
  value.policy(policy({ id: rule.id, expectedRevision: 1, maxUses: 1 }));
  assert.equal(value.check(action).status, 'needs_approval');
  value.revoke(rule.id);
  value.policy(policy());
  assert.equal(value.check(action).status, 'denied');
});

test('field prohibitions apply to mixed payloads, and expired exact approvals can be renewed explicitly', t => {
  let clock = 1000;
  const value = ledger(t, { clock: () => clock });
  value.policy(policy({ resourceClass: 'private' }));
  value.policy(policy({ effect: 'deny', resourceClass: 'private', fields: ['results'] }));
  assert.equal(value.check(intent()).status, 'denied');
  assert.equal(value.check(intent({ fields: ['method'], values: { method: 'A method.' } })).status, 'allowed');
  const action = intent({ taskId: 'expiry-task', recipient: 'Carol' });
  const old = approve(value, action, { expiresAt: 2000 });
  clock = 2000;
  const renewed = value.request(action);
  assert.equal(renewed.status, 'pending');
  assert.equal(renewed.id, old.request.id);
  assert.equal(renewed.revision, old.request.revision + 1);
  value.decide(renewed.id, { decision: 'allow', expectedRevision: renewed.revision, expectedPayloadHash: renewed.payloadHash, expiresAt: 3000 });
  assert.equal(value.check(action).status, 'allowed');
  assert.equal(value.list().decisions.length, 2);
});
