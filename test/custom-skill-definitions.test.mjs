import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conditionCatalog, conditionSchema, resolveConditions, conditionBobConfig } from '../src/condition-service.mjs';
import { DEFAULT_BOB_CONFIG, hashValue, validateConfig } from '../src/config.mjs';
import { buildAgentStates, buildTraceSnapshot, sanitizeTraceSnapshot } from '../src/agent-observability.mjs';
import { createAgentRuntime } from '../src/agent-worker.mjs';
import { ConditionStore } from '../src/condition-store.mjs';

const aliceDefinition = { id: 'compare_options', label: 'Compare options', description: 'Alice private guidance sentinel.\nExplain two choices at a time.' };
const bobDefinition = { id: 'explain_tradeoffs', label: 'Explain tradeoffs', description: 'Bob private guidance sentinel.\nExplain the smallest sufficient scope.' };
function authoredConditions() {
  const defaults = resolveConditions();
  return resolveConditions({ custom: {
    Alice: { skills: [...defaults.agents.Alice.skills, aliceDefinition.id], skillDefinitions: [aliceDefinition] },
    Bob: { skills: [...defaults.agents.Bob.skills, bobDefinition.id], skillDefinitions: [bobDefinition] }
  } });
}
function invalid(input, expectedPath, code) {
  assert.throws(() => resolveConditions(input), error => error.code === 'INVALID_CONDITIONS'
    && error.details.errors.some(item => item.path === expectedPath && (!code || item.code === code)));
}

test('custom role skill definitions round-trip with the exact hash and map onto owner configuration', () => {
  const conditions = authoredConditions(), before = structuredClone(conditions), config = conditionBobConfig(conditions);
  assert.deepEqual(resolveConditions(JSON.parse(JSON.stringify(conditions))), before);
  assert.equal(hashValue(resolveConditions(conditions)), hashValue(before));
  assert.deepEqual(config.tools.skillDefinitions, [bobDefinition]);
  assert.equal(validateConfig(config).valid, true);
  conditions.agents.Alice.skillDefinitions[0].label = 'Edited';
  assert.notEqual(hashValue(conditions), hashValue(before));
  assert.equal(Object.hasOwn(resolveConditions().agents.Alice, 'skillDefinitions'), false, 'Existing fixtures keep their optional metadata shape and hash.');
});

test('custom skill IDs and definitions retain schema, role, reference and credential boundaries', () => {
  invalid({ custom: { Alice: { skills: [''] } } }, '$.custom.Alice.skills[0]');
  invalid({ custom: { Alice: { skills: ['custom', 'custom'] } } }, '$.custom.Alice.skills', 'DUPLICATE');
  invalid({ custom: { Alice: { skills: ['custom\nlabel'] } } }, '$.custom.Alice.skills[0]');
  invalid({ custom: { Alice: { skills: ['send_scoped_reply'] } } }, '$.custom.Alice.skills[0]', 'UNKNOWN_VALUE');
  invalid({ custom: { Bob: { skills: ['send_scoped_snapshot'] } } }, '$.custom.Bob.skills[0]', 'UNKNOWN_VALUE');
  invalid({ custom: { Alice: { skillDefinitions: [aliceDefinition] } } }, '$.agents.Alice.skillDefinitions[0].id', 'SKILL_REFERENCE');
  invalid({ custom: { Alice: { skills: [aliceDefinition.id], skillDefinitions: [aliceDefinition, aliceDefinition] } } }, '$.custom.Alice.skillDefinitions[1].id', 'DUPLICATE');
  invalid({ custom: { Alice: { skills: [aliceDefinition.id], skillDefinitions: [{ ...aliceDefinition, description: 'x'.repeat(4001) }] } } }, '$.custom.Alice.skillDefinitions[0].description');
  invalid({ custom: { Alice: { skills: [aliceDefinition.id], skillDefinitions: [{ ...aliceDefinition, command: 'filesystem' }] } } }, '$.custom.Alice.skillDefinitions[0].command', 'UNKNOWN_FIELD');
  invalid({ custom: { Alice: { skills: [aliceDefinition.id], skillDefinitions: [{ ...aliceDefinition, description: 'Bearer 1234567890abcdefghijkl' }] } } }, '$.custom.Alice.skillDefinitions[0].description', 'CREDENTIAL');
  const schema = conditionSchema();
  for (const role of ['Alice', 'Bob']) {
    assert.equal(schema.$defs[role].properties.skills.items.enum, undefined);
    assert.equal(schema.$defs[role].properties.skills.maxItems, 100);
    assert.equal(schema.$defs[role].required.includes('skillDefinitions'), false);
    assert.deepEqual(schema.oneOf[0].properties.custom.properties[role].properties.skillDefinitions.items.required, ['id', 'label', 'description']);
  }
  assert.ok(conditionCatalog().skills.every(skill => skill.registered === true));
});

