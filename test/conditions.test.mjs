import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionCatalog, conditionSchema, resolveConditions, conditionBobConfig } from '../src/condition-service.mjs';
import { DEFAULT_BOB_CONFIG, validateConfig, hashValue } from '../src/config.mjs';
import { ALICE_CALENDAR } from '../src/scenario.mjs';
import { createAgentRuntime } from '../src/agent-worker.mjs';
import { SessionEngine } from '../src/session-engine.mjs';

function rejects(input, expectedPath, code) {
  assert.throws(() => resolveConditions(input), error => {
    assert.equal(error.code, 'INVALID_CONDITIONS');
    assert.equal(error.status, 422);
    assert.ok(error.details.errors.some(item => item.path === expectedPath && (!code || item.code === code)), JSON.stringify(error.details));
    return true;
  });
}

test('default conditions preserve Alice fixture and current Bob owner template without mutation', () => {
  const template = structuredClone(DEFAULT_BOB_CONFIG);
  template.persona = 'A custom fictional research collaborator';
  template.data.source = 'synthetic-owner-v2';
  template.data.availableTimes = [{ day: 'Wed', time: '11:00–11:30' }];
  template.tools.capabilities = ['read_synthetic_calendar', 'send_scoped_reply'];
  template.permissions.confirmation = 'per_action';
  template.permissions.maxUses = 7;
  const before = structuredClone(template);
  const resolved = resolveConditions(undefined, template);
  assert.equal(resolved.schemaVersion, 1);
  assert.equal(resolved.presetId, 'conference');
  assert.deepEqual(resolved.agents.Alice.data.calendar, ALICE_CALENDAR);
  assert.deepEqual(resolved.agents.Bob.data.availableTimes, template.data.availableTimes);
  assert.deepEqual(resolved.agents.Bob.skills, template.tools.capabilities);
  assert.deepEqual(resolved.agents.Bob.authorization, template.permissions);
  assert.deepEqual(conditionBobConfig(resolved, template), template);
  assert.deepEqual(resolveConditions({ presetId: 'conference' }, template), resolved);
  const catalog = conditionCatalog(template);
  assert.deepEqual(resolveConditions(catalog.defaultInput, template), resolved);
  assert.deepEqual(resolveConditions({ presetId: 'conference', componentIds: catalog.presets[0].componentIds }, template), resolved);
  assert.deepEqual(catalog.components.find(item => item.id === 'bob-data-template').patch.data.availableTimes, template.data.availableTimes);
  assert.deepEqual(template, before);
});

test('catalog presents validated distinct presets, role-aware components and registered skills', () => {
  const catalog = conditionCatalog();
  assert.ok(catalog.presets.length >= 4);
  assert.ok(catalog.components.length >= 12);
  assert.equal(new Set(catalog.components.map(item => item.id)).size, catalog.components.length);
  for (const preset of catalog.presets) {
    const resolved = resolveConditions({ presetId: preset.id });
    assert.deepEqual(preset.agents, resolved.agents);
    assert.ok(validateConfig(conditionBobConfig(resolved)).valid);
  }
  const minimal = resolveConditions({ presetId: 'minimal' });
  assert.ok(minimal.agents.Alice.data.calendar.every(row => row.status === 'Free'));
  assert.deepEqual(minimal.agents.Alice.authorization.fields, ['day', 'time', 'status']);
  assert.ok(!minimal.agents.Bob.skills.includes('share_brief'));
  assert.equal(resolveConditions({ presetId: 'broad-review' }).agents.Bob.authorization.confirmation, 'per_action');
  assert.ok(resolveConditions({ presetId: 'shared-context' }).agents.Bob.authorization.fields.includes('topic'));
  assert.ok(!resolveConditions({ presetId: 'shared-context' }).agents.Bob.authorization.fields.includes('agenda'));
});

