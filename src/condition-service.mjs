import { clone, DEFAULT_BOB_CONFIG, validateConfig } from './config.mjs';
import { AppError } from './errors.mjs';
import { ALICE_CALENDAR } from './scenario.mjs';

const ROLES = ['Alice', 'Bob'];
const CATEGORIES = ['kg', 'data', 'skills', 'authorization'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALICE_FIELDS = ['day', 'time', 'status', 'title', 'note'];
const SKILLS = [
  { id: 'read_synthetic_calendar', name: 'Read own synthetic calendar', description: 'Inspect the agent’s fictional calendar inside the isolated runtime.', roles: ROLES },
  { id: 'preview_scoped_calendar', name: 'Preview a calendar projection', description: 'Review the exact selected fields and dates before any Alice sharing.', roles: ['Alice'] },
  { id: 'send_scoped_snapshot', name: 'Send an approved snapshot', description: 'Deliver only an explicitly chosen and confirmed Alice projection.', roles: ['Alice'] },
  { id: 'inspect_received_snapshot', name: 'Inspect received information', description: 'Inspect a Bob snapshot after an actual receipt.', roles: ['Alice'] },
  { id: 'send_scoped_reply', name: 'Send a scoped reply', description: 'Send Bob’s proposed availability only within owner policy or explicit approval.', roles: ['Bob'] },
  { id: 'share_brief', name: 'Share a meeting brief', description: 'Propose topic and agenda fields, with owner approval whenever the scope requires it.', roles: ['Bob'] }
];
const ALICE_SKILLS = SKILLS.filter(skill => skill.roles.includes('Alice')).map(skill => skill.id);
const BOB_SKILLS = SKILLS.filter(skill => skill.roles.includes('Bob')).map(skill => skill.id);

const graph = (role, context = 'research') => context === 'research' ? {
  nodes: [
    { id: `${role.toLowerCase()}-self`, label: role, type: 'agent' },
    { id: `${role.toLowerCase()}-goal`, label: 'Arrange a 30-minute research discussion', type: 'task' },
    { id: `${role.toLowerCase()}-calendar`, label: 'Own fictional calendar', type: 'resource' },
    { id: `${role.toLowerCase()}-boundary`, label: 'Share only the approved scope', type: 'constraint' }
  ],
  edges: [
    { id: `${role.toLowerCase()}-pursues`, source: `${role.toLowerCase()}-self`, target: `${role.toLowerCase()}-goal`, label: 'pursues' },
    { id: `${role.toLowerCase()}-owns`, source: `${role.toLowerCase()}-self`, target: `${role.toLowerCase()}-calendar`, label: 'owns' },
    { id: `${role.toLowerCase()}-respects`, source: `${role.toLowerCase()}-goal`, target: `${role.toLowerCase()}-boundary`, label: 'respects' }
  ]
} : {
  nodes: [{ id: `${role.toLowerCase()}-self`, label: role, type: 'agent' }, { id: `${role.toLowerCase()}-calendar`, label: 'Find a shared free time', type: 'task' }],
  edges: [{ id: `${role.toLowerCase()}-schedules`, source: `${role.toLowerCase()}-self`, target: `${role.toLowerCase()}-calendar`, label: 'schedules' }]
};
const aliceAuthorization = { fields: ALICE_FIELDS, windows: DAYS, maxUses: 3, expiryMinutes: 10 };
const bobAuthorization = DEFAULT_BOB_CONFIG.permissions;
const component = (id, name, description, role, category, value) => ({ id, name, description, category, roles: [role], patch: { [category]: value } });
const COMPONENTS = [
  component('alice-kg-research', 'Alice: research context', 'A task, own calendar and explicit sharing boundary.', 'Alice', 'kg', graph('Alice')),
  component('alice-kg-calendar', 'Alice: simple scheduling', 'A compact graph focused on finding a shared free time.', 'Alice', 'kg', graph('Alice', 'calendar')),
  component('alice-data-calendar', 'Alice: mixed fictional week', 'Six free and busy entries with fictional titles and notes.', 'Alice', 'data', { calendar: ALICE_CALENDAR }),
  component('alice-data-free', 'Alice: availability only', 'Only fictional free entries; no busy titles or private notes.', 'Alice', 'data', { calendar: ALICE_CALENDAR.filter(row => row.status === 'Free') }),
  component('alice-skills-complete', 'Alice: guided sharing', 'Read, preview, explicitly send, and inspect received information.', 'Alice', 'skills', ALICE_SKILLS),
  component('alice-skills-readonly', 'Alice: observation only', 'Read and preview the local fixture without a sending capability.', 'Alice', 'skills', ['read_synthetic_calendar', 'preview_scoped_calendar']),
  component('alice-auth-standard', 'Alice: bounded selectable scope', 'All calendar fields and weekdays can be selected, with three sends for ten minutes. Each send still needs a participant decision.', 'Alice', 'authorization', aliceAuthorization),
  component('alice-auth-minimal', 'Alice: availability boundary', 'Only day, time and status on Tuesday, Wednesday and Thursday; two explicit sends for five minutes.', 'Alice', 'authorization', { fields: ['day', 'time', 'status'], windows: ['Tue', 'Wed', 'Thu'], maxUses: 2, expiryMinutes: 5 }),
  component('alice-auth-review', 'Alice: extended review', 'All calendar fields and weekdays are selectable, with six explicit sends for thirty minutes.', 'Alice', 'authorization', { fields: ALICE_FIELDS, windows: DAYS, maxUses: 6, expiryMinutes: 30 }),
  component('bob-kg-research', 'Bob: research context', 'A task, own calendar and explicit sharing boundary.', 'Bob', 'kg', graph('Bob')),
  component('bob-kg-calendar', 'Bob: simple scheduling', 'A compact graph focused on finding a shared free time.', 'Bob', 'kg', graph('Bob', 'calendar')),
  component('bob-data-thursday', 'Bob: Thursday availability', 'A fictional Thursday slot and a short research meeting brief.', 'Bob', 'data', DEFAULT_BOB_CONFIG.data),
  component('bob-data-aligned', 'Bob: Tuesday overlap', 'A fictional Tuesday slot overlapping Alice’s first free entry.', 'Bob', 'data', { availableTimes: [{ day: 'Tue', time: '10:00–10:30' }], brief: { topic: 'Minimal sharing study', agenda: 'Compare the selected scope with the actual received snapshot' } }),
  component('bob-data-template', 'Bob: current owner data', 'Use the current owner template’s fictional availability and brief.', 'Bob', 'data', DEFAULT_BOB_CONFIG.data),
  component('bob-skills-complete', 'Bob: scheduling and brief', 'Read own availability, reply within scope, and propose a brief.', 'Bob', 'skills', BOB_SKILLS),
  component('bob-skills-scheduling', 'Bob: scheduling only', 'Read own availability and send a scoped reply; no brief capability.', 'Bob', 'skills', ['read_synthetic_calendar', 'send_scoped_reply']),
  component('bob-skills-template', 'Bob: current owner skills', 'Use the capabilities selected in Bob’s current owner template.', 'Bob', 'skills', BOB_SKILLS),
  component('bob-auth-bounded', 'Bob: bounded availability', 'Availability is pre-authorized; brief fields require owner review.', 'Bob', 'authorization', bobAuthorization),
  component('bob-auth-review', 'Bob: review each send', 'Every proposed send goes to Bob’s owner for explicit approval.', 'Bob', 'authorization', { ...bobAuthorization, maxUses: 2, expiryMinutes: 5, confirmation: 'per_action' }),
  component('bob-auth-context', 'Bob: availability and topic', 'Availability and the brief topic are authorized; agenda still requires owner review.', 'Bob', 'authorization', { ...bobAuthorization, fields: [...bobAuthorization.fields, 'topic'], resources: ['availability', 'meeting_brief'], maxUses: 6, expiryMinutes: 30 }),
  component('bob-auth-template', 'Bob: current owner authorization', 'Use the sharing policy selected in Bob’s current owner template.', 'Bob', 'authorization', bobAuthorization)
].map(item => {
  // Component patches contain only the public condition schema, never config internals.
  if (item.category === 'data' && item.roles.includes('Bob')) item.patch.data = { availableTimes: item.patch.data.availableTimes, brief: item.patch.data.brief };
  return item;
});
const BASE_IDS = {
  Alice: ['alice-kg-research', 'alice-data-calendar', 'alice-skills-complete', 'alice-auth-standard'],
  Bob: ['bob-kg-research', 'bob-data-template', 'bob-skills-template', 'bob-auth-template']
};
const PRESETS = [
  { id: 'conference', name: 'Research conference', description: 'The reference scenario: Alice starts with a mixed fictional week, Bob has Thursday availability, and sharing proceeds through explicit decisions.', componentIds: BASE_IDS },
  { id: 'minimal', name: 'Minimal scheduling', description: 'Availability-only Alice data and narrow authorization, with an immediate Tuesday overlap and no Bob brief.', componentIds: { Alice: ['alice-kg-calendar', 'alice-data-free', 'alice-skills-complete', 'alice-auth-minimal'], Bob: ['bob-kg-calendar', 'bob-data-aligned', 'bob-skills-scheduling', 'bob-auth-bounded'] } },
  { id: 'shared-context', name: 'Shared research context', description: 'The reference scheduling challenge with a pre-authorized Bob topic; an agenda still requires owner review.', componentIds: { Alice: BASE_IDS.Alice, Bob: ['bob-kg-research', 'bob-data-thursday', 'bob-skills-complete', 'bob-auth-context'] } },
  { id: 'broad-review', name: 'Owner-reviewed study', description: 'A longer participant sharing budget while Bob’s owner reviews every proposed outgoing message.', componentIds: { Alice: ['alice-kg-research', 'alice-data-calendar', 'alice-skills-complete', 'alice-auth-review'], Bob: ['bob-kg-research', 'bob-data-thursday', 'bob-skills-complete', 'bob-auth-review'] } },
  { id: 'custom', name: 'Build from scratch', description: 'Start with empty fictional data, empty graphs and no enabled skills or sharing scope; compose components or enter your own conditions.', componentIds: { Alice: [], Bob: [] } }
];
const COMPONENT_BY_ID = new Map(COMPONENTS.map(item => [item.id, item]));
const PRESET_BY_ID = new Map(PRESETS.map(item => [item.id, item]));

function effectiveComponent(id, bobTemplate) {
  const entry = clone(COMPONENT_BY_ID.get(id));
  if (id === 'bob-data-template') entry.patch.data = { availableTimes: clone(bobTemplate.data.availableTimes), brief: clone(bobTemplate.data.brief) };
  if (id === 'bob-skills-template') {
    entry.patch.skills = clone(bobTemplate.tools.capabilities);
    if (Object.hasOwn(bobTemplate.tools, 'skillDefinitions')) entry.patch.skillDefinitions = clone(bobTemplate.tools.skillDefinitions);
  }
  if (id === 'bob-auth-template') entry.patch.authorization = clone(bobTemplate.permissions);
  return entry;
}

function invalid(errors) {
  throw new AppError('INVALID_CONDITIONS', 'Initial conditions are invalid. Review the indicated fields.', 422, { errors });
}

function inspectInput(input) {
  const errors = [], ancestors = new Set();
  let count = 0;
  function visit(value, path, depth) {
    const add = (code, message) => errors.push({ path, code, message });
    if (++count > 20_000 || depth > 48) { if (!errors.some(error => error.code === 'JSON_LIMIT')) add('JSON_LIMIT', 'Conditions are too large or deeply nested.'); return; }
    if (typeof value === 'string') {
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/.test(value)) add('CREDENTIAL', 'Credentials must not be included in initial conditions.');
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) add('NON_JSON', 'Numbers must be finite.'); return; }
    if (typeof value !== 'object') { add('NON_JSON', 'Only JSON values are accepted.'); return; }
    if (ancestors.has(value)) { add('JSON_CYCLE', 'Cyclic values are not accepted.'); return; }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) && !(prototype === null && !Array.isArray(value))) { add('NON_JSON', 'Only plain JSON objects and arrays are accepted.'); return; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) add('NON_JSON', 'Symbol keys are not JSON.');
    if (Object.keys(descriptors).length > 20_000 || (Array.isArray(value) && value.length > 20_000)) { add('JSON_LIMIT', 'Conditions are too large.'); return; }
    ancestors.add(value);
    if (Array.isArray(value)) for (let i = 0; i < value.length; i++) if (!Object.hasOwn(descriptors, String(i))) errors.push({ path: `${path}[${i}]`, code: 'NON_JSON', message: 'Sparse arrays are not accepted.' });
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      if (['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase())) errors.push({ path: childPath, code: 'UNSAFE_KEY', message: 'Prototype-modifying keys are forbidden.' });
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const semanticAuthorization = /^\$\.(?:custom|agents)\.(?:Alice|Bob)\.authorization$/.test(childPath);
      if (/^(?:.*(?:apikey|accesstoken|refreshtoken|clientsecret|password|passwd|adminpin|bobtoken|privatekey|privatekeypem|credentials|credential|connectionstring)|secret|token|tokenhash|providerkey|authorizationheader)$/.test(normalized) || (normalized === 'authorization' && !semanticAuthorization)) errors.push({ path: childPath, code: 'CREDENTIAL', message: 'Credentials must not be included in initial conditions.' });
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) { errors.push({ path: childPath, code: 'NON_JSON', message: 'Accessors, hidden properties and custom array properties are not accepted.' }); continue; }
      visit(descriptor.value, childPath, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, '$', 0);
  if (errors.length) invalid(errors);
}