test('owner definitions are inherited, templates restore them, and skill replacement drops only retired inherited definitions', () => {
  const owner = structuredClone(DEFAULT_BOB_CONFIG);
  owner.tools.capabilities.push(bobDefinition.id);
  owner.tools.skillDefinitions = [bobDefinition];
  const conditions = resolveConditions(undefined, owner);
  assert.deepEqual(conditions.agents.Bob.skillDefinitions, [bobDefinition]);
  assert.deepEqual(conditionBobConfig(conditions, owner), owner);
  const inherited = conditionCatalog(owner).skills.find(skill => skill.id === bobDefinition.id);
  assert.equal(inherited.registered, false);
  assert.equal(inherited.name, bobDefinition.label);
  const replaced = resolveConditions({ componentIds: { Bob: ['bob-skills-scheduling'] } }, owner);
  assert.deepEqual(replaced.agents.Bob.skillDefinitions, []);
  const restored = resolveConditions({ presetId: 'custom', componentIds: { Bob: ['bob-skills-template'] } }, owner);
  assert.deepEqual(restored.agents.Bob.skillDefinitions, [bobDefinition]);
  assert.deepEqual(resolveConditions({ custom: { Bob: { skills: ['read_synthetic_calendar'] } } }, owner).agents.Bob.skillDefinitions, []);
  invalid({ custom: { Bob: { skills: [], skillDefinitions: [bobDefinition] } } }, '$.agents.Bob.skillDefinitions[0].id', 'SKILL_REFERENCE');
});

test('owner metadata validation rejects stale, malformed and credential-bearing definitions', () => {
  for (const [definition, expectedPath] of [
    [{ ...bobDefinition, id: 'disabled' }, '$.tools.skillDefinitions[0].id'],
    [{ ...bobDefinition, label: '' }, '$.tools.skillDefinitions[0].label'],
    [{ ...bobDefinition, description: 'x'.repeat(4001) }, '$.tools.skillDefinitions[0].description'],
    [{ ...bobDefinition, description: 'Bearer 1234567890abcdefghijkl' }, '$.tools.skillDefinitions[0].description'],
    [{ ...bobDefinition, command: 'execute' }, '$.tools.skillDefinitions[0].command']
  ]) {
    const owner = structuredClone(DEFAULT_BOB_CONFIG);
    owner.tools.capabilities.push(bobDefinition.id);
    owner.tools.skillDefinitions = [definition];
    assert.equal(validateConfig(owner).valid, false, expectedPath);
    assert.ok(validateConfig(owner).errors.some(error => error.path === expectedPath), expectedPath);
  }
});

test('Bob owner configuration rejects Alice-only registered skills before saving but accepts unknown custom IDs', () => {
  for (const id of ['preview_scoped_calendar', 'send_scoped_snapshot', 'inspect_received_snapshot']) {
    const config = structuredClone(DEFAULT_BOB_CONFIG);
    config.tools.capabilities.push(id);
    const result = validateConfig(config);
    assert.equal(result.valid, false, id);
    assert.ok(result.errors.some(error => error.path === '$.tools.capabilities[3]' && error.code === 'UNKNOWN_VALUE'), id);
    assert.throws(() => resolveConditions(undefined, config), error => error.details.errors.some(item => item.path === '$.bobTemplate.tools.capabilities[3]'), id);
  }
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.tools.capabilities.push('filesystem', 'constructor', '__proto__', 'Owner custom guidance');
  assert.equal(validateConfig(config).valid, true);
  assert.deepEqual(resolveConditions(undefined, config).agents.Bob.skills, config.tools.capabilities);
});

