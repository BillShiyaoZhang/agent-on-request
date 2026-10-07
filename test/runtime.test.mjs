import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRuntimeManager, hashPayload } from '../src/runtime-manager.mjs';
import { createAgentRuntime } from '../src/agent-worker.mjs';
import { createBobServer } from '../src/bob-server.mjs';
import { macObject } from '../src/runtime-helpers.mjs';
import { hashValue } from '../src/config.mjs';

const calendar = [
  { day: 'Tue', time: '10:00–10:30', status: 'Free', title: 'ALICE_PRIVATE_TITLE', note: 'ALICE_PRIVATE_NOTE' },
  { day: 'Tue', time: '14:00–14:30', status: 'Busy', title: 'Private appointment', note: 'Do not disclose' },
  { day: 'Wed', time: '10:00–10:30', status: 'Free', title: 'Open', note: 'Personal detail' },
  { day: 'Wed', time: '14:00–14:30', status: 'Busy', title: 'Other meeting', note: 'Personal detail' },
  { day: 'Thu', time: '15:00–15:30', status: 'Free', title: 'Open', note: 'Hidden until selected' },
  { day: 'Fri', time: '09:00–09:30', status: 'Busy', title: 'ALICE_HIDDEN_FRIDAY', note: 'ALICE_HIDDEN_FRIDAY_NOTE' },
];
const config = {
  persona: 'Bob is a calm research collaborator.', objective: 'Arrange a fictional discussion.',
  prompts: { system: '', followUp: '' },
  data: { source: 'synthetic-calendar-v1', synthetic: true, availableTimes: [{ day: 'Thu', time: '15:00–15:30' }],
    brief: { topic: 'BOB_PRIVATE_TOPIC', agenda: 'BOB_PRIVATE_AGENDA' } },
  collaboration: { acceptInvitations: true, allowedPeers: ['Alice'] },
  tools: { capabilities: ['read_synthetic_calendar', 'send_scoped_reply', 'share_brief'] },
  permissions: { recipients: ['Alice'], fields: ['day', 'time', 'status'], resources: ['availability'],
    window: 'Mon–Sun', maxUses: 3, expiryMinutes: 10, confirmation: 'bounded', askAdminForNewScope: true },
  response: { constraints: 'Respect refusal.', maxWords: 80, offerBrief: true },
  runtime: { model: 'configured-default', temperature: 0.2, timeoutSeconds: 1, retryLimit: 0 }, extensions: {},
};

async function setup(t, options = {}, init = {}) {
  const manager = createRuntimeManager(options);
  t.after(() => manager.close());
  await manager.start();
  const ref = { sessionId: `session-${t.name}`, epoch: 1 };
  await manager.initialize({ ...ref, mode: 'controlled', aliceData: calendar, bobConfig: config, configRevision: 1, ...init });
  return { manager, ref };
}

async function send(manager, ref, stage, choice, operationId = `${stage}-${choice}`) {
  const projection = await manager.projectAlice({ ...ref, stage, choice });
  const request = { ...ref, operationId, ...projection, payloadHash: hashPayload(projection) };
  return { request, result: await manager.deliverToBob(request) };
}

async function httpService(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function completion(response, content) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
}

async function jsonRequest(request) {
  const chunks = [];
  for await (const part of request) chunks.push(part);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('workers are separate processes and controlled projections match the exact fixture contract', async t => {
  const { manager, ref } = await setup(t);
  const status = await manager.status();
  assert.notEqual(status.alice.pid, status.bob.pid);
  assert.notEqual(status.alice.pid, process.pid);
  assert.equal(status.live.available, false);
  const free = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'free' });
  assert.deepEqual(free.fields, ['day', 'time', 'status']);
  assert.equal(free.rows.length, 2);
  assert.equal(free.window, 'Tue–Wed');
  assert.equal(hashPayload(free), hashValue(free));
  assert(!JSON.stringify(free).includes('PRIVATE'));
  const busy = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'busy' });
  assert.equal(busy.rows.length, 4);
  const full = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'full' });
  assert.equal(full.rows.length, 4);
  assert.equal(full.rows[0].note, 'ALICE_PRIVATE_NOTE');
  assert.deepEqual(await manager.projectAlice({ ...ref, stage: 'initial', choice: 'none' }), { rows: [], fields: [], window: 'none' });
  assert.deepEqual(await manager.projectAlice({ ...ref, stage: 'additional', choice: 'keep' }), { rows: [], fields: [], window: 'none' });
  assert.equal((await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow' })).window, 'Thu');
  assert.equal((await manager.projectAlice({ ...ref, stage: 'additional', choice: 'week' })).rows.length, calendar.length);
});

