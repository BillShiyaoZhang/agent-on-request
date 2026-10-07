import { WorkerClient, RemoteBobClient } from './runtime-client.mjs';
import { RuntimeError, invariant, canonical, hashPayload, verifyObject, validateSessionRef } from './runtime-helpers.mjs';
import { callProvider } from './model-provider.mjs';

export { RuntimeError, hashPayload } from './runtime-helpers.mjs';

/** Controller-facing adapter. A plan is never a disclosure authorization. */
export function createRuntimeManager(options = {}) {
  const legacySettings = { model: options.modelName ?? process.env.MODEL_NAME ?? '', temperature: 0.2,
    maxTokens: 4096, timeoutSeconds: (options.modelTimeoutMs ?? 20_000) / 1000, retryLimit: 0, thinking: 'disabled' };
  let models = { revision: 1, apiKey: options.modelApiKey ?? process.env.MODEL_API_KEY ?? '', config: {
    provider: 'openai_compatible', baseUrl: options.modelBaseUrl ?? process.env.MODEL_BASE_URL ?? '',
    agents: { Alice: { ...legacySettings }, Bob: { ...legacySettings } } } };
  let legacyMode = true;
  // Product rounds default to two local isolated workers. Remote pairing is an explicit compatibility option.
  const bobUrl = options.bobUrl;
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
    return Boolean(snapshot.config.baseUrl && snapshot.config.agents.Alice.model && snapshot.config.agents.Bob.model
      && (snapshot.config.provider !== 'minimax_cn_token_plan' || snapshot.apiKey));
  }
  function modelInfo(snapshot = models) {
    return { revision: snapshot.revision, provider: snapshot.config.provider, baseUrl: snapshot.config.baseUrl,
      agents: structuredClone(snapshot.config.agents),
      disclosure: `本轮 Alice 使用 ${snapshot.config.agents.Alice.model}，Bob 使用 ${snapshot.config.agents.Bob.model}，模型服务地址为 ${snapshot.config.baseUrl}。Live 会把虚构日历发给 Alice 的模型；Bob 的模型只收到实际授权传送给 Bob 的日历投影，以及 Bob 自己的模拟信息。服务商可能按照其政策处理和保留输入；模型错误会明确显示。` };
  }
  function sanitized(role) {
    return { name: models.config.agents[role].model, available: available(), timeoutMs: models.config.agents[role].timeoutSeconds * 1000 };
  }
  function effectiveSettings(state, role, hints) {
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
    const result = await callProvider({ connection: { ...state.models.config, apiKey: state.models.apiKey },
      settings: effectiveSettings(state, role, request.legacyRuntime), system: request.system, context: request.context, signal: request.signal });
    session(request);
    return result;
  }

  function checkedReceipt(result, envelope, recipient, identity) {
    const proof = result?.proof?.body;
    const receipt = result?.receipt;
    invariant(proof && receipt && verifyObject(proof, result.proof.signature, identity)
      && proof.version === 1 && proof.sessionId === envelope.body.sessionId && proof.epoch === envelope.body.epoch
      && proof.sender === envelope.body.from && proof.receiver === recipient
      && proof.operationId === envelope.body.operationId && proof.payloadHash === envelope.body.payload.payloadHash
      && proof.payloadDigest === hashPayload(envelope.body.payload) && proof.status === 'received'
      && canonical(receipt) === canonical({ operationId: proof.operationId, payloadHash: proof.payloadHash,
        status: proof.status, receivedAt: proof.receivedAt }),
    'INVALID_PEER_RECEIPT', 'The peer receipt could not be verified against the exact signed operation.', 401);
    return { receipt: structuredClone(receipt) };
  }

  const manager = {
    async configureModels(snapshot) {
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
          alice = new WorkerClient('Alice', sanitized('Alice'), { onModelCall: request => broker('Alice', request) });
          bob = bobUrl ? new RemoteBobClient(bobUrl, bobToken) : new WorkerClient('Bob', sanitized('Bob'), { onModelCall: request => broker('Bob', request) });
          [aliceStatus, bobStatus] = await Promise.all([alice.start(), bob.start()]);
          started = true;
          return manager.status();
        } catch (error) {
          await Promise.allSettled([alice?.close(), bob?.close()]);
          throw error;
        } finally { starting = undefined; }
      })();
      return starting;
    },
    status() {
      return {
        alice: { online: Boolean(started && !closed && alice?.online), role: 'Alice', transport: 'ipc', isolation: alice?.isolation, ...(aliceStatus?.pid ? { pid: aliceStatus.pid } : {}) },
        bob: { online: Boolean(started && !closed && bobOnline && bob?.online), role: 'Bob', transport: bobUrl ? 'http' : 'ipc', isolation: bob?.isolation, ...(bobStatus?.pid ? { pid: bobStatus.pid } : {}) },
        live: {
          available: Boolean(available() && !closed && !bobUrl),
          model: available() ? models.config.agents.Alice.model : null,
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
        return { ready: true, alice: { ready: true }, bob: { ready: true } };
      }
      const snapshot = structuredClone(models);
      const common = { sessionId: args.sessionId, epoch: args.epoch, mode: args.mode, configRevision: args.configRevision,
        modelRevision: snapshot.revision, modelAvailable: available(snapshot) };
      try {
        const [a, b] = await Promise.all([
          alice.call('initialize', { ...common, ...(!legacyMode ? { modelSettings: snapshot.config.agents.Alice } : {}), aliceData: args.aliceData, peerPublicKey: bob.identity }),
          bob.call('initialize', { ...common, ...(!legacyMode ? { modelSettings: snapshot.config.agents.Bob } : {}), bobConfig: args.bobConfig, peerPublicKey: alice.identity }),
        ]);
        sessions.set(args.sessionId, { epoch: args.epoch, mode: args.mode, digest,
          configRevision: args.configRevision, runtime: structuredClone(args.bobConfig?.runtime || {}), models: snapshot, legacyMode });
        return { ready: true, alice: a, bob: b, models: modelInfo(snapshot) };
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
    async deliverToBob(args) {
      session(args);
      requireBob();
      const { envelope } = await alice.call('prepareOutgoing', args);
      const result = await bob.call('receive', { sessionId: args.sessionId, epoch: args.epoch, envelope });
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
      session(args);
      requireBob();
      const { envelope } = await bob.call('prepareOutgoing', args);
      invariant(verifyObject(envelope.body, envelope.signature, bob.identity), 'INVALID_PEER_SIGNATURE', 'Bob did not sign the proposed outgoing payload.', 401);
      const result = await alice.call('receive', { sessionId: args.sessionId, epoch: args.epoch, envelope });
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
      session(args);
      invariant(Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length
        && roles.every(role => ['Alice', 'Bob'].includes(role)), 'INVALID_ROLES', 'Choose Alice, Bob, or both planning runtimes.');
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
      sessions.clear();
      retired.clear();
      await Promise.allSettled([alice?.close(), bob?.close()]);
      started = false;
    },
  };
  return manager;
}
