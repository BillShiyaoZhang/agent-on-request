import { WorkerClient, RemoteBobClient } from './runtime-client.mjs';
import { RuntimeError, invariant, canonical, hashPayload, verifyObject, validateSessionRef } from './runtime-helpers.mjs';
import { callHermesPlanner, callProvider } from './model-provider.mjs';
import { ontologyDefinitions, createOntologyDialogue, startOntologyDialogue, resolveOntologyDialogue } from './ontology-dialogue.mjs';

export { RuntimeError, hashPayload } from './runtime-helpers.mjs';

/** Controller-facing adapter. A plan is never a disclosure authorization. */
export function createRuntimeManager(options = {}) {
  const { hermes, peerTransport } = options;
  const hermesSettings = { timeoutSeconds: 45, retryLimit: 1 };
  let hermesReady = false;
  const legacySettings = { model: options.modelName ?? process.env.MODEL_NAME ?? '', temperature: 0.2,
    maxTokens: 4096, timeoutSeconds: (options.modelTimeoutMs ?? 20_000) / 1000, retryLimit: 0, thinking: 'disabled' };
  let models = { revision: 1, apiKey: options.modelApiKey ?? process.env.MODEL_API_KEY ?? '', config: {
    provider: 'openai_compatible', baseUrl: options.modelBaseUrl ?? process.env.MODEL_BASE_URL ?? '',
    agents: { Alice: { ...legacySettings }, Bob: { ...legacySettings } } } };
  let legacyMode = true;
  // Product rounds default to two local isolated workers. Remote pairing is an explicit compatibility option.
  const bobUrl = options.bobUrl;
  invariant(!bobUrl || (!hermes && !peerTransport), 'RUNTIME_CONFIG', 'The Hermes direct demo requires both local roles.');
  const bobToken = options.bobToken ?? process.env.BOB_TOKEN;
  const sessions = new Map();
  const retired = new Set();
  let alice, bob, aliceStatus, bobStatus;
  let started = false;
  let starting;
  let closed = false;
  let bobOnline = true;
  const key = ref => canonical([ref.sessionId, ref.epoch]);

  function session(args) {
    validateSessionRef(args);
    invariant(!closed, 'RUNTIME_CLOSED', 'The isolated runtime manager is closed.', 503);
    invariant(!retired.has(key(args)), 'STALE_EPOCH', 'The round has been evicted.', 409);
    const state = sessions.get(args.sessionId);
    invariant(state && state.epoch === args.epoch, 'STALE_EPOCH', 'This action does not belong to an active round.', 409);
    return state;
  }

  function requireBob() {
    // A failed HTTP request changes last-known status, but must not block an explicit reconnect attempt.
    invariant(bobOnline && bob && !bob.closed && (bobUrl || bob.online),
      'PEER_OFFLINE', 'Bob is disconnected. Restore Bob and retry the same operation explicitly.', 503);
  }

  function available(snapshot = models) {
    if (hermes) return hermesReady;
    return Boolean(snapshot.config.baseUrl && snapshot.config.agents.Alice.model && snapshot.config.agents.Bob.model
      && (snapshot.config.provider !== 'minimax_cn_token_plan' || snapshot.apiKey));
  }
  function modelInfo(snapshot = models) {
    if (hermes) return { revision: 1, provider: 'hermes', agents: {
      Alice: { model: 'Hermes Alice', ...hermesSettings }, Bob: { model: 'Hermes Bob', ...hermesSettings },
    }, disclosure: 'Live 由 Alice 和 Bob 各自的本机 Hermes profile 规划。两端的模型供应商可能收到该端用于规划的虚构数据。对端数据仅在字段授权并交付后用于规划。Hermes profile 可在本机保存运行记录。' };
    return { revision: snapshot.revision, provider: snapshot.config.provider, baseUrl: snapshot.config.baseUrl,
      agents: structuredClone(snapshot.config.agents),
      disclosure: `本轮 Alice 使用 ${snapshot.config.agents.Alice.model}，Bob 使用 ${snapshot.config.agents.Bob.model}，模型服务地址为 ${snapshot.config.baseUrl}。Live 会把虚构日历发给 Alice 的模型；Bob 的模型只收到实际授权传送给 Bob 的日历投影，以及 Bob 自己的模拟信息。服务商可能按照其政策处理和保留输入；模型错误会明确显示。` };
  }
  function sanitized(role) {
    if (hermes) return { name: `Hermes ${role}`, available: hermesReady, timeoutMs: hermesSettings.timeoutSeconds * 1000 };
    return { name: models.config.agents[role].model, available: available(), timeoutMs: models.config.agents[role].timeoutSeconds * 1000 };
  }
  function effectiveSettings(state, role, hints) {
    if (hermes) return hermesSettings;
    const settings = { ...state.models.config.agents[role] };
    if (state.legacyMode && role === 'Bob') {
      const legacy = hints ?? state.runtime;
      if (legacy?.model && legacy.model !== 'configured-default') settings.model = legacy.model;
      for (const name of ['temperature', 'timeoutSeconds', 'retryLimit']) if (legacy?.[name] !== undefined) settings[name] = legacy[name];
    }
    return settings;
  }
  function rpcTimeout(args, role) {
    const state = session(args);
    const settings = effectiveSettings(state, role);
    return Math.max(options.rpcTimeoutMs || 5000, settings.timeoutSeconds * 1000 * (1 + settings.retryLimit) + 3000);
  }
  async function broker(role, request) {
    const state = session(request);
    invariant(state.mode === 'live' && request.role === role && request.modelRevision === state.models.revision,
      'MODEL_INVALID_REQUEST', 'The model request does not match this active round.', 409);
    const settings = effectiveSettings(state, role, request.legacyRuntime);
    const result = hermes ? await callHermesPlanner(hermes, request, settings.timeoutSeconds * 1000)
      : await callProvider({ connection: { ...state.models.config, apiKey: state.models.apiKey },
        settings, system: request.system, context: request.context, signal: request.signal });
    session(request);
    return result;
  }

  function checkDispatch(ref, generation) {
    invariant(session(ref).dispatchGeneration === generation, 'PLANNING_CANCELLED', 'This peer operation was interrupted.', 409);
    requireBob();
  }

  async function deliverPeer(sender, recipient, method, ref, envelope, generation, operation) {
    if (!peerTransport) return recipient.call(method, { ...ref, envelope });
    checkDispatch(ref, generation);
    if (operation) {
      const previous = await recipient.call('verifyReceipt', operation);
      if (previous) return peerTransport.transfer(recipient.role, previous, { beforeSend: () => session(ref) });
    }
    const received = await peerTransport.transfer(sender.role, envelope, { beforeSend: () => {
      checkDispatch(ref, generation);
      invariant(operation?.expiresAt === undefined || operation.expiresAt > Date.now(),
        recipient.role === 'Bob' ? 'ALICE_AUTH_EXPIRED' : 'BOB_AUTH_EXPIRED', 'The exact authorization expired before direct transmission.', 403);
    } });
    session(ref);
    requireBob();
    const receipt = await recipient.call(method, { ...ref, envelope: received });
    return peerTransport.transfer(recipient.role, receipt, { beforeSend: () => session(ref) });
  }

  function checkedReceipt(result, envelope, recipient, identity) {
    const proof = result?.proof?.body;
    const receipt = result?.receipt;
    invariant(proof && receipt && verifyObject(proof, result.proof.signature, identity)
      && proof.version === 1 && proof.sessionId === envelope.body.sessionId && proof.epoch === envelope.body.epoch
      && proof.sender === envelope.body.from && proof.receiver === recipient
      && proof.operationId === envelope.body.operationId && proof.payloadHash === envelope.body.payload.payloadHash
      && proof.payloadDigest === hashPayload(envelope.body.payload) && proof.status === 'received'
      && (!envelope.body.ontology || proof.mappingVersion === envelope.body.ontology.mappingVersion && proof.ontologyTask === envelope.body.ontology.task)
      && canonical(receipt) === canonical({ operationId: proof.operationId, payloadHash: proof.payloadHash,
        status: proof.status, receivedAt: proof.receivedAt,
        ...(proof.mappingVersion ? { mappingVersion: proof.mappingVersion, ontologyTask: proof.ontologyTask } : {}) }),
    'INVALID_PEER_RECEIPT', 'The peer receipt could not be verified against the exact signed operation.', 401);
    return { receipt: structuredClone(receipt) };
  }

  const manager = {
    async configureModels(snapshot) {
      if (hermes) return modelInfo();
      invariant(snapshot?.config?.agents?.Alice && snapshot?.config?.agents?.Bob && Number.isSafeInteger(snapshot.revision),
        'MODEL_CONFIG', 'A valid model snapshot is required.');
      models = structuredClone(snapshot);
      legacyMode = false;
      if (started) await Promise.all([alice.call('configureModel', { ...sanitized('Alice'), model: sanitized('Alice').name }), bobUrl
        ? Promise.resolve() : bob.call('configureModel', { ...sanitized('Bob'), model: sanitized('Bob').name })]);
      return modelInfo();
    },
    modelInfo(ref) { return modelInfo(ref ? session(ref).models : models); },
    async start() {
      invariant(!closed, 'RUNTIME_CLOSED', 'The runtime manager is closed.', 503);
      if (started) return manager.status();
      if (starting) return starting;
      starting = (async () => {
        try {
          if (hermes) {
            await Promise.all(['Alice', 'Bob'].map(role => hermes.check({ role })));
            hermesReady = true;
          }
          await peerTransport?.start();
          alice = new WorkerClient('Alice', sanitized('Alice'), { onModelCall: request => broker('Alice', request) });
          bob = bobUrl ? new RemoteBobClient(bobUrl, bobToken) : new WorkerClient('Bob', sanitized('Bob'), { onModelCall: request => broker('Bob', request) });
          [aliceStatus, bobStatus] = await Promise.all([alice.start(), bob.start()]);
          started = true;
          return manager.status();
        } catch (error) {
          hermesReady = false;
          await Promise.allSettled([alice?.close(), bob?.close(), peerTransport?.close()]);
          throw error;
        } finally { starting = undefined; }
      })();
      return starting;
    },
    status() {
      const transport = peerTransport?.status();
      return {
        alice: { online: Boolean(started && !closed && alice?.online), role: 'Alice', transport: transport ? 'agent-comm-direct' : 'ipc', isolation: alice?.isolation, ...(aliceStatus?.pid ? { pid: aliceStatus.pid } : {}) },
        bob: { online: Boolean(started && !closed && bobOnline && bob?.online), role: 'Bob', transport: transport ? 'agent-comm-direct' : bobUrl ? 'http' : 'ipc', isolation: bob?.isolation, ...(bobStatus?.pid ? { pid: bobStatus.pid } : {}) },
        ...(transport ? { peerTransport: transport } : {}),
        live: {
          available: Boolean(available() && !closed && !bobUrl),
          model: available() ? modelInfo().agents.Alice.model : null,
          ...(hermes ? { harness: 'hermes' } : {}),
          models: modelInfo(), disclosure: modelInfo().disclosure,
        },
      };
    },
    async initialize(args) {
      validateSessionRef(args);
      await manager.start();
      invariant(!retired.has(key(args)), 'STALE_EPOCH', 'An evicted epoch cannot be reused.', 409);
      requireBob();
      const digest = hashPayload(args);
      const existing = sessions.get(args.sessionId);
      if (existing) {
        invariant(existing.epoch === args.epoch && existing.digest === digest,
          'INITIALIZATION_CONFLICT', 'The session already has different initialized data.', 409);
        return { ready: true, alice: { ready: true }, bob: { ready: true }, ontologyDialogue: structuredClone(existing.ontologyDialogue),
          protocol: [...existing.ontologyResults.values()].at(-1)?.protocol || [] };
      }
      const snapshot = structuredClone(models);
      const ontologyDialogue = args.mode === 'replay' ? null : args.ontologyDialogue ?? createOntologyDialogue({ mode: args.mode });
      const definitions = ontologyDefinitions({ scenario: ontologyDialogue?.scenario ?? 'distinct' });
      const ontologyContext = { scenario: ontologyDialogue?.scenario ?? 'distinct', task: ontologyDialogue?.task ?? { type: 'schedule', durationMinutes: 30 } };
      const common = { sessionId: args.sessionId, epoch: args.epoch, mode: args.mode, configRevision: args.configRevision,
        modelRevision: snapshot.revision, modelAvailable: available(snapshot) };
      const roleSettings = role => hermes ? { modelSettings: hermesSettings }
        : !legacyMode ? { modelSettings: snapshot.config.agents[role] } : {};
      try {
        const [a, b] = await Promise.all([
          alice.call('initialize', { ...common, ontologyContext, ownOntology: args.ownOntology?.Alice ?? definitions.Alice,
            ...roleSettings('Alice'), aliceData: args.aliceData, ...(args.aliceProfile ? { agentProfile: args.aliceProfile } : {}), peerPublicKey: bob.identity }),
          bob.call('initialize', { ...common, ontologyContext, ownOntology: args.ownOntology?.Bob ?? definitions.Bob,
            ...roleSettings('Bob'), bobConfig: args.bobConfig, ...(args.bobProfile ? { agentProfile: args.bobProfile } : {}), peerPublicKey: alice.identity }),
        ]);
        sessions.set(args.sessionId, { epoch: args.epoch, mode: args.mode, digest,
          configRevision: args.configRevision, runtime: structuredClone(args.bobConfig?.runtime || {}), models: snapshot, legacyMode,
          dispatchGeneration: 0, negotiationRevision: 0, ontologyResults: new Map(), ontologyDialogue });
        const negotiated = args.mode === 'replay' || args.alignReview ? { dialogue: ontologyDialogue, protocol: [] }
          : await manager.negotiateOntology({ ...common, dialogue: ontologyDialogue, liveProposal: false });
        return { ready: true, alice: a, bob: b, models: modelInfo(snapshot), ontologyDialogue: negotiated.dialogue, protocol: negotiated.protocol };
      } catch (error) {
        await Promise.allSettled([alice.call('clear', common), bob.call('clear', common)]);
        retired.add(key(args));
        throw error;
      }
    },
    async projectAlice(args) {
      session(args);
      return alice.call('projectAlice', args);
    },
    async negotiateOntology(args) {
      const state = session(args);
      const generation = state.dispatchGeneration;
      requireBob();
      const dialogue = args.dialogue;
      invariant(dialogue && ['accepted', 'rejected'].includes(dialogue.status), 'ONTOLOGY_CLARIFICATION_REQUIRED', 'Resolve the owner interpretation before publishing the working ontology.', 409);
      const roundId = hashPayload({ scenario: dialogue.scenario, task: dialogue.task, ontologyVersions: dialogue.ontologyVersions,
        interpretation: dialogue.interpretation, status: dialogue.status, mappings: dialogue.proposal.mappings,
        selector: args.liveProposal === true && state.mode === 'live' ? 'live' : 'guided' });
      if (state.ontologyResults.has(roundId)) return structuredClone(state.ontologyResults.get(roundId));
      invariant(!state.negotiating, 'ONTOLOGY_PROTOCOL_BUSY', 'An ontology dialogue is already running for this round.', 409);
      state.negotiating = true;
      const roundRevision = ++state.negotiationRevision;
      const context = { scenario: dialogue.scenario, task: dialogue.task };
      const ref = { sessionId: args.sessionId, epoch: args.epoch, roundId, roundRevision, ontologyContext: context };
      const protocol = [];
      let sequence = 0, previousHash = null;
      async function exchange(sender, recipient, method, extra = {}) {
        if (peerTransport) checkDispatch(ref, generation);
        const expectedSequence = ++sequence;
        const result = await sender.call(method, { ...ref, sequence: expectedSequence, previousHash, ...extra }, rpcTimeout(args, sender.role));
        session(args);
        const envelope = result?.envelope, body = envelope?.body;
        invariant(body && verifyObject(body, envelope.signature, sender.identity) && body.channel === 'ontology'
          && body.from === sender.role && body.to === recipient.role && body.sessionId === args.sessionId && body.epoch === args.epoch
          && body.roundId === roundId && body.roundRevision === roundRevision && body.sequence === expectedSequence
          && body.previousHash === previousHash && body.payloadHash === hashPayload(body.payload),
          'ONTOLOGY_PROTOCOL', 'The isolated worker did not sign the expected ordered ontology move.', 401);
        const receipt = await deliverPeer(sender, recipient, 'receiveOntology', ref, envelope, generation);
        session(args);
        const proof = receipt?.proof?.body;
        invariant(proof && verifyObject(proof, receipt.proof.signature, recipient.identity)
          && proof.channel === 'ontology_receipt' && proof.from === recipient.role && proof.to === sender.role
          && proof.sessionId === args.sessionId && proof.epoch === args.epoch && proof.roundId === roundId
          && proof.roundRevision === roundRevision && proof.sequence === expectedSequence && proof.envelopeHash === hashPayload(body)
          && proof.status === 'received', 'ONTOLOGY_PROTOCOL', 'The recipient did not acknowledge the signed ontology move.', 401);
        protocol.push({ ...structuredClone(body), signature: envelope.signature, publicKey: sender.identity,
          receipt: structuredClone(receipt.proof), recipientPublicKey: recipient.identity, verified: true });
        previousHash = hashPayload(body);
        return result;
      }
      try {
        await exchange(alice, bob, 'ontologyModule', { authorized: true });
        await exchange(bob, alice, 'ontologyModule', { authorized: true });
        await exchange(alice, bob, 'proposeOntology', { interpretation: dialogue.interpretation, decision: dialogue.status,
          liveProposal: args.liveProposal === true && state.mode === 'live' });
        const decision = await exchange(bob, alice, 'decideOntology', { liveProposal: args.liveProposal === true && state.mode === 'live' });
        await exchange(alice, bob, 'acknowledgeOntology');
        await exchange(bob, alice, 'acknowledgeOntology');
        if (peerTransport) checkDispatch(ref, generation);
        const resultDialogue = decision.selection.decision === 'accepted' ? structuredClone(dialogue)
          : dialogue.status === 'rejected' ? structuredClone(dialogue)
            : resolveOntologyDialogue(startOntologyDialogue({ ...context, mode: state.mode }), { decision: 'reject' });
        resultDialogue.proposal.source = protocol[2].payload.selector === 'live' ? 'model' : 'guided';
        await Promise.all([alice.call('updateOntology', { ...ref, dialogue: resultDialogue }), bob.call('updateOntology', { ...ref, dialogue: resultDialogue })]);
        session(args);
        const result = { dialogue: resultDialogue, protocol,
          selection: { proposer: protocol[2].payload.selector, decider: protocol[3].payload.selector, decision: resultDialogue.status } };
        state.ontologyResults.set(roundId, structuredClone(result));
        state.ontologyDialogue = resultDialogue;
        return result;
      } finally { state.negotiating = false; }
    },
    async updateOntology(args) {
      const state = session(args);
      const registered = [...state.ontologyResults.values()].find(result => result.dialogue.registry.mappingVersion === args.dialogue?.registry.mappingVersion
        && result.dialogue.task.id === args.dialogue?.task.id && result.dialogue.status === args.dialogue?.status);
      invariant(registered, 'ONTOLOGY_NOT_ACKNOWLEDGED', 'Only a dialogue actually acknowledged by both workers can be updated.', 409);
      const move = registered.protocol.at(-1);
      const ref = { sessionId: args.sessionId, epoch: args.epoch, roundId: move.roundId, roundRevision: move.roundRevision, dialogue: args.dialogue };
      const result = await Promise.all([alice.call('updateOntology', ref), bob.call('updateOntology', ref)]);
      session(args);
      return { ready: true, alice: result[0], bob: result[1] };
    },
    async ontologyStatus(args) {
      session(args);
      const [a, b] = await Promise.all([alice.call('ontologyStatus', args), bob.call('ontologyStatus', args)]);
      return { Alice: a, Bob: b };
    },
    async deliverToBob(args) {
      const generation = session(args).dispatchGeneration;
      requireBob();
      const { envelope } = await alice.call('prepareOutgoing', args);
      const result = await deliverPeer(alice, bob, 'receive', { sessionId: args.sessionId, epoch: args.epoch }, envelope, generation, args);
      session(args);
      return checkedReceipt(result, envelope, 'Bob', bob.identity);
    },
    async planBob(args) {
      session(args);
      requireBob();
      const result = await bob.call('planBob', args, rpcTimeout(args, 'Bob'));
      session(args);
      return result;
    },
    async planAlice(args) {
      session(args);
      const result = await alice.call('planAlice', args, rpcTimeout(args, 'Alice'));
      session(args);
      return result;
    },
    async deliverToAlice(args) {
      const generation = session(args).dispatchGeneration;
      requireBob();
      const { envelope } = await bob.call('prepareOutgoing', args);
      invariant(verifyObject(envelope.body, envelope.signature, bob.identity), 'INVALID_PEER_SIGNATURE', 'Bob did not sign the proposed outgoing payload.', 401);
      const result = await deliverPeer(bob, alice, 'receive', { sessionId: args.sessionId, epoch: args.epoch }, envelope, generation, args);
      session(args);
      return checkedReceipt(result, envelope, 'Alice', alice.identity);
    },
    async verifyReceipt(args) {
      session(args);
      invariant(args.direction === 'bob' || args.direction === 'alice', 'INVALID_DIRECTION', 'Choose the exact receipt recipient.');
      const toBob = args.direction === 'bob';
      if (toBob) requireBob();
      const recipient = toBob ? bob : alice;
      const result = await recipient.call('verifyReceipt', args);
      session(args);
      if (result === null) return null;
      const payload = toBob
        ? { rows: args.rows, fields: args.fields, window: args.window, payloadHash: args.payloadHash }
        : { fields: args.fields, values: args.values, payloadHash: args.payloadHash };
      const expected = { body: { sessionId: args.sessionId, epoch: args.epoch, operationId: args.operationId,
        from: toBob ? 'Alice' : 'Bob', to: toBob ? 'Bob' : 'Alice', payload } };
      if (result.proof?.body?.mappingVersion) {
        const state = session(args), proof = result.proof.body;
        invariant([...state.ontologyResults.values()].some(item => item.dialogue.status === 'accepted'
          && item.dialogue.task.type === proof.ontologyTask && item.dialogue.registry.mappingVersion === proof.mappingVersion),
          'ONTOLOGY_STALE_VERSION', 'The receipt names a semantic mapping not accepted by this manager.', 409);
        expected.body.ontology = { task: proof.ontologyTask, mappingVersion: proof.mappingVersion };
      }
      return checkedReceipt(result, expected, toBob ? 'Bob' : 'Alice', recipient.identity);
    },
    async updateBob(args) {
      const state = session(args);
      requireBob();
      const result = await bob.call('updateBob', args);
      session(args);
      state.configRevision = args.configRevision;
      state.runtime = structuredClone(args.bobConfig?.runtime || {});
      return result;
    },
    async cancelPlanning(args, roles = ['Alice', 'Bob']) {
      const state = session(args);
      invariant(Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length
        && roles.every(role => ['Alice', 'Bob'].includes(role)), 'INVALID_ROLES', 'Choose Alice, Bob, or both planning runtimes.');
      state.dispatchGeneration++;
      // Cancellation bypasses simulated peer disconnection and never removes receipts or outgoing operations.
      const results = await Promise.all(roles.map(role => (role === 'Alice' ? alice : bob).call('cancelPlanning', args)));
      return { cancelled: true, roles: structuredClone(roles), results };
    },
    async clear(args) {
      validateSessionRef(args);
      if (!started) return { cleared: true };
      const state = sessions.get(args.sessionId);
      invariant(!state || state.epoch === args.epoch, 'STALE_EPOCH', 'Cannot evict a different active epoch.', 409);
      retired.add(key(args));
      sessions.delete(args.sessionId);
      // Cleanup bypasses simulated disconnection, but actual remote errors remain explicit.
      const results = await Promise.allSettled([alice.call('clear', args), bob.call('clear', args)]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return { cleared: true, alice: results[0].value, bob: results[1].value };
    },
    async setBobOnline(online) {
      invariant(typeof online === 'boolean', 'INVALID_ONLINE_STATE', 'Bob connection state must be boolean.');
      bobOnline = online;
      return manager.status();
    },
    async close() {
      if (closed) return;
      if (starting) await starting.catch(() => {});
      if (started) {
        const refs = [...sessions].map(([sessionId, state]) => ({ sessionId, epoch: state.epoch }));
        await Promise.allSettled(refs.map(ref => manager.clear(ref)));
      }
      closed = true;
      hermesReady = false;
      sessions.clear();
      retired.clear();
      await Promise.allSettled([alice?.close(), bob?.close(), peerTransport?.close()]);
      started = false;
    },
  };
  return manager;
}
