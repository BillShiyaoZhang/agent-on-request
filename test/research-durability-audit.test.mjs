import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research-engine.mjs';
import { AuthorizationLedger } from '../src/authorization-ledger.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

const roles = ['Alice', 'Bob'];
const clone = value => structuredClone(value);
const artifactRoot = fileURLToPath(new URL('../artifacts/', import.meta.url));
// Native scheduling is exercised without submitting a model request.
const noModelClient = { run: async () => ({ status: 'completed' }) };
const approval = request => ({ decision: 'allow', expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });

async function directoryFor() {
  await mkdir(artifactRoot, { recursive: true });
  return mkdtemp(path.join(artifactRoot, 'research-durability-audit-'));
}

async function removeDirectory(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(artifactRoot));
  assert.match(path.basename(directory), /^research-durability-audit-/);
  await rm(directory, { recursive: true, force: true });
}

async function settle(engine, workspaceId) {
  await Promise.allSettled([...engine.running]);
  while (engine.projectionRuns.has(workspaceId)) await engine.projectionRuns.get(workspaceId);
}

async function begin(engine, workspaceId, type = 'prepare_discussion') {
  await engine.start(workspaceId, { type, mode: 'native', ...(type === 'research_work' ? { goal: 'Prepare a reviewed research summary.' } : {}) });
  await settle(engine, workspaceId);
  return engine.get(workspaceId).tasks.at(-1);
}

test('persistent unacknowledged KG outbox reconstructs the local projection and replays stable events after restart', async t => {
  const directory = await directoryFor();
  const rows = new Map(), attempts = [];
  let acknowledgementLost = true, applications = 0;
  const knowledge = {
    async createWorkspace(role, { workspaceId, profile }) {
      return { ...clone(profile), nativeWorkspace: { workspaceId, namespace: `urn:audit:${role.toLowerCase()}:experience-${workspaceId}:`, seedHash: hashPayload(profile) } };
    },
    async project(role, event) {
      const key = `${role}:${event.workspaceId}:${event.id}`;
      attempts.push({ key, event: clone(event) });
      if (rows.has(key)) assert.deepEqual(rows.get(key), event, 'A replay must retain the original version and exact content.');
      else { rows.set(key, clone(event)); applications++; }
      if (acknowledgementLost) throw Object.assign(new Error('KG wrote this event but its acknowledgement was lost.'), { code: 'KG_ACK_LOST' });
    },
  };
  let engine;
  t.after(async () => { await engine?.close(); await removeDirectory(directory); });
  engine = await new ResearchEngine({ directory, knowledge, nativeClient: noModelClient }).init();
  const created = await engine.create(), workspaceId = created.workspaceId;
  const task = await begin(engine, workspaceId, 'research_work');
  const request = await engine.tool(workspaceId, task.id, 'Alice', 'authorization_request', {
    resourceId: 'alice:research-brief', fields: ['summary'],
  });
  await engine.decide(workspaceId, 'Alice', request.id, approval(request));
  await settle(engine, workspaceId);
  const w = engine.get(workspaceId);
  const pending = roles.flatMap(role => engine.ledger(w, role).pendingOutbox().map(event => ({ role, event })));
  assert.ok(pending.some(({ event }) => event.topic === 'grant'));
  assert.ok(pending.some(({ event }) => event.topic === 'decision'));
  assert.ok(rows.size > 0 && rows.size < pending.length, 'The failure covers both applied-but-unacknowledged and not-yet-applied events.');
  const replayKeys = [...rows.keys()];
  await engine.close(); engine = null;

  // The search projection is a disposable cache. The owner ledger remains intact.
  const stateDB = new DatabaseSync(path.join(directory, 'workspaces.sqlite'));
  try {
    const state = JSON.parse(stateDB.prepare('SELECT state FROM workspaces WHERE id=?').get(workspaceId).state);
    state.authorizationProjection = [];
    stateDB.prepare('UPDATE workspaces SET state=? WHERE id=?').run(JSON.stringify(state), workspaceId);
  } finally { stateDB.close(); }
  acknowledgementLost = false;
  engine = await new ResearchEngine({ directory, knowledge, nativeClient: noModelClient }).init();
  await settle(engine, workspaceId);
  const restored = engine.get(workspaceId);
  for (const role of roles) assert.deepEqual(engine.ledger(restored, role).pendingOutbox(), []);
  assert.equal(rows.size, pending.length);
  assert.equal(applications, pending.length, 'At-least-once retries must not create extra projection rows at the idempotent KG boundary.');
  for (const { role, event } of pending) {
    assert.deepEqual(rows.get(`${role}:${workspaceId}:${event.id}`), { workspaceId, ...event });
    assert.ok(restored.authorizationProjection.some(row => row.key === `${role}:${event.id}` && row.recordId === event.recordId));
  }
  for (const key of replayKeys) assert.ok(attempts.filter(attempt => attempt.key === key).length >= 2);
  const recalled = await engine.tool(workspaceId, task.id, 'Alice', 'authorization_list');
  assert.ok(recalled.grants.some(grant => grant.requestId === request.id && grant.remaining === 1));
  const deliveredAttempts = attempts.length;
  await engine.close(); engine = null;
  engine = await new ResearchEngine({ directory, knowledge, nativeClient: noModelClient }).init();
  await settle(engine, workspaceId);
  assert.equal(attempts.length, deliveredAttempts, 'A second restart must not retransmit acknowledged outbox events.');
});