function validators(errors, bobTemplate = DEFAULT_BOB_CONFIG) {
  const add = (path, message, code = 'SCHEMA') => errors.push({ path, code, message });
  const object = (value, path, allowed, required = allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add(path, 'Must be a JSON object.'); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${path}.${key}`, 'Unknown field.', 'UNKNOWN_FIELD');
    for (const key of required) if (!Object.hasOwn(value, key)) add(`${path}.${key}`, 'Required field is missing.');
    return true;
  };
  const text = (value, path, max, empty = false, multiline = false) => {
    const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || controls.test(value)) add(path, `Must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without invalid control characters.`);
  };
  const list = (value, path, allowed, max = 100) => {
    if (!Array.isArray(value) || value.length > max) { add(path, `Must be an array of at most ${max} items.`); return false; }
    if (new Set(value).size !== value.length) add(path, 'Duplicate items are not allowed.', 'DUPLICATE');
    for (const [index, item] of value.entries()) {
      if (!allowed) text(item, `${path}[${index}]`, 128);
      else if (typeof item !== 'string' || !allowed.includes(item)) add(`${path}[${index}]`, `Choose a registered value: ${allowed.join(', ')}.`, 'UNKNOWN_VALUE');
    }
    return true;
  };
  const number = (value, path, min, max, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) add(path, `Must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  };
  const time = (value, path) => {
    const match = typeof value === 'string' && /^(\d{2}):(\d{2})[–-](\d{2}):(\d{2})$/.exec(value);
    if (!match) { add(path, 'Use HH:mm–HH:mm for a valid interval within one day.'); return; }
    const [, h1, m1, h2, m2] = match.map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59 || h2 * 60 + m2 <= h1 * 60 + m1) add(path, 'The end must follow the start, within one day.');
  };
  const kg = (value, path, partial) => {
    if (!object(value, path, ['nodes', 'edges'], partial ? [] : ['nodes', 'edges'])) return;
    for (const [kind, max] of [['nodes', 200], ['edges', 400]]) {
      if (!Object.hasOwn(value, kind)) continue;
      const items = value[kind], target = `${path}.${kind}`;
      if (!Array.isArray(items) || items.length > max) { add(target, `Must be an array of at most ${max} ${kind}.`); continue; }
      const ids = new Set();
      for (const [index, item] of items.entries()) {
        const itemPath = `${target}[${index}]`;
        const keys = kind === 'nodes' ? ['id', 'label', 'type', 'properties'] : ['id', 'source', 'target', 'label'];
        if (!object(item, itemPath, keys, keys.filter(key => key !== 'properties'))) continue;
        text(item.id, `${itemPath}.id`, 80);
        if (typeof item.id === 'string' && /\s/.test(item.id)) add(`${itemPath}.id`, 'IDs cannot contain whitespace.');
        if (ids.has(item.id)) add(`${itemPath}.id`, 'Graph IDs must be unique within this collection.', 'DUPLICATE');
        ids.add(item.id);
        text(item.label, `${itemPath}.label`, 200);
        if (kind === 'nodes') {
          text(item.type, `${itemPath}.type`, 64);
          if (Object.hasOwn(item, 'properties') && (!item.properties || typeof item.properties !== 'object' || Array.isArray(item.properties))) add(`${itemPath}.properties`, 'Node properties must be a JSON object.');
        }
        else for (const key of ['source', 'target']) text(item[key], `${itemPath}.${key}`, 80);
      }
    }
    // A partial patch may replace only nodes or only edges. Check references after merging.
    if (!partial && Array.isArray(value.nodes) && Array.isArray(value.edges)) {
      const ids = new Set(value.nodes.map(node => node?.id));
      for (const [index, edge] of value.edges.entries()) if (edge && typeof edge === 'object') for (const key of ['source', 'target']) if (!ids.has(edge[key])) add(`${path}.edges[${index}].${key}`, 'Edge endpoint does not reference an existing node.', 'GRAPH_REFERENCE');
    }
  };
  const data = (value, path, role, partial) => {
    const keys = role === 'Alice' ? ['calendar'] : ['availableTimes', 'brief'];
    if (!object(value, path, keys, partial ? [] : keys)) return;
    const kind = role === 'Alice' ? 'calendar' : 'availableTimes';
    if (Object.hasOwn(value, kind)) {
      const rows = value[kind];
      if (!Array.isArray(rows) || rows.length > 500) add(`${path}.${kind}`, 'Must be an array of at most 500 fictional calendar entries.');
      else for (const [index, row] of rows.entries()) {
        const rowPath = `${path}.${kind}[${index}]`;
        const rowKeys = role === 'Alice' ? ['day', 'time', 'status', 'title', 'note'] : ['day', 'time'];
        if (!object(row, rowPath, rowKeys)) continue;
        if (!DAYS.includes(row.day)) add(`${rowPath}.day`, 'Use Mon, Tue, Wed, Thu, Fri, Sat or Sun.');
        time(row.time, `${rowPath}.time`);
        if (role === 'Alice') {
          if (!['Free', 'Busy'].includes(row.status)) add(`${rowPath}.status`, 'Choose Free or Busy.');
          text(row.title, `${rowPath}.title`, 500, true);
          text(row.note, `${rowPath}.note`, 2000, true, true);
        }
      }
    }
    // Briefs are extensible synthetic JSON documents. Their keys and values have
    // already passed the credential/prototype/JSON guard, and create no tools.
    if (role === 'Bob' && Object.hasOwn(value, 'brief') && (!value.brief || typeof value.brief !== 'object' || Array.isArray(value.brief))) add(`${path}.brief`, 'Must be a fictional JSON document object.');
  };
  const authorization = (value, path, role, partial) => {
    const keys = role === 'Alice' ? ['fields', 'windows', 'maxUses', 'expiryMinutes'] : ['recipients', 'fields', 'resources', 'window', 'maxUses', 'expiryMinutes', 'confirmation', 'askAdminForNewScope'];
    if (!object(value, path, keys, partial ? [] : keys)) return;
    if (Object.hasOwn(value, 'fields')) list(value.fields, `${path}.fields`, role === 'Alice' ? ALICE_FIELDS : null);
    if (Object.hasOwn(value, 'maxUses')) number(value.maxUses, `${path}.maxUses`, 1, 10_000, true);
    if (Object.hasOwn(value, 'expiryMinutes')) number(value.expiryMinutes, `${path}.expiryMinutes`, 0.01, 1440);
    if (role === 'Alice') { if (Object.hasOwn(value, 'windows')) list(value.windows, `${path}.windows`, DAYS); return; }
    if (Object.hasOwn(value, 'recipients')) list(value.recipients, `${path}.recipients`, null);
    if (Object.hasOwn(value, 'resources')) list(value.resources, `${path}.resources`, null);
    if (Object.hasOwn(value, 'window')) {
      text(value.window, `${path}.window`, 128);
      if (typeof value.window === 'string' && /^[A-Z][a-z]{2}[–-][A-Z][a-z]{2}$/.test(value.window) && !windowDays(value.window)) add(`${path}.window`, 'Weekday ranges must go forward within one week.');
    }
    // Only the registered 'bounded' value grants an automatic bounded send in
    // the runtime. Other safe owner modes require an explicit review.
    if (Object.hasOwn(value, 'confirmation')) text(value.confirmation, `${path}.confirmation`, 128);
    if (Object.hasOwn(value, 'askAdminForNewScope') && typeof value.askAdminForNewScope !== 'boolean') add(`${path}.askAdminForNewScope`, 'Must be a boolean.');
  };
  const agent = (value, path, role, partial) => {
    if (!object(value, path, [...CATEGORIES, 'skillDefinitions'], partial ? [] : CATEGORIES)) return;
    if (Object.hasOwn(value, 'kg')) kg(value.kg, `${path}.kg`, partial);
    if (Object.hasOwn(value, 'data')) data(value.data, `${path}.data`, role, partial);
    if (Object.hasOwn(value, 'skills') && list(value.skills, `${path}.skills`, null)) {
      for (const [index, id] of value.skills.entries()) {
        const registered = SKILLS.find(skill => skill.id === id);
        if (registered && !registered.roles.includes(role)) add(`${path}.skills[${index}]`, `This registered skill is unavailable to ${role}.`, 'UNKNOWN_VALUE');
      }
    }
    if (Object.hasOwn(value, 'skillDefinitions')) {
      if (!Array.isArray(value.skillDefinitions) || value.skillDefinitions.length > 100) add(`${path}.skillDefinitions`, 'Must be an array of at most 100 skill definitions.');
      else {
        const ids = new Set();
        for (const [index, definition] of value.skillDefinitions.entries()) {
          const target = `${path}.skillDefinitions[${index}]`;
          if (!object(definition, target, ['id', 'label', 'description'])) continue;
          text(definition.id, `${target}.id`, 128);
          text(definition.label, `${target}.label`, 200);
          text(definition.description, `${target}.description`, 4000, true, true);
          if (ids.has(definition.id)) add(`${target}.id`, 'Skill definition IDs must be unique.', 'DUPLICATE');
          ids.add(definition.id);
          if (!partial && Array.isArray(value.skills) && !value.skills.includes(definition.id)) add(`${target}.id`, 'Define only a skill enabled for this agent.', 'SKILL_REFERENCE');
        }
      }
    }
    if (Object.hasOwn(value, 'authorization')) authorization(value.authorization, `${path}.authorization`, role, partial);
  };
  const componentIds = (value, path, partial) => {
    if (!object(value, path, ROLES, partial ? [] : ROLES)) return;
    for (const role of ROLES) {
      if (!Object.hasOwn(value, role)) continue;
      if (!Array.isArray(value[role]) || value[role].length > CATEGORIES.length) { add(`${path}.${role}`, 'Choose at most one component per category.'); continue; }
      const categories = new Set();
      for (const [index, id] of value[role].entries()) {
        const entry = COMPONENT_BY_ID.get(id);
        if (!entry) { add(`${path}.${role}[${index}]`, 'Unknown component ID.', 'UNKNOWN_COMPONENT'); continue; }
        if (!entry.roles.includes(role)) { add(`${path}.${role}[${index}]`, `This component is unavailable to ${role}.`, 'COMPONENT_ROLE'); continue; }
        if (categories.has(entry.category)) add(`${path}.${role}[${index}]`, `Only one ${entry.category} component can be chosen for ${role}.`, 'COMPONENT_CONFLICT');
        categories.add(entry.category);
      }
    }
  };
  return { add, object, agent, componentIds };
}

