import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  RuntimeError, invariant, canonical, hashPayload, signObject, verifyObject,
  macObject, verifyMac, errorJSON, fromErrorJSON, validateSessionRef, validateOperation, WORKER_RPC_METHODS,
} from './runtime-helpers.mjs';

// Windows may inject PATH into a child even when fork receives an explicit
// environment allowlist. Remove it inside the paired worker as well.
if (process.send && process.env.AGENT_DEMO_ROLE) delete process.env.PATH;

const SHARED_FIELDS = ['day', 'time', 'status'];
const FULL_FIELDS = [...SHARED_FIELDS, 'title', 'note'];
const clone = value => structuredClone(value);
const isFree = row => String(row.status).toLowerCase() === 'free';
const normalizedTime = value => String(value).replace(/[–—−]/g, '-').replace(/\s/g, '');
const formatMinute = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function interval(value) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(normalizedTime(value));
  if (!match) return null;
  const [, h1, m1, h2, m2] = match.map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  return end > start ? { start, end } : null;
}

function withinTime(proposed, available, requireThirtyMinutes = false) {
  const part = interval(proposed);
  const whole = interval(available);
  return Boolean(part && whole && part.start >= whole.start && part.end <= whole.end
    && (!requireThirtyMinutes || part.end - part.start === 30));
}

function projectedCalendar(calendar, stage, choice, profile) {
  const initial = stage === 'initial';
  invariant(initial || stage === 'additional', 'INVALID_STAGE', 'Unknown projection stage.');
  invariant((initial ? ['free', 'busy', 'full', 'none'] : ['keep', 'narrow', 'week']).includes(choice),
    'INVALID_CHOICE', 'Unknown sharing choice.');
  if (choice === 'none' || choice === 'keep') return { rows: [], fields: [], window: 'none' };
  const requestedFields = choice === 'full' || choice === 'week' ? FULL_FIELDS : SHARED_FIELDS;
  const fields = profile ? requestedFields.filter(field => profile.authorization.fields.includes(field)) : requestedFields;
  const requestedDays = initial ? ['Tue', 'Wed'] : choice === 'narrow' ? ['Thu'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = profile ? requestedDays.filter(day => profile.authorization.windows.includes(day)) : requestedDays;
  const window = days.length === requestedDays.length ? (initial ? 'Tue–Wed' : choice === 'narrow' ? 'Thu' : 'Mon–Sun') : days.length ? days : 'none';
  invariant(!profile || profile.skills.includes('read_synthetic_calendar') && profile.skills.includes('preview_scoped_calendar'), 'TOOL_DISABLED', 'Alice calendar reading and preview skills are required.', 403);
  const rows = calendar.filter(row => {
    if (!days.includes(row.day) || !fields.length) return false;
    return !['free', 'narrow'].includes(choice) || isFree(row);
  }).map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? ''])));
  return { rows, fields: [...fields], window };
}

