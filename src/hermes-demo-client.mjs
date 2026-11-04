import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeError, invariant } from './runtime-helpers.mjs';

const ROLES = ['alice', 'bob'];
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const IN_PROGRESS = new Set(['queued', 'started', 'running', 'stopping']);
const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'incomplete']);
const MAX_REQUEST_BYTES = 768 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PROPOSAL_BYTES = 256 * 1024;
const CONFIG_ERROR = 'HERMES_CONFIGURATION';
const TRANSPORT_ERROR = 'MODEL_PROVIDER_ERROR';

function validTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 300_000;
}

function configureEndpoint(config, role) {
  const base = typeof config?.url === 'string' ? URL.parse(config.url) : null;
  const profilePath = base?.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
  invariant(base && ['http:', 'https:'].includes(base.protocol) && LOOPBACK.has(base.hostname)
    && !base.username && !base.password && !base.href.includes('?') && !base.href.includes('#')
    && (profilePath === '' || /^\/p\/[a-zA-Z0-9_-]{1,64}$/.test(profilePath)), CONFIG_ERROR,
  `Hermes ${role} requires a numeric loopback URL with an optional /p/<profile> prefix.`, 503);
  invariant(typeof config.apiKey === 'string' && /^[!-~]{1,4096}$/.test(config.apiKey), CONFIG_ERROR,
    `Hermes ${role} requires its own API key.`, 503);
  return { baseUrl: `${base.origin}${profilePath}`, port: base.port || (base.protocol === 'http:' ? '80' : '443'), apiKey: config.apiKey };
}

async function readRunResponse(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    invariant(bytes <= MAX_RESPONSE_BYTES, TRANSPORT_ERROR, 'Hermes returned an oversized response.', 502);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RuntimeError(TRANSPORT_ERROR, 'Hermes returned an invalid Runs API response.', 502);
  }
}

function parseProposal(output) {
  const invalid = () => new RuntimeError('MODEL_INVALID_OUTPUT', 'Hermes must return one bounded JSON proposal object.', 502);
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_PROPOSAL_BYTES) throw invalid();
  let proposal;
  try {
    proposal = JSON.parse(output);
  } catch {
    throw invalid();
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw invalid();
  return proposal;
}

