import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthorizationLedger } from '../src/authorization-ledger.mjs';

const workerSource = `
const { parentPort, workerData, threadId } = require('node:worker_threads');
(async () => {
  const { AuthorizationLedger } = await import(workerData.moduleUrl);
  const ledger = new AuthorizationLedger({ filename: workerData.filename, owner: 'Alice' });
  const barrier = new Int32Array(workerData.barrier);
  function wait(index) {
    while (Atomics.load(barrier, index) === 0) {
      if (Atomics.wait(barrier, index, 0, 15000) === 'timed-out') throw new Error('Concurrent authorization barrier timed out');
    }
  }
  try {
    parentPort.postMessage({ phase: 'ready', threadId });
    wait(0);
    let operation;
    try {
      operation = ledger.prepare(workerData.operationId, workerData.intent);
      parentPort.postMessage({ phase: 'prepared', allowed: true, operation });
    } catch (error) {
      parentPort.postMessage({ phase: 'prepared', allowed: false, code: error.code,
        operationMissing: ledger.getOperation(workerData.operationId) === null });
    }
    // Keep every connection alive until the parent has inspected the committed reservation.
    wait(1);
    if (operation) {
      ledger.dispatch(operation.id);
      const effect = Atomics.add(barrier, 2, 1) + 1;
      ledger.complete(operation.id, { receipt: { operationId: operation.id, status: 'received', effect } });
    }
    parentPort.postMessage({ phase: 'finished', operationId: workerData.operationId, allowed: Boolean(operation) });
  } finally {
    ledger.close();
  }
})().catch(error => { throw error; });
`;

function observeWorker(worker) {
  const pending = new Map();
  const promises = Object.fromEntries(['ready', 'prepared', 'finished', 'exit'].map(phase => {
    const promise = new Promise((resolve, reject) => pending.set(phase, { resolve, reject }));
    // A later phase may fail while the test is still awaiting an earlier barrier.
    promise.catch(() => {});
    return [phase, promise];
  }));
  worker.on('message', message => {
    const phase = pending.get(message.phase);
    if (phase) { pending.delete(message.phase); phase.resolve(message); }
  });
  worker.on('error', error => {
    for (const phase of pending.values()) phase.reject(error);
    pending.clear();
  });
  worker.on('exit', code => {
    pending.get('exit')?.resolve(code); pending.delete('exit');
    for (const [phase, promise] of pending) promise.reject(new Error(`Authorization worker exited (${code}) before ${phase}`));
    pending.clear();
  });
  return promises;
}

test('independent SQLite workers contend for one grant without duplicate reservations or effects', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-auth-concurrent-'));
  const filename = path.join(directory, 'alice.sqlite');
  const barrier = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const workers = [];
  let ledger;
  t.after(async () => {
    ledger?.close();
    for (const index of [0, 1]) { Atomics.store(barrier, index, 1); Atomics.notify(barrier, index); }
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(directory, { recursive: true, force: true });
  });
  const reopen = () => { ledger?.close(); ledger = new AuthorizationLedger({ filename, owner: 'Alice' }); return ledger; };
  reopen();
  const intent = { taskId: 'concurrent-discussion', projectId: 'conference-2026', action: 'peer.send',
    resourceId: 'alice:method-summary', resourceVersion: 'v1', resourceClass: 'private', recipient: 'Bob',
    purpose: 'academic-discussion', fields: ['method'], values: { method: 'A fictional reviewed method summary.' } };
  const request = ledger.request(intent);
  const { grant } = ledger.decide(request.id, { decision: 'allow_once', maxUses: 1,
    expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  ledger.close(); ledger = null;

  const competitors = Array.from({ length: 6 }, (_, index) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { filename, intent,
      operationId: `concurrent-operation-${index}`, barrier: barrier.buffer,
      moduleUrl: new URL('../src/authorization-ledger.mjs', import.meta.url).href } });
    workers.push(worker);
    return observeWorker(worker);
  });
  const ready = await Promise.all(competitors.map(worker => worker.ready));
  assert.equal(new Set(ready.map(item => item.threadId)).size, competitors.length);
  // Every worker has opened its own connection before the same atomic release.
  Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0, competitors.length);
  const attempts = await Promise.all(competitors.map(worker => worker.prepared));
  const winners = attempts.filter(item => item.allowed), losers = attempts.filter(item => !item.allowed);
  assert.equal(winners.length, 1, 'exactly one independent transaction may reserve the single-use grant');
  assert.equal(losers.length, competitors.length - 1);
  for (const loser of losers) {
    assert.equal(loser.code, 'AUTHORIZATION_REQUIRED');
    assert.equal(loser.operationMissing, true, 'a rejected transaction must not leave an operation');
  }
  const operationId = winners[0].operation.id;
  reopen();
  const reserved = ledger.list();
  assert.equal(reserved.operations.length, 1);
  assert.equal(reserved.operations[0].id, operationId);
  assert.equal(reserved.operations[0].status, 'prepared');
  assert.deepEqual({ uses: reserved.grants[0].uses, reserved: reserved.grants[0].reserved, remaining: reserved.grants[0].remaining },
    { uses: 0, reserved: 1, remaining: 0 });
  assert.deepEqual(ledger.pendingOutbox().filter(item => item.topic === 'operation').map(item => item.record.id), [operationId]);
  assert.equal(Atomics.load(barrier, 2), 0, 'no simulated external effect occurs before dispatch');
  ledger.close(); ledger = null;

  Atomics.store(barrier, 1, 1); Atomics.notify(barrier, 1, competitors.length);
  const finished = await Promise.all(competitors.map(worker => worker.finished));
  assert.equal(finished.filter(item => item.allowed).length, 1);
  assert.deepEqual(await Promise.all(competitors.map(worker => worker.exit)), competitors.map(() => 0));
  assert.equal(Atomics.load(barrier, 2), 1, 'only the permitted worker may perform the simulated external effect');

  reopen();
  const completed = ledger.list();
  assert.equal(completed.operations.length, 1);
  assert.equal(completed.operations[0].status, 'succeeded');
  assert.deepEqual(completed.operations[0].receipt, { operationId, status: 'received', effect: 1 });
  assert.deepEqual({ uses: completed.grants[0].uses, reserved: completed.grants[0].reserved, remaining: completed.grants[0].remaining },
    { uses: 1, reserved: 0, remaining: 0 });
  assert.deepEqual(ledger.pendingOutbox().filter(item => item.topic === 'operation').map(item => item.record.status),
    ['prepared', 'dispatching', 'succeeded']);
  assert.throws(() => ledger.prepare('after-contention', intent), { code: 'AUTHORIZATION_REQUIRED' });
  ledger.revoke(grant.id, { expectedRevision: grant.revision });

  reopen();
  assert.equal(ledger.list().grants[0].status, 'revoked');
  assert.equal(ledger.check(intent).reason, 'grant_revoked');
  assert.throws(() => ledger.prepare('after-revocation', intent), { code: 'AUTHORIZATION_DENIED' });
  assert.equal(ledger.list().operations.length, 1);
  assert.equal(ledger.list().grants[0].uses, 1);
  assert.equal(ledger.list().grants[0].reserved, 0);
});