test('category components override presets and custom patches merge afterward', () => {
  const input = {
    presetId: 'minimal',
    componentIds: { Alice: ['alice-kg-research', 'alice-auth-standard'], Bob: ['bob-data-thursday'] },
    custom: { Alice: { authorization: { maxUses: 4, fields: ['day', 'time'] } }, Bob: { data: { brief: { topic: 'A new fictional topic' } } } }
  };
  const before = structuredClone(input);
  const resolved = resolveConditions(input);
  assert.equal(resolved.agents.Alice.kg.nodes.length, 4);
  assert.equal(resolved.agents.Alice.data.calendar.length, 3);
  assert.equal(resolved.agents.Alice.authorization.maxUses, 4);
  assert.deepEqual(resolved.agents.Alice.authorization.fields, ['day', 'time']);
  assert.deepEqual(resolved.agents.Alice.authorization.windows, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(resolved.agents.Bob.data.availableTimes[0].day, 'Thu');
  assert.equal(resolved.agents.Bob.data.brief.topic, 'A new fictional topic');
  assert.equal(resolved.agents.Bob.data.brief.agenda, DEFAULT_BOB_CONFIG.data.brief.agenda);
  assert.ok(resolved.componentIds.Alice.includes('alice-auth-standard'));
  assert.ok(!resolved.componentIds.Alice.includes('alice-auth-minimal'));
  assert.deepEqual(resolveConditions(resolved), resolved);
  assert.deepEqual(input, before);
});

test('fully custom pack starts empty and accepts a complete user-authored fixture', () => {
  const empty = resolveConditions({ presetId: 'custom' });
  for (const role of ['Alice', 'Bob']) { assert.deepEqual(empty.agents[role].skills, []); assert.deepEqual(empty.agents[role].kg, { nodes: [], edges: [] }); }
  assert.deepEqual(empty.agents.Alice.authorization.fields, []);
  assert.deepEqual(empty.agents.Alice.authorization.windows, []);
  assert.deepEqual(empty.agents.Bob.authorization.recipients, []);
  const resolved = resolveConditions({ presetId: 'custom', custom: {
    Alice: {
      kg: { nodes: [{ id: 'owner', label: 'Alice 的研究日程', type: 'resource' }], edges: [] },
      data: { calendar: [{ day: 'Mon', time: '09:00-10:00', status: 'Free', title: '', note: 'Fictional note\nSecond line' }] },
      skills: ['read_synthetic_calendar', 'preview_scoped_calendar', 'send_scoped_snapshot'],
      authorization: { fields: ['day', 'time'], windows: ['Mon'], maxUses: 1, expiryMinutes: 2 }
    },
    Bob: { data: { availableTimes: [{ day: 'Mon', time: '09:30-10:00' }], brief: { topic: 'Fictional topic', agenda: 'First\nSecond' } }, authorization: { recipients: ['Alice'], fields: ['day', 'time'], resources: ['availability'], window: 'Mon-Fri', confirmation: 'bounded' }, skills: ['read_synthetic_calendar', 'send_scoped_reply'] }
  } });
  assert.equal(resolved.agents.Alice.data.calendar[0].time, '09:00–10:00');
  assert.equal(resolved.agents.Bob.authorization.window, 'Mon,Tue,Wed,Thu,Fri');
  assert.equal(conditionBobConfig(resolved).data.availableTimes[0].time, '09:30–10:00');
});

test('conflicting, unknown and wrong-role components have actionable paths', () => {
  rejects({ componentIds: { Alice: ['alice-data-calendar', 'alice-data-free'] } }, '$.componentIds.Alice[1]', 'COMPONENT_CONFLICT');
  rejects({ componentIds: { Alice: ['bob-data-thursday'] } }, '$.componentIds.Alice[0]', 'COMPONENT_ROLE');
  rejects({ componentIds: { Bob: ['not-a-component'] } }, '$.componentIds.Bob[0]', 'UNKNOWN_COMPONENT');
  rejects({ presetId: 'not-a-pack' }, '$.presetId', 'UNKNOWN_PRESET');
  rejects({ componentIds: { Eve: [] } }, '$.componentIds.Eve', 'UNKNOWN_FIELD');
});

test('unknown fields cannot silently request real data, tools or policy broadening', () => {
  rejects({ custom: { Alice: { data: { filePath: 'C:/private/calendar.ics' } } } }, '$.custom.Alice.data.filePath', 'UNKNOWN_FIELD');
  rejects({ custom: { Bob: { data: { source: 'https://calendar.example' } } } }, '$.custom.Bob.data.source', 'UNKNOWN_FIELD');
  rejects({ custom: { Alice: { tools: ['filesystem'] } } }, '$.custom.Alice.tools', 'UNKNOWN_FIELD');
  rejects({ custom: { Alice: { authorization: { recipients: ['Eve'] } } } }, '$.custom.Alice.authorization.recipients', 'UNKNOWN_FIELD');
  rejects({ custom: { Bob: { authorization: { recipients: [''] } } } }, '$.custom.Bob.authorization.recipients[0]');
  assert.deepEqual(resolveConditions({ custom: { Bob: { skills: ['filesystem'] } } }).agents.Bob.skills, ['filesystem'], 'Custom labels are inert metadata; registered actions retain their explicit checks.');
  rejects({ custom: { Alice: { skills: ['share_brief'] } } }, '$.custom.Alice.skills[0]', 'UNKNOWN_VALUE');
});

test('credentials and prototype mutation are rejected before merging or accessor evaluation', () => {
  rejects({ custom: { Bob: { apiKey: 'secret-value' } } }, '$.custom.Bob.apiKey', 'CREDENTIAL');
  rejects({ custom: { Bob: { data: { brief: { topic: 'Bearer 1234567890abcdefghijkl' } } } } }, '$.custom.Bob.data.brief.topic', 'CREDENTIAL');
  rejects({ custom: { Bob: { data: { brief: { authorization: 'Bearer private-value' } } } } }, '$.custom.Bob.data.brief.authorization', 'CREDENTIAL');
  rejects({ custom: { Bob: { data: { brief: { providerKey: 'private-value' } } } } }, '$.custom.Bob.data.brief.providerKey', 'CREDENTIAL');
  rejects({ custom: { Bob: { data: { brief: { tokenHash: 'private-material' } } } } }, '$.custom.Bob.data.brief.tokenHash', 'CREDENTIAL');
  rejects({ custom: { Bob: { data: { brief: { Constructor: 'hidden-prototype-material' } } } } }, '$.custom.Bob.data.brief.Constructor', 'UNSAFE_KEY');
  rejects(JSON.parse('{"custom":{"Alice":{"__proto__":{"polluted":true}}}}'), '$.custom.Alice.__proto__', 'UNSAFE_KEY');
  rejects({ custom: { Bob: { constructor: {} } } }, '$.custom.Bob.constructor', 'UNSAFE_KEY');
  let accessed = false;
  const input = {};
  Object.defineProperty(input, 'custom', { get() { accessed = true; return {}; }, enumerable: true });
  rejects(input, '$.custom', 'NON_JSON');
  assert.equal(accessed, false);
  assert.equal({}.polluted, undefined);
  const template = structuredClone(DEFAULT_BOB_CONFIG);
  template.data.brief.topic = 'Bearer 1234567890abcdefghijkl';
  assert.throws(() => resolveConditions(undefined, template), error => error.details.errors.some(item => item.path === '$.agents.Bob.data.brief.topic' && item.code === 'CREDENTIAL'));
});

test('graph validation rejects dangling endpoints, duplicates, unknown fields and oversized graphs', () => {
  rejects({ custom: { Alice: { kg: { nodes: [], edges: [{ id: 'edge', source: 'gone', target: 'gone', label: 'links' }] } } } }, '$.agents.Alice.kg.edges[0].source', 'GRAPH_REFERENCE');
  rejects({ custom: { Bob: { kg: { nodes: [{ id: 'same', label: 'A', type: 'agent' }, { id: 'same', label: 'B', type: 'agent' }] } } } }, '$.custom.Bob.kg.nodes[1].id', 'DUPLICATE');
  rejects({ custom: { Alice: { kg: { nodes: [{ id: 'own', label: 'Own', type: 'agent', url: 'https://example.com' }] } } } }, '$.custom.Alice.kg.nodes[0].url', 'UNKNOWN_FIELD');
  rejects({ custom: { Alice: { kg: { nodes: Array.from({ length: 201 }, (_, index) => ({ id: `node${index}`, label: `Node ${index}`, type: 'context' })) } } } }, '$.custom.Alice.kg.nodes');
  const complete = resolveConditions({ presetId: 'custom', custom: { Alice: { kg: { nodes: [{ id: 'a', label: 'A', type: 'agent' }, { id: 'b', label: 'B', type: 'task' }], edges: [{ id: 'e', source: 'a', target: 'b', label: 'pursues' }] } } } });
  assert.equal(complete.agents.Alice.kg.edges[0].target, 'b');
});

test('calendar validation checks complete synthetic rows and within-day time semantics', () => {
  rejects({ custom: { Alice: { data: { calendar: [{ day: 'Tuesday', time: '10:00–10:30', status: 'Free', title: '', note: '' }] } } } }, '$.custom.Alice.data.calendar[0].day');
  rejects({ custom: { Alice: { data: { calendar: [{ day: 'Tue', time: '10:00–10:30', status: 'Free' }] } } } }, '$.custom.Alice.data.calendar[0].title');
  for (const time of ['24:00–24:30', '10:60–11:30', '10:00–09:30', '10:00–10:00', '9:00–10:00', '23:30–00:30']) rejects({ custom: { Bob: { data: { availableTimes: [{ day: 'Thu', time }] } } } }, '$.custom.Bob.data.availableTimes[0].time');
  rejects({ custom: { Alice: { data: { calendar: [{ day: 'Tue', time: '10:00–10:30', status: 'Unknown', title: '', note: '' }] } } } }, '$.custom.Alice.data.calendar[0].status');
});

test('authorization validation enforces role scopes, duplicates and bounded budgets', () => {
  rejects({ custom: { Alice: { authorization: { fields: ['day', 'topic'] } } } }, '$.custom.Alice.authorization.fields[1]', 'UNKNOWN_VALUE');
  rejects({ custom: { Alice: { authorization: { windows: ['Tue', 'Tue'] } } } }, '$.custom.Alice.authorization.windows', 'DUPLICATE');
  rejects({ custom: { Bob: { authorization: { resources: [''] } } } }, '$.custom.Bob.authorization.resources[0]');
  rejects({ custom: { Bob: { authorization: { window: 'Fri–Mon' } } } }, '$.custom.Bob.authorization.window');
  rejects({ custom: { Bob: { authorization: { confirmation: '' } } } }, '$.custom.Bob.authorization.confirmation');
  rejects({ custom: { Alice: { authorization: { maxUses: 0 } } } }, '$.custom.Alice.authorization.maxUses');
  rejects({ custom: { Alice: { authorization: { maxUses: 1.5 } } } }, '$.custom.Alice.authorization.maxUses');
  rejects({ custom: { Alice: { authorization: { expiryMinutes: 1441 } } } }, '$.custom.Alice.authorization.expiryMinutes');
});

test('existing owner brief fields, inert policy labels and capabilities remain compatible', () => {
  const template = structuredClone(DEFAULT_BOB_CONFIG);
  template.data.brief = { topic: 'Fictional lab', location: 'Study room', attendees: ['Alice', 'Bob'], context: { study: 'Synthetic permission experiment' } };
  template.permissions.fields.push('location');
  template.permissions.resources.push('meeting_brief', 'synthetic_document');
  template.permissions.recipients.push('Synthetic peer');
  template.permissions.confirmation = 'owner_review';
  template.permissions.window = 'task-specific';
  template.tools.capabilities.push('synthetic_owner_label');
  assert.ok(validateConfig(template).valid);
  const resolved = resolveConditions(undefined, template);
  assert.deepEqual(conditionBobConfig(resolved, template), template);
  assert.ok(conditionCatalog(template).skills.some(skill => skill.id === 'synthetic_owner_label'));
  assert.deepEqual(resolveConditions(resolved, template), resolved);
  assert.ok(resolveConditions({ presetId: 'shared-context' }).agents.Bob.authorization.resources.includes('meeting_brief'));
  const reset = resolveConditions({ componentIds: { Bob: ['bob-data-aligned'] } }, template);
  assert.equal(Object.hasOwn(reset.agents.Bob.data.brief, 'context'), false, 'A complete data-category component must not retain unrelated old template data');
  assert.equal(reset.agents.Bob.data.availableTimes[0].day, 'Tue');
  const patched = resolveConditions({ custom: { Bob: { data: { brief: { topic: 'Updated fictional topic' } } } } }, template);
  assert.deepEqual(patched.agents.Bob.data.brief.context, template.data.brief.context, 'Custom partial patches intentionally preserve untouched values');
});

test('catalog remains usable with a large valid owner fixture without applying the fixture limit to the aggregate', () => {
  const template = structuredClone(DEFAULT_BOB_CONFIG);
  template.data.brief.rows = Array.from({ length: 3000 }, (_, index) => ({ index, category: 'fictional', allowed: true }));
  assert.ok(validateConfig(template).valid);
  const catalog = conditionCatalog(template);
  assert.equal(catalog.presets.find(preset => preset.id === 'conference').agents.Bob.data.brief.rows.length, 3000);
  assert.equal(catalog.components.find(component => component.id === 'bob-data-template').patch.data.brief.rows.length, 3000);
  assert.equal(Object.hasOwn(catalog.presets.find(preset => preset.id === 'minimal').agents.Bob.data.brief, 'rows'), false);
  assert.deepEqual(resolveConditions(catalog.defaultInput, template).agents.Bob.data.brief, template.data.brief);
});

test('resolved fixtures require full schema and reject mixed composition requests', () => {
  const missing = resolveConditions(); delete missing.agents.Alice.kg;
  rejects(missing, '$.agents.Alice.kg');
  const mixed = resolveConditions(); mixed.custom = {};
  rejects(mixed, '$.custom', 'UNKNOWN_FIELD');
  const version = resolveConditions(); version.schemaVersion = 2;
  rejects(version, '$.schemaVersion');
  rejects(null, '$');
  rejects([], '$');
  rejects({ presetId: undefined }, '$.presetId', 'NON_JSON');
});

test('non-JSON and excessive input fail safely with structured errors', () => {
  const cyclic = {}; cyclic.custom = cyclic;
  rejects(cyclic, '$.custom', 'JSON_CYCLE');
  rejects({ custom: new Date() }, '$.custom', 'NON_JSON');
  rejects({ custom: { Alice: { authorization: { maxUses: Infinity } } } }, '$.custom.Alice.authorization.maxUses', 'NON_JSON');
  const sparse = []; sparse.length = 1;
  rejects({ componentIds: { Alice: sparse } }, '$.componentIds.Alice[0]', 'NON_JSON');
});

test('catalog, schema and resolved conditions are independent editable copies', () => {
  const catalog = conditionCatalog(); catalog.presets[0].agents.Alice.data.calendar.length = 0;
  catalog.components[0].patch.kg.nodes[0].label = 'Changed';
  const next = conditionCatalog();
  assert.equal(next.presets[0].agents.Alice.data.calendar.length, ALICE_CALENDAR.length);
  assert.equal(next.components[0].patch.kg.nodes[0].label, 'Alice');
  const resolved = resolveConditions(); resolved.agents.Alice.skills.length = 0;
  assert.ok(resolveConditions().agents.Alice.skills.length > 0);
  const schema = conditionSchema(); schema.$defs.Alice.required.length = 0;
  assert.ok(conditionSchema().$defs.Alice.required.length > 0);
});

test('schema documents strict editable and resolved role shapes without relaxing array entries', () => {
  const schema = conditionSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.oneOf.length, 2);
  const editable = schema.oneOf[0], resolved = schema.oneOf[1];
  assert.equal(editable.additionalProperties, false);
  assert.deepEqual(editable.properties.custom.properties.Alice.required, []);
  assert.deepEqual(editable.properties.custom.properties.Alice.properties.data.properties.calendar.items.required, ['day', 'time', 'status', 'title', 'note']);
  assert.deepEqual(resolved.required, ['schemaVersion', 'presetId', 'componentIds', 'agents']);
  assert.equal(schema.$defs.kg.properties.nodes.maxItems, 200);
});

