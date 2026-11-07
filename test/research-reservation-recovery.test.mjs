import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResearchEngine } from '../src/research-engine.mjs';

for (const hasReceipt of [true, false]) test(`reservation restart ${hasReceipt ? 'recalls the original receipt after revocation' : 'keeps an unknown operation blocked without a second booking'}`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-reservation-recovery-'));
  let engine;
  t.after(async () => { await engine?.close(); await rm(directory, { recursive: true, force: true }); });
  engine = await new ResearchEngine({ directory, persist: true }).init();
  const created = await engine.create();
  await engine.start(created.workspaceId, { type: 'prepare_discussion' });
  let w = engine.get(created.workspaceId);
  const taskId = w.tasks.at(-1).id;
  const draft = await engine.tool(w.id, taskId, 'Alice', 'artifact_prepare', {
    kind: 'reservation', title: 'Research discussion', sourceRefs: [w.conference.id],
    fields: { title: 'Research discussion', day: 'Thu', time: '15:00–15:30', attendees: '2', agenda: 'Discuss the public conference presentations.' },
  });
  const request = await engine.tool(w.id, taskId, 'Alice', 'authorization_request', {
    action: 'reservation.submit', resourceId: draft.id, venueId: 'room-a' });
  let ledger = engine.ledger(w, 'Alice');
  const approved = ledger.decide(request.id, { decision: 'allow', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  const operationId = engine.operationId(approved.grant.intent);
  let originalReceipt;
  if (hasReceipt) {
    const complete = ledger.complete.bind(ledger);
    ledger.complete = (id, result) => {
      if (result.status === 'succeeded') throw new Error('Interrupted after booking persisted but before ledger confirmation.');
      return complete(id, result);
    };
    await assert.rejects(engine.tool(w.id, taskId, 'Alice', 'reservation_submit', {
      resourceId: draft.id, venueId: 'room-a' }), /Interrupted after booking/);
    ledger.complete = complete;
    assert.equal(w.reservations.length, 1);
    originalReceipt = structuredClone(w.reservations[0].receipt);
  } else {
    ledger.prepare(operationId, approved.grant.intent);
    ledger.dispatch(operationId);
    ledger.complete(operationId, { status: 'uncertain' });
    await engine.save(w);
  }
  assert.equal(ledger.getOperation(operationId).status, 'uncertain');
  await engine.close(); engine = undefined;
  engine = await new ResearchEngine({ directory, persist: true }).init();
  w = engine.get(created.workspaceId); ledger = engine.ledger(w, 'Alice');
  assert.equal(ledger.getOperation(operationId).status, 'uncertain');
  assert.equal(ledger.list().grants.find(grant => grant.id === approved.grant.id).reserved, 1);
  ledger.revoke(approved.grant.id);
  const args = { resourceId: draft.id, venueId: 'room-a' };
  if (hasReceipt) {
    const inspected = await engine.tool(w.id, taskId, 'Alice', 'receipt_inspect', { operationId });
    assert.deepEqual(inspected.reservations[0].receipt, originalReceipt);
    const receipt = await engine.tool(w.id, taskId, 'Alice', 'reservation_submit', args);
    assert.deepEqual(receipt, originalReceipt);
    assert.equal(receipt.operationId, operationId);
    assert.deepEqual(await engine.tool(w.id, taskId, 'Alice', 'reservation_submit', args), originalReceipt);
    assert.equal(w.reservations.length, 1);
    assert.equal(ledger.getOperation(operationId).status, 'succeeded');
    const grant = ledger.list().grants.find(grant => grant.id === approved.grant.id);
    assert.equal(grant.status, 'revoked'); assert.equal(grant.uses, 1); assert.equal(grant.reserved, 0);
  } else {
    await assert.rejects(engine.tool(w.id, taskId, 'Alice', 'reservation_submit', args), { code: 'OPERATION_UNCERTAIN' });
    assert.equal(w.reservations.length, 0);
    const inspected = await engine.tool(w.id, taskId, 'Alice', 'receipt_inspect', { operationId });
    assert.deepEqual(inspected.reservations, []);
    assert.equal(ledger.getOperation(operationId).status, 'uncertain');
    const grant = ledger.list().grants.find(grant => grant.id === approved.grant.id);
    assert.equal(grant.uses, 0); assert.equal(grant.reserved, 1);
  }
  assert.equal(ledger.list().operations.filter(operation => operation.intent.action === 'reservation.submit').length, 1);
  assert.equal(ledger.list().requests.filter(item => item.intent.action === 'reservation.submit').length, 1);
});
