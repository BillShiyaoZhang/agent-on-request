import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOB_CONFIG, hashValue } from '../src/config.mjs';
import { resolveConditions, conditionBobConfig } from '../src/condition-service.mjs';
import { buildAgentStates, buildTraceSnapshot, sanitizeTraceSnapshot } from '../src/agent-observability.mjs';

const NOW = Date.parse('2026-10-07T08:00:00.000Z');
function fixture() {
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  return {
    id: 'synthetic-session', epoch: 2, version: 4, mode: 'controlled', stage: 'additional', startedAt: new Date(NOW - 60_000).toISOString(),
    researchConsent: true, consentVersion: 'research-v2', config, configRevision: 3, templateRevision: 1,
    conditions: { schemaVersion: 1, presetId: 'custom', componentIds: { Alice: ['calendar'], Bob: ['brief'] }, agents: {
      Alice: { kg: { nodes: [{ id: 'a', label: 'Alice 初始知识', type: 'concept' }, { id: 'b', label: '边界', type: 'concept' }],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: '尊重' }, { id: 'e2', source: 'a', target: 'b', label: '研究' }] },
      data: { calendar: [{ day: 'Tue', time: '12:00–13:00', status: 'Busy', title: 'ALICE_PRIVATE', note: 'PRIVATE_NOTE' }] },
      skills: ['read_synthetic_calendar', 'preview_scoped_calendar', 'send_scoped_snapshot'], authorization: { fields: ['day', 'time', 'status'], windows: ['Tue', 'Thu'], maxUses: 3, expiryMinutes: 10 } },
      Bob: { kg: { nodes: [{ id: 'b', label: 'Bob 初始知识', type: 'concept' }], edges: [] },
        data: structuredClone(config.data), skills: ['obsolete_skill'], authorization: structuredClone(config.permissions) }
    } },
    receipts: { aliceToBob: [], bobToAlice: [] }, approvals: [], grants: [], policyUses: 1, aliceUses: 1,
    choices: { initial: 'busy', additional: null }, task: { outcome: null, meeting: null }, ended: false, paused: false, stopped: false
  };
}

test('graphs preserve each initial KG and import only confirmed receipt fields', () => {
  const session = fixture();
  session.receipts.aliceToBob = [{ operationId: 'sent-1', fields: ['day', 'time', 'status'], window: 'Tue', status: 'received',
    receivedAt: new Date(NOW).toISOString(), rows: [{ day: 'Tue', time: '12:00–13:00', status: 'Busy', title: 'ALICE_PRIVATE', note: 'PRIVATE_NOTE' }] },
  { operationId: 'pending-1', status: 'pending', fields: ['title'], rows: [{ title: 'UNCONFIRMED_SECRET' }] }];
  session.receipts.bobToAlice = [{ operationId: 'reply-1', fields: ['topic'], status: 'received', receivedAt: new Date(NOW).toISOString(),
    values: { topic: 'PUBLIC_TOPIC', agenda: 'UNSHARED_AGENDA' } }];
  const before = structuredClone(session);
  const states = buildAgentStates(session, NOW);
  assert.deepEqual(session, before);
  assert.ok(JSON.stringify(states.Alice).includes('ALICE_PRIVATE'));
  assert.ok(JSON.stringify(states.Alice).includes('PUBLIC_TOPIC'));
  assert.equal(JSON.stringify(states.Alice).includes('UNSHARED_AGENDA'), false);
  assert.equal(JSON.stringify(states.Bob).includes('ALICE_PRIVATE'), false);
  assert.equal(JSON.stringify(states.Bob).includes('PRIVATE_NOTE'), false);
  assert.equal(JSON.stringify(states.Bob).includes('UNCONFIRMED_SECRET'), false);
  assert.ok(states.Alice.kg.nodes.some(node => node.label === 'Alice 初始知识'));
  assert.ok(states.Bob.kg.nodes.some(node => node.label === 'Bob 初始知识'));
  assert.ok(states.Alice.kg.edges.some(edge => edge.relation === '尊重'));
  assert.ok(states.Alice.kg.edges.some(edge => edge.relation === '研究'));
  assert.equal(states.Bob.stats.receipts, 1);
  for (const role of ['Alice', 'Bob']) {
    const ids = new Set(states[role].kg.nodes.map(node => node.id));
    assert.equal(ids.size, states[role].kg.nodes.length);
    assert.ok(states[role].kg.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)));
    for (const node of states[role].kg.nodes.filter(node => node.origin === 'received')) assert.ok(node.provenance.operationId);
  }
  session.stopped = true;
  assert.deepEqual(buildAgentStates(session, NOW).Bob.kg, states.Bob.kg, 'revocation retains previously received knowledge');
});