test('every preset maps to real worker projection, scheduling capability and meeting-brief resource contracts', async t => {
  const policyEngine = new SessionEngine({});
  for (const preset of conditionCatalog().presets) {
    const conditions = resolveConditions({ presetId: preset.id });
    const config = conditionBobConfig(conditions);
    const alice = createAgentRuntime({ role: 'Alice' }), bob = createAgentRuntime({ role: 'Bob' });
    t.after(() => { alice.close(); bob.close(); });
    const ref = { sessionId: `preset-contract-${preset.id}`, epoch: 1 };
    const [a, b] = await Promise.all([alice.call('status'), bob.call('status')]);
    await alice.call('initialize', { ...ref, mode: 'controlled', configRevision: 1, aliceData: conditions.agents.Alice.data.calendar, agentProfile: conditions.agents.Alice, peerPublicKey: b.publicKey });
    await bob.call('initialize', { ...ref, mode: 'controlled', configRevision: 1, bobConfig: config, agentProfile: conditions.agents.Bob, peerPublicKey: a.publicKey });
    if (preset.id === 'custom') {
      await assert.rejects(alice.call('projectAlice', { ...ref, stage: 'initial', choice: 'free' }), { code: 'TOOL_DISABLED' });
      await assert.rejects(bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 }), { code: 'TOOL_DISABLED' });
      continue;
    }
    const projection = await alice.call('projectAlice', { ...ref, stage: 'initial', choice: 'free' });
    const outgoing = await alice.call('prepareOutgoing', { ...ref, ...projection, operationId: 'chosen-initial-snapshot', payloadHash: hashValue(projection) });
    const receipt = await bob.call('receive', { ...ref, envelope: outgoing.envelope });
    assert.equal(receipt.receipt.status, 'received');
    const plan = await bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 });
    assert.equal(plan.action.type, preset.id === 'minimal' ? 'meeting' : 'request_more', preset.id);
    if (!config.tools.capabilities.includes('share_brief')) {
      await assert.rejects(bob.call('planBob', { ...ref, purpose: 'brief', configRevision: 1 }), { code: 'TOOL_DISABLED' });
      continue;
    }
    const brief = await bob.call('planBob', { ...ref, purpose: 'brief', configRevision: 1 });
    assert.equal(brief.action.resource, 'meeting_brief', preset.id);
    assert.deepEqual(brief.action.values, conditions.agents.Bob.data.brief);
    if (preset.id === 'shared-context') {
      const state = { config, policyUses: 0, startedAt: new Date().toISOString() };
      assert.equal(policyEngine.allowedByPolicy(state, { ...brief.action, fields: ['topic'], values: { topic: brief.action.values.topic } }), true, 'Pre-authorized topic must use the same resource the worker actually proposes');
      assert.equal(policyEngine.allowedByPolicy(state, brief.action), false, 'The unapproved agenda must still require owner review');
    }
  }
});