for (const action of ['peer.send', 'reservation.submit']) {
  for (const boundary of ['check', 'prepare', 'dispatch']) {
    test(`a disconnected persistent ledger fails closed at ${boundary} before ${action}`, async t => {
      const directory = await directoryFor(), transfers = [];
      const peerTransport = { async transfer(from, value) { transfers.push({ from, value: clone(value) }); return clone(value); } };
      const engine = await new ResearchEngine({ directory, nativeClient: noModelClient, peerTransport }).init();
      t.after(async () => { await engine.close(); await removeDirectory(directory); });
      const created = await engine.create(), workspaceId = created.workspaceId, w = engine.get(workspaceId);
      const task = await begin(engine, workspaceId);
      let args = { resourceId: 'alice:research-brief', fields: ['summary'] };
      if (action === 'reservation.submit') {
        const form = await engine.tool(workspaceId, task.id, 'Alice', 'artifact_prepare', {
          kind: 'reservation', title: 'Reviewed discussion reservation', sourceRefs: ['alice:public-intro'],
          fields: { title: 'Research discussion', day: 'Thu', time: '15:00–15:30', attendees: '2', agenda: 'Discuss the public research introduction.' },
        });
        const venues = await engine.tool(workspaceId, task.id, 'Alice', 'resource_search', { capacity: 2 });
        const venue = venues.find(venue => venue.availableTimes.some(slot => slot.day === 'Thu' && slot.time === '15:00–16:00')) ?? venues[0];
        args = { resourceId: form.id, venueId: venue.id };
      }
      const request = await engine.tool(workspaceId, task.id, 'Alice', 'authorization_request', { action, ...args });
      await engine.decide(workspaceId, 'Alice', request.id, approval(request));
      await settle(engine, workspaceId);
      const allowed = await engine.tool(workspaceId, task.id, 'Alice', 'authorization_check', { action, ...args });
      assert.equal(allowed.status, 'allowed');
      assert.equal(allowed.basisKind, 'grant');
      const ledger = engine.ledger(w, 'Alice'), original = ledger[boundary].bind(ledger);
      let faultReached = false;
      ledger[boundary] = (...input) => {
        faultReached = true;
        ledger.db.close(); // Real loss of the SQLite connection, not a fabricated authorization response.
        return original(...input);
      };
      const tool = action === 'peer.send' ? 'peer_send' : 'reservation_submit';
      try {
        await assert.rejects(engine.tool(workspaceId, task.id, 'Alice', tool, args), error => {
          assert.equal(error.code, 'ERR_INVALID_STATE');
          assert.match(error.message, /database is not open/i);
          return true;
        });
        assert.equal(faultReached, true);
        assert.deepEqual(transfers, [], 'No peer transport call may cross an unavailable execution gate.');
        assert.deepEqual(w.messages, []);
        assert.deepEqual(w.reservations, [], 'The booking service may not issue a reservation or receipt.');
      } finally {
        engine.ledgers.get(workspaceId).Alice = new AuthorizationLedger({
          filename: path.join(directory, 'runs', workspaceId, 'alice', 'authorization.sqlite'), owner: `${workspaceId}:Alice`,
        });
      }
      const recoveredLedger = engine.ledger(w, 'Alice');
      const grant = recoveredLedger.list().grants.find(grant => grant.requestId === request.id);
      assert.equal(grant.uses, 0);
      assert.equal(grant.reserved, boundary === 'dispatch' ? 1 : 0);
      const receipt = await engine.tool(workspaceId, task.id, 'Alice', tool, args);
      assert.equal(receipt.status, action === 'peer.send' ? 'received' : 'confirmed');
      assert.equal(recoveredLedger.list().grants.find(candidate => candidate.id === grant.id)?.uses, 1);
      assert.equal(recoveredLedger.list().operations.length, 1);
      assert.equal(w.messages.length, action === 'peer.send' ? 1 : 0);
      assert.equal(w.reservations.length, action === 'reservation.submit' ? 1 : 0);
    });
  }
}