test('skills, own Bob data and authorization reflect current configuration and actual usage', () => {
  const session = fixture();
  session.config.tools.capabilities = ['send_scoped_reply'];
  session.config.data.brief.topic = 'CURRENT_TOPIC';
  session.aliceUses = 2;
  session.policyUses = 3;
  session.pendingDelivery = { direction: 'bob', operationId: 'pending-send', fields: ['status'], rows: [{ status: 'Free' }], window: 'Thu' };
  const states = buildAgentStates(session, NOW);
  assert.deepEqual(states.Bob.skills.map(skill => skill.id), ['send_scoped_reply']);
  assert.ok(JSON.stringify(states.Bob.data).includes('CURRENT_TOPIC'));
  assert.equal(states.Alice.authorization.cards[0].uses, 2);
  assert.equal(states.Alice.authorization.cards[0].remaining, 1);
  assert.equal(states.Alice.authorization.cards[0].reserved, 1);
  assert.equal(states.Bob.authorization.status, 'exhausted');
  session.conditions.agents.Alice.skills = [];
  assert.equal(buildAgentStates(session, NOW).Alice.authorization.status, 'disabled');
});

test('authorization surfaces expiration, approvals and narrow round grants without inventing use limits', () => {
  const session = fixture();
  session.startedAt = new Date(NOW - 11 * 60_000).toISOString();
  session.grants = [{ resource: 'meeting_brief', purpose: 'brief', fields: ['topic'], remaining: 1, expiresAt: NOW + 60_000 }];
  let state = buildAgentStates(session, NOW);
  assert.equal(state.Alice.authorization.status, 'expired');
  assert.equal(state.Bob.authorization.cards[0].status, 'expired');
  const grant = state.Bob.authorization.cards.find(card => card.confirmation === 'allow_round');
  assert.equal(grant.status, 'active');
  assert.equal(grant.remaining, 1);
  assert.equal(grant.maxUses, null);
  assert.equal(grant.uses, null);
  assert.deepEqual(grant.fields, ['topic']);
  assert.equal(state.Bob.authorization.status, 'active');
  session.approvals = [{ id: 'request-1', status: 'pending', policyRevision: 3, fields: ['agenda'], resource: 'meeting_brief', expiresAt: new Date(NOW + 60_000).toISOString() }];
  state = buildAgentStates(session, NOW);
  assert.equal(state.Bob.authorization.status, 'pending');
  session.ended = true;
  assert.ok(buildAgentStates(session, NOW).Bob.authorization.cards.every(card => card.status === 'disabled'));
});

test('trace whitelist is reload-stable at its captured time and rebuilds untrusted derived views', () => {
  const session = fixture();
  session.token = 'PARTICIPANT_SECRET';
  session.tokenHash = Buffer.from('HASH_SECRET');
  session.models = { apiKey: 'MODEL_SECRET' };
  session.messages = [{ text: 'RAW_CHAT_SECRET' }];
  session.config.prompts.system = 'SYSTEM_PROMPT_SECRET';
  session.config.runtime.model = 'RUNTIME_MODEL_SECRET';
  session.config.extensions = { credential: 'EXTENSION_SECRET' };
  session.config.data.extra = { apiKey: 'NESTED_SECRET' };
  session.conditions.agents.Alice.kg.nodes[0].credentials = 'KG_SECRET';
  session.conditions.agents.Alice.data.calendar[0].password = 'CALENDAR_SECRET';
  const snapshot = buildTraceSnapshot(session, NOW);
  assert.deepEqual(sanitizeTraceSnapshot(snapshot), snapshot);
  assert.equal(snapshot.capturedAt, new Date(NOW).toISOString());
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['PARTICIPANT_SECRET', 'HASH_SECRET', 'MODEL_SECRET', 'RAW_CHAT_SECRET', 'SYSTEM_PROMPT_SECRET', 'RUNTIME_MODEL_SECRET', 'EXTENSION_SECRET', 'NESTED_SECRET', 'KG_SECRET', 'CALENDAR_SECRET']) assert.equal(serialized.includes(secret), false);
  snapshot.agentStates.Bob.kg.nodes.push({ id: 'injected', label: 'INJECTED_SECRET', origin: 'received' });
  snapshot.config.permissions.token = 'INJECTED_SECRET';
  snapshot.rawChat = 'INJECTED_SECRET';
  const cleaned = sanitizeTraceSnapshot(snapshot);
  assert.equal(JSON.stringify(cleaned).includes('INJECTED_SECRET'), false);
  assert.equal(cleaned.agentStates.Bob.authorization.cards[0].status, 'active', 'reload uses captured time instead of the wall clock');
  assert.equal(sanitizeTraceSnapshot({ schemaVersion: 'unknown' }), null);
});

test('trace sanitization never evaluates accessors and deduplicates receipt operations and dangling edges', () => {
  const session = fixture();
  session.conditions.agents.Alice.kg.edges.push({ id: 'orphan', source: 'missing', target: 'a', label: 'invalid' });
  session.receipts.aliceToBob = [{ operationId: 'once', fields: ['day'], status: 'received', rows: [{ day: 'Tue' }] },
    { operationId: 'once', fields: ['note'], status: 'received', rows: [{ note: 'DUPLICATE_SECRET' }] }];
  session.pendingDelivery = { direction: 'alice', operationId: 'pending', fields: ['topic'], values: { topic: 'synthetic' } };
  Object.defineProperty(session.pendingDelivery, 'credential', { enumerable: true, get() { throw new Error('must not be evaluated'); } });
  Object.defineProperty(session.conditions.agents.Alice.data.calendar[0], 'note', { enumerable: true, get() { throw new Error('must not be evaluated'); } });
  const snapshot = buildTraceSnapshot(session, NOW);
  assert.equal(snapshot.receipts.aliceToBob.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('DUPLICATE_SECRET'), false);
  assert.ok(snapshot.agentStates.Alice.kg.edges.every(edge => edge.label !== 'invalid'));
  assert.deepEqual(sanitizeTraceSnapshot(snapshot), snapshot);
});

