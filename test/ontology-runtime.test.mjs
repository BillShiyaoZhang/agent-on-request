import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createRuntimeManager, hashPayload } from '../src/runtime-manager.mjs';
import { verifyObject, signObject } from '../src/runtime-helpers.mjs';
import { createAgentRuntime } from '../src/agent-worker.mjs';
import { WorkerClient } from '../src/runtime-client.mjs';
import { DEFAULT_BOB_CONFIG } from '../src/config.mjs';
import { ontologyDefinitions, createOntologyDialogue, startOntologyDialogue, resolveOntologyDialogue } from '../src/ontology-dialogue.mjs';

const calendar = [{ day: 'Fri', time: '15:00–16:00', status: 'Free', title: 'PRIVATE_ALICE_TITLE', note: 'PRIVATE_ALICE_NOTE' }];
async function setup(t, options = {}, initial = {}) {
  const manager = createRuntimeManager(options);
  t.after(() => manager.close());
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.data.availableTimes = [{ day: 'Fri', time: '14:45–16:30' }];
  config.data.brief = { topic: 'Private Bob topic', agenda: 'Private Bob agenda' };
  const ref = { sessionId: t.name, epoch: 1 };
  const initialized = await manager.initialize({ ...ref, mode: 'controlled', configRevision: 1, aliceData: calendar, bobConfig: config, ...initial });
  return { manager, ref, config, initialized };
}
function assertSignedProtocol(protocol) {
  assert.equal(protocol.length, 6);
  assert.deepEqual(protocol.map(item => item.kind), ['module', 'module', 'proposal', 'decision', 'acknowledgment', 'acknowledgment']);
  let previousHash = null;
  for (const [index, item] of protocol.entries()) {
    const { signature, publicKey, receipt, recipientPublicKey, verified, ...body } = item;
    assert.equal(verified, true);
    assert.equal(body.sequence, index + 1);
    assert.equal(body.previousHash, previousHash);
    assert(verifyObject(body, signature, publicKey));
    assert(verifyObject(receipt.body, receipt.signature, recipientPublicKey));
    assert.equal(receipt.body.envelopeHash, hashPayload(body));
    previousHash = hashPayload(body);
  }
  assert.notEqual(protocol[0].publicKey, protocol[1].publicKey);
  assert(!JSON.stringify(protocol).includes('PRIVATE_ALICE'));
  assert(!JSON.stringify(protocol).includes('Private Bob topic'));
  assert(!JSON.stringify(protocol.slice(0, 2)).includes('alice:EventDescription'));
}