test('Bob initialization rejects Alice own data and planning sees only delivered rows', async t => {
  const bob = createAgentRuntime({ role: 'Bob' });
  const alice = createAgentRuntime({ role: 'Alice' });
  t.after(() => { bob.close(); alice.close(); });
  const identity = await alice.call('status');
  await assert.rejects(bob.call('initialize', { sessionId: 'isolation', epoch: 1, mode: 'controlled',
    configRevision: 1, bobConfig: config, aliceData: calendar, peerPublicKey: identity.publicKey }), { code: 'ISOLATION_VIOLATION' });
  const { manager, ref } = await setup(t);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  await send(manager, ref, 'initial', 'free');
  assert.equal((await manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 })).action.type, 'request_more');
  await send(manager, ref, 'additional', 'narrow');
  assert.deepEqual((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.meeting,
    { day: 'Thu', time: '15:00–15:30' });
});

test('same operation returns its immutable receipt; changed content and forged hashes conflict', async t => {
  const { manager, ref } = await setup(t);
  const { request, result } = await send(manager, ref, 'initial', 'free', 'stable-op');
  assert.deepEqual(await manager.deliverToBob(request), result);
  result.receipt.receivedAt = 'client-mutated';
  assert.notEqual((await manager.deliverToBob(request)).receipt.receivedAt, 'client-mutated');
  const full = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'full' });
  await assert.rejects(manager.deliverToBob({ ...ref, operationId: 'stable-op', ...full, payloadHash: hashPayload(full) }), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(manager.deliverToBob({ ...request, operationId: 'forged-hash', payloadHash: '0'.repeat(64) }), { code: 'PAYLOAD_HASH_MISMATCH' });
});

test('verifyReceipt is read-only, exact and does not create outgoing or received operations', async t => {
  const { manager, ref } = await setup(t);
  const projection = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow' });
  const request = { ...ref, operationId: 'read-only-unknown', ...projection, payloadHash: hashPayload(projection) };
  assert.equal(await manager.verifyReceipt({ ...request, direction: 'bob' }), null);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  const delivered = await manager.deliverToBob(request);
  assert.deepEqual(await manager.verifyReceipt({ ...request, direction: 'bob' }), delivered);
  const full = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'week' });
  await assert.rejects(manager.verifyReceipt({ ...ref, operationId: request.operationId, ...full,
    direction: 'bob', payloadHash: hashPayload(full) }), { code: 'OPERATION_CONFLICT' });
  const fields = ['topic'];
  const values = { topic: config.data.brief.topic };
  const bobRequest = { ...ref, operationId: 'bob-read-only', fields, values, payloadHash: hashPayload({ fields, values }) };
  assert.equal(await manager.verifyReceipt({ ...bobRequest, direction: 'alice' }), null);
  const received = await manager.deliverToAlice(bobRequest);
  await manager.setBobOnline(false);
  // Alice can verify an already received Bob reply even if Bob is offline.
  assert.deepEqual(await manager.verifyReceipt({ ...bobRequest, direction: 'alice' }), received);
  await assert.rejects(manager.verifyReceipt({ ...request, direction: 'bob' }), { code: 'PEER_OFFLINE' });
});