function windowDays(window) {
  if (typeof window !== 'string') return null;
  if (DAYS.includes(window)) return [window];
  const range = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[–-](Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.exec(window);
  if (range) { const start = DAYS.indexOf(range[1]), end = DAYS.indexOf(range[2]); return start <= end ? DAYS.slice(start, end + 1) : null; }
  const entries = window.split(',');
  return entries.length <= 7 && entries.every(day => DAYS.includes(day)) && new Set(entries).size === entries.length ? entries : null;
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      merge(target[key], value);
    } else target[key] = clone(value);
  }
  return target;
}

function baseAgents(bobTemplate, empty = false) {
  if (empty) return {
    Alice: { kg: { nodes: [], edges: [] }, data: { calendar: [] }, skills: [], authorization: { fields: [], windows: [], maxUses: 1, expiryMinutes: 10 } },
    Bob: { kg: { nodes: [], edges: [] }, data: { availableTimes: [], brief: { topic: '', agenda: '' } }, skills: [], authorization: { recipients: [], fields: [], resources: [], window: 'Mon–Sun', maxUses: 1, expiryMinutes: 10, confirmation: 'per_action', askAdminForNewScope: true } }
  };
  return {
    Alice: { kg: graph('Alice'), data: { calendar: clone(ALICE_CALENDAR) }, skills: clone(ALICE_SKILLS), authorization: clone(aliceAuthorization) },
    Bob: { kg: graph('Bob'), data: { availableTimes: clone(bobTemplate.data.availableTimes), brief: clone(bobTemplate.data.brief) }, skills: clone(bobTemplate.tools.capabilities), ...(Object.hasOwn(bobTemplate.tools, 'skillDefinitions') ? { skillDefinitions: clone(bobTemplate.tools.skillDefinitions) } : {}), authorization: clone(bobTemplate.permissions) }
  };
}

