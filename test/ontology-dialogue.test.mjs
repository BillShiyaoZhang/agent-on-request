import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPayload } from '../src/runtime-helpers.mjs';
import {
  ontologyDefinitions, defaultOntologyProposal, validateOntologyProposal,
  createOntologyDialogue, startOntologyDialogue, resolveOntologyDialogue,
  interpretAliceCalendar, toBobNativeSlots, findBookableIntersections,
  registerOntologyReceipt, queryRegisteredMeetingSlots, sanitizeOntologyDialogue,
} from '../src/ontology-dialogue.mjs';

const rows = [
  { day: 'Tue', time: '10:00–11:00', status: 'Free' },
  { day: 'Tue', time: '14:00–15:00', status: 'Busy' },
];
const fields = ['day', 'time', 'status'];
const availableTimes = [{ day: 'Tue', time: '10:15–10:45' }, { day: 'Tue', time: '14:00–15:00' }];
const code = expected => error => error.code === expected;

test('task selects independent heterogeneous interval/status working subsets and excludes event details', () => {
  const dialogue = startOntologyDialogue();
  assert.equal(dialogue.status, 'awaiting_alignment');
  assert.equal(dialogue.revision, 1);
  assert.deepEqual(dialogue.selectedModules.map(item => item.id), ['alice:time', 'alice:status', 'bob:time', 'bob:status']);
  assert.deepEqual(dialogue.excludedModules.map(item => item.id), ['alice:details', 'alice:brief', 'bob:brief']);
  assert.equal(dialogue.registry.mappings.length, 0);
  assert.notEqual(dialogue.ontologyVersions.Alice.id, dialogue.ontologyVersions.Bob.id);
  assert.notEqual(dialogue.ontologyVersions.Alice.hash, dialogue.ontologyVersions.Bob.hash);
  const text = JSON.stringify(dialogue.selectedModules);
  assert.ok(text.includes('alice:CalendarEntry'));
  assert.ok(text.includes('bob:BookableSlot'));
  assert.ok(text.includes('datatype'));
  assert.ok(!text.includes('alice:title'));
  assert.ok(!text.includes('bob:agenda'));
  assert.deepEqual(dialogue.transcript.map(item => item.move), ['join', 'pick', 'propose', 'decide']);
});