test('clear evicts both contexts, refuses old epochs and new epoch starts with no received data', async t => {
  const { manager, ref } = await setup(t);
  const { request } = await send(manager, ref, 'additional', 'narrow');
  await manager.clear(ref);
  await assert.rejects(manager.deliverToBob(request), { code: 'STALE_EPOCH' });
  await assert.rejects(manager.projectAlice({ ...ref, stage: 'initial', choice: 'full' }), { code: 'STALE_EPOCH' });
  await assert.rejects(manager.initialize({ ...ref, mode: 'controlled', aliceData: calendar, bobConfig: config, configRevision: 1 }), { code: 'STALE_EPOCH' });
  const next = { ...ref, epoch: 2 };
  await manager.initialize({ ...next, mode: 'controlled', aliceData: [], bobConfig: config, configRevision: 1 });
  assert.equal((await manager.projectAlice({ ...next, stage: 'additional', choice: 'week' })).rows.length, 0);
  assert.equal((await manager.planBob({ ...next, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
});

test('restore Bob does not replay or send; explicit retry preserves the original operation', async t => {
  const { manager, ref } = await setup(t);
  const projection = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow' });
  const request = { ...ref, operationId: 'offline-op', ...projection, payloadHash: hashPayload(projection) };
  await manager.setBobOnline(false);
  assert.equal((await manager.status()).bob.online, false);
  await assert.rejects(manager.deliverToBob(request), { code: 'PEER_OFFLINE' });
  await manager.setBobOnline(true);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  const result = await manager.deliverToBob(request);
  assert.deepEqual(await manager.deliverToBob(request), result);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'meeting');
});

test('Bob update preserves actual receipts, requires a new revision and can match initial shared times', async t => {
  const { manager, ref } = await setup(t);
  await send(manager, ref, 'initial', 'free');
  const changed = structuredClone(config);
  changed.data.availableTimes = [{ day: 'Tue', time: '10:00–10:30' }];
  await manager.updateBob({ ...ref, bobConfig: changed, configRevision: 2 });
  await assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'CONFIGURATION_CHANGED' });
  assert.deepEqual((await manager.planBob({ ...ref, purpose: 'initial', configRevision: 2 })).action.meeting,
    { day: 'Tue', time: '10:00–10:30' });
  await assert.rejects(manager.updateBob({ ...ref, bobConfig: config, configRevision: 2 }), { code: 'CONFIGURATION_CHANGED' });
});

test('meeting uses a 30-minute overlap and accepts Bob outgoing subintervals', async t => {
  const changed = structuredClone(config);
  changed.data.availableTimes = [{ day: 'Thu', time: '14:00–16:00' }];
  const { manager, ref } = await setup(t, {}, { bobConfig: changed });
  await send(manager, ref, 'additional', 'narrow');
  const plan = await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 });
  assert.deepEqual(plan.action.meeting, { day: 'Thu', time: '15:00–15:30' });
  const values = { ...plan.action.meeting, status: 'Free' };
  const fields = Object.keys(values);
  assert.equal((await manager.deliverToAlice({ ...ref, operationId: 'overlap-meeting', fields, values,
    payloadHash: hashPayload({ fields, values }) })).receipt.status, 'received');
  changed.data.availableTimes = [{ day: 'Thu', time: '15:15–16:00' }];
  await manager.updateBob({ ...ref, bobConfig: changed, configRevision: 2 });
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 2 })).action.type, 'no_match');
});

