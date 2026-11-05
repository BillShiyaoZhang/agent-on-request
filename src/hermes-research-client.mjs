import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeError, invariant } from './runtime-helpers.mjs';

export const RESEARCH_TOOL_NAMES = Object.freeze([
  'knowledge_search', 'knowledge_record', 'ontology_describe', 'artifact_prepare', 'artifact_revise',
  'peer_describe', 'peer_request', 'peer_send', 'alignment_propose', 'alignment_accept',
  'authorization_check', 'authorization_request', 'authorization_list', 'authorization_propose_policy',
  'resource_search', 'reservation_submit', 'receipt_inspect', 'task_checkpoint', 'task_status',
  'research_skills_list', 'research_skill_view',
]);
const EXPECTED = new Set(RESEARCH_TOOL_NAMES);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'incomplete']);
const RUNNING = new Set(['queued', 'started', 'running', 'stopping']);
const validTimeout = value => Number.isSafeInteger(value) && value > 0 && value <= 300_000;
const validRunId = value => typeof value === 'string' && /^run_[A-Za-z0-9_-]{1,160}$/.test(value);
const validRequestId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

function runPayload(input, instructions) {
  invariant(typeof input === 'string' && input.trim() && (instructions === undefined || typeof instructions === 'string'),
    'HERMES_INVALID_REQUEST', 'Supply the exact native run input and instructions.', 422);
  const body = { input, instructions, author: { id: 'bot:agent-on-request:research', name: 'Research collaboration', is_bot: true } };
  invariant(Buffer.byteLength(JSON.stringify(body)) <= 768 * 1024, 'HERMES_INVALID_REQUEST', 'The native run input exceeds its limit.', 422);
  return body;
}

function endpoint(config, role) {
  const url = typeof config?.url === 'string' ? URL.parse(config.url) : null;
  const profile = url?.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
  invariant(url && ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash
    && (profile === '' || /^\/p\/[A-Za-z0-9_-]{1,64}$/.test(profile)),
  'HERMES_CONFIGURATION', `Configure a numeric loopback Hermes endpoint for ${role}.`, 503);
  invariant(typeof config.apiKey === 'string' && /^[!-~]{1,4096}$/.test(config.apiKey),
    'HERMES_CONFIGURATION', `Configure an independent Hermes key for ${role}.`, 503);
  return { url: `${url.origin}${profile}`, key: config.apiKey, port: url.port || (url.protocol === 'http:' ? '80' : '443') };
}

