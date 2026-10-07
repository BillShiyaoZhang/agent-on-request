import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { clone, hashValue, validateConfig, diffConfig } from './config.mjs';
import { AppError, requireThat } from './errors.mjs';
import { ALICE_CALENDAR, REPLAY_STEPS, SCENARIO_VERSION } from './scenario.mjs';

const tokenHash = token => createHash('sha256').update(String(token)).digest();
const now = () => new Date().toISOString();
const INITIAL = new Set(['free', 'busy', 'full', 'none']);
const ADDITIONAL = new Set(['keep', 'narrow', 'week']);
const PUBLIC_WAIT = { admin: 'Bob’s owner needs to decide whether to share this exact content.', peer_offline: 'Bob has not confirmed receipt. Restore the connection, then explicitly retry the same operation.', model_timeout: 'Agent planning did not finish. Received snapshots remain; researcher intervention is needed.', configuration_changed: 'Bob’s configuration changed in this round. Recheck the policy before resuming.', researcher: 'The researcher paused this round.' };

export class SessionEngine {
  constructor({ runtime, profiles, research, maxSessions = 100, sessionTtlMs = 2 * 60 * 60 * 1000 }) {
    this.runtime = runtime;
    this.profiles = profiles;
    this.research = research;
    this.sessions = new Map();
    this.epoch = 0;
    this.cleanupPending = new Map();
    this.maxSessions = maxSessions;
    this.sessionTtlMs = sessionTtlMs;
  }
  get(id) {
    const session = this.sessions.get(id);
    requireThat(session, 'SESSION_GONE', 'This round was reset or expired. Start a new round.', 404);
    return session;
  }
  authorize(id, token) {
    const session = this.get(id);
    requireThat(typeof token === 'string' && timingSafeEqual(tokenHash(token), session.tokenHash), 'UNAUTHORIZED', 'The participant credential is invalid.', 401);
    return session;
  }
  lock(session, operation) {
    const result = session.queue.then(async () => {
      requireThat(this.sessions.get(session.id) === session, 'SESSION_GONE', 'This round has ended or been reset.', 409);
      return operation();
    });
    session.queue = result.catch(() => {});
    return result;
  }
  planningCurrent(session, generation) {
    return this.sessions.get(session.id) === session && session.interruptGeneration === generation && !session.ended && !session.paused;
  }
  confirmedMeeting(session) {
    const meeting = session.preparedMeeting;
    return meeting && session.receipts.bobToAlice.some(receipt => ['day', 'time', 'status'].every(field => receipt.fields.includes(field))
      && receipt.values.day === meeting.day && receipt.values.time === meeting.time && receipt.values.status === 'Free')
      ? clone(meeting) : null;
  }
  interruptPlanning(session, reason) {
    requireThat(this.sessions.get(session.id) === session, 'SESSION_GONE', 'This round has ended or been reset.', 409);
    session.interruptGeneration++;
    session.version++;
    if (reason === 'pause' || reason === 'configuration_changed') {
      session.savedStage ??= session.stage;
      session.paused = true; session.stage = 'paused';
      const waiting = reason === 'pause' ? 'researcher' : 'configuration_changed';
      session.waiting = { reason: waiting, message: PUBLIC_WAIT[waiting] };
    } else if (reason === 'revoke') {
      session.stopped = true; session.continuation = null;
      if (session.pendingDelivery?.direction === 'bob') session.pendingDelivery = null;
    } else {
      session.ended = true; session.stopped = true; session.paused = false;
      session.stage = 'complete'; session.waiting = null; session.continuation = null; session.pendingDelivery = null;
      session.approvals.forEach(item => { if (item.status === 'pending') item.status = 'cancelled'; });
    }
    // Start cancellation before waiting for the queue occupied by the model call.
    // Even if the worker is unavailable, the generation prevents its late proposal from committing.
    return (async () => {
      try { return await this.runtime.cancelPlanning?.({ sessionId: session.id, epoch: session.epoch }); }
      catch { return { cancelled: false }; }
    })();
  }
  message(session, from, text, kind = 'status') {
    session.messages.push({ from, text, kind, at: now() });
    if (session.messages.length > 100) session.messages.shift();
  }
  async event(session, kind, data = {}) { await this.research.append(session, { kind, ...data }); }
  view(session) {
    const status = this.runtime.status();
    return clone({
      session: { id: session.id, epoch: session.epoch, version: session.version, stage: session.stage, mode: session.mode, modelRevision: session.models?.revision ?? null, researchConsent: session.researchConsent, consentVersion: session.consentVersion, startedAt: session.startedAt, ended: session.ended, paused: session.paused },
      alice: { calendar: ALICE_CALENDAR, stopped: session.stopped },
      bob: { name: 'Bob', configRevision: session.configRevision, templateRevision: session.templateRevision, online: status.bob.online },
      choices: session.choices, receipts: session.receipts, messages: session.messages,
      pendingApprovals: session.approvals.filter(item => item.status === 'pending').map(item => ({ id: item.id, owner: 'Bob', summary: item.summary, status: item.status })),
      waiting: session.waiting, task: session.task, runtime: { alice: status.alice, bob: status.bob }, replay: session.replay,
      answers: session.answers, models: session.models ?? null
    });
  }
  async create({ mode = 'controlled', researchConsent = false, previousSessionId, previousToken } = {}) {
    requireThat(['controlled', 'live', 'replay'].includes(mode), 'MODE', 'Choose a valid run mode.');
    requireThat(typeof researchConsent === 'boolean', 'CONSENT', 'Research consent must be an explicit boolean.');
    requireThat(mode !== 'live' || this.runtime.status().live.available, 'LIVE_UNAVAILABLE', 'A model provider is not configured.', 409);
    for (const [id, ref] of this.cleanupPending) {
      try { await this.runtime.clear(ref); this.cleanupPending.delete(id); }
      catch { throw new AppError('CLEANUP_PENDING', 'Remote cleanup of the previous Bob context is unconfirmed. Restore Bob before starting a new round.', 503); }
    }
    if (previousSessionId) {
      const previous = this.authorize(previousSessionId, previousToken);
      const cancelled = this.interruptPlanning(previous, 'reset');
      await this.lock(previous, async () => { await cancelled; await this.remove(previous); });
    }
    for (const old of [...this.sessions.values()]) if (Date.now() - Date.parse(old.startedAt) > this.sessionTtlMs) await this.expire(old);
    requireThat(this.sessions.size < this.maxSessions, 'CAPACITY', 'Session capacity reached. Ask the researcher to close idle sessions.', 503);
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: randomUUID(), epoch: ++this.epoch, tokenHash: tokenHash(token), version: 1,
      mode, researchConsent: mode === 'replay' ? false : researchConsent, consentVersion: 'research-v1', scenarioVersion: SCENARIO_VERSION,
      startedAt: now(), ended: false, paused: false, stopped: false, stage: mode === 'replay' ? 'replay' : 'initial',
      config: clone(this.profiles.template), configRevision: this.profiles.templateRevision, templateRevision: this.profiles.templateRevision,
      choices: { initial: null, additional: null }, receipts: { aliceToBob: [], bobToAlice: [] }, messages: [], waiting: null,
      task: { outcome: null, meeting: null }, approvals: [], grants: [], policyUses: 0, answers: {}, queue: Promise.resolve(), requests: new Map(),
      inflightRequests: new Map(), interruptGeneration: 0,
      pendingDelivery: null, continuation: null, savedStage: null, preparedMeeting: null, requestSequence: 0,
      replay: mode === 'replay' ? { source: 'synthetic-reference-v1', index: 0, total: REPLAY_STEPS.length, steps: REPLAY_STEPS } : null
    };
    const initialized = await this.runtime.initialize({ sessionId: session.id, epoch: session.epoch, mode, aliceData: clone(ALICE_CALENDAR), bobConfig: session.config, configRevision: session.configRevision });
    session.models = initialized?.models ?? this.runtime.modelInfo?.({ sessionId: session.id, epoch: session.epoch }) ?? null;
    this.sessions.set(session.id, session);
    try {
      if (session.researchConsent && this.profiles.persist) await this.profiles.mutate(() => undefined);
      await this.research.start(session);
    }
    catch (error) { this.sessions.delete(session.id); await this.runtime.clear({ sessionId: session.id, epoch: session.epoch }); throw error; }
    this.message(session, 'system', mode === 'replay' ? 'This is a synthetic reference replay. It produces no actual messages or research records.' : 'Alice and Bob are ready. All calendar data is fictional. Choose a sharing scope first.');
    if (mode === 'live') { session.continuation = 'intro'; await this.continuePlan(session); }
    return { token, state: this.view(session) };
  }
  async expire(session) {
    if (this.sessions.get(session.id) !== session || Date.now() - Date.parse(session.startedAt) <= this.sessionTtlMs) return { expired: false };
    const cancelled = this.interruptPlanning(session, 'expire');
    await this.lock(session, async () => { await cancelled; await this.remove(session); });
    return { expired: true };
  }
  async remove(session) {
    let cleared;
    try { cleared = await this.clearContexts(session); }
    finally {
      this.sessions.delete(session.id);
      session.approvals.forEach(item => { if (item.status === 'pending') item.status = 'superseded'; });
      await this.research.finish(session, session.task.outcome ?? 'incomplete', cleared ? [] : ['cleanup_uncertain']);
    }
    requireThat(cleared, 'CLEANUP_PENDING', 'Local credentials were revoked. Bob’s remote cleanup is unconfirmed; restore Bob before starting a new round.', 503);
  }
  async clearContexts(session) {
    const ref = { sessionId: session.id, epoch: session.epoch };
    try { await this.runtime.clear(ref); this.cleanupPending.delete(session.id); return true; }
    catch {
      this.cleanupPending.set(session.id, ref);
      await this.event(session, 'technical', { code: 'CLEANUP_PENDING', reason: 'remote_cleanup_unconfirmed' });
      return false;
    }
  }
  list() {
    return { sessions: [...this.sessions.values()].map(session => ({ id: session.id, epoch: session.epoch, stage: session.stage, mode: session.mode, modelRevision: session.models?.revision ?? null, researchConsent: session.researchConsent, configRevision: session.configRevision, pendingCount: session.approvals.filter(item => item.status === 'pending').length, startedAt: session.startedAt })), runtime: this.runtime.status() };
  }
  configView(sessionId) {
    const session = sessionId ? this.get(sessionId) : null;
    return { template: clone(this.profiles.template), templateRevision: this.profiles.templateRevision, active: session ? clone(session.config) : null, activeRevision: session?.configRevision ?? null, profiles: this.profiles.list(), versions: this.profiles.listVersions() };
  }
  validate(config, sessionId) {
    const validation = validateConfig(config);
    return { ...validation, diff: validation.valid ? diffConfig(sessionId ? this.get(sessionId).config : this.profiles.template, config) : [] };
  }
  async applyConfig({ config, target, sessionId, expectedRevision }) {
    const validation = validateConfig(config);
    requireThat(validation.valid, 'CONFIG_INVALID', 'Configuration validation failed.', 422, validation.errors);
    requireThat(['template', 'session'].includes(target), 'CONFIG_TARGET', 'Choose a next-round template or a current-round override.');
    if (target === 'template') {
      await this.profiles.applyTemplate(config, expectedRevision);
      return this.configView(sessionId);
    }
    const session = this.get(sessionId);
    const reviewedConfig = clone(config);
    requireThat(!session.ended && session.mode !== 'replay', 'CONFIG_SESSION', 'This session cannot accept a current-round configuration.', 409);
    requireThat(expectedRevision === session.configRevision, 'STALE_CONFIG', 'The active configuration changed. Review the difference again.', 409);
    const digest = hashValue({ config: reviewedConfig, expectedRevision });
    if (session.configApply) {
      requireThat(session.configApply.digest === digest, 'STALE_CONFIG', 'Another current-round configuration is being applied.', 409);
      return session.configApply.promise;
    }
    const cancelled = this.interruptPlanning(session, 'configuration_changed');
    const applying = { digest };
    session.configApply = applying;
    const result = this.lock(session, async () => {
      await cancelled;
      requireThat(!session.ended && session.mode !== 'replay', 'CONFIG_SESSION', 'This session cannot accept a current-round configuration.', 409);
      requireThat(expectedRevision === session.configRevision, 'STALE_CONFIG', 'The active configuration changed. Review the difference again.', 409);
      const revision = await this.profiles.nextRevision(reviewedConfig);
      requireThat(!session.ended, 'ENDED', 'This round has ended.', 409);
      await this.runtime.updateBob({ sessionId: session.id, epoch: session.epoch, bobConfig: reviewedConfig, configRevision: revision });
      requireThat(!session.ended, 'ENDED', 'This round has ended.', 409);
      session.config = reviewedConfig; session.configRevision = revision; session.policyUses = 0; session.grants = [];
      session.savedStage = session.savedStage ?? session.stage;
      session.approvals.forEach(item => { if (item.status === 'pending') item.status = 'superseded'; });
      session.paused = true; session.stage = 'paused'; session.waiting = { reason: 'configuration_changed', message: PUBLIC_WAIT.configuration_changed }; session.version++;
      this.message(session, 'system', 'The researcher updated Bob’s active configuration. Delivered snapshots remain; unexecuted replies will be rechecked.');
      await this.event(session, 'config_changed', { configRevision: revision, actor: 'admin' });
      return { ...this.configView(sessionId), state: this.view(session) };
    });
    applying.promise = result;
    try { return await result; }
    finally { if (session.configApply === applying) session.configApply = null; }
  }
  async projection(session, stage, choice) {
    requireThat((stage === 'initial' ? INITIAL : stage === 'additional' ? ADDITIONAL : new Set()).has(choice), 'CHOICE', 'Choose a valid sharing scope.');
    if (choice === 'none' || choice === 'keep') return { rows: [], fields: [], window: 'none' };
    return this.runtime.projectAlice({ sessionId: session.id, epoch: session.epoch, stage, choice });
  }
  async preview(session, { stage, choice }) {
    return this.lock(session, async () => {
      requireThat(session.mode !== 'replay' && !session.ended && !session.paused && session.stage === stage, 'STALE_STAGE', 'The current step changed.', 409);
      const payload = await this.projection(session, stage, choice);
      return { ...payload, payloadHash: hashValue(payload), recipient: 'Bob', sessionVersion: session.version };
    });
  }
  async action(session, input) {
    input = clone(input);
    const type = input.action;
    let accepted;
    let cancelled;
    let inflight;
    if (type === 'end' || type === 'stop_sharing') {
      // HTTP authentication happens before this method. Validate the complete restrictive intent before preempting.
      requireThat(this.sessions.get(session.id) === session, 'SESSION_GONE', 'This round has ended or been reset.', 409);
      requireThat(typeof input.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.requestId), 'REQUEST_ID', 'A submission needs a stable request ID.');
      const digest = hashValue(input);
      const prior = session.requests.get(input.requestId) ?? session.inflightRequests.get(input.requestId);
      if (prior) { requireThat(prior.digest === digest, 'REQUEST_CONFLICT', 'The same request ID cannot carry a different intent.', 409); return prior.promise ?? { state: this.view(session) }; }
      requireThat(session.requests.size < 100, 'ACTION_LIMIT', 'This round reached its action limit.', 429);
      requireThat(input.expectedVersion === session.version, 'STALE_SESSION', 'The round changed. Confirm the scope again.', 409);
      requireThat(!session.ended, 'ENDED', 'This round has ended.', 409);
      requireThat(type !== 'stop_sharing' || session.mode !== 'replay', 'REPLAY', 'Replay cannot modify actual sharing permissions.');
      accepted = { digest, pendingAliceId: session.pendingDelivery?.direction === 'bob' ? session.pendingDelivery.operationId : null };
      session.requests.set(input.requestId, accepted);
      cancelled = this.interruptPlanning(session, type === 'end' ? 'end' : 'revoke');
    }
    const result = this.lock(session, async () => {
      if (accepted) await cancelled;
      requireThat(typeof input.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(input.requestId), 'REQUEST_ID', 'A submission needs a stable request ID.');
      const digest = accepted?.digest ?? hashValue(input);
      const prior = session.requests.get(input.requestId);
      if (!accepted && prior) { requireThat(prior.digest === digest, 'REQUEST_CONFLICT', 'The same request ID cannot carry a different intent.', 409); return { state: this.view(session) }; }
      if (!accepted) {
        requireThat(session.requests.size < 100, 'ACTION_LIMIT', 'This round reached its action limit.', 429);
        requireThat(input.expectedVersion === session.version, 'STALE_SESSION', 'The round changed. Confirm the scope again.', 409);
        requireThat(!session.ended, 'ENDED', 'This round has ended.', 409);
        inflight = { digest };
        session.inflightRequests.set(input.requestId, inflight);
      }
      const generation = session.interruptGeneration;
      if (['answer_prediction', 'answer_revocation'].includes(type)) {
        const valid = type === 'answer_prediction' ? ['approved_snapshot', 'outside_scope', 'not_sure'] : ['future_only', 'delete_received', 'not_sure'];
        requireThat(valid.includes(input.answer) && session.mode !== 'replay', 'ANSWER', 'Choose a valid answer.');
        const questionId = type === 'answer_prediction' ? 'received_scope' : 'withdrawal';
        requireThat(!session.answers[questionId], 'ANSWERED', 'This question has already been submitted.', 409);
        session.answers[questionId] = input.answer;
        await this.event(session, 'prediction', { questionId, answer: input.answer, correct: input.answer === (type === 'answer_prediction' ? 'approved_snapshot' : 'future_only'), stage: session.stage });
      } else if (type === 'end') {
        session.ended = true; session.stopped = true; session.paused = false; session.stage = 'complete'; session.waiting = null;
        session.approvals.forEach(item => { if (item.status === 'pending') item.status = 'cancelled'; });
        if (!session.task.outcome) {
          const meeting = this.confirmedMeeting(session);
          session.task = { outcome: meeting ? 'arranged' : 'ended', meeting };
        }
        const cleared = await this.clearContexts(session);
        await this.research.finish(session, session.task.outcome, cleared ? [] : ['cleanup_uncertain']);
        this.message(session, 'system', cleared ? 'This round ended. Both agents’ temporary contexts have been cleared.' : 'This round ended and further actions stopped. Bob’s remote cleanup is unconfirmed; restore the connection before starting a new round.', cleared ? 'status' : 'technical');
      } else if (type === 'stop_sharing') {
        requireThat(session.mode !== 'replay', 'REPLAY', 'Replay cannot modify actual sharing permissions.');
        session.stopped = true;
        const pendingAliceId = accepted?.pendingAliceId ?? (session.pendingDelivery?.direction === 'bob' ? session.pendingDelivery.operationId : null);
        if (pendingAliceId && !session.receipts.aliceToBob.some(receipt => receipt.operationId === pendingAliceId)) {
          session.pendingDelivery = null;
          session.continuation = null;
          this.message(session, 'system', 'Retries of the unconfirmed Alice transmission stopped. Its receipt status remains uncertain.', 'technical');
        }
        await this.event(session, 'permission_changed', { actor: 'Alice', choice: 'revoke' });
        this.message(session, 'Alice', 'Future sharing stopped. Bob’s already received snapshots remain in this round’s receipt history.');
        session.continuation = null;
        session.approvals.forEach(item => { if (item.status === 'pending') item.status = 'cancelled'; });
        if (!session.task.outcome) {
          const meeting = this.confirmedMeeting(session);
          await this.complete(session, meeting ? 'arranged' : 'boundary_kept', meeting);
        }
      } else if (type === 'replay_next') {
        requireThat(session.mode === 'replay', 'REPLAY', 'This is not replay mode.');
        const step = REPLAY_STEPS[session.replay.index];
        requireThat(step, 'REPLAY_END', 'The replay has finished.', 409);
        session.replay.index++;
        this.message(session, 'system', step.text, 'replay');
        if (session.replay.index === REPLAY_STEPS.length) session.task.outcome = 'arranged';
      } else {
        requireThat(!session.paused && session.mode !== 'replay' && !session.stopped, 'PAUSED', 'New sharing cannot be submitted at this point.', 409);
        const stage = type === 'share_initial' ? 'initial' : type === 'respond_additional' ? 'additional' : null;
        requireThat(stage && session.stage === stage, 'STALE_STAGE', 'The current step has changed.', 409);
        const payload = await this.projection(session, stage, input.choice);
        requireThat(!session.ended && !session.paused && !session.stopped, 'INTERRUPTED', 'Sharing was interrupted before transmission.', 409);
        requireThat(input.previewHash === hashValue(payload), 'PREVIEW_CHANGED', 'The proposed payload differs from the preview. Confirm it again.', 409);
        session.choices[stage] = input.choice;
        await this.event(session, 'choice', { stage, choice: input.choice, fields: payload.fields, window: payload.window, payloadHash: input.previewHash });
        requireThat(this.planningCurrent(session, generation) && !session.stopped, 'INTERRUPTED', 'Sharing was interrupted before transmission.', 409);
        if (input.choice === 'none' || input.choice === 'keep') {
          this.message(session, 'Alice', 'The participant kept their sharing boundary. This is a valid outcome.');
          await this.complete(session, input.choice === 'none' ? 'declined' : 'boundary_kept');
        } else {
          session.pendingDelivery = { direction: 'bob', operationId: `${session.id}:alice:${++session.requestSequence}`, ...payload, payloadHash: input.previewHash, next: stage };
          await this.continueDelivery(session);
        }
      }
      if (!accepted) session.version++;
      session.requests.set(input.requestId, { digest });
      return { state: this.view(session) };
    });
    if (accepted) accepted.promise = result;
    try { return await result; }
    finally { if (inflight && session.inflightRequests.get(input.requestId) === inflight) session.inflightRequests.delete(input.requestId); }
  }
  async complete(session, outcome, meeting = session.preparedMeeting) {
    session.stage = 'complete'; session.waiting = null; session.paused = false; session.continuation = null; session.savedStage = null;
    session.task = { outcome, meeting: meeting ? clone(meeting) : null };
    session.preparedMeeting = outcome === 'arranged' && meeting ? clone(meeting) : null;
    await this.event(session, 'stage', { stage: 'complete', status: outcome });
    this.message(session, 'system', outcome === 'arranged' ? `Both agents confirmed the fictional meeting: ${meeting.day} ${meeting.time}.` : 'The round completed within the participant’s chosen sharing boundary.');
  }
  async suspend(session, error) {
    session.savedStage ??= session.stage;
    session.paused = true; session.stage = 'paused';
    const reason = /OFFLINE|TRANSPORT|PEER|CONNECTION|ECONN/i.test(error.code ?? '') ? 'peer_offline' : 'model_timeout';
    session.waiting = { reason, message: PUBLIC_WAIT[reason] };
    this.message(session, 'system', session.waiting.message, 'technical');
    await this.event(session, 'technical', { code: /^[A-Za-z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'RUNTIME_ERROR', stage: session.stage });
  }
  async continueDelivery(session) {
    const operation = session.pendingDelivery;
    const generation = session.interruptGeneration;
    if (!operation || !this.planningCurrent(session, generation)) return;
    try {
      requireThat(operation.direction !== 'bob' || !session.stopped, 'SHARING_STOPPED', 'Alice stopped future sharing. This operation cannot be transmitted.', 409);
      const request = { sessionId: session.id, epoch: session.epoch, ...operation };
      let result;
      if (operation.direction === 'alice' && (operation.expiresAt <= Date.now() || operation.policyRevision !== session.configRevision)) {
        result = await this.runtime.verifyReceipt(request);
        if (!result) {
          if (!this.planningCurrent(session, generation)) return;
          session.pendingDelivery = null;
          await this.event(session, 'permission_changed', { actor: 'Bob', reason: 'grant_expired', policyRevision: session.configRevision });
          if (!this.planningCurrent(session, generation)) return;
          this.message(session, 'system', 'Bob’s prior permission expired before a confirmed delivery. Review a new exact request; no expired transfer was sent.');
          await this.proposeBob(session, { fields: operation.fields, values: operation.values, resource: operation.resource, purpose: operation.purpose, next: operation.next, summary: 'Bob needs a renewed permission for this exact reply.' });
          return;
        }
      } else result = operation.direction === 'bob' ? await this.runtime.deliverToBob(request) : await this.runtime.deliverToAlice(request);
      requireThat(result.receipt?.status === 'received' && result.receipt.payloadHash === operation.payloadHash, 'RECEIPT_INVALID', 'The recipient confirmation does not match the payload.', 502);
      const list = operation.direction === 'bob' ? session.receipts.aliceToBob : session.receipts.bobToAlice;
      if (!list.some(receipt => receipt.operationId === operation.operationId)) {
        list.push({ operationId: operation.operationId, fields: operation.fields, ...(operation.direction === 'bob' ? { rows: operation.rows, window: operation.window } : { values: operation.values }), payloadHash: operation.payloadHash, status: 'received', receivedAt: result.receipt.receivedAt });
        await this.event(session, 'delivery', { fields: operation.fields, window: operation.window, recipient: operation.direction === 'bob' ? 'Bob' : 'Alice', operationId: operation.operationId, payloadHash: operation.payloadHash });
      }
      if (session.pendingDelivery === operation) session.pendingDelivery = null;
      this.message(session, 'system', `${operation.direction === 'bob' ? 'Bob' : 'Alice'} confirmed receipt of this exact snapshot.`, 'receipt');
      if (!this.planningCurrent(session, generation)) {
        // An already delivered snapshot stays in the ledger. Pause may resume its next planning step explicitly.
        if (session.paused && !session.ended && !session.stopped && !session.pendingDelivery) session.continuation = operation.next;
        return;
      }
      session.continuation = operation.next;
      await this.continuePlan(session);
    } catch (error) { if (this.planningCurrent(session, generation)) await this.suspend(session, error); }
  }
  async continuePlan(session) {
    const next = session.continuation;
    const generation = session.interruptGeneration;
    if (!next || !this.planningCurrent(session, generation)) return;
    try {
      if (next === 'intro') {
        const result = await this.runtime.planAlice({ sessionId: session.id, epoch: session.epoch, purpose: 'intro', mode: session.mode });
        if (!this.planningCurrent(session, generation)) return;
        this.message(session, 'Alice', result.message, 'agent');
        session.continuation = null; session.stage = 'initial'; session.savedStage = null;
        return;
      }
      if (next === 'done') { await this.complete(session, session.preparedMeeting ? 'arranged' : 'boundary_kept'); return; }
      if (next === 'boundary') { await this.complete(session, 'boundary_kept', null); return; }
      if (next === 'after_availability') {
        if (!session.config.response.offerBrief || !session.config.tools.capabilities.includes('share_brief')) { await this.complete(session, 'arranged'); return; }
        const fields = Object.keys(session.config.data.brief);
        if (!fields.length) { await this.complete(session, 'arranged'); return; }
        const planned = await this.runtime.planBob({ sessionId: session.id, epoch: session.epoch, purpose: 'brief', configRevision: session.configRevision });
        if (!this.planningCurrent(session, generation)) return;
        requireThat(planned.action?.type === 'share_brief', 'INVALID_OUTPUT', 'Bob proposed an invalid optional brief.', 502);
        await this.proposeBob(session, { fields: planned.action.fields, values: planned.action.values, resource: planned.action.resource, purpose: 'optional_meeting_context', next: 'done', summary: 'Bob would like to share an optional meeting brief with Alice.' });
        return;
      }
      if (next === 'recheck') {
        // Re-evaluate proposals using the new policy; Alice's delivered snapshot stays immutable.
        if (!session.receipts.aliceToBob.length) { session.stage = 'initial'; session.savedStage = null; session.continuation = null; return; }
      }
      const purpose = next === 'initial' ? 'initial' : 'additional';
      const result = await this.runtime.planBob({ sessionId: session.id, epoch: session.epoch, purpose, configRevision: session.configRevision });
      if (!this.planningCurrent(session, generation)) return;
      const action = result.action;
      requireThat(action && ['request_more', 'meeting', 'no_match'].includes(action.type), 'INVALID_OUTPUT', 'Bob proposed an invalid action.', 502);
      if (action.type === 'request_more') {
        session.stage = 'additional'; session.savedStage = null; session.continuation = null;
        this.message(session, 'Bob', 'There is no common time in the received scope. Would you share Thursday free times, or a full-week snapshot? Keeping the current boundary is also valid.', 'request');
        await this.event(session, 'request', { actor: 'Bob', stage: 'additional', reason: 'no_match' });
      } else if (action.type === 'no_match') {
        this.message(session, 'Bob', 'There is still no common time in the received scope.');
        await this.complete(session, 'boundary_kept', null);
      } else {
        requireThat(session.config.tools.capabilities.includes('send_scoped_reply'), 'TOOL_DISABLED', 'Bob’s scoped reply tool is disabled.', 409);
        session.preparedMeeting = clone(action.meeting);
        await this.proposeBob(session, { resource: 'availability', purpose: 'confirm_meeting', fields: ['day', 'time', 'status'], values: { ...action.meeting, status: 'Free' }, next: 'after_availability', summary: 'Bob would like to confirm a shared meeting time with Alice.' });
      }
    } catch (error) { if (this.planningCurrent(session, generation)) await this.suspend(session, error); }
  }
  allowedByPolicy(session, proposal) {
    const policy = session.config.permissions;
    const day = proposal.values.day;
    const windowDays = policy.window === 'Mon–Sun' || policy.window === 'Mon-Sun' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : policy.window.split(/[–,-]/).map(x => x.trim());
    return policy.confirmation === 'bounded' && policy.recipients.includes('Alice') && policy.resources.includes(proposal.resource) && proposal.fields.every(field => policy.fields.includes(field)) && (!day || windowDays.includes(day)) && session.policyUses < policy.maxUses && Date.now() < Date.parse(session.startedAt) + policy.expiryMinutes * 60_000;
  }
  async proposeBob(session, proposal) {
    const payloadHash = hashValue({ fields: proposal.fields, values: proposal.values });
    proposal.payloadHash = payloadHash;
    const grant = session.grants.find(item => item.resource === proposal.resource && item.purpose === proposal.purpose && item.remaining > 0 && item.expiresAt > Date.now() && item.fields.every(field => proposal.fields.includes(field)) && item.payloadHash === hashValue({ fields: item.fields, values: Object.fromEntries(item.fields.map(field => [field, proposal.values[field]])) }));
    if (this.allowedByPolicy(session, proposal) || grant) {
      if (grant) {
        grant.remaining--;
        proposal = { ...proposal, fields: clone(grant.fields), values: Object.fromEntries(grant.fields.map(field => [field, proposal.values[field]])), expiresAt: grant.expiresAt, next: proposal.resource === 'availability' && !['day', 'time', 'status'].every(field => grant.fields.includes(field)) ? 'boundary' : proposal.next };
      } else { session.policyUses++; proposal.expiresAt = Date.parse(session.startedAt) + session.config.permissions.expiryMinutes * 60_000; }
      await this.sendBob(session, proposal);
      return;
    }
    if (!session.config.permissions.askAdminForNewScope) {
      this.message(session, 'Bob', 'Bob’s current policy does not allow this sharing.');
      session.continuation = proposal.next;
      if (proposal.resource === 'availability') await this.complete(session, 'boundary_kept', null); else await this.continuePlan(session);
      return;
    }
    const approval = { id: randomUUID(), owner: 'Bob', sessionId: session.id, epoch: session.epoch, actionId: `${session.id}:bob:${++session.requestSequence}`, kind: proposal.resource, summary: proposal.summary, recipient: 'Alice', purpose: proposal.purpose, resource: proposal.resource, fields: clone(proposal.fields), values: clone(proposal.values), payloadHash, policyRevision: session.configRevision, status: 'pending', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), reason: 'scope_not_pre_authorized', next: proposal.next, requestedAt: Date.now() };
    session.approvals.push(approval);
    session.savedStage = session.stage; session.stage = 'waiting_admin'; session.paused = false; session.continuation = null;
    session.waiting = { reason: 'admin', message: PUBLIC_WAIT.admin };
    this.message(session, 'system', approval.summary + ' The participant’s Alice sharing choices stay unchanged.', 'approval');
    await this.event(session, 'request', { actor: 'Bob', fields: proposal.fields, policyRevision: session.configRevision, reason: 'owner_approval', stage: session.stage });
  }
  async sendBob(session, proposal, operationId) {
    session.pendingDelivery = { direction: 'alice', operationId: operationId ?? `${session.id}:bob:${++session.requestSequence}`, fields: clone(proposal.fields), values: clone(proposal.values), payloadHash: hashValue({ fields: proposal.fields, values: proposal.values }), next: proposal.next, expiresAt: proposal.expiresAt, policyRevision: session.configRevision, resource: proposal.resource, purpose: proposal.purpose };
    await this.continueDelivery(session);
  }
  approvals(sessionId) { return clone(this.get(sessionId).approvals.map(({ next, requestedAt, ...item }) => item)); }
  async decide(id, input) {
    const session = [...this.sessions.values()].find(item => item.approvals.some(approval => approval.id === id));
    requireThat(session, 'APPROVAL_GONE', 'The approval request no longer exists.', 404);
    return this.lock(session, async () => {
      const approval = session.approvals.find(item => item.id === id);
      if (approval.status === 'pending' && !session.ended && !session.paused && approval.epoch === session.epoch && approval.policyRevision === session.configRevision && Date.parse(approval.expiresAt) <= Date.now()) {
        approval.status = 'expired';
        await this.proposeBob(session, { fields: approval.fields, values: approval.values, resource: approval.resource, purpose: approval.purpose, next: approval.next, summary: 'Bob renewed an expired request. Review its exact content again.' });
        await this.event(session, 'admin_intervention', { actor: 'admin', action: 'renew_expired_request' });
        session.version++;
        throw new AppError('STALE_APPROVAL', 'The pending request expired and was renewed. Review the new request; no approval was carried over.', 409);
      }
      requireThat(approval.status === 'pending' && !session.ended && !session.paused && approval.epoch === session.epoch && approval.policyRevision === session.configRevision && input.expectedPolicyRevision === approval.policyRevision && input.expectedPayloadHash === approval.payloadHash && Date.parse(approval.expiresAt) > Date.now(), 'STALE_APPROVAL', 'The request changed, expired or paused. Review the current request.', 409);
      requireThat(['allow_once', 'allow_round', 'deny'].includes(input.decision), 'DECISION', 'Choose one-time approval, a bounded round grant, or denial.');
      if (input.decision === 'deny') {
        approval.status = 'denied'; session.waiting = null;
        this.message(session, 'system', 'Bob’s owner declined this sharing.');
        if (approval.resource === 'availability') await this.complete(session, 'boundary_kept', null);
        else { session.continuation = approval.next; await this.continuePlan(session); }
      } else {
        const fields = input.fields ?? approval.fields;
        requireThat(Array.isArray(fields) && fields.length && new Set(fields).size === fields.length && fields.every(field => approval.fields.includes(field)), 'GRANT_FIELDS', 'Only fields in this request may be selected.');
        const maxUses = input.decision === 'allow_once' ? 1 : input.maxUses ?? 2;
        const expiryMinutes = input.expiryMinutes ?? 5;
        requireThat(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100 && Number.isFinite(expiryMinutes) && expiryMinutes > 0 && expiryMinutes <= 60, 'GRANT_LIMIT', 'A grant needs a 1–100 use limit and an expiry of at most 60 minutes.');
        const values = Object.fromEntries(fields.map(field => [field, approval.values[field]]));
        const proposal = { fields, values, resource: approval.resource, purpose: approval.purpose, expiresAt: Date.now() + expiryMinutes * 60_000, next: approval.resource === 'availability' && !['day', 'time', 'status'].every(field => fields.includes(field)) ? 'boundary' : approval.next };
        if (input.decision === 'allow_round') session.grants.push({ resource: proposal.resource, purpose: proposal.purpose, fields: clone(fields), payloadHash: hashValue({ fields, values }), remaining: maxUses - 1, expiresAt: Date.now() + expiryMinutes * 60_000 });
        approval.status = 'allowed'; session.waiting = null;
        await this.sendBob(session, proposal, approval.actionId);
      }
      await this.event(session, 'admin_intervention', { choice: input.decision, actor: 'admin', policyRevision: approval.policyRevision, adminWaitMs: Date.now() - approval.requestedAt, fields: input.fields ?? approval.fields, action: 'owner_approval' });
      session.version++;
      return { state: this.view(session) };
    });
  }
  async intervene(session, { action, kind }) {
    requireThat(this.sessions.get(session.id) === session, 'SESSION_GONE', 'This round has ended or been reset.', 409);
    // Reset creates a fresh session outside the old lock, never reuses old credentials.
    if (action === 'reset') {
      if (session.resetPromise) return session.resetPromise;
      const mode = session.mode;
      const cancelled = this.interruptPlanning(session, 'reset');
      const result = (async () => {
        await this.lock(session, async () => { await cancelled; await this.event(session, 'admin_intervention', { action: 'reset', actor: 'admin' }); await this.remove(session); });
        return this.create({ mode, researchConsent: false });
      })();
      session.resetPromise = result;
      return result;
    }
    requireThat(!session.ended && session.mode !== 'replay', 'INTERVENTION', 'This session cannot accept that intervention.', 409);
    requireThat(['pause', 'resume', 'disconnect_bob', 'restore_bob', 'retry', 'inject_request'].includes(action), 'INTERVENTION', 'Unknown intervention.');
    let cancelled;
    if (action === 'pause') {
      if (session.paused && ['researcher', 'configuration_changed'].includes(session.waiting?.reason)) return { state: this.view(session) };
      cancelled = this.interruptPlanning(session, 'pause');
    }
    return this.lock(session, async () => {
      if (cancelled) await cancelled;
      requireThat(!session.ended && session.mode !== 'replay', 'INTERVENTION', 'This session cannot accept that intervention.', 409);
      requireThat(['pause', 'resume', 'disconnect_bob', 'restore_bob', 'retry', 'inject_request'].includes(action), 'INTERVENTION', 'Unknown intervention.');
      if (action === 'disconnect_bob' || action === 'restore_bob') {
        await this.runtime.setBobOnline(action === 'restore_bob');
        this.message(session, 'system', action === 'restore_bob' ? 'Bob’s connection was restored. Unsent content requires an explicit researcher retry.' : 'The researcher simulated a Bob disconnection.', 'technical');
      } else if (action === 'pause') {
        session.savedStage ??= session.stage; session.paused = true; session.stage = 'paused'; session.waiting = { reason: 'researcher', message: PUBLIC_WAIT.researcher };
      } else if (action === 'resume' || action === 'retry') {
        requireThat(session.paused, 'NOT_PAUSED', 'There is no paused operation to retry.', 409);
        const changed = session.waiting?.reason === 'configuration_changed';
        session.paused = false; session.waiting = null; session.stage = session.savedStage ?? 'initial'; session.savedStage = null;
        if (changed) { session.pendingDelivery = null; session.continuation = 'recheck'; }
        if (session.pendingDelivery) await this.continueDelivery(session);
        else if (session.continuation) await this.continuePlan(session);
      } else if (action === 'inject_request') {
        requireThat(!session.paused && !session.pendingDelivery && !session.approvals.some(item => item.status === 'pending'), 'BUSY', 'Resolve the current pending operation first.', 409);
        requireThat(session.config.tools.capabilities.includes('share_brief'), 'TOOL_DISABLED', 'The brief sharing tool is disabled.', 409);
        const resource = kind || 'meeting_brief';
        requireThat(typeof resource === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(resource), 'RESOURCE', 'The resource name is invalid.');
        await this.proposeBob(session, { resource, purpose: 'optional_meeting_context', fields: Object.keys(session.config.data.brief), values: clone(session.config.data.brief), next: session.task.outcome ? 'done' : 'initial', summary: 'The researcher triggered an optional Bob brief sharing request.' });
      }
      await this.event(session, 'admin_intervention', { action, actor: 'admin' });
      if (!cancelled) session.version++;
      return { state: this.view(session) };
    });
  }
  async close() {
    const sessions = [...this.sessions.values()];
    const cancelled = sessions.map(session => this.interruptPlanning(session, 'close'));
    await Promise.all(cancelled);
    await Promise.all(sessions.map(session => this.lock(session, () => this.remove(session)).catch(() => {})));
    await this.runtime.close();
  }
}