test('Bob outgoing data is signed, source-checked and idempotent across later config updates', async t => {
  const { manager, ref } = await setup(t);
  const plan = await manager.planBob({ ...ref, purpose: 'brief', configRevision: 1 });
  assert.equal(plan.message, 'Bob prepared an optional meeting brief.');
  const { fields, values } = plan.action;
  const request = { ...ref, operationId: 'bob-brief', fields, values, payloadHash: hashPayload({ fields, values }) };
  const receipt = await manager.deliverToAlice(request);
  assert.equal(receipt.receipt.status, 'received');
  assert.deepEqual(await manager.deliverToAlice(request), receipt);
  const badValues = { ...values, topic: 'invented' };
  await assert.rejects(manager.deliverToAlice({ ...request, operationId: 'bob-false', values: badValues,
    payloadHash: hashPayload({ fields, values: badValues }) }), { code: 'INVALID_BOB_DATA' });
  const changed = structuredClone(config);
  changed.data.brief.topic = 'updated';
  await manager.updateBob({ ...ref, bobConfig: changed, configRevision: 2 });
  assert.deepEqual(await manager.deliverToAlice(request), receipt);
  const availability = { day: 'Thu', time: '15:00–15:30', status: 'Free' };
  const availabilityFields = Object.keys(availability);
  assert.equal((await manager.deliverToAlice({ ...ref, operationId: 'bob-availability', fields: availabilityFields,
    values: availability, payloadHash: hashPayload({ fields: availabilityFields, values: availability }) })).receipt.status, 'received');
});

test('remote Bob has local API parity, authenticated pairing and complete reset', async t => {
  const token = 'dedicated-test-peer-token-not-a-product-credential';
  const server = createBobServer({ token, port: 0 });
  t.after(() => server.close());
  await server.start();
  const bobUrl = `http://127.0.0.1:${server.address().port}`;
  const { manager, ref } = await setup(t, { bobUrl, bobToken: token });
  assert.equal((await manager.status()).bob.transport, 'http');
  const { request, result } = await send(manager, ref, 'additional', 'narrow', 'remote-op');
  assert.deepEqual(await manager.deliverToBob(request), result);
  assert.deepEqual(await manager.verifyReceipt({ ...request, direction: 'bob' }), result);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'meeting');
  const plan = await manager.planBob({ ...ref, purpose: 'brief', configRevision: 1 });
  const { fields, values } = plan.action;
  assert.equal((await manager.deliverToAlice({ ...ref, operationId: 'remote-bob-outgoing', fields, values,
    payloadHash: hashPayload({ fields, values }) })).receipt.status, 'received');
  await manager.clear(ref);
  await assert.rejects(manager.deliverToBob(request), { code: 'STALE_EPOCH' });
  const invalid = createRuntimeManager({ bobUrl, bobToken: `${token}-wrong` });
  t.after(() => invalid.close());
  await assert.rejects(invalid.start(), { code: 'BOB_AUTH_FAILED' });
  const unsigned = await fetch(`${bobUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${token}` }, body: JSON.stringify({ body: { method: 'status' }, signature: 'wrong' }) });
  assert.equal(unsigned.status, 401);
});

test('remote receipt lookup cannot turn missing receipt or failed connection into a send', async t => {
  const token = 'dedicated-read-only-peer-test-token';
  const server = createBobServer({ token, port: 0 });
  t.after(() => server.close());
  await server.start();
  const actual = `http://127.0.0.1:${server.address().port}`;
  let broken = false;
  const methods = [];
  const proxy = await httpService(t, async (request, response) => {
    const envelope = await jsonRequest(request);
    methods.push(envelope.body.method);
    if (broken) { response.destroy(); return; }
    const result = await fetch(`${actual}/rpc`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(envelope) });
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(await result.text());
  });
  const { manager, ref } = await setup(t, { bobUrl: proxy, bobToken: token });
  const projection = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow' });
  const request = { ...ref, operationId: 'remote-missing', ...projection, payloadHash: hashPayload(projection), direction: 'bob' };
  methods.length = 0;
  assert.equal(await manager.verifyReceipt(request), null);
  assert.deepEqual(methods, ['verifyReceipt']);
  broken = true;
  await assert.rejects(manager.verifyReceipt(request), { code: 'PEER_UNAVAILABLE' });
  assert.deepEqual(methods, ['verifyReceipt', 'verifyReceipt']);
  broken = false;
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  assert.equal(await manager.verifyReceipt(request), null);
});

