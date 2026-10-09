import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  RuntimeError, invariant, canonical, hashPayload, signObject, verifyObject,
  macObject, verifyMac, errorJSON, fromErrorJSON, validateSessionRef, validateOperation, WORKER_RPC_METHODS,
} from './runtime-helpers.mjs';
import { ontologyDefinitions, createOntologyDialogue, startOntologyDialogue, defaultOntologyProposal, validateOntologyProposal,
  resolveOntologyDialogue, registerOntologyReceipt, queryRegisteredMeetingSlots } from './ontology-dialogue.mjs';

// Windows may inject PATH into a child even when fork receives an explicit
// environment allowlist. Remove it inside the paired worker as well.
if (process.send && process.env.AGENT_DEMO_ROLE) delete process.env.PATH;

const SHARED_FIELDS = ['day', 'time', 'status'];
const FULL_FIELDS = [...SHARED_FIELDS, 'title', 'note'];
const clone = value => structuredClone(value);
const isFree = row => String(row.status).toLowerCase() === 'free';
const normalizedTime = value => String(value).replace(/[–—−]/g, '-').replace(/\s/g, '');
const formatMinute = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const ontologyMove = (kind, sender) => kind === 'module' ? sender === 'Alice' ? 'join' : 'pick'
  : kind === 'proposal' ? 'propose' : kind === 'decision' ? 'decide' : kind === 'acknowledgment' ? sender === 'Alice' ? 'end' : 'close' : null;
const ontologyStep = (kind, sender) => kind === 'module' ? sender === 'Alice' ? 1 : 2
  : kind === 'proposal' && sender === 'Alice' ? 3 : kind === 'decision' && sender === 'Bob' ? 4
    : kind === 'acknowledgment' ? sender === 'Alice' ? 5 : 6 : null;

function interval(value) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(normalizedTime(value));
  if (!match) return null;
  const [, h1, m1, h2, m2] = match.map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  return end > start ? { start, end } : null;
}

function withinTime(proposed, available, requiredMinutes = null) {
  const part = interval(proposed);
  const whole = interval(available);
  return Boolean(part && whole && part.start >= whole.start && part.end <= whole.end
    && (!requiredMinutes || part.end - part.start === (requiredMinutes === true ? 30 : requiredMinutes)));
}