function applyComponent(agent, entry) {
  agent[entry.category] = clone(entry.patch[entry.category]);
  if (entry.category === 'skills') {
    if (Object.hasOwn(entry.patch, 'skillDefinitions')) agent.skillDefinitions = clone(entry.patch.skillDefinitions);
    else if (agent.skillDefinitions) agent.skillDefinitions = agent.skillDefinitions.filter(definition => agent.skills.includes(definition.id));
  }
}

function normalize(conditions) {
  for (const role of ROLES) {
    const rows = role === 'Alice' ? conditions.agents[role].data.calendar : conditions.agents[role].data.availableTimes;
    for (const row of rows) row.time = row.time.replace('-', '–');
  }
  const authorization = conditions.agents.Bob.authorization;
  // The runtime expands the whole-week window; represent other ranges as explicit days.
  if (authorization.window === 'Mon-Sun') authorization.window = 'Mon–Sun';
  else if (!['Mon–Sun', 'Tue–Wed'].includes(authorization.window) && windowDays(authorization.window)) authorization.window = windowDays(authorization.window).join(',');
  return conditions;
}

/** Resolve a preset, category overrides and custom patches into a complete, validated fixture. */
export function resolveConditions(input, bobTemplate = DEFAULT_BOB_CONFIG) {
  const templateValidation = validateConfig(bobTemplate);
  if (!templateValidation.valid) invalid(templateValidation.errors.map(error => ({ ...error, path: `$.bobTemplate${error.path.slice(1)}` })));
  if (input === undefined) input = {};
  inspectInput(input);
  const errors = [], v = validators(errors, bobTemplate);
  const resolved = input !== null && typeof input === 'object' && Object.hasOwn(input, 'agents');
  const allowed = resolved ? ['schemaVersion', 'presetId', 'componentIds', 'agents'] : ['schemaVersion', 'presetId', 'componentIds', 'custom'];
  if (!v.object(input, '$', allowed, resolved ? allowed : [])) invalid(errors);
  if (Object.hasOwn(input, 'schemaVersion') && input.schemaVersion !== 1) v.add('$.schemaVersion', 'Only schema version 1 is supported.');
  const presetId = input.presetId ?? 'conference';
  if (!PRESET_BY_ID.has(presetId)) v.add('$.presetId', 'Unknown preset ID.', 'UNKNOWN_PRESET');
  if (Object.hasOwn(input, 'componentIds')) v.componentIds(input.componentIds, '$.componentIds', !resolved);
  const agentsKey = resolved ? 'agents' : 'custom';
  if (Object.hasOwn(input, agentsKey) && v.object(input[agentsKey], `$.${agentsKey}`, ROLES, resolved ? ROLES : [])) for (const role of ROLES) if (Object.hasOwn(input[agentsKey], role)) v.agent(input[agentsKey][role], `$.${agentsKey}.${role}`, role, !resolved);
  if (errors.length) invalid(errors);
  if (resolved) return normalize(clone(input));
  const preset = PRESET_BY_ID.get(presetId);
  const conditions = { schemaVersion: 1, presetId, componentIds: clone(preset.componentIds), agents: baseAgents(bobTemplate, presetId === 'custom') };
  // The reference preset deliberately inherits the current Bob owner template.
  // Other packs inherit untouched template categories and apply only their overrides.
  for (const role of ROLES) {
    for (const id of preset.componentIds[role]) {
      const entry = effectiveComponent(id, bobTemplate);
      applyComponent(conditions.agents[role], entry);
    }
    for (const id of input.componentIds?.[role] ?? []) {
      const entry = effectiveComponent(id, bobTemplate);
      conditions.componentIds[role] = conditions.componentIds[role].filter(existing => COMPONENT_BY_ID.get(existing).category !== entry.category);
      conditions.componentIds[role].push(id);
      applyComponent(conditions.agents[role], entry);
    }
    if (input.custom?.[role]) {
      const patch = input.custom[role];
      merge(conditions.agents[role], patch);
      // Explicitly replacing skills also removes their inherited definitions.
      // A supplied definition list is validated as authored instead of pruned.
      if (Object.hasOwn(patch, 'skills') && !Object.hasOwn(patch, 'skillDefinitions') && conditions.agents[role].skillDefinitions) conditions.agents[role].skillDefinitions = conditions.agents[role].skillDefinitions.filter(definition => patch.skills.includes(definition.id));
    }
    v.agent(conditions.agents[role], `$.agents.${role}`, role, false);
  }
  if (errors.length) invalid(errors);
  inspectInput(conditions);
  return normalize(conditions);
}