test('remote response authentication alone cannot replace the Bob signed receipt', async t => {
  const token = 'another-dedicated-test-peer-token';
  const server = createBobServer({ token, port: 0 });
  t.after(() => server.close());
  await server.start();
  const actual = `http://127.0.0.1:${server.address().port}`;
  const proxy = await httpService(t, async (request, response) => {
    const envelope = await jsonRequest(request);
    const result = await fetch(`${actual}/rpc`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(envelope) });
    const output = await result.json();
    if (output.body?.result?.proof) output.body.result.proof.signature = 'invalid-receipt-signature';
    output.signature = macObject(output.body, token);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(output));
  });
  const { manager, ref } = await setup(t, { bobUrl: proxy, bobToken: token });
  await assert.rejects(send(manager, ref, 'initial', 'free'), { code: 'INVALID_PEER_RECEIPT' });
});

test('real HTTP disconnection permits an explicit reconnect without automatic delivery', async t => {
  const token = 'dedicated-network-recovery-test-token';
  const server = createBobServer({ token, port: 0 });
  t.after(() => server.close());
  await server.start();
  const actual = `http://127.0.0.1:${server.address().port}`;
  let broken = false;
  let attempts = 0;
  const proxy = await httpService(t, async (request, response) => {
    attempts++;
    if (broken) { response.destroy(); return; }
    const envelope = await jsonRequest(request);
    const result = await fetch(`${actual}/rpc`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(envelope) });
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(await result.text());
  });
  const { manager, ref } = await setup(t, { bobUrl: proxy, bobToken: token });
  const projection = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow' });
  const request = { ...ref, operationId: 'recover-http-op', ...projection, payloadHash: hashPayload(projection) };
  broken = true;
  await assert.rejects(manager.deliverToBob(request), { code: 'PEER_UNAVAILABLE' });
  assert.equal(manager.status().bob.online, false);
  const before = attempts;
  broken = false;
  await manager.setBobOnline(true);
  assert.equal(attempts, before);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  assert.equal((await manager.deliverToBob(request)).receipt.status, 'received');
});

test('controlled mode never invokes even a configured provider', async t => {
  let requests = 0;
  const base = await httpService(t, (request, response) => { requests++; response.writeHead(500); response.end(); });
  const { manager, ref } = await setup(t, { modelBaseUrl: `${base}/v1`, modelName: 'test-model' });
  await manager.planAlice({ ...ref, purpose: 'intro', mode: 'controlled' });
  await manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 });
  assert.equal(requests, 0);
});

test('Bob collaboration refusal remains a deterministic guard in live mode', async t => {
  let requests = 0;
  const base = await httpService(t, (request, response) => { requests++; response.writeHead(500); response.end(); });
  const changed = structuredClone(config);
  changed.collaboration.acceptInvitations = false;
  const { manager, ref } = await setup(t, { modelBaseUrl: base, modelName: 'test-model' }, { mode: 'live', bobConfig: changed });
  await send(manager, ref, 'additional', 'narrow');
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
  assert.equal(requests, 0);
});

test('live Bob model input excludes Alice private/unshared data and does not disclose brief in a message', async t => {
  const calls = [];
  const base = await httpService(t, async (request, response) => {
    const body = await jsonRequest(request);
    calls.push(body);
    const context = JSON.parse(body.messages[1].content);
    if (context.purpose === 'brief') completion(response, { message: 'BOB_PRIVATE_TOPIC in unapproved message',
      action: { type: 'share_brief', fields: Object.keys(context.ownBrief), values: context.ownBrief, resource: 'meeting_brief' } });
    else completion(response, { message: 'Please choose whether to provide more availability.', action: { type: 'request_more' } });
  });
  const { manager, ref } = await setup(t, { modelBaseUrl: `${base}/v1`, modelName: 'test-model', modelApiKey: 'TEST_PROVIDER_SECRET' }, { mode: 'live' });
  await send(manager, ref, 'initial', 'free');
  await manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 });
  const context = JSON.stringify(calls[0].messages);
  assert(!context.includes('ALICE_PRIVATE'));
  assert(!context.includes('ALICE_HIDDEN_FRIDAY'));
  assert(!context.includes('BOB_PRIVATE_TOPIC'));
  assert.equal(calls[0].store, false);
  const plan = await manager.planBob({ ...ref, purpose: 'brief', configRevision: 1 });
  assert(!plan.message.includes('BOB_PRIVATE_TOPIC'));
  assert.equal(plan.action.values.topic, 'BOB_PRIVATE_TOPIC');
  assert(!JSON.stringify(await manager.status()).includes('TEST_PROVIDER_SECRET'));
});

