import { createHash } from 'node:crypto';

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_KEYS = new Set(['apikey', 'modelapikey', 'providerkey', 'password', 'passwd', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'bobtoken', 'adminpin', 'authorization', 'credentials', 'credential', 'privatekey', 'connectionstring']);
const DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

export const DEFAULT_BOB_CONFIG = {
  persona: 'Bob is a calm research collaborator.',
  objective: 'Arrange a fictional 30-minute discussion with Alice.',
  prompts: {
    system: 'Use only fictional information and actually received snapshots. Respect Alice’s decisions. Request only the scope needed for this task.',
    followUp: 'If the received window has no common time, ask whether Alice wants to add Thursday free times or a full-week snapshot. Respect refusal.'
  },
  data: {
    source: 'synthetic-calendar-v1', synthetic: true,
    availableTimes: [{ day: 'Thu', time: '15:00–15:30' }],
    brief: { topic: 'Agent collaboration interfaces', agenda: 'Scope, data sharing, follow-up' }
  },
  collaboration: { acceptInvitations: true, allowedPeers: ['Alice'] },
  tools: { capabilities: ['read_synthetic_calendar', 'send_scoped_reply', 'share_brief'] },
  permissions: {
    recipients: ['Alice'], fields: ['day', 'time', 'status'], resources: ['availability'],
    window: 'Mon–Sun', maxUses: 3, expiryMinutes: 10, confirmation: 'bounded', askAdminForNewScope: true
  },
  response: { constraints: 'Respect refusal. Never claim an unsent payload was received.', maxWords: 80, offerBrief: true },
  runtime: { model: 'configured-default', temperature: 0.2, timeoutSeconds: 20, retryLimit: 0 },
  extensions: {}
};

function inspectJSON(value, { credentials = false } = {}) {
  const errors = [];
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, path, depth) {
    if (++nodes > 20_000 || depth > 64) {
      if (!errors.some(error => error.code === 'JSON_LIMIT')) errors.push({ path, code: 'JSON_LIMIT', message: 'JSON is too large or deeply nested.' });
      return;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) errors.push({ path, code: 'NON_JSON', message: 'Numbers must be finite.' });
      return;
    }
    if (typeof item !== 'object') {
      errors.push({ path, code: 'NON_JSON', message: 'Only JSON values are accepted.' });
      return;
    }
    if (ancestors.has(item)) {
      errors.push({ path, code: 'JSON_CYCLE', message: 'Cyclic values are not JSON.' });
      return;
    }
    const prototype = Object.getPrototypeOf(item);
    if ((!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) || (Array.isArray(item) && prototype !== Array.prototype)) {
      errors.push({ path, code: 'NON_JSON', message: 'Only plain JSON objects and arrays are accepted.' });
      return;
    }
    if (Object.getOwnPropertySymbols(item).length) errors.push({ path, code: 'NON_JSON', message: 'Symbol keys are not JSON.' });
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if ((Array.isArray(item) && item.length > 20_000) || Object.keys(descriptors).length > 20_000) {
      errors.push({ path, code: 'JSON_LIMIT', message: 'JSON is too large.' });
      ancestors.delete(item);
      return;
    }
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) errors.push({ path: `${path}[${index}]`, code: 'NON_JSON', message: 'Sparse arrays are not accepted.' });
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      const childPath = Array.isArray(item) ? `${path}[${key}]` : `${path}.${key}`;
      if (BLOCKED_KEYS.has(key)) errors.push({ path: childPath, code: 'UNSAFE_KEY', message: 'Prototype-modifying keys are forbidden.' });
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (credentials && (SECRET_KEYS.has(normalizedKey) || /(?:apikey|accesstoken|refreshtoken|clientsecret|password|passwd|adminpin|bobtoken|privatekey|privatekeypem|credentials|connectionstring)$/.test(normalizedKey) || normalizedKey === 'authorizationheader')) errors.push({ path: childPath, code: 'CREDENTIAL', message: 'Credentials belong in server environment variables, never in research configurations.' });
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key))) {
        errors.push({ path: childPath, code: 'NON_JSON', message: 'Accessors, hidden properties and custom array properties are not JSON.' });
        continue;
      }
      visit(descriptor.value, childPath, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, '$', 0);
  return errors;
}

