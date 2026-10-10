import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { renameAtomicFile } from './atomic-file.mjs';
import path from 'node:path';
import { hashValue } from './config.mjs';
import { buildTraceSnapshot, sanitizeTraceSnapshot } from './agent-observability.mjs';
import { PLANNING_STEPS } from './runtime-helpers.mjs';
import { MODEL_OUTPUT_DIAGNOSTICS } from './model-provider.mjs';

const IDENTIFIER = /^[A-Za-z0-9_.:\/-]{1,128}$/;
const SAFE_KINDS = /^[a-z][a-z0-9_]{0,63}$/;
const WINDOWS = new Set(['none', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Tue–Wed', 'Tue-Wed', 'Mon–Sun', 'Mon-Sun', 'Thursday', 'week', 'initial', 'narrow', 'full_week']);
const CHOICES = new Set(['free', 'busy', 'full', 'none', 'keep', 'narrow', 'week', 'allow', 'deny', 'revoke', 'stop', 'allow_once', 'allow_round', 'accept', 'clarify', 'reject']);
const ANSWERS = new Set(['approved_snapshot', 'outside_scope', 'not_sure', 'future_only', 'delete_received', 'mapping_not_permission', 'mapping_grants_access', 'task_subset', 'whole_ontology']);
const QUESTIONS = new Set(['received_scope', 'withdrawal', 'ontology_alignment', 'task_module']);
const ACTORS = new Set(['Alice', 'Bob', 'researcher', 'admin', 'system', 'runtime']);
const STATUSES = new Set(['active', 'completed', 'stopped', 'technical', 'arranged', 'boundary_kept', 'declined', 'ended', 'technical_abort', 'incomplete', 'withdrawn']);
const COMPLETED = new Set(['completed', 'arranged', 'boundary_kept', 'declined']);
const STOPPED = new Set(['stopped', 'ended', 'incomplete', 'withdrawn']);
const NUMERIC_KEYS = new Set(['configRevision', 'policyRevision', 'adminWaitMs', 'decisionMs']);
const IDENTIFIER_KEYS = new Set(['operationId', 'code', 'reason', 'grantRevision', 'fieldSet', 'field_set', 'scenarioVersion', 'requestId', 'action', 'mappingVersion']);
const ALIASES = { sharing_choice: 'choice', scope_requested: 'request', delivered: 'delivery', receipt: 'delivery', configuration: 'config_changed', configuration_changed: 'config_changed', config_change: 'config_changed' };
// Research records contain many validated snapshots, so the per-configuration
// JSON complexity limit must not be applied to the accumulated run collection.
const clone = value => structuredClone(value);
const stringify = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const traceHash = value => createHash('sha256').update(stringify(value)).digest('hex');

function metadata(session) { return session?.session && typeof session.session === 'object' ? session.session : session; }
function consented(session) { const meta = metadata(session); return meta?.researchConsent === true && (meta.mode === 'controlled' || meta.mode === 'live'); }
function sessionKey(session) {
  const meta = metadata(session);
  if (!meta || typeof meta.id !== 'string' || !meta.id || !Number.isSafeInteger(meta.epoch ?? 0)) throw new TypeError('Research sessions require an id and a nonnegative integer epoch.');
  if ((meta.epoch ?? 0) < 0) throw new TypeError('Session epoch cannot be negative.');
  return `${meta.id}\u0000${meta.epoch ?? 0}`;
}
function safeRevision(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeId(value) { return typeof value === 'string' && IDENTIFIER.test(value); }
function whitelistModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revision = safeRevision(value.revision);
  if (revision === null || !['minimax_cn_token_plan', 'openai_compatible'].includes(value.provider)) return null;
  const agents = {};
  for (const role of ['Alice', 'Bob']) {
    const input = value.agents?.[role];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const { model, temperature, maxTokens, timeoutSeconds, retryLimit, thinking } = input;
    if (typeof model !== 'string' || !model.trim() || model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)
      || typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
      || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 32768
      || typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300
      || !Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 3
      || !['disabled', 'adaptive'].includes(thinking)) return null;
    // Construct the research condition explicitly. Endpoint, credentials, reasoning,
    // disclosure text and future provider fields can never enter this snapshot.
    agents[role] = { model, temperature, maxTokens, timeoutSeconds, retryLimit, thinking };
  }
  return { revision, provider: value.provider, agents };
}
function safeQuality(value) {
  if (Array.isArray(value)) return [...new Set(value.filter(safeId))].slice(0, 50);
  if (value && typeof value === 'object') return Object.keys(value).filter(key => safeId(key) && value[key] === true).slice(0, 50);
  return [];
}
function safeWindow(value) {
  if (typeof value === 'string' && WINDOWS.has(value)) return value;
  if (Array.isArray(value) && value.length <= 7 && value.every(day => WINDOWS.has(day) && day.length === 3)) return [...value];
  return undefined;
}
function whitelistEvent(event, run) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const inputKind = event.kind ?? event.type;
  if (typeof inputKind !== 'string' || !SAFE_KINDS.test(inputKind)) return null;
  const kind = ALIASES[inputKind] ?? inputKind;
  const nested = event.data ?? event.payload;
  const input = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...nested, ...event } : event;
  const suppliedElapsed = input.elapsedMs ?? input.elapsed_ms;
  const elapsedMs = Number.isFinite(suppliedElapsed) && suppliedElapsed >= 0 && suppliedElapsed <= 86_400_000 ? Math.round(suppliedElapsed) : Math.max(0, Date.now() - Date.parse(run.startedAt));
  const output = { seq: run.events.length + 1, elapsedMs, kind };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'stage' && ['alignment', 'initial', 'additional', 'waiting_admin', 'paused', 'complete', 'replay', 'post_explanation'].includes(value)) output[key] = value;
    else if (key === 'choice' && CHOICES.has(value)) output[key] = value;
    else if (key === 'fields' && Array.isArray(value) && value.length <= 100 && value.every(safeId)) output[key] = [...value];
    else if (key === 'moduleIds' && Array.isArray(value) && value.length <= 8 && value.every(safeId)) output[key] = [...value];
    else if (key === 'step' && PLANNING_STEPS.includes(value)) output[key] = value;
    else if (key === 'diagnostic' && typeof value === 'string' && Object.hasOwn(MODEL_OUTPUT_DIAGNOSTICS, value)) output[key] = value;
    else if (key === 'window' || key === 'timeWindow' || key === 'time_window') { const window = safeWindow(value); if (window !== undefined) output[key] = window; }
    else if (key === 'payloadHash' && typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) output[key] = value.toLowerCase();
    else if ((key === 'actor' || key === 'recipient') && ACTORS.has(value)) output[key] = value;
    else if (key === 'answer' && ANSWERS.has(value)) output[key] = value;
    else if (key === 'questionId' && QUESTIONS.has(value)) output[key] = value;
    else if (NUMERIC_KEYS.has(key) && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (!key.endsWith('Revision') || Number.isSafeInteger(value))) output[key] = value;
    else if (IDENTIFIER_KEYS.has(key) && safeId(value)) output[key] = value;
    else if (key === 'status' && STATUSES.has(value)) output[key] = value;
    else if (['correct', 'assisted', 'repeat', 'group', 'modeSwitched'].includes(key) && typeof value === 'boolean') output[key] = value;
  }
  return output;
}
function csvCell(value) {
  const string = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // Prevent a spreadsheet import from interpreting untrusted identifiers as formulas.
  const safe = /^[=+\-@\t\r]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}

