import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgentCommDirect } from '../src/agent-comm-direct.mjs';
import { createHermesDemoClient } from '../src/hermes-demo-client.mjs';
import { createDemoServer } from '../src/server.mjs';
import { RuntimeError } from '../src/runtime-helpers.mjs';

function fixtureHermes() {
  return {
    async check() { return { ready: true }; },
    async propose({ input }) {
      const context = JSON.parse(input);
      if (context.purpose === 'ontology_alignment') return { message: 'Use the supplied mappings.', decision: 'accept', selectedMappingIds: context.candidates.map(item => item.id) };
      if (context.purpose === 'initial') return { message: 'Would you like to add a window?', action: { type: 'request_more' } };
      if (context.purpose === 'additional') return { message: 'Found the Thursday window.', action: { type: 'meeting', meeting: context.sharedIntersection[0] } };
      if (context.purpose === 'brief') return { message: 'Prepared a brief.', action: { type: 'share_brief', fields: Object.keys(context.ownBrief), values: context.ownBrief, resource: 'meeting_brief' } };
      return { message: 'You choose what to share.' };
    },
  };
}

function traceTransports(hermes, bridge) {
  const calls = [], transfers = [];
  return {
    calls, transfers,
    hermes: { check: request => hermes.check(request), async propose(request) {
      calls.push({ role: request.role, context: JSON.parse(request.input), instructions: request.instructions, id: request.requestId });
      return hermes.propose(request);
    } },
    peerTransport: {
      start: () => bridge?.start(), close: () => bridge?.close(), status: () => bridge?.status() ?? { online: true },
      async transfer(from, payload, options) {
        transfers.push({ from, payload: structuredClone(payload) });
        if (bridge) return bridge.transfer(from, payload, options);
        options?.beforeSend();
        return structuredClone(payload);
      },
    },
  };
}

async function choose(engine, session, stage, choice) {
  const preview = await engine.preview(session, { stage, choice });
  return engine.action(session, { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
    previewHash: preview.payloadHash, requestId: randomUUID(), expectedVersion: preview.sessionVersion });
}

async function exercise(t, hermes, bridge) {
  const { calls, transfers, ...options } = traceTransports(hermes, bridge);
  const app = await createDemoServer({ ...options, persist: false });
  t.after(() => app.close());
  const { engine, runtime } = app;
  assert.equal(runtime.status().live.harness, 'hermes');
  assert.equal(runtime.status().alice.transport, 'agent-comm-direct');
  if (bridge) assert.notEqual(runtime.status().peerTransport.addresses.Alice, runtime.status().peerTransport.addresses.Bob);
  const { state: start } = await engine.create({ mode: 'live' });
  const session = engine.get(start.session.id);
  assert.equal(start.session.stage, 'initial');
  assert.equal(calls[0].role, 'Alice');
  const before = transfers.length;
  await engine.preview(session, { stage: 'initial', choice: 'free' });
  assert.equal(transfers.length, before);

  await choose(engine, session, 'initial', 'free');
  const { state: pending } = await choose(engine, session, 'additional', 'narrow');
  assert.equal(pending.session.stage, 'waiting_admin');
  assert.equal(pending.receipts.aliceToBob.length, 2);
  assert(calls.some(call => call.role === 'Bob' && call.context.purpose === 'additional'));
  assert(calls.every(call => call.id && !call.instructions.includes('Call submit_proposal')));
  const approval = engine.approvals(session.id).find(item => item.status === 'pending');
  assert(!JSON.stringify(transfers).includes(approval.values.agenda));
  const { state: done } = await engine.decide(approval.id, { decision: 'allow_once', fields: ['topic'],
    expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assert.equal(done.task.outcome, 'arranged');
  assert.deepEqual(done.receipts.bobToAlice.at(-1).values, { topic: approval.values.topic });
  assert(!JSON.stringify(transfers).includes(approval.values.agenda));
  assert(transfers.some(({ from, payload }) => from === 'Bob' && payload.proof?.body?.receiver === 'Bob'
    && payload.proof.body.status === 'received'));

  const { state: newRound } = await engine.create({ mode: 'controlled' });
  const offline = engine.get(newRound.session.id);
  await engine.intervene(offline, { action: 'disconnect_bob' });
  const transferCount = transfers.length;
  await choose(engine, offline, 'initial', 'full');
  assert(offline.pendingDelivery);
  await engine.action(offline, { action: 'stop_sharing', requestId: randomUUID(), expectedVersion: offline.version });
  await engine.intervene(offline, { action: 'restore_bob' });
  assert.equal(transfers.length, transferCount);
  assert.deepEqual(offline.receipts.aliceToBob, []);
}

test('Hermes direct mode retains owner approval, recipient proof and offline revocation', t => exercise(t, fixtureHermes()));

test('retry after a lost return path fetches the exact receipt without resending data', async t => {
  let dataSends = 0;
  let lostReceipt = false;
  const peerTransport = { start() {}, close() {}, status: () => ({ online: true }), async transfer(from, payload, options) {
    options?.beforeSend();
    if (from === 'Alice' && payload.body?.operationId) dataSends++;
    if (!lostReceipt && from === 'Bob' && payload.proof?.body?.operationId) {
      lostReceipt = true;
      throw new RuntimeError('PEER_TIMEOUT', 'Test: return path unavailable.', 504);
    }
    return structuredClone(payload);
  } };
  const app = await createDemoServer({ peerTransport, persist: false });
  t.after(() => app.close());
  const { engine } = app;
  const { state } = await engine.create();
  const session = engine.get(state.session.id);
  const { state: paused } = await choose(engine, session, 'initial', 'free');
  assert.equal(paused.session.stage, 'paused');
  assert.equal(paused.receipts.aliceToBob.length, 0);
  assert.equal(dataSends, 1);
  const { state: retried } = await engine.intervene(session, { action: 'retry' });
  assert.equal(retried.receipts.aliceToBob.length, 1);
  assert.equal(dataSends, 1);
});

test('stopping sharing while the direct bridge is preparing prevents the pending send', async t => {
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let dataSends = 0;
  const peerTransport = { start() {}, close() {}, status: () => ({ online: true }), async transfer(from, payload, options) {
    if (from === 'Alice' && payload.body?.operationId) {
      waiting.resolve();
      await release.promise;
      options?.beforeSend();
      dataSends++;
    } else options?.beforeSend();
    return structuredClone(payload);
  } };
  const app = await createDemoServer({ peerTransport, persist: false });
  t.after(() => app.close());
  const { engine } = app;
  const { state } = await engine.create();
  const session = engine.get(state.session.id);
  const choosing = choose(engine, session, 'initial', 'free');
  await waiting.promise;
  const stopping = engine.action(session, { action: 'stop_sharing', requestId: randomUUID(), expectedVersion: session.version });
  release.resolve();
  const [, stopped] = await Promise.all([choosing, stopping]);
  assert.equal(dataSends, 0);
  assert.deepEqual(stopped.state.receipts.aliceToBob, []);
});

const bridgeCommand = process.env.DEMO_TEST_AGENT_COMM_DIRECT;
test('built agent-comm SDK bridge carries the complete demo round', { skip: !bridgeCommand },
  t => exercise(t, fixtureHermes(), createAgentCommDirect({ command: bridgeCommand })));

const realHermes = process.env.DEMO_TEST_REAL_HERMES;
test('two local Hermes gateways and agent-comm complete the signed demo round', { skip: !realHermes || !bridgeCommand },
  t => exercise(t, createHermesDemoClient({ endpoints: JSON.parse(realHermes) }), createAgentCommDirect({ command: bridgeCommand })));