test('both isolated workers sign task modules, decide independently and acknowledge exact mapping versions', async t => {
  const { manager, ref, initialized } = await setup(t);
  assertSignedProtocol(initialized.protocol);
  assert.equal(initialized.ontologyDialogue.status, 'accepted');
  const native = await manager.ontologyStatus(ref);
  assert.equal(native.Alice.ownOntologyId, 'urn:demo:alice:calendar');
  assert.equal(native.Bob.ownOntologyId, 'urn:demo:bob:appointments');
  assert.equal(native.Bob.dialogues.schedule.registry.facts.length, 0);
  assert.equal((await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.type, 'no_match');
});

test('synthetic replay initializes no mapping and never sends ontology dialogue messages', async t => {
  const methods = [];
  const original = WorkerClient.prototype.call;
  t.mock.method(WorkerClient.prototype, 'call', function(method, args, timeout) {
    methods.push(method);
    return original.call(this, method, args, timeout);
  });
  const { manager, ref, initialized } = await setup(t, {}, { mode: 'replay', ontologyDialogue: null });
  assert.equal(initialized.ontologyDialogue, null);
  assert.deepEqual(initialized.protocol, []);
  assert(methods.every(method => ['status', 'initialize'].includes(method)));
  const native = await manager.ontologyStatus(ref);
  assert.deepEqual(native.Alice.dialogues, {});
  assert.deepEqual(native.Bob.dialogues, {});
});

test('valid peer signatures cannot smuggle excluded modules, reorder moves or inject an unacknowledged registry', async t => {
  const bob = createAgentRuntime({ role: 'Bob' });
  t.after(() => bob.close());
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dialogue = createOntologyDialogue();
  const ref = { sessionId: t.name, epoch: 1 };
  const ontologyContext = { scenario: dialogue.scenario, task: dialogue.task };
  await bob.call('initialize', { ...ref, mode: 'controlled', configRevision: 1, bobConfig: DEFAULT_BOB_CONFIG,
    ontologyContext, ownOntology: ontologyDefinitions().Bob, peerPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  const round = { roundId: hashPayload('forged-round'), roundRevision: 1 };
  const modules = dialogue.selectedModules.filter(item => item.owner === 'Alice');
  const envelope = (sequence, selected) => {
    const payload = { ontologyId: ontologyDefinitions().Alice.id, ontologyVersion: ontologyDefinitions().Alice.version, task: dialogue.task, modules: selected };
    const body = { version: 1, channel: 'ontology', from: 'Alice', to: 'Bob', ...ref, ...round,
      sequence, previousHash: null, kind: 'module', move: 'join', payload, payloadHash: hashPayload(payload) };
    return { body, signature: signObject(body, privateKey) };
  };
  await assert.rejects(bob.call('receiveOntology', { ...ref, ontologyContext, envelope: envelope(2, modules) }), { code: 'ONTOLOGY_PROTOCOL_ORDER' });
  await assert.rejects(bob.call('receiveOntology', { ...ref, ontologyContext,
    envelope: envelope(1, [...modules, ontologyDefinitions().Alice.modules.find(item => item.id === 'alice:details')]) }), { code: 'ONTOLOGY_MODULE_CHANGED' });
  await bob.call('receiveOntology', { ...ref, ontologyContext, envelope: envelope(1, modules) });
  await assert.rejects(bob.call('updateOntology', { ...ref, ...round, dialogue }), { code: 'ONTOLOGY_NOT_ACKNOWLEDGED' });
});

test('a staged ambiguous dialogue blocks data interpretation until owner clarification and dual acknowledgments', async t => {
  const pending = startOntologyDialogue({ scenario: 'ambiguous' });
  const { manager, ref, initialized } = await setup(t, {}, { ontologyDialogue: pending, alignReview: true });
  assert.equal(initialized.protocol.length, 0);
  await assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'ONTOLOGY_NOT_ALIGNED' });
  await assert.rejects(manager.negotiateOntology({ ...ref, dialogue: pending }), { code: 'ONTOLOGY_CLARIFICATION_REQUIRED' });
  const accepted = resolveOntologyDialogue(pending, { decision: 'clarify', calendarFreeMeansBookable: true });
  const negotiated = await manager.negotiateOntology({ ...ref, dialogue: accepted, liveProposal: false });
  assertSignedProtocol(negotiated.protocol);
  assert.equal(negotiated.dialogue.registry.mappings.find(item => item.id === 'map:free-meaning').relation, 'conditional');
});

test('Friday projections register only signed received native facts and scheduling uses the registered duration', async t => {
  const ontologyDialogue = createOntologyDialogue({ task: { type: 'schedule', durationMinutes: 45 } });
  const { manager, ref, initialized } = await setup(t, {}, { ontologyDialogue });
  const projection = await manager.projectAlice({ ...ref, stage: 'additional', choice: 'narrow', days: ['Fri'] });
  assert.equal(projection.window, 'Fri');
  const request = { ...ref, operationId: 'friday-data', ...projection, payloadHash: hashPayload(projection) };
  const delivered = await manager.deliverToBob(request);
  assert.equal(delivered.receipt.mappingVersion, initialized.ontologyDialogue.registry.mappingVersion);
  assert.equal(delivered.receipt.ontologyTask, 'schedule');
  const native = (await manager.ontologyStatus(ref)).Bob.dialogues.schedule;
  assert.deepEqual(native.registry.facts[0].values, { weekday: 5, startMinute: 900, endMinute: 960, bookable: true });
  assert.equal(native.registry.facts[0].receiptId, 'friday-data');
  const meeting = (await manager.planBob({ ...ref, purpose: 'additional', configRevision: 1 })).action.meeting;
  assert.deepEqual(meeting, { day: 'Fri', time: '15:00–15:45' });
  assert.deepEqual(await manager.verifyReceipt({ ...request, direction: 'bob' }), delivered);
  const forged = { ...projection, rows: [{ day: 'Fri', time: '12:00–13:00', status: 'Free' }] };
  await assert.rejects(manager.deliverToBob({ ...ref, operationId: 'forged', ...forged, payloadHash: hashPayload(forged) }), { code: 'INVALID_PROJECTION' });
});

test('optional topic and agenda tasks align separately while preserving the schedule registry and old receipts', async t => {
  const { manager, ref, config } = await setup(t);
  for (const field of ['topic', 'agenda']) {
    const dialogue = createOntologyDialogue({ task: { type: 'brief', fields: [field] } });
    const negotiated = await manager.negotiateOntology({ ...ref, dialogue, liveProposal: false });
    assertSignedProtocol(negotiated.protocol);
    assert.deepEqual(negotiated.protocol[0].payload.modules.map(item => item.id), ['alice:brief']);
    const fields = [field], values = { [field]: config.data.brief[field] };
    const receipt = await manager.deliverToAlice({ ...ref, operationId: `brief-${field}`, fields, values, payloadHash: hashPayload({ fields, values }) });
    assert.equal(receipt.receipt.mappingVersion, dialogue.registry.mappingVersion);
    const native = await manager.ontologyStatus(ref);
    assert.deepEqual(native.Alice.dialogues.brief.registry.facts[0].values, values);
    assert.equal(native.Bob.dialogues.schedule.status, 'accepted');
  }
});

test('custom brief fields remain exact received data and cannot inherit a scheduling or partial briefing mapping', async t => {
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.data.brief = { topic: 'Recognized topic', customField: 'Opaque custom value', status: 'A briefing status, not calendar occupancy' };
  const { manager, ref } = await setup(t, {}, { bobConfig: config });
  const topic = createOntologyDialogue({ task: { type: 'brief', fields: ['topic'] } });
  await manager.negotiateOntology({ ...ref, dialogue: topic, liveProposal: false });
  const fields = ['topic', 'customField'], values = { topic: config.data.brief.topic, customField: config.data.brief.customField };
  const request = { ...ref, operationId: 'custom-brief', resource: 'meeting_brief', fields, values, payloadHash: hashPayload({ fields, values }) };
  const delivered = await manager.deliverToAlice(request);
  assert.equal(delivered.receipt.mappingVersion, undefined);
  assert.equal(delivered.receipt.ontologyTask, undefined);
  assert.deepEqual(await manager.verifyReceipt({ ...request, direction: 'alice' }), delivered);
  const native = await manager.ontologyStatus(ref);
  assert.equal(native.Alice.dialogues.brief.registry.facts.length, 0);
  assert.equal(native.Alice.dialogues.schedule.registry.facts.length, 0);
  const statusFields = ['status'], statusValues = { status: config.data.brief.status };
  const statusReceipt = await manager.deliverToAlice({ ...ref, operationId: 'brief-status', resource: 'meeting_brief',
    fields: statusFields, values: statusValues, payloadHash: hashPayload({ fields: statusFields, values: statusValues }) });
  assert.equal(statusReceipt.receipt.mappingVersion, undefined);
});

test('a custom brief field named time keeps its own string meaning and still rejects invented values', async t => {
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.data.brief = { time: 'After the draft is ready, rather than a clock interval' };
  const { manager, ref } = await setup(t, {}, { bobConfig: config });
  const fields = ['time'], values = config.data.brief;
  const delivered = await manager.deliverToAlice({ ...ref, operationId: 'custom-time', resource: 'meeting_brief', fields, values,
    payloadHash: hashPayload({ fields, values }) });
  assert.equal(delivered.receipt.status, 'received');
  assert.equal(delivered.receipt.mappingVersion, undefined);
  const invented = { time: 'Before the draft is ready' };
  await assert.rejects(manager.deliverToAlice({ ...ref, operationId: 'invented-time', resource: 'meeting_brief', fields, values: invented,
    payloadHash: hashPayload({ fields, values: invented }) }), { code: 'INVALID_BOB_DATA' });
});

test('Live models select only disclosed candidates; none is a real rejection and Guided recovery is explicit', async t => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const context = JSON.parse(body.messages.find(item => item.role === 'user').content);
    requests.push({ context, schema: body.tools[0].function.parameters });
    const selection = context.stage === 'propose' ? { decision: 'accept', selectedMappingIds: context.candidates.map(item => item.id) }
      : { decision: 'none', selectedMappingIds: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ message: 'Only supplied definitions were considered.', ...selection }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const pending = startOntologyDialogue({ mode: 'live' });
  const { manager, ref } = await setup(t, { modelBaseUrl: `http://127.0.0.1:${server.address().port}`, modelName: 'test-selector', modelTimeoutMs: 1000 },
    { mode: 'live', ontologyDialogue: pending, alignReview: true });
  const accepted = resolveOntologyDialogue(pending, { decision: 'accept' });
  const live = await manager.negotiateOntology({ ...ref, dialogue: accepted, liveProposal: true });
  assert.equal(live.dialogue.status, 'rejected');
  assert.equal(live.dialogue.proposal.source, 'model');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(item => item.context.stage), ['propose', 'decide']);
  assert(requests.every(item => item.schema.additionalProperties === false));
  assert(!JSON.stringify(requests).includes('PRIVATE_ALICE'));
  assert(!JSON.stringify(requests).includes('Private Bob agenda'));
  await assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'ONTOLOGY_NOT_ALIGNED' });
  const guided = await manager.negotiateOntology({ ...ref, dialogue: accepted, liveProposal: false });
  assert.equal(guided.dialogue.status, 'accepted');
  assert.equal(requests.length, 2);
  assertSignedProtocol(guided.protocol);
});