function fullTrace(session) { return metadata(session)?.consentVersion === 'research-v2' && Boolean(session?.conditions); }
function addTrace(run, snapshot, kind, eventSeq = null) {
  if (run.consentVersion !== 'research-v2' || !run.trace) return;
  const clean = sanitizeTraceSnapshot(snapshot);
  if (!clean) return;
  const previousHash = run.trace.at(-1)?.hash ?? null;
  const item = { seq: run.trace.length + 1, at: clean.capturedAt, kind: SAFE_KINDS.test(kind) ? kind : 'checkpoint', eventSeq, snapshot: clean, previousHash };
  item.hash = traceHash(item);
  run.trace.push(item);
}

export class ResearchStore {
  constructor({ directory, persist = true } = {}) {
    if (persist && (typeof directory !== 'string' || !directory)) throw new TypeError('A research directory is required when persistence is enabled.');
    this.directory = directory ? path.resolve(directory) : null;
    this.persist = persist;
    this.filename = this.directory ? path.join(this.directory, 'runs.json') : null;
    this.runs = new Map();
    this.activeSessions = new Map();
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    if (this.persist) {
      try {
        const directory = await lstat(this.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Research storage must be a real directory.');
        let handle;
        try {
          handle = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Research storage must be a regular file.');
          const saved = JSON.parse(await handle.readFile('utf8'));
          if (saved.schemaVersion !== 1 || !Array.isArray(saved.runs)) throw new Error('Unsupported research storage schema.');
          let rewrite = false;
          for (const run of saved.runs) {
            if (!safeId(run.runId) || !['controlled', 'live'].includes(run.mode) || !Array.isArray(run.events) || !STATUSES.has(run.status) || !Number.isFinite(Date.parse(run.startedAt))) throw new Error('Invalid research storage record.');
            // Reapply the event whitelist when loading; never trust an old/raw trace file.
            const models = whitelistModels(run.models);
            const clean = {
              runId: run.runId, mode: run.mode,
              scenarioVersion: safeId(run.scenarioVersion) ? run.scenarioVersion : 'synthetic-calendar-v1',
              consentVersion: safeId(run.consentVersion) ? run.consentVersion : 'research-v1',
              startedAt: new Date(run.startedAt).toISOString(), status: run.status,
              quality: safeQuality(run.quality), configRevision: safeRevision(run.configRevision),
              modelRevision: models?.revision ?? safeRevision(run.modelRevision), models, events: []
            };
            if (run.endedAt && Number.isFinite(Date.parse(run.endedAt))) clean.endedAt = new Date(run.endedAt).toISOString();
            for (const event of run.events) { const cleaned = whitelistEvent(event, clean); if (cleaned) clean.events.push(cleaned); }
            if (clean.consentVersion === 'research-v2') {
              clean.trace = [];
              for (const step of Array.isArray(run.trace) ? run.trace : []) {
                const snapshot = sanitizeTraceSnapshot(step.snapshot);
                if (!snapshot || !SAFE_KINDS.test(step.kind) || step.seq !== clean.trace.length + 1 || step.previousHash !== (clean.trace.at(-1)?.hash ?? null)
                  || !(step.eventSeq === null || Number.isSafeInteger(step.eventSeq) && step.eventSeq > 0 && step.eventSeq <= clean.events.length)) {
                  clean.quality = [...new Set([...clean.quality, 'trace_integrity_failed'])]; break;
                }
                const item = { seq: step.seq, at: snapshot.capturedAt, kind: step.kind, eventSeq: step.eventSeq, snapshot, previousHash: step.previousHash };
                if (traceHash(item) !== step.hash) { clean.quality = [...new Set([...clean.quality, 'trace_integrity_failed'])]; break; }
                clean.trace.push({ ...item, hash: step.hash });
              }
              if (clean.trace.length) { clean.initialConditions = clone(clean.trace[0].snapshot.conditions); clean.conditionsHash = hashValue(clean.initialConditions); }
            }
            // Controller sessions cannot survive a process restart. Keep any recorded
            // task outcome, but do not pretend an orphan can still accept answers.
            if (clean.status === 'active') {
              clean.status = 'incomplete';
              clean.quality = [...new Set([...clean.quality, 'process_interrupted'])];
            }
            // Also scrub closed records and migrate older records. Filtering only
            // the in-memory export would leave rejected historical fields on disk.
            try { if (stringify(run) !== stringify(clean)) rewrite = true; }
            catch { rewrite = true; }
            this.runs.set(clean.runId, clean);
          }
          // Windows cannot replace a destination file while this read handle is open.
          await handle.close(); handle = null;
          if (rewrite) await this.save(this.runs);
        } finally { await handle?.close(); }
        await chmod(this.directory, 0o700);
        await chmod(this.filename, 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.initialized = true;
    return this;
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async save(nextRuns) {
    if (!this.persist) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Research storage must be a real directory.');
    await chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.runs-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${stringify({ schemaVersion: 1, runs: [...nextRuns.values()] })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await renameAtomicFile(temporary, this.filename);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async start(session) {
    if (!consented(session)) return null;
    const initialMeta = metadata(session);
    const sourceModels = initialMeta?.models ?? session?.models;
    // Capture this session's round snapshot before any queued asynchronous work.
    // There is intentionally no global model-store fallback.
    const models = whitelistModels(sourceModels);
    const modelRevision = models?.revision ?? safeRevision(initialMeta?.modelRevision ?? sourceModels?.revision);
    const captured = fullTrace(session) ? buildTraceSnapshot(session) : null;
    return this.enqueue(async () => {
      if (!consented(session)) return null;
      await this.init();
      const key = sessionKey(session);
      if (this.activeSessions.has(key)) return this.activeSessions.get(key);
      const meta = metadata(session);
      const runId = randomUUID();
      const started = typeof meta.startedAt === 'number' ? meta.startedAt : Date.parse(meta.startedAt);
      const run = {
        runId, mode: meta.mode,
        scenarioVersion: safeId(meta.scenarioVersion) ? meta.scenarioVersion : 'synthetic-calendar-v1',
        consentVersion: safeId(meta.consentVersion) ? meta.consentVersion : 'research-v1',
        startedAt: new Date(Number.isFinite(started) ? started : Date.now()).toISOString(),
        status: 'active', quality: [], configRevision: safeRevision(meta.configRevision ?? session?.bob?.configRevision),
        modelRevision, models, events: []
      };
      if (captured) {
        run.trace = [];
        addTrace(run, captured, 'initialized');
        if (run.trace.length) { run.initialConditions = clone(run.trace[0].snapshot.conditions); run.conditionsHash = hashValue(run.initialConditions); }
      }
      const next = new Map(this.runs).set(runId, run);
      await this.save(next);
      this.runs = next;
      this.activeSessions.set(key, runId);
      return runId;
    });
  }

  async append(session, event, snapshot) {
    if (!consented(session)) return false;
    const captured = fullTrace(session) ? clone(snapshot ?? buildTraceSnapshot(session)) : null;
    return this.enqueue(async () => {
      if (!consented(session)) return false;
      await this.init();
      const runId = this.activeSessions.get(sessionKey(session));
      const current = this.runs.get(runId);
      if (!current || current.status !== 'active') return false;
      const filtered = whitelistEvent(event, current);
      if (!filtered) return false;
      const run = clone(current);
      run.events.push(filtered);
      if (captured) addTrace(run, captured, filtered.kind, filtered.seq);
      if (filtered.kind === 'admin_intervention' && !run.quality.includes('admin_intervention')) run.quality.push('admin_intervention');
      if (filtered.kind === 'config_changed' && !run.quality.includes('configuration_changed')) run.quality.push('configuration_changed');
      if (filtered.kind === 'technical' && !run.quality.includes('technical_issue')) run.quality.push('technical_issue');
      const next = new Map(this.runs).set(runId, run);
      await this.save(next);
      this.runs = next;
      return true;
    });
  }

  async checkpoint(session, kind, snapshot) {
    if (!consented(session) || !fullTrace(session)) return false;
    const captured = clone(snapshot ?? buildTraceSnapshot(session));
    return this.enqueue(async () => {
      await this.init();
      const runId = this.activeSessions.get(sessionKey(session));
      const current = this.runs.get(runId);
      if (!current || current.status !== 'active') return false;
      const run = clone(current);
      addTrace(run, captured, kind);
      const next = new Map(this.runs).set(runId, run);
      await this.save(next); this.runs = next;
      return true;
    });
  }

  async finish(session, status, quality = []) {
    if (!consented(session)) return false;
    if (!STATUSES.has(status) || status === 'active') throw new TypeError('Unknown research completion status.');
    const captured = fullTrace(session) ? buildTraceSnapshot(session) : null;
    return this.enqueue(async () => {
      if (!consented(session)) return false;
      await this.init();
      const key = sessionKey(session);
      const runId = this.activeSessions.get(key);
      const current = this.runs.get(runId);
      if (!current || current.status !== 'active') return false;
      const run = clone(current);
      if (captured) addTrace(run, captured, 'closed');
      run.status = status;
      run.endedAt = new Date().toISOString();
      run.quality = [...new Set([...run.quality, ...safeQuality(quality)])];
      const next = new Map(this.runs).set(runId, run);
      await this.save(next);
      this.runs = next;
      return true;
    });
  }

  list() {
    const runs = clone([...this.runs.values()]);
    const hasTaskOutcome = run => COMPLETED.has(run.status) || run.events.some(event => event.kind === 'stage' && event.stage === 'complete' && COMPLETED.has(event.status));
    return {
      runs,
      summary: {
        runs: runs.length,
        completed: runs.filter(run => COMPLETED.has(run.status)).length,
        taskCompleted: runs.filter(hasTaskOutcome).length,
        runsPendingClose: runs.filter(run => run.status === 'active' && hasTaskOutcome(run)).length,
        affectedByTechnical: runs.filter(run => run.quality.includes('technical_issue') || run.events.some(event => event.kind === 'technical')).length,
        stopped: runs.filter(run => STOPPED.has(run.status)).length,
        technical: runs.filter(run => run.status === 'technical' || run.status === 'technical_abort').length,
        replayExcluded: 0
      }
    };
  }

  export(format = 'jsonl') {
    const { runs } = this.list();
    if (format === 'jsonl') return runs.map(run => JSON.stringify(run)).join('\n') + (runs.length ? '\n' : '');
    if (format !== 'csv') throw new TypeError('Export format must be jsonl or csv.');
    const columns = ['runId', 'mode', 'scenarioVersion', 'consentVersion', 'startedAt', 'status', 'quality', 'configRevision', 'modelRevision', 'models', 'seq', 'elapsedMs', 'kind', 'stage', 'choice', 'fields', 'window', 'timeWindow', 'time_window', 'operationId', 'payloadHash', 'recipient', 'questionId', 'answer', 'correct', 'actor', 'action', 'code', 'reason', 'policyRevision', 'adminWaitMs', 'decisionMs', 'eventConfigRevision', 'eventStatus', 'assisted', 'repeat', 'group', 'modeSwitched', 'fieldSet', 'field_set', 'requestId', 'grantRevision', 'conditionsHash', 'initialConditions', 'trace'];
    const lines = [columns.map(csvCell).join(',')];
    for (const run of runs) {
      for (const event of run.events.length ? run.events : [{}]) {
        const row = { ...run, ...event, status: run.status, configRevision: run.configRevision, eventConfigRevision: event.configRevision, eventStatus: event.status,
          initialConditions: event.seq === 1 || !event.seq ? run.initialConditions : undefined, trace: event.seq === 1 || !event.seq ? run.trace : undefined };
        lines.push(columns.map(column => csvCell(row[column])).join(','));
      }
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  async deleteRun(runId) {
    if (!safeId(runId)) return false;
    return this.enqueue(async () => {
      await this.init();
      if (!this.runs.has(runId)) return false;
      const next = new Map(this.runs);
      next.delete(runId);
      await this.save(next);
      this.runs = next;
      for (const [key, id] of this.activeSessions) if (id === runId) this.activeSessions.delete(key);
      return true;
    });
  }
}