/** Each instance lives in one dedicated process; it never reads or writes a personal store. */
export function createAgentRuntime({ role, model = {}, modelCall }) {
  invariant(['Alice', 'Bob'].includes(role), 'INVALID_ROLE', 'An isolated agent role is required.');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicIdentity = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const peerRole = role === 'Alice' ? 'Bob' : 'Alice';
  const sessions = new Map();
  const retired = new Set();
  let currentModel = { available: Boolean(model.available), name: model.name || null, timeoutMs: model.timeoutMs || 20_000 };
  const epochKey = ({ sessionId, epoch }) => canonical([sessionId, epoch]);

  function current(args) {
    validateSessionRef(args);
    const state = sessions.get(args.sessionId);
    invariant(!retired.has(epochKey(args)), 'STALE_EPOCH', 'This session epoch has been evicted.', 409);
    invariant(state, 'UNKNOWN_SESSION', 'The isolated agent does not know this session.', 404);
    invariant(state.epoch === args.epoch, 'STALE_EPOCH', 'The action belongs to an old session epoch.', 409);
    return state;
  }

  function assertStillCurrent(args, state, revision) {
    invariant(current(args) === state && (revision === undefined || state.configRevision === revision),
      'CONFIGURATION_CHANGED', 'The context changed while the agent was planning.', 409);
  }

  function intersections(state) {
    const rows = [...state.received.values()].flatMap(item => item.payload.rows || []).filter(isFree);
    const own = state.bobConfig?.data?.availableTimes || [];
    const seen = new Set();
    const matches = [];
    for (const row of rows) for (const slot of own) {
      if (slot.day !== row.day) continue;
      const a = interval(row.time);
      const b = interval(slot.time);
      if (!a || !b) continue;
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end - start < 30) continue;
      const time = `${formatMinute(start)}–${formatMinute(end)}`;
      const key = canonical([row.day, time]);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ day: row.day, time });
    }
    return matches;
  }

  async function oneModelCall(state, system, context, runtime = {}) {
    invariant(state.modelSnapshot.available && typeof modelCall === 'function', 'MODEL_UNAVAILABLE', 'Live mode has no configured parent model broker.', 503);
    const abort = new AbortController();
    state.modelCalls.add(abort);
    const effectiveRuntime = state.modelSettings || runtime;
    const timeoutMs = Math.max(10, Math.min(300_000,
      effectiveRuntime.timeoutSeconds === undefined ? state.modelSnapshot.timeoutMs : Number(effectiveRuntime.timeoutSeconds) * 1000));
    const timer = setTimeout(() => abort.abort('timeout'), timeoutMs);
    timer.unref();
    try {
      const result = await modelCall({ role, sessionId: state.sessionId, epoch: state.epoch,
        modelRevision: state.modelRevision,
        system: `${system}\nReturn a single JSON object, with no Markdown. Planning proposes actions; it never authorizes or executes them.`,
        context: clone(context), legacyRuntime: clone(effectiveRuntime), signal: abort.signal });
      invariant(!abort.signal.aborted, 'PLANNING_CANCELLED', 'This planning request was interrupted.', 409);
      return result;
    } catch (error) {
      if (abort.signal.aborted) {
        if (abort.signal.reason === 'timeout') throw new RuntimeError('MODEL_TIMEOUT', 'The configured model timed out. Retry explicitly or end this round.', 504);
        if (abort.signal.reason === 'configuration_changed') throw new RuntimeError('CONFIGURATION_CHANGED', 'Bob configuration changed while the model was planning.', 409);
        if (abort.signal.reason === 'planning_cancelled') throw new RuntimeError('PLANNING_CANCELLED', 'This planning request was interrupted.', 409);
        throw new RuntimeError('STALE_EPOCH', 'The model context was cleared or replaced.', 409);
      }
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('MODEL_PROVIDER_ERROR', 'The parent model broker could not complete this planning request.', 502);
    } finally {
      clearTimeout(timer);
      state.modelCalls.delete(abort);
    }
  }

  async function callModel(state, system, context, runtime = {}) {
    // The Agent owns retry budgets; each broker callback performs exactly one attempt.
    const effectiveRuntime = state.modelSettings || runtime;
    const attempts = Math.max(1, Math.min(11, 1 + (Number(effectiveRuntime.retryLimit) || 0)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { return await oneModelCall(state, system, context, runtime); }
      catch (error) {
        if (attempt + 1 === attempts || !['MODEL_TIMEOUT', 'MODEL_PROVIDER_ERROR'].includes(error.code)) throw error;
      }
    }
  }

  function messageFrom(output, maxWords = 80) {
    invariant(output && typeof output === 'object' && typeof output.message === 'string' && output.message.trim()
      && output.message.length <= 4000, 'MODEL_INVALID_OUTPUT', 'The model must propose a bounded message.', 502);
    return output.message.trim().split(/\s+/).slice(0, Math.max(1, maxWords)).join(' ');
  }

  const methods = {
    status() {
      return { online: true, role, transport: 'ipc', pid: process.pid, publicKey: publicIdentity,
        live: { available: currentModel.available, model: currentModel.available ? currentModel.name : null } };
    },
    configureModel(args) {
      invariant(typeof args.available === 'boolean' && (args.model === null || typeof args.model === 'string'),
        'MODEL_CONFIGURATION_ERROR', 'Model availability must contain only sanitized provider metadata.');
      currentModel = { available: args.available, name: args.model,
        timeoutMs: Number.isFinite(args.timeoutMs) ? Math.max(10, Math.min(300_000, args.timeoutMs)) : currentModel.timeoutMs };
      return { available: currentModel.available, model: currentModel.name };
    },
    initialize(args) {
      validateSessionRef(args);
      invariant(!retired.has(epochKey(args)), 'STALE_EPOCH', 'An evicted epoch cannot be initialized again.', 409);
      invariant(['controlled', 'live', 'replay'].includes(args.mode), 'INVALID_MODE', 'Unknown runtime mode.');
      invariant(typeof args.peerPublicKey === 'string' && args.peerPublicKey.includes('PUBLIC KEY'),
        'MISSING_PEER_IDENTITY', 'The other isolated agent must be paired first.');
      invariant(role !== 'Bob' || args.aliceData === undefined, 'ISOLATION_VIOLATION', 'Bob cannot receive the Alice fixture.');
      invariant(role !== 'Alice' || args.bobConfig === undefined, 'ISOLATION_VIOLATION', 'Alice cannot receive Bob private configuration.');
      const initialHash = hashPayload(args);
      if (sessions.has(args.sessionId)) {
        const existing = current(args);
        invariant(existing.initialHash === initialHash, 'INITIALIZATION_CONFLICT', 'This active session was already initialized differently.', 409);
        return { ready: true, role, epoch: args.epoch };
      }
      const modelSnapshot = {
        available: typeof args.modelAvailable === 'boolean' ? args.modelAvailable : currentModel.available,
        name: args.modelSettings?.model ?? currentModel.name,
        timeoutMs: Number.isFinite(args.modelSettings?.timeoutSeconds)
          ? Math.max(10, Math.min(300_000, args.modelSettings.timeoutSeconds * 1000)) : currentModel.timeoutMs,
      };
      if (args.mode === 'live') invariant(modelSnapshot.available, 'MODEL_UNAVAILABLE', `${role} has no configured live provider.`, 503);
      const calendar = role === 'Alice' ? (Array.isArray(args.aliceData) ? args.aliceData : args.aliceData?.calendar) : [];
      invariant(role !== 'Alice' || Array.isArray(calendar), 'INVALID_FIXTURE', 'Alice requires a synthetic calendar array.');
      const state = { sessionId: args.sessionId, epoch: args.epoch, mode: args.mode,
        modelRevision: args.modelRevision ?? 1, modelSnapshot,
        modelSettings: args.modelSettings ? clone(args.modelSettings) : null,
        peerPublicKey: args.peerPublicKey, initialHash,
        calendar: clone(calendar), bobConfig: role === 'Bob' ? clone(args.bobConfig) : undefined,
        agentProfile: args.agentProfile ? clone(args.agentProfile) : null, initializedAt: Date.now(),
        configRevision: args.configRevision, received: new Map(), outgoing: new Map(), modelCalls: new Set() };
      sessions.set(args.sessionId, state);
      return { ready: true, role, epoch: args.epoch };
    },
    projectAlice(args) {
      invariant(role === 'Alice', 'WRONG_AGENT', 'Only Alice can project her own fixture.', 403);
      const state = current(args);
      return projectedCalendar(state.calendar, args.stage, args.choice, state.agentProfile);
    },
    prepareOutgoing(args) {
      validateOperation(args);
      const state = current(args);
      const payload = role === 'Alice'
        ? { rows: args.rows, fields: args.fields, window: args.window, payloadHash: args.payloadHash }
        : { fields: args.fields, values: args.values, payloadHash: args.payloadHash };
      const digest = hashPayload(payload);
      const previous = state.outgoing.get(args.operationId);
      if (previous) {
        invariant(previous.digest === digest, 'OPERATION_CONFLICT', 'This operation ID already names a different payload.', 409);
        return clone(previous.result);
      }
      if (role === 'Alice') {
        if (state.agentProfile) {
          invariant(state.agentProfile.skills.includes('send_scoped_snapshot'), 'TOOL_DISABLED', 'Alice snapshot sending skill is disabled.', 403);
          invariant(state.outgoing.size < state.agentProfile.authorization.maxUses, 'ALICE_AUTH_LIMIT', 'Alice initial sharing budget is exhausted.', 403);
          invariant(Date.now() < state.initializedAt + state.agentProfile.authorization.expiryMinutes * 60_000, 'ALICE_AUTH_EXPIRED', 'Alice initial authorization has expired.', 403);
        }
        const expected = hashPayload({ rows: args.rows, fields: args.fields, window: args.window });
        invariant(args.payloadHash === expected, 'PAYLOAD_HASH_MISMATCH', 'The Alice payload does not match its exact preview hash.', 409);
        const projections = [['initial', 'free'], ['initial', 'busy'], ['initial', 'full'], ['initial', 'none'],
          ['additional', 'keep'], ['additional', 'narrow'], ['additional', 'week']];
        invariant(projections.some(([stage, choice]) => hashPayload(projectedCalendar(state.calendar, stage, choice, state.agentProfile)) === expected),
          'INVALID_PROJECTION', 'Alice can send only an exact supported projection of her own fixture.', 403);
      } else {
        invariant(args.values && typeof args.values === 'object' && !Array.isArray(args.values)
          && canonical(Object.keys(args.values).sort()) === canonical([...args.fields].sort()),
          'INVALID_VALUES', 'Bob outgoing values must exactly match the selected fields.');
        invariant(hashPayload({ fields: args.fields, values: args.values }) === args.payloadHash,
          'PAYLOAD_HASH_MISMATCH', 'The Bob payload does not match its exact content hash.', 409);
        const ownSources = [state.bobConfig?.data?.brief || {},
          ...(state.bobConfig?.data?.availableTimes || []).map(slot => ({ ...slot, status: 'Free' }))];
        invariant(ownSources.some(source => args.fields.every(field => Object.hasOwn(source, field)
          && (field === 'time' ? withinTime(args.values[field], source[field])
            : canonical(source[field]) === canonical(args.values[field])))),
          'INVALID_BOB_DATA', 'Bob can send only actual values from his current synthetic data.', 403);
      }
      const body = { version: 1, from: role, to: peerRole, sessionId: args.sessionId, epoch: args.epoch,
        operationId: args.operationId, payload, createdAt: new Date().toISOString() };
      const result = { envelope: { body, signature: signObject(body, privateKey) } };
      state.outgoing.set(args.operationId, { digest, result: clone(result) });
      return result;
    },
    receive(args) {
      const state = current(args);
      const { body, signature } = args.envelope || {};
      invariant(body && verifyObject(body, signature, state.peerPublicKey), 'INVALID_PEER_SIGNATURE', 'The peer message signature is invalid.', 401);
      invariant(body.version === 1 && body.from === peerRole && body.to === role
        && body.sessionId === args.sessionId && body.epoch === args.epoch,
        'INVALID_PEER_ENVELOPE', 'The message has the wrong sender, recipient or epoch.', 409);
      validateOperation({ ...body, ...body.payload });
      const payload = body.payload;
      invariant(payload.payloadHash === hashPayload(role === 'Bob'
        ? { rows: payload.rows, fields: payload.fields, window: payload.window }
        : { fields: payload.fields, values: payload.values }), 'PAYLOAD_HASH_MISMATCH', 'The signed content hash is invalid.', 409);
      const digest = hashPayload(payload);
      const previous = state.received.get(body.operationId);
      if (previous) {
        invariant(previous.digest === digest, 'OPERATION_CONFLICT', 'The peer reused an operation ID with different content.', 409);
        return clone(previous.result);
      }
      const receipt = { operationId: body.operationId, payloadHash: payload.payloadHash,
        status: 'received', receivedAt: new Date().toISOString() };
      const proof = { version: 1, sessionId: args.sessionId, epoch: args.epoch,
        sender: peerRole, receiver: role, payloadDigest: digest, ...receipt };
      const result = { receipt, proof: { body: proof, signature: signObject(proof, privateKey) } };
      state.received.set(body.operationId, { digest, payload: clone(payload), result: clone(result) });
      return result;
    },
    verifyReceipt(args) {
      validateOperation(args);
      const state = current(args);
      const payload = role === 'Bob'
        ? { rows: args.rows, fields: args.fields, window: args.window, payloadHash: args.payloadHash }
        : { fields: args.fields, values: args.values, payloadHash: args.payloadHash };
      invariant(args.payloadHash === hashPayload(role === 'Bob'
        ? { rows: args.rows, fields: args.fields, window: args.window }
        : { fields: args.fields, values: args.values }), 'PAYLOAD_HASH_MISMATCH', 'The receipt query must name exact content.', 409);
      const previous = state.received.get(args.operationId);
      if (!previous) return null;
      invariant(previous.digest === hashPayload(payload), 'OPERATION_CONFLICT', 'The receipt belongs to different content.', 409);
      return clone(previous.result);
    },
    async planBob(args) {
      invariant(role === 'Bob', 'WRONG_AGENT', 'Only Bob can plan Bob actions.', 403);
      const state = current(args);
      invariant(args.configRevision === state.configRevision, 'CONFIGURATION_CHANGED', 'Bob policy revision changed.', 409);
      invariant(['initial', 'additional', 'brief'].includes(args.purpose), 'INVALID_PURPOSE', 'Unknown Bob planning purpose.');
      const revision = state.configRevision;
      const config = state.bobConfig;
      invariant(args.purpose === 'brief' || config.tools?.capabilities?.includes('read_synthetic_calendar'), 'TOOL_DISABLED', 'Bob calendar reading skill is disabled.', 403);
      invariant(args.purpose !== 'brief' || config.tools?.capabilities?.includes('share_brief'), 'TOOL_DISABLED', 'Bob brief sharing skill is disabled.', 403);
      const matches = intersections(state);
      const brief = clone(config.data?.brief || {});
      if (config.collaboration?.acceptInvitations === false || !config.collaboration?.allowedPeers?.includes('Alice')) {
        return { message: 'Bob is not accepting this collaboration.', action: { type: 'no_match' } };
      }
      let output;
      if (state.mode === 'live') {
        const actions = args.purpose === 'brief' ? ['share_brief']
          : args.purpose === 'initial' ? ['request_more', 'meeting', 'no_match'] : ['meeting', 'no_match'];
        const system = `You are Bob, a fictional collaboration agent. ${config.persona || ''}\n${config.objective || ''}\n${config.prompts?.system || ''}\n${config.response?.constraints || ''}\n`
          + 'Return JSON {"message":"text","action":{"type":"allowed type","meeting":{"day":"...","time":"..."}}}. '
          + 'For share_brief instead return fields, values and resource="meeting_brief". Never invent a meeting or source values. '
          + 'You have only the actual received Alice projection. You do not know any unshared calendar entry. Do not execute tools.';
        output = await callModel(state, system, {
          purpose: args.purpose, allowedActions: actions, ownKnowledgeGraph: clone(state.agentProfile?.kg || { nodes: [], edges: [] }), skills: clone(config.tools?.capabilities || []),
          received: [...state.received.values()].map(item => clone(item.payload)),
          ownAvailableTimes: config.tools?.capabilities?.includes('read_synthetic_calendar') ? clone(config.data?.availableTimes || []) : [], sharedIntersection: args.purpose === 'brief' ? [] : matches,
          ...(args.purpose === 'brief' ? { ownBrief: brief } : { followUpInstruction: config.prompts?.followUp || '' }),
        }, config.runtime || {});
        assertStillCurrent(args, state, revision);
        const message = messageFrom(output, config.response?.maxWords || 80);
        invariant(output.action && actions.includes(output.action.type), 'MODEL_INVALID_OUTPUT', 'The model proposed an unsupported Bob action.', 502);
        if (output.action.type === 'meeting') {
          invariant(matches.some(meeting => meeting.day === output.action.meeting?.day
            && withinTime(output.action.meeting?.time, meeting.time, true)),
            'MODEL_INVALID_MEETING', 'The model meeting is outside the actually shared free-time intersection.', 502);
          return { message, action: { type: 'meeting', meeting: { day: output.action.meeting.day, time: output.action.meeting.time } } };
        }
        if (output.action.type === 'share_brief') {
          const { fields, values, resource } = output.action;
          invariant(Array.isArray(fields) && fields.length && new Set(fields).size === fields.length && values
            && fields.every(field => Object.hasOwn(brief, field) && canonical(brief[field]) === canonical(values[field]))
            && canonical(Object.keys(values).sort()) === canonical([...fields].sort()) && resource === 'meeting_brief',
            'MODEL_INVALID_OUTPUT', 'The model brief must propose actual Bob data only.', 502);
          return { message: 'Bob prepared an optional meeting brief.', action: { type: 'share_brief', fields: clone(fields), values: clone(values), resource } };
        }
        return { message, action: { type: output.action.type } };
      }
      if (args.purpose === 'brief') return { message: 'Bob prepared an optional meeting brief.',
        action: { type: 'share_brief', fields: Object.keys(brief), values: brief, resource: 'meeting_brief' } };
      if (matches.length) {
        const start = interval(matches[0].time).start;
        const meeting = { day: matches[0].day, time: `${formatMinute(start)}–${formatMinute(start + 30)}` };
        return { message: `We both have a shared free time on ${meeting.day} at ${meeting.time}.`, action: { type: 'meeting', meeting } };
      }
      if (args.purpose === 'initial') return { message: config.prompts?.followUp
        || 'I cannot find a matching time in the shared rows. Would you share Thursday free times, keep the current boundary, or share the week?',
      action: { type: 'request_more' } };
      return { message: 'The shared information has no matching free time. Your sharing boundary remains in place.', action: { type: 'no_match' } };
    },
    async planAlice(args) {
      invariant(role === 'Alice', 'WRONG_AGENT', 'Only Alice can plan Alice messages.', 403);
      const state = current(args);
      invariant(args.mode === undefined || args.mode === state.mode, 'MODE_CHANGED', 'The requested mode differs from the current round.', 409);
      invariant(['intro', 'proposal'].includes(args.purpose), 'INVALID_PURPOSE', 'Unknown Alice planning purpose.');
      if (state.mode !== 'live') return { message: args.purpose === 'intro'
        ? 'I can help arrange a fictional discussion with Bob. You choose exactly what I share.'
        : 'I will use only the exact projection you approve for this collaboration.' };
      const output = await callModel(state,
        'You are Alice, a fictional assistant speaking to your own participant. Return JSON {"message":"text"}. '
          + 'Explain that the participant chooses any sharing. Never claim you have already sent or authorized anything.',
        { purpose: args.purpose, ownCalendar: state.agentProfile && !state.agentProfile.skills.includes('read_synthetic_calendar') ? [] : clone(state.calendar), ownKnowledgeGraph: clone(state.agentProfile?.kg || { nodes: [], edges: [] }), skills: clone(state.agentProfile?.skills || []), receivedBobData: state.agentProfile && !state.agentProfile.skills.includes('inspect_received_snapshot') ? [] : [...state.received.values()].map(item => clone(item.payload)) });
      assertStillCurrent(args, state);
      return { message: messageFrom(output) };
    },
    cancelPlanning(args) {
      const state = current(args);
      const count = state.modelCalls.size;
      for (const abort of state.modelCalls) abort.abort('planning_cancelled');
      return { cancelled: true, role, count };
    },
    updateBob(args) {
      invariant(role === 'Bob', 'WRONG_AGENT', 'Only Bob configuration can be replaced here.', 403);
      const state = current(args);
      invariant(Number.isSafeInteger(args.configRevision) && args.configRevision > state.configRevision,
        'CONFIGURATION_CHANGED', 'A Bob update requires a newer revision.', 409);
      for (const abort of state.modelCalls) abort.abort('configuration_changed');
      state.bobConfig = clone(args.bobConfig);
      state.configRevision = args.configRevision;
      return { ready: true, role, epoch: args.epoch, configRevision: args.configRevision };
    },
    clear(args) {
      validateSessionRef(args);
      const state = sessions.get(args.sessionId);
      invariant(!state || state.epoch === args.epoch, 'STALE_EPOCH', 'Cannot clear a different active epoch.', 409);
      if (state) {
        sessions.delete(args.sessionId);
        for (const abort of state.modelCalls) abort.abort('cleared');
        state.received.clear();
        state.outgoing.clear();
        state.calendar.length = 0;
        state.bobConfig = undefined;
        state.agentProfile = null;
        state.modelSettings = null;
        state.modelSnapshot = null;
        state.initialHash = undefined;
        state.peerPublicKey = undefined;
      }
      retired.add(epochKey(args));
      return { cleared: true, role, epoch: args.epoch };
    },
  };
  return { async call(method, args = {}) {
    invariant(WORKER_RPC_METHODS.has(method), 'UNKNOWN_METHOD', 'This isolated runtime method does not exist.', 404);
    return methods[method](args);
  }, close() {
    for (const [sessionId, state] of sessions) methods.clear({ sessionId, epoch: state.epoch });
    sessions.clear();
    retired.clear();
  } };
}