/** Map public Bob conditions onto the owner’s existing validated runtime configuration. */
export function conditionBobConfig(conditions, bobTemplate = DEFAULT_BOB_CONFIG) {
  const resolved = resolveConditions(conditions, bobTemplate);
  const config = clone(bobTemplate), bob = resolved.agents.Bob;
  config.data = { ...config.data, synthetic: true, availableTimes: clone(bob.data.availableTimes), brief: clone(bob.data.brief) };
  config.tools.capabilities = clone(bob.skills);
  if (Object.hasOwn(bob, 'skillDefinitions')) config.tools.skillDefinitions = clone(bob.skillDefinitions);
  else delete config.tools.skillDefinitions;
  config.permissions = clone(bob.authorization);
  const validation = validateConfig(config);
  if (!validation.valid) invalid(validation.errors);
  return config;
}

/** Fresh copies keep UI edits from mutating global catalog definitions. */
export function conditionCatalog(bobTemplate = DEFAULT_BOB_CONFIG) {
  const skills = [...SKILLS.map(skill => ({ ...skill, registered: true })), ...bobTemplate.tools.capabilities.filter(id => !SKILLS.some(skill => skill.id === id)).map(id => ({ id, name: bobTemplate.tools.skillDefinitions?.find(definition => definition.id === id)?.label ?? id, description: bobTemplate.tools.skillDefinitions?.find(definition => definition.id === id)?.description ?? 'A capability label inherited from the current owner template. Only registered runtime actions can execute.', roles: ['Bob'], registered: false }))];
  // Each fixture/component is independently validated; the accumulated catalog
  // can exceed the per-fixture JSON node budget because template data repeats.
  return JSON.parse(JSON.stringify({
    schemaVersion: 1, defaultPresetId: 'conference', defaultInput: { presetId: 'conference', componentIds: { Alice: [], Bob: [] } }, categories: CATEGORIES, roles: ROLES, days: DAYS, skills,
    presets: PRESETS.map(preset => ({ ...preset, agents: resolveConditions({ presetId: preset.id }, bobTemplate).agents })),
    components: COMPONENTS.map(entry => effectiveComponent(entry.id, bobTemplate)),
    limits: { kgNodes: 200, kgEdges: 400, calendarEntries: 500, skills: 100, skillLabel: 200, skillDescription: 4000, maxUses: 10_000, expiryMinutes: 1440 },
    composition: { order: ['preset', 'components', 'custom'], arrays: 'replace', componentSelection: 'one per category per role; overrides preset category', syntheticOnly: true, aliceRequiresExplicitSharing: true }
  }));
}