export function canonicalStringify(value) {
  const errors = inspectJSON(value);
  if (errors.length) throw new TypeError(`${errors[0].message} (${errors[0].path})`);
  function encode(item) {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return encode(value);
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function clone(value) {
  return JSON.parse(canonicalStringify(value));
}

export function validateConfig(config) {
  const errors = inspectJSON(config, { credentials: true });
  if (errors.length) return { valid: false, errors };
  const add = (path, message) => errors.push({ path, code: 'SCHEMA', message });
  const object = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add(path, 'Must be a JSON object.'); return false; }
    return true;
  };
  const text = (value, path, max = 20_000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) add(path, `Must be a nonempty string of at most ${max} characters.`);
  };
  const boolean = (value, path) => { if (typeof value !== 'boolean') add(path, 'Must be a boolean.'); };
  const number = (value, path, min, max, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) add(path, `Must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  };
  const strings = (value, path) => {
    if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item))) add(path, 'Must be a list of at most 100 nonempty strings, without control characters.');
  };
  if (!object(config, '$')) return { valid: false, errors };
  text(config.persona, '$.persona');
  text(config.objective, '$.objective');
  if (object(config.prompts, '$.prompts')) { text(config.prompts.system, '$.prompts.system'); text(config.prompts.followUp, '$.prompts.followUp'); }
  if (object(config.data, '$.data')) {
    text(config.data.source, '$.data.source', 128);
    if (config.data.synthetic !== true) add('$.data.synthetic', 'This demo accepts synthetic data only.');
    if (!Array.isArray(config.data.availableTimes) || config.data.availableTimes.length > 500) add('$.data.availableTimes', 'Must be an array of at most 500 synthetic day/time objects.');
    else for (const [index, slot] of config.data.availableTimes.entries()) {
      const path = `$.data.availableTimes[${index}]`;
      if (!object(slot, path)) continue;
      if (!DAYS.has(slot.day)) add(`${path}.day`, 'Use Mon, Tue, Wed, Thu, Fri, Sat or Sun.');
      const match = typeof slot.time === 'string' && /^(\d{2}):(\d{2})[–-](\d{2}):(\d{2})$/.exec(slot.time);
      if (!match) add(`${path}.time`, 'Use HH:mm–HH:mm, with a valid end later than the start.');
      else {
        const [, h1, m1, h2, m2] = match.map(Number);
        if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59 || h2 * 60 + m2 <= h1 * 60 + m1) add(`${path}.time`, 'Time must be valid and end after it starts, within one day.');
      }
    }
    object(config.data.brief, '$.data.brief');
  }
  if (object(config.collaboration, '$.collaboration')) { boolean(config.collaboration.acceptInvitations, '$.collaboration.acceptInvitations'); strings(config.collaboration.allowedPeers, '$.collaboration.allowedPeers'); }
  if (object(config.tools, '$.tools')) strings(config.tools.capabilities, '$.tools.capabilities');
  if (object(config.permissions, '$.permissions')) {
    for (const key of ['recipients', 'fields', 'resources']) strings(config.permissions[key], `$.permissions.${key}`);
    text(config.permissions.window, '$.permissions.window', 128);
    number(config.permissions.maxUses, '$.permissions.maxUses', 1, 10_000, true);
    number(config.permissions.expiryMinutes, '$.permissions.expiryMinutes', 0.01, 1440);
    text(config.permissions.confirmation, '$.permissions.confirmation', 128);
    boolean(config.permissions.askAdminForNewScope, '$.permissions.askAdminForNewScope');
  }
  if (object(config.response, '$.response')) {
    text(config.response.constraints, '$.response.constraints');
    number(config.response.maxWords, '$.response.maxWords', 1, 2000, true);
    boolean(config.response.offerBrief, '$.response.offerBrief');
  }
  if (object(config.runtime, '$.runtime')) {
    text(config.runtime.model, '$.runtime.model', 256);
    number(config.runtime.temperature, '$.runtime.temperature', 0, 2);
    number(config.runtime.timeoutSeconds, '$.runtime.timeoutSeconds', 1, 300);
    number(config.runtime.retryLimit, '$.runtime.retryLimit', 0, 10, true);
  }
  if (Object.hasOwn(config, 'extensions')) object(config.extensions, '$.extensions');
  return { valid: errors.length === 0, errors };
}

export function diffConfig(before, after) {
  canonicalStringify(before);
  canonicalStringify(after);
  const differences = [];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function walk(left, right, path, leftExists = true, rightExists = true) {
    if (!leftExists || !rightExists) {
      differences.push({ path, before: leftExists ? clone(left) : undefined, after: rightExists ? clone(right) : undefined });
      return;
    }
    if (canonicalStringify(left) === canonicalStringify(right)) return;
    if (isObject(left) && isObject(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key], right[key], path ? `${path}.${key}` : key, Object.hasOwn(left, key), Object.hasOwn(right, key));
      return;
    }
    differences.push({ path: path || '$', before: clone(left), after: clone(right) });
  }
  walk(before, after, '');
  return differences;
}