test('live meeting output is rejected outside the actual shared free-time intersection', async t => {
  const base = await httpService(t, async (request, response) => {
    await jsonRequest(request);
    completion(response, { message: 'A meeting is possible.', action: { type: 'meeting', meeting: { day: 'Thu', time: '15:00–15:30' } } });
  });
  const { manager, ref } = await setup(t, { modelBaseUrl: base, modelName: 'test-model' }, { mode: 'live' });
  await send(manager, ref, 'initial', 'free');
  await assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'MODEL_INVALID_MEETING' });
  await send(manager, ref, 'additional', 'narrow');
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'meeting');
});

test('provider errors and timeout stay explicit and never silently become controlled output', async t => {
  const errorBase = await httpService(t, (request, response) => { response.writeHead(503); response.end('raw secret must not escape'); });
  const failure = await setup(t, { modelBaseUrl: errorBase, modelName: 'test-model' }, { mode: 'live' });
  await assert.rejects(failure.manager.planAlice({ ...failure.ref, purpose: 'intro', mode: 'live' }), error => {
    assert.equal(error.code, 'MODEL_PROVIDER_ERROR');
    assert(!error.message.includes('raw secret'));
    return true;
  });
  const slowBase = await httpService(t, () => {});
  const timeout = await setup(t, { modelBaseUrl: slowBase, modelName: 'test-model', modelTimeoutMs: 40 }, { mode: 'live' });
  await assert.rejects(timeout.manager.planAlice({ ...timeout.ref, purpose: 'intro', mode: 'live' }), { code: 'MODEL_TIMEOUT' });
});

test('clear aborts in-flight model context; a new epoch has no old fixture', async t => {
  let notify;
  const entered = new Promise(resolve => { notify = resolve; });
  let calls = 0;
  const base = await httpService(t, async (request, response) => {
    const body = await jsonRequest(request);
    calls++;
    if (calls === 1) { notify(); return; }
    assert(!JSON.stringify(body.messages).includes('ALICE_PRIVATE'));
    completion(response, { message: 'Fresh context.' });
  });
  const { manager, ref } = await setup(t, { modelBaseUrl: base, modelName: 'test-model' }, { mode: 'live' });
  const pending = assert.rejects(manager.planAlice({ ...ref, purpose: 'intro', mode: 'live' }), { code: 'STALE_EPOCH' });
  await entered;
  await manager.clear(ref);
  await pending;
  const next = { ...ref, epoch: 2 };
  await manager.initialize({ ...next, mode: 'live', aliceData: [], bobConfig: config, configRevision: 1 });
  assert.equal((await manager.planAlice({ ...next, purpose: 'intro', mode: 'live' })).message, 'Fresh context.');
});

test('Bob policy update aborts in-flight planning and does not change old delivered receipts', async t => {
  let notify;
  const entered = new Promise(resolve => { notify = resolve; });
  const base = await httpService(t, async request => { await jsonRequest(request); notify(); });
  const { manager, ref } = await setup(t, { modelBaseUrl: base, modelName: 'test-model' }, { mode: 'live' });
  const { request, result } = await send(manager, ref, 'initial', 'free');
  const pending = assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'CONFIGURATION_CHANGED' });
  await entered;
  await manager.updateBob({ ...ref, bobConfig: config, configRevision: 2 });
  await pending;
  assert.deepEqual(await manager.deliverToBob(request), result);
});

test('close terminates both worker processes', async () => {
  const manager = createRuntimeManager();
  await manager.start();
  const status = await manager.status();
  await manager.close();
  for (const pid of [status.alice.pid, status.bob.pid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await manager.status()).alice.online, false);
});