test('custom date-array windows remain exact in durable traces and readable in graph details', () => {
  const session = fixture();
  session.receipts.aliceToBob = [{ operationId: 'days', fields: ['day', 'time'], window: ['Tue', 'Thu'], status: 'received', rows: [{ day: 'Tue', time: '12:00–13:00' }] }];
  const snapshot = buildTraceSnapshot(session, NOW);
  assert.deepEqual(snapshot.receipts.aliceToBob[0].window, ['Tue', 'Thu']);
  assert.deepEqual(sanitizeTraceSnapshot(snapshot), snapshot);
  const node = snapshot.agentStates.Bob.kg.nodes.find(node => node.type === 'snapshot');
  assert.equal(node.details.find(detail => detail.label === '日期范围').value, 'Tue、Thu');
  session.config.tools.capabilities = ['share_brief'];
  session.config.permissions.resources = ['meeting_brief'];
  session.config.permissions.fields = ['topic'];
  assert.equal(buildAgentStates(session, NOW).Bob.authorization.status, 'active');
});

test('safe nested synthetic brief values survive reconstruction with recursive credential removal', () => {
  const session = fixture();
  const brief = { topic: 'Nested study', agenda: ['calendar', { day: 'Tue', costs: [1, 2], credential: 'NESTED_CREDENTIAL' }],
    statistics: { count: 2, note: null, apiKey: 'NESTED_KEY' }, prompts: { system: 'FICTIONAL_PROMPT' } };
  session.config.data.brief = structuredClone(brief);
  session.conditions.agents.Bob.data.brief = structuredClone(brief);
  session.receipts.bobToAlice = [{ operationId: 'nested', status: 'received', fields: ['agenda'], values: { agenda: brief.agenda, statistics: brief.statistics } }];
  session.approvals = [{ id: 'nested-approval', fields: ['statistics'], values: { statistics: brief.statistics } }];
  const snapshot = buildTraceSnapshot(session, NOW);
  const expected = { topic: 'Nested study', agenda: ['calendar', { day: 'Tue', costs: [1, 2] }], statistics: { count: 2, note: null }, prompts: { system: 'FICTIONAL_PROMPT' } };
  assert.deepEqual(snapshot.config.data.brief, expected);
  assert.deepEqual(snapshot.conditions.agents.Bob.data.brief, expected);
  assert.deepEqual(snapshot.receipts.bobToAlice[0].values, { agenda: expected.agenda });
  assert.deepEqual(snapshot.approvals[0].values, { statistics: expected.statistics });
  assert.deepEqual(sanitizeTraceSnapshot(snapshot), snapshot);
  assert.equal(/NESTED_CREDENTIAL|NESTED_KEY/.test(JSON.stringify(snapshot)), false);
  const item = snapshot.agentStates.Bob.data.find(card => card.kind === 'brief').items.find(item => item.label === '议程');
  assert.ok(item.details[0].value.includes('日期：Tue'));
  assert.equal(item.details[0].value.includes('[object Object]'), false);
});

test('accepted large custom briefs retain exact values, all fields and reviewed hashes in trace sources', () => {
  const brief = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`study_${index}`, `Finding ${index}`]));
  brief.longText = 'Synthetic research finding. '.repeat(1000);
  brief['study_' + 'x'.repeat(150)] = 'A permitted extensible JSON field';
  brief.observations = Array.from({ length: 3000 }, (_, index) => ({ index, result: `Observation ${index}` }));
  const input = resolveConditions();
  input.agents.Bob.data.brief = brief;
  const conditions = resolveConditions(input);
  const session = fixture();
  session.conditions = conditions;
  session.conditionsHash = hashValue(conditions);
  session.config = conditionBobConfig(conditions);
  const fields = Object.keys(brief);
  session.receipts.bobToAlice = [{ operationId: 'complete-study', status: 'received', fields, values: brief }];
  const snapshot = buildTraceSnapshot(session, NOW);
  assert.deepEqual(snapshot.conditions, conditions);
  assert.equal(hashValue(snapshot.conditions), session.conditionsHash);
  assert.deepEqual(snapshot.config.data.brief, brief);
  assert.deepEqual(snapshot.receipts.bobToAlice[0].fields, fields);
  assert.deepEqual(snapshot.receipts.bobToAlice[0].values, brief);
  assert.deepEqual(sanitizeTraceSnapshot(snapshot), snapshot);
  assert.equal(snapshot.agentStates.Bob.data.find(card => card.kind === 'brief').count, fields.length);
});