/** Runs a proposal on a configured local Hermes. The caller validates domain fields and handles all actions. */
export function createHermesDemoClient({ endpoints, timeoutMs = 60_000, pollIntervalMs = 250, fetchImpl = fetch } = {}) {
  invariant(validTimeout(timeoutMs) && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0 && pollIntervalMs <= 5_000,
    CONFIG_ERROR, 'Hermes requires a bounded run timeout and poll interval.', 503);
  const [alice, bob] = ROLES.map(role => configureEndpoint(endpoints?.[role], role));
  invariant(alice.port !== bob.port && alice.apiKey !== bob.apiKey, CONFIG_ERROR,
    'Hermes Alice and Bob require separate local ports and API keys.', 503);
  const configured = { alice, bob };

  function endpointFor(role) {
    const name = typeof role === 'string' ? role.toLowerCase() : '';
    invariant(ROLES.includes(name), CONFIG_ERROR, 'Unknown Hermes demo role.', 503);
    const { baseUrl, apiKey } = configured[name];
    return { baseUrl, auth: { Authorization: `Bearer ${apiKey}` } };
  }

  async function requestJson(url, options, signal) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      if (options.method === 'POST' && response.status === 409) {
        throw new RuntimeError('HERMES_IDEMPOTENCY_CONFLICT', 'Hermes rejected a reused request identifier.', 409);
      }
      throw new RuntimeError(TRANSPORT_ERROR, `Hermes Runs API returned HTTP ${response.status}.`, 502);
    }
    return readRunResponse(response);
  }

  async function checkToolsets(baseUrl, auth, signal) {
    const inventory = await requestJson(`${baseUrl}/v1/toolsets`, { method: 'GET', headers: auth }, signal);
    // The inventory covers Hermes-configurable toolsets. The demo profiles must also omit default MCP servers.
    invariant(inventory?.object === 'list' && inventory.platform === 'api_server'
      && Array.isArray(inventory.data) && inventory.data.every(toolset => toolset?.enabled === false),
    'HERMES_TOOLSETS', 'The Hermes demo profile must disable its API toolsets.', 503);
  }

  async function check({ role, signal }) {
    const { baseUrl, auth } = endpointFor(role);
    const deadline = AbortSignal.timeout(Math.min(timeoutMs, 5_000));
    const checkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      checkSignal.throwIfAborted();
      const options = { method: 'GET', headers: auth };
      const [capabilities, health] = await Promise.all([
        requestJson(`${baseUrl}/v1/capabilities`, options, checkSignal),
        requestJson(`${baseUrl}/health/detailed`, options, checkSignal),
        checkToolsets(baseUrl, auth, checkSignal),
      ]);
      checkSignal.throwIfAborted();
      const features = capabilities?.features;
      invariant(capabilities?.object === 'hermes.api_server.capabilities' && capabilities.auth?.type === 'bearer'
        && capabilities.auth.required === true && features?.run_submission === true && features.run_status === true
        && features.run_stop === true && features.runs_idempotency?.supported === true && features.runs_idempotency.durable === true,
      'HERMES_CAPABILITY', 'The local Hermes endpoint must support authenticated Runs with durable idempotency and stop control.', 503);
      invariant(health?.platform === 'hermes-agent' && health.status === 'ok' && health.readiness?.status === 'ok',
        'HERMES_NOT_READY', 'The local Hermes gateway reported degraded readiness.', 503);
      return { ready: true };
    } catch (error) {
      if (signal?.aborted) throw new RuntimeError('MODEL_CANCELLED', 'The Hermes readiness check was cancelled.', 409);
      if (deadline.aborted) throw new RuntimeError('MODEL_TIMEOUT', 'The Hermes readiness check timed out.', 504);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(TRANSPORT_ERROR, 'The local Hermes readiness API could not be reached.', 502);
    }
  }

  async function propose({ role, input, instructions, requestId, signal, timeoutMs: runTimeoutMs = timeoutMs }) {
    const { baseUrl, auth } = endpointFor(role);
    invariant(validTimeout(runTimeoutMs) && typeof requestId === 'string' && /^[!-~]{1,255}$/.test(requestId)
      && typeof input === 'string' && input.trim() && (instructions === undefined || typeof instructions === 'string'),
      'HERMES_INVALID_REQUEST', 'Hermes requires proposal input, a bounded timeout, and a stable request identifier.');
    const runsUrl = `${baseUrl}/v1/runs`;
    const body = JSON.stringify({ input, instructions, author: { id: 'bot:agent-on-request', name: 'Agent on Request', is_bot: true } });
    invariant(Buffer.byteLength(body) <= MAX_REQUEST_BYTES, 'HERMES_INVALID_REQUEST', 'Hermes proposal input exceeds the size limit.');

    const deadline = AbortSignal.timeout(runTimeoutMs);
    const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let runUrl;
    let settled = false;

    try {
      runSignal.throwIfAborted();
      await checkToolsets(baseUrl, auth, runSignal);
      runSignal.throwIfAborted();
      const admission = await requestJson(runsUrl, { method: 'POST', body,
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': requestId } }, runSignal);
      invariant(typeof admission?.run_id === 'string' && /^run_[a-zA-Z0-9_-]{1,100}$/.test(admission.run_id),
        TRANSPORT_ERROR, 'Hermes did not return a valid run identifier.', 502);
      runUrl = `${runsUrl}/${admission.run_id}`;

      while (true) {
        const run = await requestJson(runUrl, { method: 'GET', headers: auth }, runSignal);
        invariant(run?.run_id === admission.run_id, TRANSPORT_ERROR, 'Hermes returned a different run identifier.', 502);
        runSignal.throwIfAborted();
        settled = FINISHED.has(run.status) || run.status === 'unknown';
        if (run.status === 'completed') {
          invariant(run.completed !== false && !run.partial && !run.interrupted && !run.error,
            'MODEL_INVALID_OUTPUT', 'Hermes did not finish a usable proposal.', 502);
          return parseProposal(run.output);
        }
        if (run.status === 'waiting_for_approval' || run.status === 'waiting_for_clarification') {
          throw new RuntimeError('HERMES_CONTROL_REQUIRED', 'A Hermes proposal requested interactive control.', 409);
        }
        invariant(IN_PROGRESS.has(run.status), TRANSPORT_ERROR, 'Hermes did not finish a usable proposal.', 502);
        await delay(pollIntervalMs, undefined, { signal: runSignal });
      }
    } catch (error) {
      if (runUrl && !settled) {
        // A stop request is bounded independently. A lost admission has no run ID to stop;
        // repeating the original request ID lets Hermes recover its existing admission.
        try {
          const stopped = await fetchImpl(`${runUrl}/stop`, { method: 'POST', headers: auth,
            redirect: 'error', signal: AbortSignal.timeout(1_000) });
          await stopped.body?.cancel();
        } catch { /* Best effort; no proposal escapes on cancellation. */ }
      }
      if (signal?.aborted) throw new RuntimeError('MODEL_CANCELLED', 'The Hermes proposal was cancelled.', 409);
      if (deadline.aborted) throw new RuntimeError('MODEL_TIMEOUT', 'The Hermes proposal timed out.', 504);
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(TRANSPORT_ERROR, 'The local Hermes Runs API could not be reached.', 502);
    }
  }

  return { check, propose };
}