test('skill and field label lookup ignores inherited prototype entries while preserving custom metadata IDs', t => {
  Object.defineProperty(Object.prototype, 'inherited_skill', { configurable: true, value: ['Inherited label sentinel', 'Inherited description sentinel'] });
  t.after(() => { delete Object.prototype.inherited_skill; });
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.tools.capabilities.push('__proto__', 'constructor', 'toString', 'inherited_skill');
  config.permissions.fields.push('inherited_skill');
  const conditions = resolveConditions(undefined, config), agents = buildAgentStates({ conditions, config });
  assert.equal(agents.Bob.skills.find(skill => skill.id === 'inherited_skill').label, 'inherited skill');
  assert.equal(JSON.stringify(agents).includes('Inherited label sentinel'), false);
  for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(typeof agents.Bob.skills.find(skill => skill.id === id).label, 'string');
  config.tools.skillDefinitions = [{ id: 'constructor', label: 'Custom constructor guidance', description: 'A safe metadata string.' }];
  assert.equal(buildAgentStates({ conditions, config }).Bob.skills.find(skill => skill.id === 'constructor').label, 'Custom constructor guidance');
});

test('agent observation and trace preserve role labels, exact metadata and the reviewed fixture hash', () => {
  const conditions = authoredConditions(), config = conditionBobConfig(conditions), state = {
    conditions, config, conditionsHash: hashValue(conditions), aliceCalendar: conditions.agents.Alice.data.calendar,
    startedAt: new Date().toISOString(), receipts: { aliceToBob: [], bobToAlice: [] }, approvals: [], grants: []
  };
  const agents = buildAgentStates(state);
  assert.equal(agents.Alice.skills.find(skill => skill.id === aliceDefinition.id).description, aliceDefinition.description);
  assert.equal(agents.Bob.skills.find(skill => skill.id === bobDefinition.id).label, bobDefinition.label);
  assert.equal(JSON.stringify(agents.Alice).includes('Bob private guidance sentinel'), false);
  assert.equal(JSON.stringify(agents.Bob).includes('Alice private guidance sentinel'), false);
  const snapshot = buildTraceSnapshot(state), restored = sanitizeTraceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.conditions, conditions);
  assert.deepEqual(restored.config.tools.skillDefinitions, [bobDefinition]);
  assert.equal(hashValue(restored.conditions), hashValue(conditions));
  config.tools.skillDefinitions = [{ ...bobDefinition, label: 'Updated owner label', description: '' }];
  assert.equal(buildAgentStates(state).Bob.skills.find(skill => skill.id === bobDefinition.id).label, 'Updated owner label');
  delete config.tools.skillDefinitions;
  assert.notEqual(buildAgentStates(state).Bob.skills.find(skill => skill.id === bobDefinition.id).label, bobDefinition.label, 'A removed owner definition does not fall back to the initial profile.');
});

test('custom skill wording stays exact and marked even when it matches built-in localization keys', () => {
  const conditions = resolveConditions({ custom: {
    Alice: { skills: ['read_synthetic_calendar', 'owner_label', 'plain_custom'], skillDefinitions: [
      { id: 'read_synthetic_calendar', label: 'Objective', description: 'Allowed fields' },
      { id: 'owner_label', label: 'Skills', description: 'Initial authorization ceiling' }
    ] }
  } });
  const state = { conditions, config: conditionBobConfig(conditions) };
  const agents = buildAgentStates(state);
  const registeredOverride = agents.Alice.skills.find(skill => skill.id === 'read_synthetic_calendar');
  assert.equal(registeredOverride.label, 'Objective');
  assert.equal(registeredOverride.description, 'Allowed fields');
  assert.equal(registeredOverride.customized, true);
  const authored = agents.Alice.skills.find(skill => skill.id === 'owner_label');
  assert.equal(authored.label, 'Skills');
  assert.equal(authored.description, 'Initial authorization ceiling');
  assert.equal(authored.customized, true);
  assert.equal(agents.Alice.skills.find(skill => skill.id === 'plain_custom').customized, true);
  assert.equal(Object.hasOwn(agents.Bob.skills.find(skill => skill.id === 'read_synthetic_calendar'), 'customized'), false, 'A registered skill without overrides preserves its previous shape for localization.');
  const snapshot = sanitizeTraceSnapshot(buildTraceSnapshot(state));
  assert.deepEqual(snapshot.agentStates.Alice.skills, agents.Alice.skills);
});