test('live planning receives only each role’s own custom KG and enforces disabled received-snapshot inspection', async t => {
  const modelContexts = {};
  const alice = createAgentRuntime({ role: 'Alice', model: { available: true }, modelCall: async request => {
    modelContexts[request.sessionId] = structuredClone(request.context);
    return { message: request.context.ownKnowledgeGraph.nodes[0].label };
  } });
  const bob = createAgentRuntime({ role: 'Bob', model: { available: true }, modelCall: async request => {
    modelContexts.Bob = structuredClone(request.context);
    return { message: request.context.ownKnowledgeGraph.nodes[0].label, action: { type: 'no_match' } };
  } });
  t.after(() => { alice.close(); bob.close(); });
  const [a, b] = await Promise.all([alice.call('status'), bob.call('status')]);
  for (const enabled of [false, true]) {
    const conditions = resolveConditions({ custom: {
      Alice: { kg: { nodes: [{ id: 'alice-only', label: 'Alice custom KG sentinel', type: 'context' }], edges: [] }, skills: enabled ? ['read_synthetic_calendar', 'inspect_received_snapshot'] : ['read_synthetic_calendar'] },
      Bob: { kg: { nodes: [{ id: 'bob-only', label: 'Bob custom KG sentinel', type: 'context' }], edges: [] } }
    } });
    const config = conditionBobConfig(conditions), ref = { sessionId: `kg-live-${enabled}`, epoch: 1 };
    await alice.call('initialize', { ...ref, mode: 'live', configRevision: 1, aliceData: conditions.agents.Alice.data.calendar, agentProfile: conditions.agents.Alice, peerPublicKey: b.publicKey });
    await bob.call('initialize', { ...ref, mode: 'live', configRevision: 1, bobConfig: config, agentProfile: conditions.agents.Bob, peerPublicKey: a.publicKey });
    const payload = { fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00–15:30', status: 'Free' } };
    const outgoing = await bob.call('prepareOutgoing', { ...ref, ...payload, payloadHash: hashValue(payload), operationId: 'confirmed-availability' });
    await alice.call('receive', { ...ref, envelope: outgoing.envelope });
    assert.equal((await alice.call('planAlice', { ...ref, purpose: 'intro', mode: 'live' })).message, 'Alice custom KG sentinel');
    assert.deepEqual(modelContexts[ref.sessionId].ownKnowledgeGraph, conditions.agents.Alice.kg);
    assert.equal(modelContexts[ref.sessionId].receivedBobData.length, enabled ? 1 : 0);
    assert.equal(JSON.stringify(modelContexts[ref.sessionId]).includes('Bob custom KG sentinel'), false);
    assert.equal((await bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 })).message, 'Bob custom KG sentinel');
    assert.deepEqual(modelContexts.Bob.ownKnowledgeGraph, conditions.agents.Bob.kg);
    assert.deepEqual(modelContexts.Bob.received, []);
    assert.equal(JSON.stringify(modelContexts.Bob).includes('Alice custom KG sentinel'), false);
  }
});