function projectedCalendar(calendar, stage, choice, profile, requestedScope) {
  const initial = stage === 'initial';
  invariant(initial || stage === 'additional', 'INVALID_STAGE', 'Unknown projection stage.');
  invariant((initial ? ['free', 'busy', 'full', 'none'] : ['keep', 'narrow', 'week']).includes(choice),
    'INVALID_CHOICE', 'Unknown sharing choice.');
  if (choice === 'none' || choice === 'keep') return { rows: [], fields: [], window: 'none' };
  const requestedFields = choice === 'full' || choice === 'week' ? FULL_FIELDS : SHARED_FIELDS;
  const fields = profile ? requestedFields.filter(field => profile.authorization.fields.includes(field)) : requestedFields;
  const requestedDays = requestedScope ?? (initial ? ['Tue', 'Wed'] : choice === 'narrow' ? ['Thu'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  invariant(Array.isArray(requestedDays) && requestedDays.length <= 7 && new Set(requestedDays).size === requestedDays.length
    && requestedDays.every(day => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(day)), 'INVALID_DAYS', 'Calendar projection days must be unique weekdays.');
  const days = profile ? requestedDays.filter(day => profile.authorization.windows.includes(day)) : requestedDays;
  const window = days.length === requestedDays.length ? (requestedScope ? days.length === 1 ? days[0] : days : initial ? 'Tue–Wed' : choice === 'narrow' ? 'Thu' : 'Mon–Sun') : days.length ? days : 'none';
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
    const dialogue = state.ontologies.get('schedule');
    invariant(dialogue?.status === 'accepted', 'ONTOLOGY_NOT_ALIGNED', 'Bob must receive and accept a task mapping before planning a meeting.', 409);
    return queryRegisteredMeetingSlots({ dialogue, availableTimes: state.bobConfig?.data?.availableTimes || [] });
  }

  function selectedOwnModule(state) {
    const suffixes = state.ontologyContext.task.type === 'brief' ? [':brief'] : [':time', ':status'];
    return state.ownOntology.modules.filter(item => suffixes.some(suffix => item.id.endsWith(suffix)));
  }

  function ontologyRound(state, args) {
    invariant(typeof args.roundId === 'string' && /^[a-f0-9]{64}$/.test(args.roundId)
      && Number.isSafeInteger(args.roundRevision) && args.roundRevision > 0, 'ONTOLOGY_PROTOCOL', 'The dialogue must identify a bounded versioned round.');
    if (!state.ontologyRound || args.roundRevision > state.ontologyRound.revision) {
      if (args.ontologyContext) {
        invariant(args.ontologyContext.scenario === state.ontologyContext.scenario, 'ONTOLOGY_STALE_VERSION', 'An ontology scenario cannot change during a session.', 409);
        const validated = startOntologyDialogue({ ...args.ontologyContext, mode: state.mode });
        state.ontologyContext = { scenario: validated.scenario, task: validated.task };
      }
      state.ontologyRound = { id: args.roundId, revision: args.roundRevision, sequence: 0, lastHash: null,
        messages: new Map(), peerModules: null, proposal: null, decision: null, ownAcknowledged: false, peerAcknowledged: false };
    }
    invariant(state.ontologyRound.id === args.roundId && state.ontologyRound.revision === args.roundRevision,
      'ONTOLOGY_STALE_VERSION', 'This ontology message belongs to an old or conflicting dialogue.', 409);
    return state.ontologyRound;
  }

  function signOntology(state, args, kind, payload) {
    const round = ontologyRound(state, args);
    invariant(args.sequence === ontologyStep(kind, role), 'ONTOLOGY_PROTOCOL_ORDER', 'This agent may not perform that dialogue move at this sequence.', 409);
    const previous = round.messages.get(args.sequence);
    if (previous) {
      invariant(previous.envelope.body.from === role && previous.envelope.body.kind === kind
        && canonical(previous.envelope.body.payload) === canonical(payload), 'ONTOLOGY_PROTOCOL_CONFLICT', 'This dialogue step already records different content.', 409);
      return clone(previous.envelope);
    }
    invariant(Number.isSafeInteger(args.sequence) && args.sequence === round.sequence + 1 && args.sequence <= 100
      && args.previousHash === round.lastHash, 'ONTOLOGY_PROTOCOL_ORDER', 'The signed dialogue sequence or preceding hash is invalid.', 409);
    const body = { version: 1, channel: 'ontology', from: role, to: peerRole, sessionId: state.sessionId, epoch: state.epoch,
      roundId: round.id, roundRevision: round.revision, sequence: args.sequence, previousHash: round.lastHash,
      kind, move: ontologyMove(kind, role), payload: clone(payload), payloadHash: hashPayload(payload) };
    const envelope = { body, signature: signObject(body, privateKey) };
    round.sequence = body.sequence; round.lastHash = hashPayload(body);
    round.messages.set(body.sequence, { envelope: clone(envelope) });
    return envelope;
  }

  function modelSelection(output, candidates) {
    invariant(output && ['accept', 'reject', 'none'].includes(output.decision)
      && Array.isArray(output.selectedMappingIds) && new Set(output.selectedMappingIds).size === output.selectedMappingIds.length
      && output.selectedMappingIds.every(id => candidates.some(item => item.id === id))
      && Object.keys(output).every(key => ['message', 'decision', 'selectedMappingIds'].includes(key)),
      'MODEL_INVALID_OUTPUT', 'The model must select registered mapping identifiers or explicitly choose none.', 502);
    const message = messageFrom(output);
    invariant(output.decision === 'accept' || output.selectedMappingIds.length === 0,
      'MODEL_INVALID_OUTPUT', 'A rejected or none proposal cannot include accepted mappings.', 502);
    const accepted = output.decision === 'accept' && output.selectedMappingIds.length === candidates.length;
    return { decision: accepted ? 'accepted' : 'rejected', message,
      selectedMappingIds: accepted ? candidates.map(item => item.id) : [],
      reasonCode: accepted ? 'MODEL_ACCEPTED_REGISTERED_MAPPING' : output.decision === 'none' ? 'MODEL_CHOSE_NONE' : 'MODEL_REJECTED_OR_INCOMPLETE_MAPPING' };
  }

  function agreementDialogue(state, round) {
    const pending = startOntologyDialogue({ ...state.ontologyContext, mode: state.mode });
    return resolveOntologyDialogue(pending, { decision: round.decision.decision === 'accepted' ? 'accept' : 'reject',
      ...(state.ontologyContext.task.type === 'schedule' && round.decision.decision === 'accepted'
        ? { calendarFreeMeansBookable: round.proposal.interpretation.calendarFreeMeansBookable } : {}) });
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
      const ontologyContext = { scenario: args.ontologyContext?.scenario ?? 'distinct', task: args.ontologyContext?.task ?? { type: 'schedule', durationMinutes: 30 } };
      const ownOntology = ontologyDefinitions({ scenario: ontologyContext.scenario })[role];
      invariant(!args.ownOntology || canonical(args.ownOntology) === canonical(ownOntology), 'ISOLATION_VIOLATION', 'Initialize each worker with exactly its own versioned ontology profile.');
      invariant(args.ontologyDialogue === undefined, 'ISOLATION_VIOLATION', 'A worker receives the peer working ontology only through signed dialogue messages.');
      const state = { sessionId: args.sessionId, epoch: args.epoch, mode: args.mode,
        modelRevision: args.modelRevision ?? 1, modelSnapshot,
        modelSettings: args.modelSettings ? clone(args.modelSettings) : null,
        peerPublicKey: args.peerPublicKey, initialHash,
        calendar: clone(calendar), bobConfig: role === 'Bob' ? clone(args.bobConfig) : undefined,
        agentProfile: args.agentProfile ? clone(args.agentProfile) : null, initializedAt: Date.now(),
        configRevision: args.configRevision, received: new Map(), outgoing: new Map(), modelCalls: new Set(), projections: new Map(),
        ownOntology: clone(ownOntology), ontologyContext,
        // Direct library callers predate the dialogue API. Product managers always supply
        // ontologyContext and execute the signed two-worker negotiation before any query.
        ontologies: new Map(args.ontologyContext ? [] : [['schedule', createOntologyDialogue({ mode: args.mode })]]),
        legacyLocalMapping: !args.ontologyContext, ontologyHistory: new Map(), ontologyRound: null };
      for (const dialogue of state.ontologies.values()) state.ontologyHistory.set(dialogue.task.id, dialogue);
      sessions.set(args.sessionId, state);
      return { ready: true, role, epoch: args.epoch };
    },
    ontologyModule(args) {
      const state = current(args);
      const round = ontologyRound(state, args);
      invariant(args.authorized === true, 'ONTOLOGY_DISCLOSURE_NOT_AUTHORIZED', 'Publishing a working ontology needs a separate explicit decision.', 403);
      return { envelope: signOntology(state, args, 'module', { ontologyId: state.ownOntology.id, ontologyVersion: state.ownOntology.version,
        task: clone(state.ontologyContext.task), modules: clone(selectedOwnModule(state)) }) };
    },
    receiveOntology(args) {
      const state = current(args);
      const { body, signature } = args.envelope || {};
      invariant(body && verifyObject(body, signature, state.peerPublicKey), 'INVALID_PEER_SIGNATURE', 'The ontology message signature is invalid.', 401);
      invariant(body.version === 1 && body.channel === 'ontology' && body.from === peerRole && body.to === role
        && body.sessionId === state.sessionId && body.epoch === state.epoch && body.payloadHash === hashPayload(body.payload),
        'ONTOLOGY_PROTOCOL', 'The ontology message has the wrong identity, epoch or content digest.', 409);
      invariant(body.move === ontologyMove(body.kind, body.from), 'ONTOLOGY_PROTOCOL', 'The signed dialogue move does not match its sender and protocol kind.', 409);
      invariant(body.sequence === ontologyStep(body.kind, body.from), 'ONTOLOGY_PROTOCOL_ORDER', 'The signed dialogue move appears in the wrong protocol stage.', 409);
      const round = ontologyRound(state, { ...body, ontologyContext: args.ontologyContext });
      const previous = round.messages.get(body.sequence);
      if (previous) {
        invariant(canonical(previous.envelope) === canonical(args.envelope), 'ONTOLOGY_PROTOCOL_CONFLICT', 'A signed dialogue step was reused with different content.', 409);
        return clone(previous.receipt);
      }
      invariant(body.sequence === round.sequence + 1 && body.previousHash === round.lastHash, 'ONTOLOGY_PROTOCOL_ORDER', 'The ontology message arrived out of order.', 409);
      if (body.kind === 'module') {
        invariant(canonical(body.payload.task) === canonical(state.ontologyContext.task), 'ONTOLOGY_TASK_MISMATCH', 'Working ontologies must refer to the same registered task.', 409);
        const peerDefinition = ontologyDefinitions({ scenario: state.ontologyContext.scenario })[peerRole];
        invariant(body.payload.ontologyId === peerDefinition.id && body.payload.ontologyVersion === peerDefinition.version,
          'ONTOLOGY_MODULE_CHANGED', 'The working ontology names a different published version.', 409);
        const expected = startOntologyDialogue({ ...state.ontologyContext, mode: state.mode }).selectedModules.filter(item => item.owner === peerRole);
        invariant(canonical(body.payload.modules) === canonical(expected), 'ONTOLOGY_MODULE_CHANGED', 'The published working ontology does not match its versioned task subset.', 409);
        round.peerModules = clone(body.payload.modules);
      } else if (body.kind === 'proposal') {
        invariant(role === 'Bob' && round.peerModules && body.sequence === 3, 'ONTOLOGY_PROTOCOL_ORDER', 'Bob needs the signed working ontology before receiving a proposal.', 409);
        const verified = validateOntologyProposal({ mappings: body.payload.candidates.map(({ source, target, relation, transform }) => ({ source, target, relation, transform })) }, state.ontologyContext);
        invariant(canonical(verified) === canonical(body.payload.candidates), 'ONTOLOGY_INVALID_PROPOSAL', 'Mapping explanations and identifiers must match the disclosed ontology definitions.', 409);
        invariant(['accepted', 'rejected'].includes(body.payload.decision)
          && typeof body.payload.interpretation?.authorizesDisclosure === 'boolean' && body.payload.interpretation.authorizesDisclosure === false,
          'ONTOLOGY_PROTOCOL', 'A semantic proposal cannot grant disclosure permission.');
        round.proposal = clone(body.payload);
      } else if (body.kind === 'decision') {
        invariant(role === 'Alice' && round.proposal && body.sequence === 4, 'ONTOLOGY_PROTOCOL_ORDER', 'Alice needs her original signed proposal before a decision.', 409);
        invariant(['accepted', 'rejected'].includes(body.payload.decision)
          && canonical(body.payload.selectedMappingIds) === canonical(body.payload.decision === 'accepted' ? round.proposal.candidates.map(item => item.id) : []),
          'ONTOLOGY_INVALID_PROPOSAL', 'Bob accepted unsupported or incomplete semantic mappings.', 409);
        round.decision = clone(body.payload);
      } else if (body.kind === 'acknowledgment') {
        invariant(round.decision && body.payload.agreementHash === hashPayload({ decision: round.decision.decision,
          mappingVersion: agreementDialogue(state, round).registry.mappingVersion }), 'ONTOLOGY_PROTOCOL', 'The peer acknowledgment does not match the agreed mapping version.', 409);
        round.peerAcknowledged = true;
      } else invariant(false, 'ONTOLOGY_PROTOCOL', 'Unsupported ontology dialogue move.');
      round.sequence = body.sequence; round.lastHash = hashPayload(body);
      const proof = { version: 1, channel: 'ontology_receipt', sessionId: state.sessionId, epoch: state.epoch, roundId: round.id,
        roundRevision: round.revision, sequence: body.sequence, from: role, to: peerRole, envelopeHash: hashPayload(body), status: 'received' };
      const receipt = { proof: { body: proof, signature: signObject(proof, privateKey) } };
      round.messages.set(body.sequence, { envelope: clone(args.envelope), receipt: clone(receipt) });
      return receipt;
    },
    async proposeOntology(args) {
      invariant(role === 'Alice', 'WRONG_AGENT', 'Alice proposes the correspondences for this dialogue.', 403);
      const state = current(args), round = ontologyRound(state, args);
      invariant(round.peerModules, 'ONTOLOGY_PROTOCOL_ORDER', 'Alice must receive Bob’s task subset before proposing correspondences.', 409);
      const candidates = validateOntologyProposal(defaultOntologyProposal(state.ontologyContext), state.ontologyContext);
      let selection = { decision: args.decision === 'rejected' ? 'rejected' : 'accepted', selectedMappingIds: args.decision === 'rejected' ? [] : candidates.map(item => item.id),
        message: 'Rule selector proposes registered correspondences inside the disclosed task modules.' };
      if (args.liveProposal && selection.decision === 'accepted') {
        const revision = state.configRevision;
        const output = await callModel(state, 'You are Alice selecting task-scoped ontology correspondences. Choose only supplied candidate identifiers or none. '
          + 'Return message, decision and selectedMappingIds. Accept only a complete semantically sound task mapping. A mapping never authorizes data disclosure.',
        { purpose: 'ontology_alignment', stage: 'propose', task: clone(state.ontologyContext.task),
          ownWorkingOntology: clone(selectedOwnModule(state)), receivedWorkingOntology: clone(round.peerModules), candidates: clone(candidates), interpretation: clone(args.interpretation) });
        assertStillCurrent(args, state, revision);
        invariant(state.ontologyRound === round, 'ONTOLOGY_STALE_VERSION', 'The ontology dialogue changed while its model was selecting.', 409);
        selection = modelSelection(output, candidates);
      }
      if (selection.decision === 'rejected') selection.selectedMappingIds = [];
      const payload = { candidates, interpretation: clone(args.interpretation), ...selection, selector: args.liveProposal ? 'live' : 'guided' };
      round.proposal = clone(payload);
      return { envelope: signOntology(state, args, 'proposal', payload), selection };
    },
    async decideOntology(args) {
      invariant(role === 'Bob', 'WRONG_AGENT', 'Bob independently decides the received correspondence proposal.', 403);
      const state = current(args), round = ontologyRound(state, args);
      invariant(round.proposal && round.peerModules, 'ONTOLOGY_PROTOCOL_ORDER', 'Bob must receive the signed proposal and working subset before deciding.', 409);
      const interpretationValid = state.ontologyContext.task.type !== 'schedule' || round.proposal.interpretation.calendarFreeMeansBookable === true;
      let selection = { decision: round.proposal.decision === 'accepted' && interpretationValid ? 'accepted' : 'rejected',
        selectedMappingIds: round.proposal.candidates.map(item => item.id), message: 'Bob verifies the definitions, registered transforms and task-scoped owner interpretation.', selector: 'guided' };
      if (args.liveProposal && selection.decision === 'accepted') {
        const revision = state.configRevision;
        const output = await callModel(state, 'You are Bob independently reviewing Alice’s signed correspondence proposal. '
          + 'Choose only supplied candidate identifiers or none. Return message, decision and selectedMappingIds. '
          + 'Calendar occupancy does not imply invitation permission without the supplied explicit task-scoped interpretation. Mapping acceptance never permits data disclosure.',
        { purpose: 'ontology_alignment', stage: 'decide', task: clone(state.ontologyContext.task), ownWorkingOntology: clone(selectedOwnModule(state)),
          receivedWorkingOntology: clone(round.peerModules), candidates: clone(round.proposal.candidates), interpretation: clone(round.proposal.interpretation) });
        assertStillCurrent(args, state, revision);
        invariant(state.ontologyRound === round, 'ONTOLOGY_STALE_VERSION', 'The ontology dialogue changed while Bob was reviewing.', 409);
        selection = { ...modelSelection(output, round.proposal.candidates), selector: 'live' };
      }
      if (selection.decision === 'rejected') selection.selectedMappingIds = [];
      round.decision = clone(selection);
      return { envelope: signOntology(state, args, 'decision', selection), selection };
    },
    acknowledgeOntology(args) {
      const state = current(args), round = ontologyRound(state, args);
      invariant(round.decision, 'ONTOLOGY_PROTOCOL_ORDER', 'A semantic decision is required before acknowledgment.', 409);
      const dialogue = agreementDialogue(state, round);
      const payload = { decision: dialogue.status, mappingVersion: dialogue.registry.mappingVersion,
        agreementHash: hashPayload({ decision: dialogue.status, mappingVersion: dialogue.registry.mappingVersion }) };
      round.ownAcknowledged = true;
      return { envelope: signOntology(state, args, 'acknowledgment', payload) };
    },
    updateOntology(args) {
      const state = current(args), round = ontologyRound(state, args);
      invariant(round.ownAcknowledged && round.peerAcknowledged, 'ONTOLOGY_NOT_ACKNOWLEDGED', 'Both agents must independently acknowledge the mapping before it becomes usable.', 409);
      const agreed = agreementDialogue(state, round);
      invariant(args.dialogue?.status === agreed.status && args.dialogue.registry.mappingVersion === agreed.registry.mappingVersion
        && canonical(args.dialogue.registry.mappings) === canonical(agreed.registry.mappings)
        && canonical(args.dialogue.selectedModules) === canonical(agreed.selectedModules), 'ONTOLOGY_STALE_VERSION', 'The registry update differs from the signed agreement.', 409);
      const previous = state.ontologyHistory.get(agreed.task.id);
      if (previous?.status === 'accepted') invariant(previous.registry.mappingVersion === agreed.registry.mappingVersion, 'ONTOLOGY_STALE_VERSION', 'A used mapping cannot drift within an active task.', 409);
      // The controller cannot manufacture or overwrite received semantic facts.
      const registered = previous?.status === 'accepted' ? previous : agreed;
      state.ontologies.set(agreed.task.type, registered);
      state.ontologyHistory.set(agreed.task.id, registered);
      return { ready: true, role, status: agreed.status, task: agreed.task.type, mappingVersion: agreed.registry.mappingVersion };
    },
    ontologyStatus(args) {
      const state = current(args);
      return { role, ownOntologyId: state.ownOntology.id, dialogues: Object.fromEntries([...state.ontologies].map(([type, dialogue]) => [type, clone(dialogue)])) };
    },
    projectAlice(args) {
      invariant(role === 'Alice', 'WRONG_AGENT', 'Only Alice can project her own fixture.', 403);
      const state = current(args);
      const projection = projectedCalendar(state.calendar, args.stage, args.choice, state.agentProfile, args.days);
      state.projections.set(hashPayload(projection), { stage: args.stage, choice: args.choice, days: clone(args.days) });
      return projection;
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
        const recorded = args.projection ?? state.projections.get(expected);
        const supported = recorded ? hashPayload(projectedCalendar(state.calendar, recorded.stage, recorded.choice, state.agentProfile, recorded.days)) === expected : false;
        invariant(supported || projections.some(([stage, choice]) => hashPayload(projectedCalendar(state.calendar, stage, choice, state.agentProfile)) === expected),
          'INVALID_PROJECTION', 'Alice can send only an exact supported projection of her own fixture.', 403);
      } else {
        invariant(args.values && typeof args.values === 'object' && !Array.isArray(args.values)
          && canonical(Object.keys(args.values).sort()) === canonical([...args.fields].sort()),
          'INVALID_VALUES', 'Bob outgoing values must exactly match the selected fields.');
        invariant(hashPayload({ fields: args.fields, values: args.values }) === args.payloadHash,
          'PAYLOAD_HASH_MISMATCH', 'The Bob payload does not match its exact content hash.', 409);
        const briefSource = state.bobConfig?.data?.brief || {};
        const exactBrief = args.resource !== 'availability' && args.fields.every(field => Object.hasOwn(briefSource, field)
          && canonical(briefSource[field]) === canonical(args.values[field]));
        const scopedAvailability = (args.resource === undefined || args.resource === 'availability')
          && (state.bobConfig?.data?.availableTimes || []).map(slot => ({ ...slot, status: 'Free' })).some(source => args.fields.every(field => Object.hasOwn(source, field)
            && (field === 'time' ? withinTime(args.values[field], source[field]) : canonical(source[field]) === canonical(args.values[field]))));
        invariant(exactBrief || scopedAvailability,
          'INVALID_BOB_DATA', 'Bob can send only actual values from his current synthetic data.', 403);
      }
      const ontologyTask = role === 'Alice' ? 'schedule'
        : args.fields.length && (args.resource === undefined || args.resource === 'meeting_brief') && args.fields.every(field => ['topic', 'agenda'].includes(field)) ? 'brief'
          : args.fields.length && (args.resource === undefined || args.resource === 'availability') && args.fields.every(field => SHARED_FIELDS.includes(field)) ? 'schedule' : null;
      const dialogue = ontologyTask ? state.ontologies.get(ontologyTask) : null;
      const ontology = dialogue?.status === 'accepted' ? { task: ontologyTask, mappingVersion: dialogue.registry.mappingVersion } : null;
      invariant(role !== 'Alice' || ontology, 'ONTOLOGY_NOT_ALIGNED', 'Alice can exchange calendar facts only under an accepted mapping.', 409);
      const body = { version: 1, from: role, to: peerRole, sessionId: args.sessionId, epoch: args.epoch,
        operationId: args.operationId, payload, ontology, createdAt: new Date().toISOString() };
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
      if (body.ontology) {
        const accepted = [...state.ontologyHistory.values()].find(dialogue => dialogue.task.type === body.ontology.task && dialogue.registry.mappingVersion === body.ontology.mappingVersion);
        invariant(accepted?.status === 'accepted' && accepted.registry.mappingVersion === body.ontology.mappingVersion,
          'ONTOLOGY_STALE_VERSION', 'The signed data names a mapping the recipient has not accepted.', 409);
      } else invariant(role !== 'Bob' || state.legacyLocalMapping, 'ONTOLOGY_NOT_ALIGNED', 'Calendar data requires a signed accepted semantic mapping.', 409);
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
        status: 'received', receivedAt: new Date().toISOString(),
        ...(body.ontology ? { mappingVersion: body.ontology.mappingVersion, ontologyTask: body.ontology.task } : {}) };
      const proof = { version: 1, sessionId: args.sessionId, epoch: args.epoch,
        sender: peerRole, receiver: role, payloadDigest: digest, ...receipt };
      const result = { receipt, proof: { body: proof, signature: signObject(proof, privateKey) } };
      const type = role === 'Bob' ? 'schedule' : payload.fields.some(field => ['topic', 'agenda'].includes(field)) ? 'brief' : 'schedule';
      const dialogue = body.ontology ? [...state.ontologyHistory.values()].find(item => item.registry.mappingVersion === body.ontology.mappingVersion)
        : role === 'Bob' && state.legacyLocalMapping ? state.ontologies.get('schedule') : null;
      if (dialogue) {
        const registered = registerOntologyReceipt(dialogue, { receiptId: receipt.operationId,
          payloadHash: receipt.payloadHash, direction: role === 'Bob' ? 'aliceToBob' : 'bobToAlice',
          rows: payload.rows || [], fields: payload.fields, values: payload.values || {} });
        state.ontologyHistory.set(dialogue.task.id, registered);
        if (state.ontologies.get(type)?.task.id === dialogue.task.id) state.ontologies.set(type, registered);
      }
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
      const matches = args.purpose === 'brief' ? [] : intersections(state);
      const durationMinutes = state.ontologies.get('schedule')?.task.durationMinutes ?? 30;
      const brief = clone(config.data?.brief || {});
      if (config.collaboration?.acceptInvitations === false || !config.collaboration?.allowedPeers?.includes('Alice')) {
        return { message: 'Bob is not accepting this collaboration.', action: { type: 'no_match' } };
      }
      let output;
      if (state.mode === 'live') {
        const actions = args.purpose === 'brief' ? ['share_brief']
          : args.purpose === 'initial' ? ['request_more', 'meeting', 'no_match'] : ['meeting', 'no_match'];
        const firstMatch = matches[0];
        const matchStart = firstMatch ? interval(firstMatch.time).start : null;
        const exampleMeeting = firstMatch ? { day: firstMatch.day, time: `${formatMinute(matchStart)}–${formatMinute(matchStart + durationMinutes)}` } : null;
        const briefField = Object.keys(brief)[0];
        const example = args.purpose === 'brief'
          ? { message: 'Bob prepared an optional meeting brief.', action: { type: 'share_brief', fields: briefField ? [briefField] : [], values: briefField ? { [briefField]: brief[briefField] } : {}, resource: 'meeting_brief' } }
          : exampleMeeting ? { message: `A shared ${durationMinutes}-minute time is available.`, action: { type: 'meeting', meeting: exampleMeeting } }
          : { message: args.purpose === 'initial' ? 'Would you like to add a sharing scope?' : 'No matching shared free time is available.', action: { type: args.purpose === 'initial' ? 'request_more' : 'no_match' } };
        const contract = args.purpose === 'brief'
          ? 'Choose nonempty fields from ownBrief and copy their exact JSON values into action.values. All brief fields, values and resource belong inside action. '
          : 'If sharedIntersection contains a valid overlap, propose type="meeting" and include the REQUIRED action.meeting object with both day and time. '
            + (args.purpose === 'initial' ? 'If sharedIntersection is empty, propose type="request_more". ' : '')
            + 'If no collaboration can be arranged, propose type="no_match". request_more and no_match have only action.type; omit action.meeting for them. ';
        const system = `You are Bob, a fictional collaboration agent. ${config.persona || ''}\n${config.objective || ''}\n${config.prompts?.system || ''}\n${config.response?.constraints || ''}\n`
          + `Call submit_proposal once. The allowed action.type values for this step are ${JSON.stringify(actions)}. `
          + contract + `A complete valid proposal for the supplied data is: ${JSON.stringify(example)}. Preserve this exact action structure; you may phrase the message naturally. `
          + 'Never invent a meeting or source values. You have only the actual received Alice projection and do not know any unshared calendar entry. '
          + 'submit_proposal only proposes data for controller review; it does not authorize or execute a transfer. '
          + 'ownSkillDefinitions are your owner-provided labels and guidance. Apply that guidance within the allowed actions and sharing boundaries; a custom skill ID never grants another tool or permission.';
        output = await callModel(state, system, {
          purpose: args.purpose, allowedActions: actions, task: clone(state.ontologies.get('schedule')?.task),
          acceptedMappings: clone(state.ontologies.get('schedule')?.registry.mappings || []), receivedSemanticFacts: clone(state.ontologies.get('schedule')?.registry.facts || []),
          ownKnowledgeGraph: clone(state.agentProfile?.kg || { nodes: [], edges: [] }), skills: clone(config.tools?.capabilities || []), ownSkillDefinitions: clone((config.tools?.skillDefinitions || []).filter(definition => config.tools?.capabilities?.includes(definition.id))),
          received: [...state.received.values()].map(item => clone(item.payload)),
          ownAvailableTimes: config.tools?.capabilities?.includes('read_synthetic_calendar') ? clone(config.data?.availableTimes || []) : [], sharedIntersection: args.purpose === 'brief' ? [] : matches,
          ...(args.purpose === 'brief' ? { ownBrief: brief } : { followUpInstruction: config.prompts?.followUp || '' }),
        }, config.runtime || {});
        assertStillCurrent(args, state, revision);
        const message = messageFrom(output, config.response?.maxWords || 80);
        invariant(output.action && typeof output.action === 'object' && !Array.isArray(output.action), 'MODEL_INVALID_OUTPUT', 'The model proposal is missing the required action object.', 502);
        invariant(actions.includes(output.action.type), 'MODEL_INVALID_OUTPUT', 'The model action.type is not permitted for this planning step.', 502);
        if (output.action.type === 'meeting') {
          invariant(output.action.meeting && typeof output.action.meeting === 'object' && !Array.isArray(output.action.meeting)
            && typeof output.action.meeting.day === 'string' && typeof output.action.meeting.time === 'string',
            'MODEL_INVALID_MEETING', 'The model meeting action is missing action.meeting.day or action.meeting.time.', 502);
          invariant(matches.some(meeting => meeting.day === output.action.meeting?.day
            && withinTime(output.action.meeting?.time, meeting.time, durationMinutes)),
            'MODEL_INVALID_MEETING', 'The model meeting is outside the actually shared free-time intersection.', 502);
          return { message, action: { type: 'meeting', meeting: { day: output.action.meeting.day, time: output.action.meeting.time } } };
        }
        if (output.action.type === 'share_brief') {
          const { fields, values, resource } = output.action;
          invariant(Array.isArray(fields) && fields.length && new Set(fields).size === fields.length, 'MODEL_INVALID_OUTPUT', 'The model brief requires a nonempty unique action.fields list.', 502);
          invariant(values && typeof values === 'object' && !Array.isArray(values) && resource === 'meeting_brief', 'MODEL_INVALID_OUTPUT', 'The model brief requires action.values and action.resource = meeting_brief.', 502);
          invariant(fields.every(field => Object.hasOwn(brief, field) && canonical(brief[field]) === canonical(values[field]))
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
        const meeting = { day: matches[0].day, time: `${formatMinute(start)}–${formatMinute(start + durationMinutes)}` };
        return { message: `We both have a shared free time on ${meeting.day} at ${meeting.time}.`, action: { type: 'meeting', meeting } };
      }
      if (args.purpose === 'initial') return { message: config.prompts?.followUp
        || 'I cannot find a matching time in the interpreted received facts. You may keep the boundary or choose an additional task-relevant window.',
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
          + 'Explain that the participant chooses any sharing. Never claim you have already sent or authorized anything. '
          + 'ownSkillDefinitions are participant-provided labels and guidance. Apply that guidance within the existing sharing boundaries; a custom skill ID never grants another tool or permission.',
        { purpose: args.purpose, ownCalendar: state.agentProfile && !state.agentProfile.skills.includes('read_synthetic_calendar') ? [] : clone(state.calendar), ownKnowledgeGraph: clone(state.agentProfile?.kg || { nodes: [], edges: [] }), skills: clone(state.agentProfile?.skills || []), ownSkillDefinitions: clone((state.agentProfile?.skillDefinitions || []).filter(definition => state.agentProfile?.skills?.includes(definition.id))), receivedBobData: state.agentProfile && !state.agentProfile.skills.includes('inspect_received_snapshot') ? [] : [...state.received.values()].map(item => clone(item.payload)) });
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