/** Native multi-tool runs. Domain records, not the returned model text, determine task success. */
export function createHermesResearchClient({ endpoints, timeoutMs = 300_000, pollIntervalMs = 250, fetchImpl = fetch } = {}) {
  invariant(validTimeout(timeoutMs) && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0 && pollIntervalMs <= 5_000,
    'HERMES_CONFIGURATION', 'Use a bounded native run timeout and polling interval.', 503);
  const configured = Object.fromEntries(['alice', 'bob'].map(role => [role, endpoint(endpoints?.[role], role)]));
  invariant(configured.alice.port !== configured.bob.port && configured.alice.key !== configured.bob.key,
    'HERMES_CONFIGURATION', 'Research agents require separate Hermes ports and keys.', 503);
  const active = new Map();

  function target(role) {
    const key = typeof role === 'string' ? role.toLowerCase() : '';
    invariant(Object.hasOwn(configured, key), 'HERMES_CONFIGURATION', 'Choose Alice or Bob.', 422);
    return { role: key, ...configured[key] };
  }
  async function request(url, config, method, signal, body, idempotencyKey) {
    const response = await fetchImpl(url, { method, redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RuntimeError(response.status === 409 ? 'HERMES_IDEMPOTENCY_CONFLICT' : 'HERMES_RESEARCH_TRANSPORT',
        `The Hermes research API returned HTTP ${response.status}.`, response.status === 409 ? 409 : 502);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      invariant(size <= 768 * 1024, 'HERMES_RESEARCH_TRANSPORT', 'The Hermes research response exceeds its limit.', 502);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new RuntimeError('HERMES_RESEARCH_TRANSPORT', 'The Hermes research API returned invalid JSON.', 502); }
  }
  async function inventory(config, signal) {
    const value = await request(`${config.url}/v1/toolsets`, config, 'GET', signal);
    invariant(value?.object === 'list' && value.platform === 'api_server' && Array.isArray(value.data),
      'HERMES_RESEARCH_TOOLS', 'Hermes must publish its concrete API tool inventory.', 503);
    const enabled = value.data.filter(entry => entry?.enabled === true);
    const tools = enabled.flatMap(entry => Array.isArray(entry.tools) ? entry.tools : []);
    invariant(enabled.length === 1 && enabled[0].name === 'research' && enabled[0].configured !== false
      && tools.length === EXPECTED.size && new Set(tools).size === EXPECTED.size
      && tools.every(name => EXPECTED.has(name)), 'HERMES_RESEARCH_TOOLS',
    'Enable only the exact research toolset, including read-only research skill access.', 503);
    return value;
  }
  async function check({ role, signal } = {}) {
    const config = target(role);
    const deadline = AbortSignal.timeout(Math.min(timeoutMs, 5_000));
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const [capabilities, health] = await Promise.all([
        request(`${config.url}/v1/capabilities`, config, 'GET', combined),
        request(`${config.url}/health/detailed`, config, 'GET', combined),
        inventory(config, combined),
      ]);
      const features = capabilities?.features;
      invariant(capabilities?.object === 'hermes.api_server.capabilities' && capabilities.auth?.type === 'bearer'
        && capabilities.auth.required === true && features?.run_submission === true && features.run_status === true
        && features.run_stop === true && features.runs_idempotency?.supported === true && features.runs_idempotency.durable === true,
      'HERMES_CAPABILITY', 'Hermes must support authenticated, durable idempotent Runs and stop control.', 503);
      invariant(health?.platform === 'hermes-agent' && health.status === 'ok' && health.readiness?.status === 'ok',
        'HERMES_NOT_READY', 'The native Hermes research profile is not ready.', 503);
      return { ready: true, tools: [...RESEARCH_TOOL_NAMES] };
    } catch (error) {
      if (signal?.aborted) throw new RuntimeError('MODEL_CANCELLED', 'Research readiness was cancelled.', 409);
      if (deadline.aborted) throw new RuntimeError('MODEL_TIMEOUT', 'Research readiness timed out.', 504);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('HERMES_RESEARCH_TRANSPORT', 'The native Hermes research profile is unavailable.', 502);
    }
  }
  async function settle(config, record) {
    if (!record.url) return false;
    const deadline = AbortSignal.timeout(5_000);
    try {
      // Some Hermes versions acknowledge stop with an empty 202 response.
      // The status lookup, rather than the acknowledgement body, proves settlement.
      try { await request(`${record.url}/stop`, config, 'POST', deadline, {}); } catch { /* Reconcile below. */ }
      while (!deadline.aborted) {
        const result = await request(record.url, config, 'GET', deadline);
        if (result.run_id !== record.id) return false;
        if (TERMINAL.has(result.status)) { active.delete(config.role); return true; }
        if (!RUNNING.has(result.status) && !['waiting_for_approval', 'waiting_for_clarification'].includes(result.status)) return false;
        await delay(pollIntervalMs, undefined, { signal: deadline });
      }
    } catch { /* Keep the role occupied until a later reconcile confirms termination. */ }
    return false;
  }
  async function reconcile({ role, runId, requestId, input, instructions }) {
    const config = target(role);
    const persisted = runId !== undefined || requestId !== undefined || input !== undefined || instructions !== undefined;
    let record = active.get(config.role);
    // Preserve the existing in-process reconcile contract when no durable
    // reference is supplied. In particular a lost admission remains occupied.
    if (!persisted) {
      if (!record) return { settled: true };
      return { settled: await settle(config, record), runId: record.id ?? null };
    }
    invariant(!record || (!requestId || record.requestId === requestId) && (!runId || !record.id || record.id === runId),
      'HERMES_RESEARCH_BUSY', 'A different native run already owns this role.', 409);
    if (!record) {
      record = { requestId: requestId ?? null, id: null, url: null };
      active.set(config.role, record);
    }
    const deadline = AbortSignal.timeout(5_000);
    try {
      if (runId !== undefined && runId !== null) {
        invariant(validRunId(runId), 'HERMES_INVALID_REQUEST', 'The persisted Hermes run identifier is invalid.', 422);
        record.id = runId; record.url = `${config.url}/v1/runs/${runId}`;
      }
      if (!record.id) {
        invariant(validRequestId(requestId), 'HERMES_INVALID_REQUEST', 'Lost admission recovery requires the original idempotency key.', 422);
        const body = runPayload(input, instructions);
        invariant(!record.body || JSON.stringify(record.body) === JSON.stringify(body),
          'HERMES_INVALID_REQUEST', 'Lost admission recovery must reuse the exact original request body.', 422);
        record.requestId = requestId; record.body = body;
        // The authenticated Runs API durably resolves the same original key;
        // never substitute a fresh key when recovering a lost POST response.
        const admitted = await request(`${config.url}/v1/runs`, config, 'POST', deadline, body, requestId);
        invariant(validRunId(admitted?.run_id), 'HERMES_RESEARCH_TRANSPORT', 'Hermes returned an invalid recovered run identifier.', 502);
        record.id = admitted.run_id; record.url = `${config.url}/v1/runs/${record.id}`;
      }
      const state = await request(record.url, config, 'GET', deadline);
      invariant(state?.run_id === record.id, 'HERMES_RESEARCH_TRANSPORT', 'Hermes returned a different recovered run.', 502);
      if (TERMINAL.has(state.status)) {
        active.delete(config.role);
        return { settled: true, runId: record.id };
      }
      if (await settle(config, record)) return { settled: true, runId: record.id };
    } catch { /* A persisted but unresolved run continues owning its role. */ }
    throw new RuntimeError('HERMES_RUN_UNSETTLED',
      'The persisted Hermes run could not be confirmed stopped. Keep its assignment until reconciliation.', 503);
  }
  async function run({ role, input, instructions, requestId, signal, onAdmitted, timeoutMs: runTimeout = timeoutMs }) {
    const config = target(role);
    invariant(!active.has(config.role), 'HERMES_RESEARCH_BUSY', 'The previous role run must settle before assigning another task.', 409);
    invariant(validRequestId(requestId) && validTimeout(runTimeout)
      && (onAdmitted === undefined || typeof onAdmitted === 'function'),
    'HERMES_INVALID_REQUEST', 'Supply native run input, a stable request identifier and a bounded deadline.', 422);
    const body = runPayload(input, instructions);
    const deadline = AbortSignal.timeout(runTimeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const record = { requestId, id: null, url: null, body };
    active.set(config.role, record);
    let submitted = false;
    try {
      combined.throwIfAborted();
      await inventory(config, combined);
      // Retain an unknown admission rather than allowing a new run after a lost POST response.
      submitted = true;
      const admitted = await request(`${config.url}/v1/runs`, config, 'POST', combined, body, requestId);
      invariant(validRunId(admitted?.run_id),
        'HERMES_RESEARCH_TRANSPORT', 'Hermes returned an invalid native run identifier.', 502);
      record.id = admitted.run_id; record.url = `${config.url}/v1/runs/${record.id}`;
      if (onAdmitted) await onAdmitted({ runId: record.id, requestId });
      while (true) {
        const result = await request(record.url, config, 'GET', combined);
        invariant(result?.run_id === record.id, 'HERMES_RESEARCH_TRANSPORT', 'Hermes returned a different native run.', 502);
        combined.throwIfAborted();
        if (TERMINAL.has(result.status)) {
          active.delete(config.role);
          invariant(result.status === 'completed' && result.completed !== false && !result.partial && !result.interrupted && !result.error,
            'HERMES_RESEARCH_FAILED', 'Hermes did not complete the native tool run. Inspect task records before retrying.', 502);
          invariant(typeof result.output === 'string' && Buffer.byteLength(result.output) <= 512 * 1024,
            'HERMES_RESEARCH_TRANSPORT', 'Hermes returned an invalid run explanation.', 502);
          return { runId: record.id, status: 'completed', output: result.output };
        }
        invariant(!['waiting_for_approval', 'waiting_for_clarification'].includes(result.status),
          'HERMES_CONTROL_REQUIRED', 'Native tools must save owner decisions through the research task service.', 409);
        invariant(RUNNING.has(result.status), 'HERMES_RESEARCH_TRANSPORT', 'Hermes returned an unknown run status.', 502);
        await delay(pollIntervalMs, undefined, { signal: combined });
      }
    } catch (error) {
      if (!submitted) active.delete(config.role);
      else if (!record.url && error?.code === 'HERMES_IDEMPOTENCY_CONFLICT') active.delete(config.role);
      else if (active.has(config.role)) await settle(config, record);
      if (active.has(config.role)) throw new RuntimeError('HERMES_RUN_UNSETTLED',
        'The Hermes run has not been confirmed stopped. Keep its assignment until reconciliation.', 503);
      if (signal?.aborted) throw new RuntimeError('MODEL_CANCELLED', 'The native research run was cancelled.', 409);
      if (deadline.aborted) throw new RuntimeError('MODEL_TIMEOUT', 'The native research run timed out.', 504);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('HERMES_RESEARCH_TRANSPORT', 'The native research run could not be completed.', 502);
    }
  }
  return { check, run, reconcile, active: () => [...active].map(([role, record]) => ({ role, requestId: record.requestId, runId: record.id })) };
}