test('live workers receive only their own guidance and custom labels cannot create action types', async t => {
  const contexts = {}, conditions = authoredConditions(), config = conditionBobConfig(conditions);
  let invalidAction = false;
  const alice = createAgentRuntime({ role: 'Alice', model: { available: true }, modelCall: async request => {
    contexts.Alice = structuredClone(request.context);
    return { message: request.context.ownSkillDefinitions[0].label };
  } });
  const bob = createAgentRuntime({ role: 'Bob', model: { available: true }, modelCall: async request => {
    contexts.Bob = structuredClone(request.context);
    return { message: request.context.ownSkillDefinitions[0].label, action: { type: invalidAction ? bobDefinition.id : 'no_match' } };
  } });
  t.after(() => { alice.close(); bob.close(); });
  const [a, b] = await Promise.all([alice.call('status'), bob.call('status')]);
  const ref = { sessionId: 'custom-guidance-live', epoch: 1 };
  await alice.call('initialize', { ...ref, mode: 'live', configRevision: 1, aliceData: conditions.agents.Alice.data.calendar, agentProfile: conditions.agents.Alice, peerPublicKey: b.publicKey });
  await bob.call('initialize', { ...ref, mode: 'live', configRevision: 1, bobConfig: config, agentProfile: conditions.agents.Bob, peerPublicKey: a.publicKey });
  assert.equal((await alice.call('planAlice', { ...ref, purpose: 'intro' })).message, aliceDefinition.label);
  assert.equal((await bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 })).message, bobDefinition.label);
  assert.deepEqual(contexts.Alice.ownSkillDefinitions, [aliceDefinition]);
  assert.deepEqual(contexts.Bob.ownSkillDefinitions, [bobDefinition]);
  assert.equal(JSON.stringify(contexts.Alice).includes('Bob private guidance sentinel'), false);
  assert.equal(JSON.stringify(contexts.Bob).includes('Alice private guidance sentinel'), false);
  invalidAction = true;
  await assert.rejects(bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 }), { code: 'MODEL_INVALID_OUTPUT' });
  invalidAction = false;
  config.tools.skillDefinitions = [{ ...bobDefinition, label: 'New owner guidance' }];
  await bob.call('updateBob', { ...ref, configRevision: 2, bobConfig: config });
  assert.equal((await bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 2 })).message, 'New owner guidance');
  assert.equal(contexts.Bob.ownSkillDefinitions[0].label, 'New owner guidance');
  assert.equal(contexts.Bob.allowedActions.includes(bobDefinition.id), false);
});

test('custom labels cannot replace registered reading or sending skills', async t => {
  const conditions = resolveConditions({ custom: {
    Alice: { skills: [aliceDefinition.id], skillDefinitions: [aliceDefinition] },
    Bob: { skills: [bobDefinition.id], skillDefinitions: [bobDefinition] }
  } });
  const alice = createAgentRuntime({ role: 'Alice' }), bob = createAgentRuntime({ role: 'Bob' });
  t.after(() => { alice.close(); bob.close(); });
  const [a, b] = await Promise.all([alice.call('status'), bob.call('status')]);
  const ref = { sessionId: 'custom-label-boundary', epoch: 1 };
  await alice.call('initialize', { ...ref, mode: 'controlled', configRevision: 1, aliceData: conditions.agents.Alice.data.calendar, agentProfile: conditions.agents.Alice, peerPublicKey: b.publicKey });
  await bob.call('initialize', { ...ref, mode: 'controlled', configRevision: 1, bobConfig: conditionBobConfig(conditions), agentProfile: conditions.agents.Bob, peerPublicKey: a.publicKey });
  await assert.rejects(alice.call('projectAlice', { ...ref, stage: 'initial', choice: 'free' }), { code: 'TOOL_DISABLED' });
  const payload = { rows: [], fields: [], window: 'none' };
  await assert.rejects(alice.call('prepareOutgoing', { ...ref, ...payload, payloadHash: hashValue(payload), operationId: 'custom-label-send' }), { code: 'TOOL_DISABLED' });
  await assert.rejects(bob.call('planBob', { ...ref, purpose: 'initial', configRevision: 1 }), { code: 'TOOL_DISABLED' });
  await assert.rejects(bob.call('planBob', { ...ref, purpose: 'brief', configRevision: 1 }), { code: 'TOOL_DISABLED' });
});

test('saved reusable bundles reload custom role definitions with the exact reviewed hash', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-custom-skills-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConditionStore({ directory });
  await store.init();
  const conditions = authoredConditions(), bundle = await store.save({ name: 'Custom role guidance', input: conditions });
  assert.equal(bundle.hash, hashValue(conditions));
  const restored = new ConditionStore({ directory });
  await restored.init();
  assert.deepEqual(restored.list(), store.list());
  assert.deepEqual(restored.list()[0].conditions.agents.Alice.skillDefinitions, [aliceDefinition]);
  assert.deepEqual(restored.list()[0].conditions.agents.Bob.skillDefinitions, [bobDefinition]);
});
