import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalStringify, clone, diffConfig } from './config.mjs';
import { AppError, requireThat } from './errors.mjs';

export const DEFAULT_MODEL_CONFIG = {
  provider: 'minimax_cn_token_plan',
  baseUrl: 'https://api.minimax.cn/v1',
  agents: {
    Alice: { model: 'MiniMax-M3', temperature: 1, maxTokens: 4096, timeoutSeconds: 45, retryLimit: 0, thinking: 'disabled' },
    Bob: { model: 'MiniMax-M3', temperature: 1, maxTokens: 4096, timeoutSeconds: 45, retryLimit: 0, thinking: 'disabled' }
  }
};

const PROVIDERS = new Set(['minimax_cn_token_plan', 'openai_compatible']);
const AGENT_KEYS = new Set(['model', 'temperature', 'maxTokens', 'timeoutSeconds', 'retryLimit', 'thinking']);
const CONTROLS = /[\u0000-\u001f\u007f]/;

function normalizedEndpoint(baseUrl) {
  try { return new URL(baseUrl).href.replace(/\/+$/, ''); }
  catch { return null; }
}

export function validateModelConfig(config) {
  const errors = [];
  const add = (path, message) => errors.push({ path, code: 'MODEL_SCHEMA', message });
  try { canonicalStringify(config); }
  catch {
    return { valid: false, errors: [{ path: '$', code: 'MODEL_JSON', message: 'Model configuration must be plain JSON, without cycles or unsafe keys.' }] };
  }
  const object = (value, path, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add(path, 'Must be a JSON object.'); return false; }
    // Do not echo unknown keys: a mistakenly pasted credential can itself be a key.
    if (Object.keys(value).some(key => !allowed.has(key))) add(path, 'Unknown or credential-bearing configuration keys are not accepted.');
    return true;
  };
  const number = (value, path, min, max, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) add(path, `Must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  };
  if (!object(config, '$', new Set(['provider', 'baseUrl', 'agents']))) return { valid: false, errors };
  if (!PROVIDERS.has(config.provider)) add('$.provider', 'Select minimax_cn_token_plan or openai_compatible.');
  let url;
  if (typeof config.baseUrl !== 'string' || !config.baseUrl || config.baseUrl.length > 2048 || CONTROLS.test(config.baseUrl) || config.baseUrl.trim() !== config.baseUrl) add('$.baseUrl', 'Use a valid API base URL without whitespace, credentials or query parameters.');
  else {
    try { url = new URL(config.baseUrl); }
    catch { add('$.baseUrl', 'Use a valid API base URL.'); }
  }
  if (url) {
    if (url.username || url.password || url.search || url.hash) add('$.baseUrl', 'URL credentials, query parameters and fragments are forbidden.');
    if (config.provider === 'minimax_cn_token_plan' && config.baseUrl.replace(/\/+$/, '') !== 'https://api.minimax.cn/v1') add('$.baseUrl', 'MiniMax China Token Plan requires https://api.minimax.cn/v1.');
    if (config.provider === 'openai_compatible') {
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) add('$.baseUrl', 'Use HTTPS, or HTTP on localhost/loopback for a local provider.');
    }
  }
  if (object(config.agents, '$.agents', new Set(['Alice', 'Bob']))) {
    for (const name of ['Alice', 'Bob']) {
      const agent = config.agents[name];
      const base = `$.agents.${name}`;
      if (!object(agent, base, AGENT_KEYS)) continue;
      if (typeof agent.model !== 'string' || !agent.model.trim() || agent.model.length > 128 || CONTROLS.test(agent.model)) add(`${base}.model`, 'Model name must be nonempty, at most 128 characters, and contain no control characters.');
      number(agent.temperature, `${base}.temperature`, 0, 2);
      number(agent.maxTokens, `${base}.maxTokens`, 128, 32768, true);
      number(agent.timeoutSeconds, `${base}.timeoutSeconds`, 1, 300);
      number(agent.retryLimit, `${base}.retryLimit`, 0, 3, true);
      if (!['disabled', 'adaptive'].includes(agent.thinking)) add(`${base}.thinking`, 'Select disabled or adaptive.');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function diffModelConfig(before, after) { return diffConfig(before, after); }

function validateKey(key, config) {
  if (typeof key !== 'string' || key.length > 8192 || CONTROLS.test(key) || key.trim() !== key) throw new AppError('MODEL_KEY_INVALID', 'The model API key is invalid. Never place it inside the configuration JSON.', 422);
  if (!key) return;
  if (config.provider === 'minimax_cn_token_plan' && (!key.startsWith('sk-cp') || key.length < 16)) throw new AppError('MODEL_KEY_INVALID', 'MiniMax Token Plan requires a subscription key beginning with sk-cp and at least 16 characters.', 422);
}

/** Server-side storage only. snapshot() includes a secret and must never be exposed by an HTTP route. */
export class ModelStore {
  #apiKey = '';
  #initialApiKey;

  constructor({ directory, persist = true, initialConfig = DEFAULT_MODEL_CONFIG, apiKey = '' } = {}) {
    requireThat(!persist || (typeof directory === 'string' && directory), 'MODEL_STORAGE', 'A model configuration directory is required.');
    this.directory = directory ? path.resolve(directory) : null;
    this.filename = this.directory ? path.join(this.directory, 'models.json') : null;
    this.persist = persist;
    try { this.initialConfig = clone(initialConfig); }
    catch { throw new AppError('MODEL_JSON', 'Initial model configuration must be plain JSON.'); }
    this.#initialApiKey = apiKey;
    this.config = null;
    this.revision = 1;
    this.initialized = false;
    this.initializing = null;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    try { return await this.initializing; }
    finally { this.initializing = null; }
  }

  async initialize() {
    let saved = null;
    if (this.persist) {
      try {
        const directory = await lstat(this.directory);
        requireThat(directory.isDirectory() && !directory.isSymbolicLink(), 'MODEL_STORAGE', 'Model storage must be a real directory.');
        let handle;
        try {
          handle = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          requireThat((await handle.stat()).isFile(), 'MODEL_STORAGE', 'Model storage must be a regular file.');
          try { saved = JSON.parse(await handle.readFile('utf8')); }
          catch { throw new AppError('MODEL_STORAGE', 'Saved model configuration could not be read.'); }
          requireThat(saved && typeof saved === 'object' && !Array.isArray(saved), 'MODEL_STORAGE', 'Saved model configuration metadata is invalid.');
        } finally { await handle?.close(); }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error instanceof AppError) throw error;
          throw new AppError('MODEL_STORAGE', 'Saved model configuration could not be opened.');
        }
      }
    }
    const config = saved ? saved.config : this.initialConfig;
    const key = saved ? saved.apiKey : this.#initialApiKey;
    const validation = validateModelConfig(config);
    requireThat(validation.valid, 'MODEL_CONFIG_INVALID', 'Model configuration failed validation.', 422, validation.errors);
    if (saved) requireThat(saved.schemaVersion === 1 && Number.isSafeInteger(saved.revision) && saved.revision >= 1 && Object.keys(saved).every(name => ['schemaVersion', 'config', 'revision', 'apiKey'].includes(name)), 'MODEL_STORAGE', 'Saved model configuration metadata is invalid.');
    validateKey(key, config);
    const revision = saved ? saved.revision : 1;
    if (this.persist) {
      if (saved) { await chmod(this.directory, 0o700); await chmod(this.filename, 0o600); }
      else if (key) await this.save({ config, revision, apiKey: key });
    }
    this.config = clone(config);
    this.#apiKey = key;
    this.revision = revision;
    this.initialConfig = null;
    this.#initialApiKey = null;
    this.initialized = true;
    return this;
  }

  ready() { requireThat(this.initialized, 'MODEL_NOT_READY', 'Initialize model storage before use.', 503); }

  view() {
    this.ready();
    return { config: clone(this.config), revision: this.revision, keyConfigured: Boolean(this.#apiKey) };
  }

  snapshot() {
    this.ready();
    return { config: clone(this.config), revision: this.revision, apiKey: this.#apiKey };
  }

  validate(config) {
    this.ready();
    const validation = validateModelConfig(config);
    return { ...validation, diff: validation.valid ? diffModelConfig(this.config, config) : [] };
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async apply({ config, apiKey, expectedRevision, clearKey = false } = {}) {
    // Clone before queueing so a caller cannot alter a reviewed configuration mid-flight.
    const validation = validateModelConfig(config);
    requireThat(validation.valid, 'MODEL_CONFIG_INVALID', 'Model configuration failed validation.', 422, validation.errors);
    const nextConfig = clone(config);
    requireThat(typeof clearKey === 'boolean', 'MODEL_KEY_INVALID', 'clearKey must be an explicit boolean.');
    requireThat(apiKey === undefined || typeof apiKey === 'string', 'MODEL_KEY_INVALID', 'The model API key must be a string.');
    const newKey = typeof apiKey === 'string' && apiKey.length > 0;
    requireThat(!(newKey && clearKey), 'MODEL_KEY_CONFLICT', 'Provide a new key or clear the old key, not both.');
    return this.enqueue(async () => {
      await this.init();
      requireThat(expectedRevision === this.revision, 'STALE_MODEL_CONFIG', 'Model configuration changed. Review the current revision before applying.', 409);
      const endpointChanged = nextConfig.provider !== this.config.provider || normalizedEndpoint(nextConfig.baseUrl) !== normalizedEndpoint(this.config.baseUrl);
      requireThat(!this.#apiKey || !endpointChanged || newKey || clearKey, 'MODEL_KEY_RECONFIRM', 'Changing provider or endpoint requires a new key or explicit clearKey confirmation.', 409);
      const nextKey = clearKey ? '' : newKey ? apiKey : this.#apiKey;
      validateKey(nextKey, nextConfig);
      const next = { config: nextConfig, revision: this.revision + 1, apiKey: nextKey };
      await this.save(next);
      this.config = next.config;
      this.revision = next.revision;
      this.#apiKey = next.apiKey;
      return this.view();
    });
  }

  async save({ config, revision, apiKey }) {
    if (!this.persist) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    requireThat(directory.isDirectory() && !directory.isSymbolicLink(), 'MODEL_STORAGE', 'Model storage must be a real directory.');
    await chmod(this.directory, 0o700);
    try {
      const existing = await lstat(this.filename);
      requireThat(existing.isFile() && !existing.isSymbolicLink(), 'MODEL_STORAGE', 'Model storage must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(this.directory, `.models-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${canonicalStringify({ schemaVersion: 1, config, revision, apiKey })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.filename);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