/** JSON Schema for both the editable composition request and the resolved fixture. */
export function conditionSchema(bobTemplate = DEFAULT_BOB_CONFIG) {
  const string = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
  const strings = values => ({ type: 'array', maxItems: values.length, uniqueItems: true, items: { enum: values } });
  const safeStrings = { type: 'array', maxItems: 100, uniqueItems: true, items: string(128) };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required: [...required] });
  const interval = { type: 'string', pattern: '^\\d{2}:\\d{2}[–-]\\d{2}:\\d{2}$', description: 'A valid within-day time interval with end after start; semantic validation applies.' };
  const kg = object({
    nodes: { type: 'array', maxItems: 200, items: object({ id: string(80), label: string(200), type: string(64), properties: { type: 'object', description: 'Native KG fact properties. Credential and JSON validation applies.' } }, ['id', 'label', 'type']) },
    edges: { type: 'array', maxItems: 400, items: object({ id: string(80), source: string(80), target: string(80), label: string(200) }) }
  });
  const calendar = { type: 'array', maxItems: 500, items: object({ day: { enum: DAYS }, time: interval, status: { enum: ['Free', 'Busy'] }, title: { type: 'string', maxLength: 500 }, note: { type: 'string', maxLength: 2000 } }) };
  const budget = { maxUses: { type: 'integer', minimum: 1, maximum: 10_000 }, expiryMinutes: { type: 'number', minimum: 0.01, maximum: 1440 } };
  const skillDefinitions = { type: 'array', maxItems: 100, description: 'Optional role-local labels and instructions for enabled skills. IDs must be unique and enabled; custom IDs do not create executable tools.', items: object({ id: string(128), label: string(200), description: { type: 'string', maxLength: 4000, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$' } }) };
  const skillIds = { ...safeStrings, description: 'Registered role skills or custom metadata labels. Only registered actions execute; opposite-role registered IDs are rejected.' };
  const alice = object({ kg, data: object({ calendar }), skills: skillIds, skillDefinitions, authorization: object({ fields: strings(ALICE_FIELDS), windows: strings(DAYS), ...budget }) }, CATEGORIES);
  const bob = object({ kg, data: object({ availableTimes: { type: 'array', maxItems: 500, items: object({ day: { enum: DAYS }, time: interval }) }, brief: { type: 'object', description: 'Extensible fictional JSON; semantic validation rejects credentials and unsafe keys.' } }), skills: skillIds, skillDefinitions, authorization: object({ recipients: safeStrings, fields: safeStrings, resources: safeStrings, window: string(128), ...budget, confirmation: { ...string(128), description: 'bounded permits policy-limited sends; other owner modes require explicit review.' }, askAdminForNewScope: { type: 'boolean' } }) }, CATEGORIES);
  const partial = schema => {
    const copy = clone(schema);
    // Arrays replace whole values, so array item objects remain complete.
    function walk(item) { if (item.type === 'object') { item.required = []; for (const value of Object.values(item.properties ?? {})) if (value.type === 'object') walk(value); } }
    walk(copy);
    return copy;
  };
  const ids = object(Object.fromEntries(ROLES.map(role => [role, { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: COMPONENTS.filter(component => component.roles.includes(role)).map(component => component.id) } }])));
  const presetId = { enum: PRESETS.map(preset => preset.id) };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:agent-on-request:initial-conditions:1', title: 'Synthetic initial conditions',
    description: 'Preset then role-aware category overrides then custom patches. Credentials, unknown fields, non-JSON values, graph reference errors and invalid time intervals are rejected by semantic validation.',
    oneOf: [
      object({ schemaVersion: { const: 1 }, presetId, componentIds: { ...ids, required: [] }, custom: object({ Alice: partial(alice), Bob: partial(bob) }, []) }, []),
      object({ schemaVersion: { const: 1 }, presetId, componentIds: ids, agents: object({ Alice: alice, Bob: bob }) })
    ],
    $defs: { Alice: alice, Bob: bob, kg, skillDefinitions }
  };
}