function runWorker() {
  const role = process.env.AGENT_DEMO_ROLE;
  const secret = process.env.AGENT_DEMO_RPC_SECRET;
  if (!secret || !process.send) process.exit(1);
  const model = JSON.parse(process.env.AGENT_DEMO_WORKER_MODEL || '{}');
  delete process.env.AGENT_DEMO_WORKER_MODEL;
  delete process.env.AGENT_DEMO_RPC_SECRET;
  const pendingModels = new Map();
  const send = body => {
    if (process.connected) process.send({ body, signature: macObject(body, secret) });
  };
  const modelCall = args => new Promise((resolveModel, rejectModel) => {
    const id = randomUUID();
    const ref = { sessionId: args.sessionId, epoch: args.epoch, modelRevision: args.modelRevision };
    const request = { id, role, target: 'controller', kind: 'model_request', ...ref,
      system: args.system, context: args.context, legacyRuntime: args.legacyRuntime };
    const cancel = () => {
      pendingModels.delete(id);
      send({ id, role, target: 'controller', kind: 'model_cancel', ...ref });
      rejectModel(new RuntimeError('MODEL_CANCELLED', 'This model request was cancelled.', 409));
    };
    if (args.signal.aborted) { cancel(); return; }
    args.signal.addEventListener('abort', cancel, { once: true });
    pendingModels.set(id, { ...ref, resolve: resolveModel, reject: rejectModel,
      release: () => args.signal.removeEventListener('abort', cancel) });
    if (!process.connected) {
      pendingModels.delete(id);
      args.signal.removeEventListener('abort', cancel);
      rejectModel(new RuntimeError('RUNTIME_OFFLINE', 'The parent model broker is disconnected.', 503));
      return;
    }
    send(request);
  });
  const runtime = createAgentRuntime({ role, model, modelCall });
  process.on('message', async envelope => {
    const { body, signature } = envelope || {};
    if (!body || !verifyMac(body, signature, secret) || body.target !== role || body.role !== 'controller') return;
    if (body.kind === 'model_response') {
      const pending = pendingModels.get(body.id);
      if (!pending || body.sessionId !== pending.sessionId || body.epoch !== pending.epoch
        || body.modelRevision !== pending.modelRevision) return;
      pendingModels.delete(body.id);
      pending.release();
      if (body.ok) pending.resolve(body.result);
      else pending.reject(fromErrorJSON(body.error));
      return;
    }
    const response = { id: body.id, role, target: 'controller' };
    try { response.result = await runtime.call(body.method, body.args); response.ok = true; }
    catch (error) { response.ok = false; response.error = errorJSON(error); }
    if (process.connected) process.send({ body: response, signature: macObject(response, secret) });
  });
  process.on('disconnect', () => { runtime.close(); process.exit(0); });
  process.on('SIGTERM', () => { runtime.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.env.AGENT_DEMO_ROLE) runWorker();