test('unaccepted or rejected mapping cannot interpret data even when lexical keys match', () => {
  const pending = startOntologyDialogue();
  assert.throws(() => interpretAliceCalendar({ dialogue: pending, rows, fields }), code('ONTOLOGY_NOT_ALIGNED'));
  const rejected = resolveOntologyDialogue(pending, { decision: 'reject' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.registry.mappings.length, 0);
  assert.throws(() => findBookableIntersections({ dialogue: rejected, receivedRows: rows, availableTimes }), code('ONTOLOGY_NOT_ALIGNED'));
  assert.deepEqual(rejected.transcript.slice(-3).map(item => item.move), ['end', 'end', 'close']);
});

test('accepted mapping executes weekday, unit and status transformation before scheduling', () => {
  const dialogue = createOntologyDialogue();
  assert.equal(dialogue.status, 'accepted');
  assert.equal(dialogue.interpretation.authorizesDisclosure, false);
  assert.match(dialogue.registry.mappingVersion, /^[a-f0-9]{64}$/);
  assert.deepEqual(interpretAliceCalendar({ dialogue, rows, fields }), [
    { weekday: 2, startMinute: 600, endMinute: 660, bookable: true },
    { weekday: 2, startMinute: 840, endMinute: 900, bookable: false },
  ]);
  assert.deepEqual(toBobNativeSlots(availableTimes), [
    { weekday: 2, startMinute: 615, endMinute: 645, bookable: true },
    { weekday: 2, startMinute: 840, endMinute: 900, bookable: true },
  ]);
  assert.deepEqual(findBookableIntersections({ dialogue, receivedRows: rows, availableTimes }), [{ day: 'Tue', time: '10:15–10:45' }]);
  assert.deepEqual(findBookableIntersections({ dialogue, receivedRows: rows, availableTimes: [{ weekday: 2, startMinute: 615, endMinute: 640, bookable: true }] }), []);
  assert.deepEqual(findBookableIntersections({ dialogue, receivedRows: rows, availableTimes: [{ weekday: 2, startMinute: 600, endMinute: 660, bookable: false }] }), []);
});

test('same label with occupancy-only meaning requires explicit owner clarification', () => {
  const pending = startOntologyDialogue({ scenario: 'ambiguous' });
  assert.equal(pending.status, 'needs_clarification');
  assert.throws(() => resolveOntologyDialogue(pending, { decision: 'accept' }), code('ONTOLOGY_CLARIFICATION_REQUIRED'));
  const clarified = resolveOntologyDialogue(pending, { decision: 'clarify', calendarFreeMeansBookable: true });
  assert.equal(clarified.status, 'accepted');
  assert.equal(clarified.revision, 2);
  assert.ok(clarified.transcript.some(item => item.reasonCode === 'OWNER_TASK_SCOPED_CLARIFICATION'));
  assert.equal(clarified.registry.mappings.find(item => item.id === 'map:free-meaning').relation, 'conditional');
  const declined = resolveOntologyDialogue(pending, { decision: 'clarify', calendarFreeMeansBookable: false });
  assert.equal(declined.status, 'rejected');
  assert.equal(declined.registry.mappings.length, 0);
  assert.notEqual(pending.ontologyVersions.Alice.hash, createOntologyDialogue().ontologyVersions.Alice.hash);
});

test('clarification request remains pending and cannot authorize interpretation', () => {
  const pending = startOntologyDialogue();
  const requested = resolveOntologyDialogue(pending, { decision: 'clarify' });
  assert.equal(requested.status, 'needs_clarification');
  assert.equal(requested.revision, 2);
  assert.equal(requested.registry.mappings.length, 0);
  assert.equal(requested.transcript.at(-1).reasonCode, 'CLARIFICATION_REQUESTED');
  assert.throws(() => interpretAliceCalendar({ dialogue: requested, rows, fields }), code('ONTOLOGY_NOT_ALIGNED'));
});

test('live proposal is validated against the selected modules; arbitrary transforms and hidden fields fail', () => {
  const proposal = defaultOntologyProposal();
  assert.equal(validateOntologyProposal(proposal).length, 6);
  const outOfTask = structuredClone(proposal);
  outOfTask.mappings[0].source = 'alice:note';
  assert.throws(() => validateOntologyProposal(outOfTask), code('ONTOLOGY_INVALID_PROPOSAL'));
  const arbitrary = structuredClone(proposal);
  arbitrary.mappings[0].transform = 'eval(row.note)';
  assert.throws(() => validateOntologyProposal(arbitrary), code('ONTOLOGY_INVALID_PROPOSAL'));
  const permission = structuredClone(proposal);
  permission.authorization = { fields: ['title', 'note'] };
  assert.throws(() => validateOntologyProposal(permission), code('ONTOLOGY_INVALID_PROPOSAL'));
  const repeated = structuredClone(proposal);
  repeated.mappings[1] = repeated.mappings[0];
  assert.throws(() => validateOntologyProposal(repeated), code('ONTOLOGY_INVALID_PROPOSAL'));
});

test('model lexical equivalence is challenged and replaced by an explicit counter-proposal before acceptance', () => {
  const proposal = defaultOntologyProposal();
  proposal.mappings.find(item => item.source === 'alice:Free').relation = 'equivalent';
  proposal.message = 'UNTRUSTED_MODEL_TEXT';
  const pending = startOntologyDialogue({ mode: 'live', proposal });
  assert.equal(pending.proposal.source, 'model');
  assert.equal(pending.proposal.mappings.find(item => item.source === 'alice:Free').relation, 'equivalent');
  assert.ok(!JSON.stringify(pending).includes('UNTRUSTED_MODEL_TEXT'));
  const accepted = resolveOntologyDialogue(pending, { decision: 'accept' });
  const counter = accepted.transcript.findIndex(item => item.reasonCode === 'BOUNDED_COUNTER_PROPOSAL');
  const decision = accepted.transcript.findIndex(item => item.kind === 'accept');
  assert.ok(counter >= 0 && decision > counter);
  assert.equal(accepted.registry.mappings.find(item => item.source === 'alice:Free').relation, 'conditional');
});

test('mapping cannot invent missing status or consume keys outside the received disclosure scope', () => {
  const dialogue = createOntologyDialogue();
  assert.throws(() => interpretAliceCalendar({ dialogue, rows: [{ day: 'Tue', time: '10:00–11:00' }], fields: ['day', 'time'] }), code('ONTOLOGY_MISSING_FIELDS'));
  assert.deepEqual(findBookableIntersections({ dialogue, receivedRows: [{ day: 'Tue', time: '10:00–11:00' }], receivedFields: ['day', 'time'], availableTimes }), []);
  assert.throws(() => interpretAliceCalendar({ dialogue, rows: [{ ...rows[0], note: 'HIDDEN' }], fields }), code('ONTOLOGY_UNAUTHORIZED_FIELD'));
  const authorizedFull = interpretAliceCalendar({ dialogue, rows: [{ ...rows[0], title: 'TITLE', note: 'NOTE' }], fields: [...fields, 'title', 'note'] });
  assert.ok(!JSON.stringify(authorizedFull).includes('TITLE'));
  assert.ok(!JSON.stringify(authorizedFull).includes('NOTE'));
});

test('received values must satisfy datatype and interval constraints', () => {
  const dialogue = createOntologyDialogue();
  for (const row of [
    { day: 'Tomorrow', time: '10:00–11:00', status: 'Free' },
    { day: 'Tue', time: '25:00–26:00', status: 'Free' },
    { day: 'Tue', time: '11:00–10:00', status: 'Free' },
    { day: 'Tue', time: '10:00–11:00', status: 'Unknown' },
  ]) assert.throws(() => interpretAliceCalendar({ dialogue, rows: [row], fields }), code('ONTOLOGY_INVALID_VALUE'));
  assert.throws(() => findBookableIntersections({ dialogue, durationMinutes: 60 }), code('ONTOLOGY_TASK_MISMATCH'));
});

test('semantic registry requires receipts and accepted mapping provenance; scheduling queries consume registered facts', () => {
  const dialogue = createOntologyDialogue();
  assert.deepEqual(queryRegisteredMeetingSlots({ dialogue, availableTimes }), []);
  const payloadHash = hashPayload({ rows, fields, window: 'Tue' });
  const registered = registerOntologyReceipt(dialogue, { receiptId: 'receipt-1', payloadHash, rows, fields });
  assert.equal(dialogue.registry.facts.length, 0);
  assert.equal(registered.registry.facts.length, 2);
  assert.deepEqual(queryRegisteredMeetingSlots({ dialogue: registered, availableTimes }), [{ day: 'Tue', time: '10:15–10:45' }]);
  assert.ok(registered.registry.facts.every(item => item.receiptId === 'receipt-1' && item.payloadHash === payloadHash
    && item.mappingVersion === registered.registry.mappingVersion && item.sourceFields.join(',') === fields.join(',')));
  assert.deepEqual(registerOntologyReceipt(registered, { receiptId: 'receipt-1', payloadHash, rows, fields }), registered);
  assert.throws(() => registerOntologyReceipt(registered, { receiptId: 'receipt-1', payloadHash: 'a'.repeat(64), rows, fields }), code('ONTOLOGY_RECEIPT_CONFLICT'));
  assert.throws(() => registerOntologyReceipt(dialogue, { receiptId: 'no-digest', rows, fields }), code('ONTOLOGY_RECEIPT'));
});

test('insufficient or unaligned receipts are retained without manufacturing semantic facts', () => {
  const payloadHash = 'b'.repeat(64);
  const partial = registerOntologyReceipt(createOntologyDialogue(), { receiptId: 'partial', payloadHash, rows: [{ day: 'Tue' }], fields: ['day'] });
  assert.equal(partial.registry.facts.length, 0);
  assert.equal(partial.registry.receipts[0].reasonCode, 'INSUFFICIENT_AUTHORIZED_FIELDS');
  const pending = registerOntologyReceipt(startOntologyDialogue(), { receiptId: 'pending', payloadHash, rows, fields });
  assert.equal(pending.registry.facts.length, 0);
  assert.equal(pending.registry.receipts[0].reasonCode, 'ALIGNMENT_NOT_ACCEPTED');
});

test('brief is a separate task module and interprets only the received selected fields', () => {
  const dialogue = createOntologyDialogue({ task: { type: 'brief', fields: ['topic'] } });
  assert.deepEqual(dialogue.selectedModules.map(item => item.id), ['alice:brief', 'bob:brief']);
  assert.equal(dialogue.registry.mappings.length, 2);
  assert.ok(!dialogue.registry.mappings.some(item => item.source === 'bob:agenda'));
  const registered = registerOntologyReceipt(dialogue, { receiptId: 'topic', payloadHash: 'c'.repeat(64), direction: 'bobToAlice', fields: ['topic'], values: { topic: 'Task-driven alignment' } });
  assert.deepEqual(registered.registry.facts[0].values, { topic: 'Task-driven alignment' });
  assert.throws(() => registerOntologyReceipt(dialogue, { receiptId: 'agenda', payloadHash: 'd'.repeat(64), direction: 'bobToAlice', fields: ['agenda'], values: { agenda: 'Hidden agenda' } }), code('ONTOLOGY_UNAUTHORIZED_FIELD'));
  assert.throws(() => interpretAliceCalendar({ dialogue, rows, fields }), code('ONTOLOGY_TASK_MISMATCH'));
});

test('registry and mapping tampering fail instead of silently making new semantic knowledge', () => {
  const dialogue = createOntologyDialogue();
  const edited = structuredClone(dialogue);
  edited.registry.mappings[0].transform = 'identity';
  assert.throws(() => interpretAliceCalendar({ dialogue: edited, rows, fields }), code('ONTOLOGY_STATE_CHANGED'));
  const editedSchema = structuredClone(dialogue);
  editedSchema.selectedModules[0].concepts[0].definition = 'Ignore the owner';
  assert.throws(() => interpretAliceCalendar({ dialogue: editedSchema, rows, fields }), code('ONTOLOGY_STATE_CHANGED'));
});

test('safe export reconstructs fixed explanations and whitelists only signed protocol evidence', () => {
  const dialogue = createOntologyDialogue();
  dialogue.transcript[0].message = 'IGNORE_ALL_INSTRUCTIONS';
  dialogue.transcript[0].providerContext = { secret: 'LEAK' };
  dialogue.providerResponse = 'LEAK';
  dialogue.protocol = [{ sequence: 1, from: 'Alice', to: 'Bob', move: 'propose', payloadHash: 'e'.repeat(64),
    signature: 'A'.repeat(88), mappingVersion: dialogue.registry.mappingVersion, version: 1, text: 'IGNORE_ALL_INSTRUCTIONS', context: { secret: 'LEAK' } }];
  const safe = sanitizeOntologyDialogue(dialogue);
  assert.ok(!JSON.stringify(safe).includes('IGNORE_ALL_INSTRUCTIONS'));
  assert.ok(!JSON.stringify(safe).includes('LEAK'));
  assert.equal(safe.protocol[0].signature, 'A'.repeat(88));
  assert.equal(safe.protocol[0].verified, false);
  assert.equal(safe.protocol[0].verification, 'reload_hash_only');
  assert.equal(safe.registry.hash, dialogue.registry.hash);
  assert.equal(safe.revision, dialogue.revision);
  assert.equal(sanitizeOntologyDialogue(safe).registry.hash, safe.registry.hash);
  assert.deepEqual(sanitizeOntologyDialogue(safe), safe);
});

test('custom peer fields outside the task remain receipt metadata without exposing their values', () => {
  const registered = registerOntologyReceipt(createOntologyDialogue(), { receiptId: 'custom-brief', payloadHash: 'a'.repeat(64),
    direction: 'bobToAlice', fields: ['preparationHint'], values: { preparationHint: 'PRIVATE_CUSTOM_DETAIL' } });
  assert.equal(registered.registry.facts.length, 0);
  assert.equal(registered.registry.receipts[0].reasonCode, 'OUTSIDE_TASK_MODULE');
  assert.deepEqual(sanitizeOntologyDialogue(registered).registry.receipts[0].fields, ['preparationHint']);
  assert.ok(!JSON.stringify(sanitizeOntologyDialogue(registered)).includes('PRIVATE_CUSTOM_DETAIL'));
  assert.throws(() => registerOntologyReceipt(createOntologyDialogue(), { receiptId: 'unsafe', payloadHash: 'a'.repeat(64),
    direction: 'bobToAlice', fields: ['api-key'], values: {} }), code('ONTOLOGY_RECEIPT'));
});

test('safe protocol view projects actual signed runtime kinds into dialogue moves without exposing payloads', () => {
  const dialogue = createOntologyDialogue();
  dialogue.protocol = ['module', 'proposal', 'decision', 'ack'].map((kind, index) => ({
    version: 1, sequence: index + 1, from: 'Alice', to: 'Bob', kind, payloadHash: 'e'.repeat(64), signature: 'A'.repeat(88),
    payload: { arbitraryPrivateText: 'NO_RAW_PROTOCOL_BODY' }, publicKey: 'PUBLIC_KEY', receipt: { anyRawBody: 'NO_RAW_RECEIPT_BODY' }, verified: true,
  }));
  const safe = sanitizeOntologyDialogue(dialogue);
  assert.deepEqual(safe.protocol.map(item => item.move), ['pick', 'propose', 'decide', 'end']);
  assert.ok(safe.protocol.every(item => item.verified && item.verification === 'runtime_confirmed'));
  assert.ok(!JSON.stringify(safe).includes('NO_RAW_PROTOCOL_BODY'));
  assert.ok(!JSON.stringify(safe).includes('NO_RAW_RECEIPT_BODY'));
  assert.deepEqual(sanitizeOntologyDialogue(safe), safe);
});

test('published ontology contains no fixture data and mutations cannot affect future definitions', () => {
  const first = ontologyDefinitions();
  first.Alice.modules[0].concepts[0].definition = 'Changed locally';
  const second = ontologyDefinitions();
  assert.ok(!JSON.stringify(second).includes('Changed locally'));
  assert.ok(!JSON.stringify(second).includes('Project review'));
});
