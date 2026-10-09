import { createHash } from 'node:crypto';
import { ALICE_CALENDAR } from './scenario.mjs';
import { sanitizeOntologyDialogue } from './ontology-dialogue.mjs';

const ROLES = ['Alice', 'Bob'];
const FIELD_LABELS = { day: '日期', time: '时间', status: '状态', title: '事件标题', note: '备注', topic: '讨论主题', agenda: '议程' };
const SKILLS = {
  read_synthetic_calendar: ['读取日历', '读取自己持有的模拟日历与可用时间。'],
  project_calendar: ['生成日历快照', '按用户确认的字段和日期范围生成快照。'],
  preview_scoped_calendar: ['预览日历快照', '发送前查看所选字段和日期范围的确切内容。'],
  inspect_received_snapshot: ['查看已收到的信息', '仅查看对方已确认发送和接收的快照。'],
  send_scoped_snapshot: ['发送授权快照', '仅发送经过用户确认的日历快照。'],
  send_scoped_reply: ['发送授权回复', '按有效授权发送明确范围的回复。'],
  share_brief: ['分享会议简报', '按授权范围分享自己持有的会议简报。'],
  request_additional_scope: ['请求更多范围', '在已收到的信息不足时请求进一步授权。'],
  receive_scoped_reply: ['接收回复', '接收并记录对方确认发送的快照。'],
  plan_meeting: ['安排会议', '根据自己的数据与实际收到的快照寻找共同时间。']
};
const unsafeKey = key => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:apikey|accesstoken|refreshtoken|clientsecret|password|passwd|adminpin|bobtoken|privatekey|privatekeypem|credentials|credential|connectionstring)$/.test(normalized)
    || ['secret', 'token', 'tokenhash', 'providerkey', 'authorization', 'authorizationheader'].includes(normalized)
    || ['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase());
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const read = (value, key) => {
  if (!object(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const text = (value, limit = 20_000) => typeof value === 'string' && value.length <= limit ? value : null;
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
// Fixtures are validated before recording. Generic brief field names/values may
// exceed the limits used for policy labels, so do not silently shorten them.
const strings = value => Array.isArray(value) ? [...new Set(value.slice(0, 20_000).filter(item => typeof item === 'string'))] : [];
const list = value => Array.isArray(value) ? value.slice(0, 500) : [];
const windowValue = value => Array.isArray(value) ? strings(value).slice(0, 7) : text(value, 128);
const windowLabel = value => Array.isArray(value) ? value.join('、') : value;
const iso = value => (typeof value === 'string' || typeof value === 'number') && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const labelField = field => Object.hasOwn(FIELD_LABELS, field) ? FIELD_LABELS[field] : field.replaceAll('_', ' ');

function scalars(input, fields = Object.keys(object(input) ? input : {})) {
  const output = {};
  for (const key of fields.slice(0, 100)) {
    if (typeof key !== 'string' || unsafeKey(key)) continue;
    const value = read(input, key);
    if (typeof value === 'string' && value.length <= 20_000 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || value === null) output[key] = value;
  }
  return output;
}
function syntheticValue(input, depth = 0, ancestors = new Set(), budget = { remaining: 20_000 }) {
  if (--budget.remaining < 0 || depth > 64) return undefined;
  if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') return input;
  const array = Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype;
  if (!array && !object(input) || ancestors.has(input)) return undefined;
  ancestors.add(input);
  const output = array ? [] : {};
  const keys = array ? Array.from({ length: Math.min(input.length, 20_000) }, (_, index) => String(index)) : Object.keys(input).slice(0, 20_000);
  for (const key of keys) {
    if (!array && unsafeKey(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    const value = syntheticValue(descriptor.value, depth + 1, ancestors, budget);
    if (value !== undefined) {
      if (array) output.push(value); else output[key] = value;
    }
  }
  ancestors.delete(input);
  return output;
}
function syntheticFields(input, fields = Object.keys(object(input) ? input : {})) {
  const output = {}, budget = { remaining: 20_000 };
  for (const key of fields.slice(0, 20_000)) {
    if (typeof key !== 'string' || unsafeKey(key)) continue;
    const value = syntheticValue(read(input, key), 0, new Set(), budget);
    if (value !== undefined) output[key] = value;
  }
  return output;
}
function calendar(input, availability = false) {
  return list(input).filter(object).map(row => scalars(row, availability ? ['day', 'time'] : ['day', 'time', 'status', 'title', 'note']));
}
function kg(input) {
  const nodes = [];
  for (const node of list(read(input, 'nodes'))) {
    const id = text(read(node, 'id'), 128), label = text(read(node, 'label'), 500), type = text(read(node, 'type'), 128);
    if (id && label && !nodes.some(item => item.id === id)) nodes.push({ id, label, type: type ?? 'concept' });
  }
  const ids = new Set(nodes.map(node => node.id));
  const edges = [];
  for (const edge of list(read(input, 'edges'))) {
    const source = text(read(edge, 'source'), 128), target = text(read(edge, 'target'), 128), label = text(read(edge, 'label'), 500);
    if (!ids.has(source) || !ids.has(target) || !label) continue;
    const id = text(read(edge, 'id'), 128) ?? digest([source, target, label]);
    if (!edges.some(item => item.id === id)) edges.push({ id, source, target, label });
  }
  return { nodes, edges };
}
function aliceAuthorization(input) {
  return { fields: strings(read(input, 'fields')), windows: strings(read(input, 'windows')),
    maxUses: number(read(input, 'maxUses')), expiryMinutes: number(read(input, 'expiryMinutes')) };
}
function bobAuthorization(input) {
  return { recipients: strings(read(input, 'recipients')), fields: strings(read(input, 'fields')), resources: strings(read(input, 'resources')),
    window: text(read(input, 'window'), 128), maxUses: number(read(input, 'maxUses')), expiryMinutes: number(read(input, 'expiryMinutes')),
    confirmation: text(read(input, 'confirmation'), 128), askAdminForNewScope: read(input, 'askAdminForNewScope') === true };
}
function skillDefinitions(input, enabled) {
  const definitions = [], ids = new Set();
  for (const definition of list(input).slice(0, 100)) {
    const id = text(read(definition, 'id'), 128), label = text(read(definition, 'label'), 200), description = text(read(definition, 'description'), 4000);
    if (!id || !label || description === null || !enabled.includes(id) || ids.has(id)) continue;
    if ([id, label, description].some(value => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/.test(value))) continue;
    ids.add(id);
    definitions.push({ id, label, description });
  }
  return definitions;
}
function conditions(input) {
  if (!object(input) || !object(read(input, 'agents'))) return null;
  const agents = {};
  for (const role of ROLES) {
    const agent = read(read(input, 'agents'), role), data = read(agent, 'data');
    agents[role] = { kg: kg(read(agent, 'kg')), data: role === 'Alice' ? { calendar: calendar(read(data, 'calendar')) }
      : { availableTimes: calendar(read(data, 'availableTimes'), true), brief: syntheticFields(read(data, 'brief')) },
    skills: strings(read(agent, 'skills')), ...(read(agent, 'skillDefinitions') === undefined ? {} : { skillDefinitions: skillDefinitions(read(agent, 'skillDefinitions'), strings(read(agent, 'skills'))) }), authorization: role === 'Alice' ? aliceAuthorization(read(agent, 'authorization')) : bobAuthorization(read(agent, 'authorization')) };
  }
  const componentIds = read(input, 'componentIds');
  return { schemaVersion: 1, presetId: text(read(input, 'presetId'), 128), componentIds: { Alice: strings(read(componentIds, 'Alice')), Bob: strings(read(componentIds, 'Bob')) }, agents };
}
function config(input) {
  if (!object(input)) return null;
  const data = read(input, 'data'), collaboration = read(input, 'collaboration'), response = read(input, 'response'), tools = read(input, 'tools');
  // Prompts, provider/runtime settings and arbitrary extensions are intentionally outside this trace schema.
  return { persona: text(read(input, 'persona')), objective: text(read(input, 'objective')),
    data: { source: text(read(data, 'source'), 128), synthetic: read(data, 'synthetic') === true,
      availableTimes: calendar(read(data, 'availableTimes'), true), brief: syntheticFields(read(data, 'brief')) },
    collaboration: { acceptInvitations: read(collaboration, 'acceptInvitations') === true, allowedPeers: strings(read(collaboration, 'allowedPeers')) },
    tools: { capabilities: strings(read(tools, 'capabilities')), ...(read(tools, 'skillDefinitions') === undefined ? {} : { skillDefinitions: skillDefinitions(read(tools, 'skillDefinitions'), strings(read(tools, 'capabilities'))) }) }, permissions: bobAuthorization(read(input, 'permissions')),
    response: { constraints: text(read(response, 'constraints')), maxWords: number(read(response, 'maxWords')), offerBrief: read(response, 'offerBrief') === true } };
}
function receipt(input, direction) {
  const operationId = text(read(input, 'operationId'), 256), fields = strings(read(input, 'fields'));
  if (!operationId) return null;
  const output = { operationId, fields, status: text(read(input, 'status'), 128), receivedAt: iso(read(input, 'receivedAt')), payloadHash: text(read(input, 'payloadHash'), 128) };
  const mappingVersion = read(input, 'mappingVersion'), ontologyTask = read(input, 'ontologyTask');
  if (typeof mappingVersion === 'string' && /^[a-f0-9]{64}$/.test(mappingVersion) && ['schedule', 'brief'].includes(ontologyTask)) {
    output.mappingVersion = mappingVersion; output.ontologyTask = ontologyTask;
  }
  if (direction === 'aliceToBob') {
    output.window = windowValue(read(input, 'window'));
    output.rows = list(read(input, 'rows')).filter(object).map(row => scalars(row, fields));
  } else output.values = syntheticFields(read(input, 'values'), fields);
  return output;
}
function receipts(input) {
  return Object.fromEntries(['aliceToBob', 'bobToAlice'].map(direction => {
    const seen = new Set();
    const entries = list(read(input, direction)).map(item => receipt(item, direction)).filter(item => {
      if (!item || seen.has(item.operationId)) return false;
      seen.add(item.operationId); return true;
    });
    return [direction, entries];
  }));
}
function approvals(input) {
  return list(input).filter(object).map(item => {
    const fields = strings(read(item, 'fields'));
    return { id: text(read(item, 'id'), 256), owner: 'Bob', actionId: text(read(item, 'actionId'), 256),
      epoch: number(read(item, 'epoch')), kind: text(read(item, 'kind'), 128), summary: text(read(item, 'summary')),
      recipient: text(read(item, 'recipient'), 128), purpose: text(read(item, 'purpose'), 128), resource: text(read(item, 'resource'), 128),
      fields, values: syntheticFields(read(item, 'values'), fields), payloadHash: text(read(item, 'payloadHash'), 128),
      policyRevision: number(read(item, 'policyRevision')), status: text(read(item, 'status'), 128),
      expiresAt: iso(read(item, 'expiresAt')), requestedAt: number(read(item, 'requestedAt')), reason: text(read(item, 'reason'), 128), next: text(read(item, 'next'), 128) };
  });
}
function grants(input) {
  return list(input).filter(object).map(item => ({ resource: text(read(item, 'resource'), 128), purpose: text(read(item, 'purpose'), 128),
    fields: strings(read(item, 'fields')), payloadHash: text(read(item, 'payloadHash'), 128), remaining: number(read(item, 'remaining')),
    maxUses: number(read(item, 'maxUses')), uses: number(read(item, 'uses')), expiresAt: iso(read(item, 'expiresAt')) }));
}
function pending(input) {
  if (!object(input)) return null;
  const direction = read(input, 'direction');
  if (!['bob', 'alice'].includes(direction)) return null;
  const whitelist = Object.fromEntries(['operationId', 'fields', 'receivedAt', 'payloadHash', 'window', 'rows', 'values'].map(key => [key, read(input, key)]));
  const entry = receipt({ ...whitelist, status: 'pending' }, direction === 'bob' ? 'aliceToBob' : 'bobToAlice');
  return entry && { ...entry, direction, expiresAt: iso(read(input, 'expiresAt')), policyRevision: number(read(input, 'policyRevision')),
    resource: text(read(input, 'resource'), 128), purpose: text(read(input, 'purpose'), 128), next: text(read(input, 'next'), 128) };
}
function baseSnapshot(input) {
  const task = read(input, 'task'), choices = read(input, 'choices'), waiting = read(input, 'waiting');
  return { schemaVersion: 'agent-trace-v1', capturedAt: iso(read(input, 'capturedAt')),
    id: text(read(input, 'id'), 256), epoch: number(read(input, 'epoch')), mode: text(read(input, 'mode'), 128),
    scenarioVersion: text(read(input, 'scenarioVersion'), 128), consentVersion: text(read(input, 'consentVersion'), 128),
    researchConsent: read(input, 'researchConsent') === true, startedAt: iso(read(input, 'startedAt')),
    conditions: conditions(read(input, 'conditions')), conditionsHash: text(read(input, 'conditionsHash'), 128), config: config(read(input, 'config')),
    configRevision: number(read(input, 'configRevision')), templateRevision: number(read(input, 'templateRevision')),
    stage: text(read(input, 'stage'), 128), savedStage: text(read(input, 'savedStage'), 128), version: number(read(input, 'version')),
    stopped: read(input, 'stopped') === true, ended: read(input, 'ended') === true, paused: read(input, 'paused') === true,
    task: { outcome: text(read(task, 'outcome'), 128), meeting: object(read(task, 'meeting')) ? scalars(read(task, 'meeting'), ['day', 'time']) : null,
      ...(read(task, 'reason') !== undefined ? { reason: text(read(task, 'reason'), 128) } : {}) },
    preparedMeeting: object(read(input, 'preparedMeeting')) ? scalars(read(input, 'preparedMeeting'), ['day', 'time']) : null,
    choices: { initial: text(read(choices, 'initial'), 128), additional: text(read(choices, 'additional'), 128) },
    waiting: object(waiting) ? { reason: text(read(waiting, 'reason'), 128), message: text(read(waiting, 'message')) } : null,
    receipts: receipts(read(input, 'receipts')), approvals: approvals(read(input, 'approvals')), grants: grants(read(input, 'grants')),
    policyUses: number(read(input, 'policyUses')) ?? 0, aliceUses: number(read(input, 'aliceUses')),
    aliceCalendar: calendar(read(input, 'aliceCalendar')),
    pendingDelivery: pending(read(input, 'pendingDelivery')), continuation: text(read(input, 'continuation'), 128),
    requestSequence: number(read(input, 'requestSequence')), interruptGeneration: number(read(input, 'interruptGeneration')),
    ...(read(input, 'ontology') ? { ontology: sanitizeOntologyDialogue(read(input, 'ontology')) } : {}),
    ...(read(input, 'briefOntology') ? { briefOntology: sanitizeOntologyDialogue(read(input, 'briefOntology')) } : {}),
    ...(read(input, 'additionalRequest') ? { additionalRequest: {
      days: strings(read(read(input, 'additionalRequest'), 'days')).filter(day => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].includes(day)),
      fields: strings(read(read(input, 'additionalRequest'), 'fields')).filter(field => ['day','time','status'].includes(field)), reason: 'no_match'
    } } : {}) };
}

const readableValue = (value, depth = 0) => {
  if (value === null) return '空';
  if (Array.isArray(value)) return value.slice(0, 12).map(item => readableValue(item, depth + 1)).join('、').slice(0, 1000);
  if (object(value)) return depth > 4 ? `${Object.keys(value).length} 个字段` : Object.entries(value).slice(0, 12)
    .map(([field, item]) => `${labelField(field)}：${readableValue(item, depth + 1)}`).join('；').slice(0, 1000);
  return String(value).slice(0, 1000);
};
const details = values => Object.entries(values).filter(([, value]) => value !== '' && value !== null)
  .map(([field, value]) => ({ label: labelField(field), value: readableValue(value) }));
const slotLabel = values => [values.day, values.time, values.status === 'Free' ? '空闲' : values.status === 'Busy' ? '忙碌' : values.status].filter(Boolean).join(' · ') || '收到的字段';
function graphFor(role, ownKg, ownData, incoming) {
  const nodes = new Map(), edges = new Map(), root = `${role}:agent`;
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return node.id; };
  const addEdge = (source, target, relation, label, origin = 'own', operationId) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const id = `${role}:edge:${digest([source, target, relation, label, operationId])}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, relation, label, origin, ...(operationId ? { operationId } : {}) });
  };
  addNode({ id: root, label: role, type: 'agent', origin: 'own', details: [] });
  const ownIds = new Map();
  for (const node of ownKg.nodes) {
    const id = `${role}:kg:${node.id}`; ownIds.set(node.id, id);
    addNode({ ...node, id, origin: 'own', details: [], sourceId: node.id });
  }
  for (const edge of ownKg.edges) addEdge(ownIds.get(edge.source), ownIds.get(edge.target), edge.label, edge.label);
  for (const id of ownIds.values()) addEdge(root, id, 'knows', '初始知识');
  for (const card of ownData) {
    const cardId = `${role}:data:${card.id}`;
    addNode({ id: cardId, label: card.label, type: 'dataset', origin: 'own', details: [{ label: '条目', value: String(card.count) }] });
    addEdge(root, cardId, 'owns', '持有数据');
    for (const item of card.items) {
      const id = `${cardId}:${digest([item.label, item.details])}`;
      addNode({ id, label: item.label, type: card.kind === 'brief' ? 'fact' : 'calendar_slot', origin: 'own', details: item.details });
      addEdge(cardId, id, 'contains', card.kind === 'brief' ? '包含简报字段' : '包含时间段');
    }
  }
  for (const receipt of incoming) {
    const sender = role === 'Alice' ? 'Bob' : 'Alice';
    const provenance = { operationId: receipt.operationId, fields: receipt.fields, receivedAt: receipt.receivedAt, sender };
    const id = `${role}:received:${receipt.operationId}`;
    addNode({ id, label: `来自 ${sender} 的快照`, type: 'snapshot', origin: 'received', details: [
      { label: '字段', value: receipt.fields.map(labelField).join('、') }, ...(receipt.window ? [{ label: '日期范围', value: windowLabel(receipt.window) }] : [])], provenance });
    addEdge(root, id, 'received', '已确认接收', 'received', receipt.operationId);
    const values = receipt.rows ?? [receipt.values];
    for (const row of values) {
      const rowDetails = details(row), rowId = `${id}:${digest(row)}`;
      addNode({ id: rowId, label: receipt.rows || row.day || row.time ? slotLabel(row) : '已收到的简报',
        type: receipt.rows || row.day || row.time ? 'calendar_slot' : 'fact', origin: 'received', details: rowDetails, provenance });
      addEdge(id, rowId, 'disclosed', '包含已授权字段', 'received', receipt.operationId);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
function ownInventory(role, data) {
  const rows = role === 'Alice' ? data.calendar : data.availableTimes;
  const items = rows.map(row => ({ label: slotLabel(row), details: details(row) }));
  const result = [{ id: 'calendar', label: role === 'Alice' ? '自己的日历' : '自己的可用时间', kind: 'calendar', origin: 'own',
    count: rows.length, fields: [...new Set(rows.flatMap(row => Object.keys(row)))], summary: `${rows.length} 个模拟时间段`, items }];
  if (role === 'Bob') result.push({ id: 'brief', label: '自己的会议简报', kind: 'brief', origin: 'own', count: Object.keys(data.brief).length,
    fields: Object.keys(data.brief), summary: data.brief.topic ? readableValue(data.brief.topic) : `${Object.keys(data.brief).length} 个简报字段`,
    items: Object.entries(data.brief).map(([field, value]) => ({ label: labelField(field), details: [{ label: labelField(field), value: readableValue(value ?? '') }] })) });
  return result;
}
const expiryAt = (startedAt, minutes) => startedAt && minutes !== null ? iso(Date.parse(startedAt) + minutes * 60_000) : null;
function permissionStatus({ disabled, expired, remaining, pending = false }) {
  return disabled ? 'disabled' : expired ? 'expired' : remaining === 0 ? 'exhausted' : pending ? 'pending' : 'active';
}
function authorizationFor(role, state, at) {
  const isAlice = role === 'Alice', policy = isAlice ? state.conditions?.agents.Alice.authorization : state.config?.permissions;
  const disabled = state.ended || state.stopped;
  const hasTool = resource => state.config?.tools.capabilities.includes(resource === 'availability' ? 'send_scoped_reply' : resource === 'meeting_brief' ? 'share_brief' : 'send_scoped_reply') === true;
  const incomingPending = state.approvals.filter(item => item.status === 'pending' && item.policyRevision === state.configRevision);
  const expiresAt = expiryAt(state.startedAt, policy?.expiryMinutes ?? null);
  const uses = isAlice ? state.aliceUses ?? state.receipts.aliceToBob.filter(item => item.status === 'received').length : state.policyUses;
  const maxUses = policy?.maxUses ?? null, remaining = maxUses === null ? null : Math.max(0, maxUses - uses);
  const policyDisabled = disabled || !policy || !policy.fields.length || isAlice && (!policy.windows.length || !['read_synthetic_calendar', 'preview_scoped_calendar', 'send_scoped_snapshot'].every(id => state.conditions.agents.Alice.skills.includes(id)))
    || !isAlice && (!policy.recipients.includes('Alice') || !policy.resources.some(hasTool));
  const status = permissionStatus({ disabled: policyDisabled, expired: expiresAt && at >= Date.parse(expiresAt), remaining,
    pending: !isAlice && policy?.confirmation !== 'bounded' });
  const cards = [{ id: `${role}:policy`, label: isAlice ? '日历分享上限' : '当前分享策略', status,
    recipient: isAlice ? 'Bob' : policy?.recipients.join('、') ?? '', resource: isAlice ? 'calendar' : policy?.resources.join('、') ?? '',
    fields: policy?.fields ?? [], windows: isAlice ? policy?.windows ?? [] : policy?.window ? [policy.window] : [],
    maxUses, uses, remaining, expiresAt, confirmation: isAlice ? 'per_action' : policy?.confirmation ?? null,
    reserved: state.pendingDelivery?.direction === (isAlice ? 'bob' : 'alice') ? 1 : 0,
    description: isAlice ? '每次分享仍需本人确认；已收到的快照保留在回合记录中。' : '计数在授权发送时消耗；未确认接收的发送也占用预算。' }];
  if (!isAlice) {
    for (const [index, grant] of state.grants.entries()) cards.push({ id: `Bob:grant:${index}`, label: '本回合授权',
      status: permissionStatus({ disabled: disabled || !hasTool(grant.resource), expired: grant.expiresAt && at >= Date.parse(grant.expiresAt), remaining: grant.remaining }),
      recipient: 'Alice', resource: grant.resource, purpose: grant.purpose, fields: grant.fields, windows: [], maxUses: grant.maxUses,
      uses: grant.uses ?? (grant.maxUses !== null && grant.remaining !== null ? grant.maxUses - grant.remaining : null),
      remaining: grant.remaining, expiresAt: grant.expiresAt, confirmation: 'allow_round',
      description: '仅对这次请求的确切字段、值、用途有效。' });
    for (const approval of incomingPending) cards.push({ id: `Bob:approval:${approval.id}`, label: '等待主人审核',
      status: permissionStatus({ disabled, expired: approval.expiresAt && at >= Date.parse(approval.expiresAt), pending: true }),
      recipient: approval.recipient, resource: approval.resource, fields: approval.fields, windows: [], maxUses: null,
      uses: 0, remaining: null, expiresAt: approval.expiresAt, confirmation: 'owner', description: approval.summary });
  }
  const activeGrant = cards.some(card => card.confirmation === 'allow_round' && card.status === 'active');
  const overall = disabled ? 'disabled' : cards.some(card => card.status === 'pending') ? 'pending' : activeGrant ? 'active' : status;
  const summary = { active: '授权有效', pending: '需逐次授权或等待审核', expired: '授权已到期', exhausted: '授权次数已用尽', disabled: '后续分享已禁用' }[overall];
  return { status: overall, summary, cards, receivedSnapshotsRetained: true };
}

/** Builds readable, receipt-backed per-agent state without mutating the session. */
export function buildAgentStates(session, at = Date.now()) {
  const state = baseSnapshot(session);
  // The fallback supports pre-initialization-condition sessions; an explicit empty calendar stays empty.
  if (!read(session, 'aliceCalendar') && !state.conditions) state.aliceCalendar = calendar(ALICE_CALENDAR);
  const result = {};
  for (const role of ROLES) {
    const initialized = state.conditions?.agents[role];
    const data = role === 'Alice' ? { calendar: read(session, 'aliceCalendar') ? state.aliceCalendar : initialized?.data.calendar ?? state.aliceCalendar }
      : state.config?.data ?? initialized?.data ?? { availableTimes: [], brief: {} };
    const ownData = ownInventory(role, data);
    const incoming = state.receipts[role === 'Alice' ? 'bobToAlice' : 'aliceToBob'].filter(receipt => receipt.status === 'received');
    const graph = graphFor(role, initialized?.kg ?? { nodes: [], edges: [] }, ownData, incoming);
    const capabilities = role === 'Bob' ? state.config?.tools.capabilities ?? initialized?.skills ?? [] : initialized?.skills ?? ['read_synthetic_calendar', 'project_calendar', 'send_scoped_snapshot'];
    const definitions = new Map((role === 'Bob' && state.config ? state.config.tools.skillDefinitions ?? [] : initialized?.skillDefinitions ?? []).map(definition => [definition.id, definition]));
    result[role] = { id: role, label: role, kg: graph,
      skills: capabilities.map(id => {
        const registered = Object.hasOwn(SKILLS, id) ? SKILLS[id] : null;
        const definition = definitions.get(id);
        return { id, label: definition?.label ?? registered?.[0] ?? id.replaceAll('_', ' '), description: definition?.description ?? registered?.[1] ?? '此标签提供自定义角色指导；只会执行已注册的操作。', enabled: true, ...(!registered || definition ? { customized: true } : {}) };
      }),
      data: [...ownData, ...incoming.map(receipt => ({ id: `received:${receipt.operationId}`, label: `来自 ${role === 'Alice' ? 'Bob' : 'Alice'} 的快照`,
        kind: 'snapshot', origin: 'received', count: receipt.rows?.length ?? Object.keys(receipt.values).length, fields: receipt.fields,
        summary: `${receipt.fields.map(labelField).join('、')}${receipt.window ? ` · ${windowLabel(receipt.window)}` : ''}`,
        items: (receipt.rows ?? [receipt.values]).map(row => ({ label: slotLabel(row), details: details(row) })),
        provenance: { operationId: receipt.operationId, fields: receipt.fields, receivedAt: receipt.receivedAt, sender: role === 'Alice' ? 'Bob' : 'Alice' } }))],
      authorization: authorizationFor(role, state, at), stats: { ownNodes: graph.nodes.filter(node => node.origin === 'own').length,
        receivedNodes: graph.nodes.filter(node => node.origin === 'received').length, edges: graph.edges.length, receipts: incoming.length } };
  }
  return result;
}

/** Full synthetic state whitelist; credentials, raw conversation and model internals never enter a trace. */
export function buildTraceSnapshot(session, at = Date.now()) {
  const snapshot = baseSnapshot(session);
  snapshot.capturedAt = iso(at);
  if (!read(session, 'aliceCalendar')) snapshot.aliceCalendar = snapshot.conditions?.agents.Alice.data.calendar ?? calendar(ALICE_CALENDAR);
  snapshot.agentStates = buildAgentStates(snapshot, at);
  return snapshot;
}

/** Reapply the whitelist on disk reload and derive views rather than trusting saved graph content. */
export function sanitizeTraceSnapshot(input) {
  if (!object(input) || read(input, 'schemaVersion') !== 'agent-trace-v1' || !iso(read(input, 'capturedAt')) || !conditions(read(input, 'conditions'))) return null;
  try {
    const snapshot = baseSnapshot(input);
    snapshot.agentStates = buildAgentStates(snapshot, Date.parse(snapshot.capturedAt));
    return snapshot;
  } catch {
    // Invalid semantic evidence marks this trace entry invalid on reload.
    return null;
  }
}
