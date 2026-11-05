import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { AuthorizationLedger } from './authorization-ledger.mjs';
import { researchProfile, researchConference, researchMappings, selectWorkingOntology } from './research-profiles.mjs';
import { AppError, requireThat } from './errors.mjs';
import { canonical, hashPayload } from './runtime-helpers.mjs';
import { defaultResearchCommand } from './research-commands.mjs';

const clone = value => structuredClone(value);
const other = role => role === 'Alice' ? 'Bob' : 'Alice';
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const TASKS = ['schedule', 'select_presentation', 'prepare_discussion'];
const ROLE_NAMES = ['Alice', 'Bob'];
const purpose = 'academic_coordination';
const activityDetails = value => {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  return encoded.length <= 24000 ? clone(value) : { truncated: true, preview: encoded.slice(0, 24000) };
};
const cleanFields = fields => {
  requireThat(fields && typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length > 0 && Object.keys(fields).length <= 16,
    'ARTIFACT_FIELDS', 'Provide a bounded field object.');
  for (const [key, value] of Object.entries(fields)) requireThat(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
    && !['__proto__', 'prototype', 'constructor', 'owner', 'role', 'authorization', 'public', 'visibility'].includes(key)
    && typeof value === 'string' && value.length <= 8000, 'ARTIFACT_FIELDS', 'Artifact fields must be named text fields.');
  return clone(fields);
};
const minute = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
const clock = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const interval = row => { const [a, b] = row.time.split(/[–—-]/); return [minute(a), minute(b)]; };
function validateReservationFields(fields) {
  requireThat(['title', 'day', 'time', 'attendees', 'agenda'].every(key => typeof fields[key] === 'string' && fields[key].trim().length > 0),
    'RESERVATION_FIELDS', 'A reservation draft requires text fields title, day, time, attendees (participant count), and agenda. Example: day="Thu", time="15:00–15:30", attendees="8".');
  requireThat(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(fields.day) && /^([01]\d|2[0-3]):[0-5]\d[–-]([01]\d|2[0-3]):[0-5]\d$/.test(fields.time)
    && interval(fields)[0] < interval(fields)[1] && /^\d{1,4}$/.test(fields.attendees) && Number(fields.attendees) >= 1 && Number(fields.attendees) <= 1000,
  'RESERVATION_FIELDS', 'Use a weekday, a valid same-day HH:MM–HH:MM interval, and attendees as a positive integer count.');
}

/** Native agents use the same typed tools as the deterministic rehearsal driver.
 * The service owns identities, source projections, durable authorization and actual receipts.
 */
export class ResearchEngine {
  constructor({ directory, persist = true, nativeClient, knowledge, agentTokens = {} } = {}) {
    this.directory = directory; this.persist = persist; this.nativeClient = nativeClient; this.knowledge = knowledge;
    this.agentTokens = agentTokens; this.workspaces = new Map(); this.ledgers = new Map(); this.queues = new Map();
    this.assignments = new Map(); this.roleBusy = new Map(); this.running = new Set(); this.controllers = new Map(); this.blockedRoles = new Set(); this.closed = false;
    this.projectionRuns = new Map();
  }
  async init() {
    if (this.nativeClient?.check) await Promise.all(ROLE_NAMES.map(role => this.nativeClient.check({ role })));
    if (this.knowledge) await this.knowledge.initialize(Object.fromEntries(ROLE_NAMES.map(role => [role, researchProfile(role)])));
    if (this.persist) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.stateDB = new DatabaseSync(this.persist ? path.join(this.directory, 'workspaces.sqlite') : ':memory:');
    this.stateDB.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
    for (const entry of this.stateDB.prepare('SELECT id,state FROM workspaces').all()) {
      const w = JSON.parse(entry.state);
      requireThat(w.id === entry.id && w.schemaVersion === 1, 'RESEARCH_STORAGE', 'The collaboration workspace cannot be loaded.', 503);
      this.workspaces.set(w.id, w); this.openLedgers(w);
      w.policyCandidates ??= { Alice: [], Bob: [] };
      w.activity ??= [];
      for (const task of w.tasks) if (task.status === 'running') { task.status = 'paused'; task.error = '服务重启；请恢复任务，先核验已有操作回执。'; }
      for (const task of w.tasks) for (const role of ROLE_NAMES) if (task.nativeRuns?.[role] && task.nativeRuns[role].status !== 'settled') this.blockedRoles.add(role);
      await this.flush(w);
    }
    if (this.nativeClient) for (const role of [...this.blockedRoles]) {
      try { await this.recoverRole(role); }
      catch (error) {
        for (const w of this.workspaces.values()) for (const task of w.tasks) if (task.nativeRuns?.[role]?.status !== 'settled' && task.nativeRuns?.[role]) {
          if (!['completed', 'partial', 'cancelled'].includes(task.status)) task.status = 'paused';
          task.error = `${error.code ?? 'HERMES_RUN_UNSETTLED'}: 尚未确认重启前的原生运行已结束。`; await this.save(w);
        }
      }
    }
    this.projectionTimer = setInterval(() => { if (!this.closed) for (const w of this.workspaces.values()) this.projectOutbox(w); }, 5000);
    this.projectionTimer.unref();
    return this;
  }
  openLedgers(w) {
    const rows = {};
    for (const role of ROLE_NAMES) rows[role] = new AuthorizationLedger({ owner: `${w.id}:${role}`,
      filename: this.persist ? path.join(this.directory, w.id, `${role.toLowerCase()}.sqlite`) : ':memory:' });
    this.ledgers.set(w.id, rows); return rows;
  }
  ledger(w, role) { return this.ledgers.get(w.id)[role]; }
  get(id) { const w = this.workspaces.get(id); requireThat(w, 'RESEARCH_NOT_FOUND', 'The collaboration workspace does not exist.', 404); return w; }
  task(w, id) { const t = w.tasks.find(item => item.id === id); requireThat(t, 'RESEARCH_TASK', 'The task does not exist.', 404); return t; }
  lock(w, fn) {
    const next = (this.queues.get(w.id) ?? Promise.resolve()).then(fn);
    this.queues.set(w.id, next.catch(() => {})); return next;
  }
  async save(w) {
    this.recordResults(w);
    this.stateDB.prepare('INSERT INTO workspaces(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(w.id, JSON.stringify(w));
  }
  activity(w, event, { ownerOnly = false, sharedDetails = false } = {}) {
    w.activity ??= [];
    const entry = { ...clone(event), id: randomUUID(), sequence: (w.activity.at(-1)?.sequence ?? 0) + 1,
      at: new Date().toISOString(), ownerOnly, sharedDetails,
      ...(event.details === undefined ? {} : { details: activityDetails(event.details) }) };
    w.activity.push(entry); return entry;
  }
  activityView(w, role) {
    return (w.activity ?? []).filter(event => {
      const task = w.tasks.find(t => t.id === event.taskId);
      return task && (task.type !== 'research_work' || task.initiator === role) && (!event.ownerOnly || event.role === role);
    }).map(event => {
      const { ownerOnly, sharedDetails, ...visible } = clone(event);
      if (event.role !== role && !sharedDetails) {
        delete visible.text; delete visible.details;
        if (event.text !== undefined || event.details !== undefined) visible.redacted = true;
      }
      return visible;
    });
  }
  conversation(w, t, from, to, name, details, messageId) {
    for (const role of [from, to]) this.activity(w, { taskId: t.id, role, kind: 'message',
      direction: role === from ? 'outgoing' : 'incoming', from, to, name, messageId, status: 'received', details }, { sharedDetails: true });
  }
  recordResults(w) {
    for (const t of w.tasks) {
      if (!t.result) continue;
      const resultHash = hashPayload({ status: t.status, result: t.result });
      if ((w.activity ?? []).some(event => event.taskId === t.id && event.kind === 'result' && event.resultHash === resultHash)) continue;
      for (const role of t.type === 'research_work' ? [t.initiator] : ROLE_NAMES) this.activity(w, { taskId: t.id, role,
        kind: 'result', direction: 'outgoing', from: role, to: `owner:${role}`, name: 'verified_result',
        status: t.status, resultHash, details: t.result }, { sharedDetails: true });
    }
  }
  async flush(w) {
    let changed = false;
    for (const role of ROLE_NAMES) {
      const ledger = this.ledger(w, role);
      for (const item of ledger.pendingOutbox()) {
        const key = `${role}:${item.id}`;
        if (!w.authorizationProjection.some(row => row.key === key)) { w.authorizationProjection.push({ key, role, ...item }); changed = true; }
      }
    }
    // A discoverable local projection is committed before delivery acknowledgement.
    if (changed) await this.save(w);
    if (!this.knowledge) for (const role of ROLE_NAMES) { const ledger = this.ledger(w, role); for (const item of ledger.pendingOutbox()) ledger.acknowledgeOutbox(item.id); }
    else this.projectOutbox(w);
  }
  projectOutbox(w) {
    if (!this.knowledge || this.closed || this.projectionRuns.has(w.id)) return;
    const run = Promise.allSettled(ROLE_NAMES.map(async role => {
      const ledger = this.ledger(w, role);
      for (const item of ledger.pendingOutbox()) {
        try { await this.knowledge.project(role, { workspaceId: w.id, ...item }); ledger.acknowledgeOutbox(item.id); }
        catch { break; } // Never delay authorization/execution on an unavailable KG projection.
      }
    }));
    this.projectionRuns.set(w.id, run);
    run.finally(() => this.projectionRuns.delete(w.id)).catch(() => {});
  }
  async create() {
    const id = randomUUID(); const tokens = Object.fromEntries(ROLE_NAMES.map(role => [role, randomBytes(32).toString('base64url')]));
    const profiles = {};
    for (const role of ROLE_NAMES) profiles[role] = this.knowledge ? await this.knowledge.profile(role) : researchProfile(role);
    const keys = Object.fromEntries(ROLE_NAMES.map(role => {
      const pair = generateKeyPairSync('ed25519'); return [role, { private: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), public: pair.publicKey.export({ type: 'spki', format: 'pem' }) }];
    }));
    const w = { schemaVersion: 1, id, projectId: `collaboration:${id}`, createdAt: new Date().toISOString(),
      ownerHashes: Object.fromEntries(ROLE_NAMES.map(role => [role, digest(tokens[role])])), keys, profiles,
      conference: researchConference(), tasks: [], artifacts: [], messages: [], reservations: [], authorizationProjection: [], policyCandidates: { Alice: [], Bob: [] }, events: [], activity: [] };
    if (this.persist) await mkdir(path.join(this.directory, id), { recursive: true });
    this.workspaces.set(id, w); this.openLedgers(w);
    for (const role of ROLE_NAMES) this.ledger(w, role).policy({ id: `standing:${role}`, effect: 'allow', actions: ['peer.send'],
      resourceClass: 'public', recipients: [other(role)], purposes: [purpose], projectId: w.projectId });
    for (const role of ROLE_NAMES) this.ledger(w, role).policy({ id: `availability:${role}`, effect: 'allow', actions: ['peer.send'],
      resources: ['availability', 'report-interests'], recipients: [other(role)], purposes: [purpose], projectId: w.projectId });
    await this.flush(w); await this.save(w);
    return { workspaceId: id, owner: 'Alice', token: tokens.Alice, state: this.view(w, 'Alice') };
  }
  authorize(id, token) {
    const w = this.get(id); const role = ROLE_NAMES.find(name => w.ownerHashes[name] === digest(token ?? ''));
    requireThat(role, 'RESEARCH_OWNER_AUTH', 'Open this workspace with its owner credential.', 401); return { w, role };
  }
  async claimOwner(id, role) {
    requireThat(ROLE_NAMES.includes(role), 'RESEARCH_ROLE', 'Choose an owner.');
    const w = this.get(id); const token = randomBytes(32).toString('base64url');
    await this.lock(w, async () => { w.ownerHashes[role] = digest(token); await this.save(w); }); return { token, owner: role, workspaceId: id };
  }
  catalog() {
    return { tasks: TASKS, nativeAvailable: Boolean(this.nativeClient), profiles: Object.fromEntries(ROLE_NAMES.map(role => {
      const p = researchProfile(role); return [role, { role, ontology: p.ontology, skills: p.skills }];
    })), conference: researchConference() };
  }
  taskView(task, role) {
    if (task.type === 'research_work' && task.initiator !== role) return { id: task.id, type: task.type, status: task.status };
    const { nativeRuns, ownerGoal, ...view } = clone(task);
    if (task.initiator === role) view.ownerGoal = ownerGoal;
    return { ...view, checkpoints: Object.fromEntries(Object.entries(task.checkpoints).map(([owner, checkpoint]) => [owner, owner === role ? clone(checkpoint) : { status: checkpoint.status }])) };
  }
  view(w, role) {
    const own = clone(w.profiles[role]); const peer = w.profiles[other(role)];
    const sharedTask = w.tasks.findLast(task => task.type !== 'research_work');
    return { workspaceId: w.id, projectId: w.projectId, owner: role, createdAt: w.createdAt, profile: own,
      peer: { role: other(role), ontology: sharedTask ? clone(sharedTask.ontology[other(role)]) : { id: peer.ontology.id, version: peer.ontology.version, modules: [] }, skills: peer.skills }, conference: clone(w.conference),
      tasks: w.tasks.filter(task => task.type !== 'research_work' || task.initiator === role).map(task => this.taskView(task, role)), artifacts: clone(w.artifacts.filter(a => a.owner === role)),
      messages: clone(w.messages.filter(m => m.from === role || m.to === role)),
      activity: this.activityView(w, role),
      authorizations: this.ledger(w, role).list(),
      policyCandidates: clone(w.policyCandidates[role]),
      authorizationProjection: clone(w.authorizationProjection.filter(row => row.role === role)),
      reservations: w.reservations.map(r => ({ ...clone(r), ...(r.owner !== role ? { values: undefined } : {}) })), events: clone(w.events.filter(e => !e.role || e.role === role)) };
  }
  async start(id, input = {}, initiator = 'Alice') {
    const w = this.get(id); const type = input.type; const mode = input.mode ?? 'controlled';
    requireThat(TASKS.includes(type) || type === 'research_work', 'RESEARCH_TASK_TYPE', 'Choose a supported collaboration task.');
    requireThat(['controlled', 'native'].includes(mode) && (mode !== 'native' || this.nativeClient), 'RESEARCH_MODE', 'Native Hermes is not configured.', 409);
    requireThat(!w.endedAt, 'RESEARCH_ENDED', 'Start a new identity to begin another experience.', 409);
    const command = input.command ?? (type === 'research_work' ? input.goal : defaultResearchCommand(type));
    requireThat(typeof command === 'string' && command.trim().length > 0 && command.length <= 4000, 'RESEARCH_COMMAND', 'Provide a bounded owner command.');
    if (mode === 'native') for (const role of type === 'research_work' ? [initiator] : ROLE_NAMES) if (this.blockedRoles.has(role)) await this.recoverRole(role);
    if (type === 'research_work') requireThat(mode === 'native' && typeof input.goal === 'string' && input.goal.trim().length > 0 && input.goal.length <= 4000, 'RESEARCH_GOAL', 'A native research task needs a bounded owner goal.');
    const t = await this.lock(w, async () => {
      requireThat(!w.tasks.some(item => ['running', 'needs_owner'].includes(item.status)), 'RESEARCH_BUSY', 'Finish or pause the current task first.', 409);
      const t = { id: randomUUID(), type, mode, initiator, ownerGoal: command.trim(), status: 'running', createdAt: new Date().toISOString(), durationMinutes: 30,
        ontology: Object.fromEntries(ROLE_NAMES.map(role => [role, this.workingOntology(w, role, type)])),
        proposals: [], mappings: [], checkpoints: {}, wakeRoles: { Alice: type !== 'research_work' || initiator === 'Alice', Bob: type !== 'research_work' || initiator === 'Bob' }, runCounts: { Alice: 0, Bob: 0 },
        result: null, error: null, input: { scheduleTask: w.tasks.findLast(x => x.type === 'schedule' && x.result)?.id ?? null,
          reportTask: w.tasks.findLast(x => x.type === 'select_presentation' && x.result)?.id ?? null } };
      if (type === 'research_work') {
        const peerRole = other(initiator), peerOntology = w.profiles[peerRole].ontology;
        t.ontology[peerRole] = { owner: peerRole, id: peerOntology.id, version: peerOntology.version, hash: peerOntology.hash, modules: [] };
      }
      if (type === 'select_presentation') t.mappingReview = this.mappingCandidates(t);
      w.tasks.push(t);
      this.activity(w, { taskId: t.id, role: initiator, kind: 'command', direction: 'incoming', from: `owner:${initiator}`, to: initiator, name: 'owner_command', text: command.trim(), status: 'received' });
      await this.save(w); return t;
    });
    if (mode === 'controlled') await this.drive(w, t); else this.wakeNative(w);
    return this.view(w, initiator);
  }
  workingOntology(w, role, type) {
    if (type === 'research_work') return { owner: role, ...clone(w.profiles[role].ontology), taskType: type };
    return selectWorkingOntology(role, type, w.profiles[role]);
  }
  mappingCandidates(t) {
    const terms = modules => new Map(modules.flatMap(m => m.concepts).map(c => [c.id, c]));
    const actual = new Map(ROLE_NAMES.flatMap(role => [...terms(t.ontology[role].modules).entries()]));
    const original = new Map(ROLE_NAMES.flatMap(role => [...terms(researchProfile(role).ontology.modules).entries()]));
    const meaning = term => term && hashPayload({ definition: term.definition, parent: term.parent ?? null,
      properties: (term.properties ?? []).map(p => ({ id: p.id, datatype: p.datatype, constraints: p.constraints ?? {} })) });
    return researchMappings().filter(m => m.taskTypes.includes(t.type)).map(m => {
      const source = actual.get(m.source), target = actual.get(m.target);
      const unchanged = source && target && meaning(source) === meaning(original.get(m.source)) && meaning(target) === meaning(original.get(m.target));
      return { ...m, valid: Boolean(m.valid && unchanged), sourceDefinition: source?.definition ?? null, targetDefinition: target?.definition ?? null,
        ...(!unchanged ? { reason: 'The current disclosed definitions differ from this registered correspondence. Review and register a new version before using it.' } : {}),
        ontologyHashes: Object.fromEntries(ROLE_NAMES.map(role => [role, t.ontology[role].hash])) };
    });
  }
  source(w, t, role, id) {
    const p = w.profiles[role];
    if (id === 'availability') return { id, version: p.ontology.version, visibility: 'availability', fields: { slots: p.calendar.filter(r => r.status === 'Free').map(({ day, time, status }) => ({ day, time, status })) } };
    if (id === 'report-interests') {
      const reports = w.conference.reports.filter(report => (report.topics?.[role] ?? []).some(topic => (p.interests ?? []).includes(topic)));
      return { id, version: p.ontology.version, visibility: 'availability', fields: { reportIds: reports.map(r => r.id), interests: clone(p.interests ?? []) } };
    }
    const material = p.materials.find(m => m.id === id || m.id.endsWith(`:${id}`));
    if (material) return clone(material);
    const artifact = w.artifacts.find(a => a.id === id && a.owner === role && a.taskId === t.id);
    requireThat(artifact, 'RESEARCH_SOURCE', 'The source does not belong to this agent and task.', 404); return clone(artifact);
  }
  intent(w, t, role, args) {
    const action = args.action ?? 'peer.send'; const source = this.source(w, t, role, args.resourceId ?? args.artifactId);
    requireThat(['peer.send', 'reservation.submit'].includes(action), 'RESEARCH_ACTION', 'Choose a supported action.');
    const fields = args.fields ?? Object.keys(source.fields);
    requireThat(Array.isArray(fields) && fields.length > 0 && new Set(fields).size === fields.length && fields.every(k => Object.hasOwn(source.fields, k)), 'RESEARCH_FIELDS', 'Select existing source fields.');
    let values = Object.fromEntries(fields.map(k => [k, clone(source.fields[k])]));
    let recipient = other(role); let resourceClass = source.visibility === 'public' && source.ownerConfirmedVisibility === true ? 'public' : source.visibility === 'availability' ? 'availability' : 'private';
    if (action === 'peer.send') requireThat(!args.recipient || args.recipient === recipient, 'RESEARCH_RECIPIENT', 'Send only to the paired agent.');
    else {
      requireThat(role === 'Alice', 'RESERVATION_ORGANIZER', 'Alice is the designated organizer for this collaboration.', 403);
      requireThat(source.kind === 'reservation', 'RESERVATION_DRAFT', 'Prepare a reservation draft first.');
      validateReservationFields(source.fields);
      requireThat(fields.length === Object.keys(source.fields).length, 'RESERVATION_FIELDS', 'A reservation requires the complete reviewed form.');
      const venue = w.conference.venues.find(v => v.id === args.venueId);
      requireThat(venue, 'RESEARCH_VENUE', 'Choose an existing venue.');
      recipient = 'conference-reservations'; resourceClass = 'reservation'; values = { ...values, venueId: venue.id };
    }
    return { taskId: t.id, projectId: w.projectId, action, resourceId: source.id, resourceVersion: String(source.version), resourceClass,
      recipient, purpose, fields: Object.keys(values).sort(), values };
  }
  operationId(intent) { return `op:${hashPayload(intent)}`; }
  async execute(w, t, role, intent, perform) {
    const ledger = this.ledger(w, role); const id = this.operationId(intent);
    let operation = ledger.getOperation(id);
    if (operation?.status === 'succeeded') return clone(operation.receipt);
    const known = w.messages.find(m => m.id === id)?.receipt ?? w.reservations.find(r => r.operationId === id)?.receipt;
    if (known && operation) { ledger.complete(id, { status: 'succeeded', receipt: known }); await this.flush(w); return clone(known); }
    requireThat(!operation || !['dispatching', 'uncertain'].includes(operation.status), 'OPERATION_UNCERTAIN', 'The earlier operation has no confirmed receipt. Reconcile it before submitting again.', 409);
    if (!operation) {
      const check = ledger.check(intent);
      requireThat(check.status === 'allowed', check.status === 'denied' ? 'AUTHORIZATION_DENIED' : 'AUTHORIZATION_REQUIRED', check.reason ?? 'Owner approval is required.', 403);
      operation = ledger.prepare(id, intent);
    }
    ledger.dispatch(id);
    try {
      const receipt = await perform(id); await this.save(w);
      ledger.complete(id, { status: 'succeeded', receipt }); await this.flush(w); return receipt;
    } catch (error) { ledger.complete(id, { status: ['VENUE_UNAVAILABLE', 'RESERVATION_TIME'].includes(error.code) ? 'failed' : 'uncertain' }); throw error; }
  }
  async send(w, t, role, args) {
    const intent = this.intent(w, t, role, { ...args, action: 'peer.send' });
    const receipt = await this.execute(w, t, role, intent, async id => {
      const payload = clone(intent.values);
      const envelope = { id, workspaceId: w.id, taskId: t.id, from: role, to: other(role), resourceId: intent.resourceId,
        sourceVersion: intent.resourceVersion, fields: intent.fields, payload, payloadHash: hashPayload(payload), mappingHash: hashPayload(t.mappings) };
      const signature = sign(null, Buffer.from(canonical(envelope)), w.keys[role].private).toString('base64');
      requireThat(verify(null, Buffer.from(canonical(envelope)), w.keys[role].public, Buffer.from(signature, 'base64')), 'RESEARCH_SIGNATURE', 'Message signature verification failed.', 503);
      const ack = { operationId: id, status: 'received', receiver: other(role), payloadHash: envelope.payloadHash, receivedAt: new Date().toISOString() };
      const receipt = { ...ack, signature: sign(null, Buffer.from(canonical(ack)), w.keys[other(role)].private).toString('base64') };
      w.messages.push({ ...envelope, signature, receipt });
      this.conversation(w, t, role, other(role), 'peer_send', { resourceId: envelope.resourceId, sourceVersion: envelope.sourceVersion, fields: envelope.fields, payload, receipt }, id);
      t.wakeRoles[other(role)] = true; return receipt;
    });
    this.reconcile(w, t); return receipt;
  }
  reconcile(w, t) {
    const messages = w.messages.filter(m => m.taskId === t.id);
    if (t.type === 'schedule') {
      const a = messages.find(m => m.from === 'Alice' && m.resourceId === 'availability'); const b = messages.find(m => m.from === 'Bob' && m.resourceId === 'availability');
      if (!a || !b) return;
      const common = [];
      for (const x of a.payload.slots) for (const y of b.payload.slots) if (x.day === y.day) {
        const [xs, xe] = interval(x); const [ys, ye] = interval(y); const start = Math.max(xs, ys); const end = Math.min(xe, ye);
        if (end - start >= t.durationMinutes) common.push({ day: x.day, time: `${clock(start)}–${clock(start + t.durationMinutes)}` });
      }
      t.result = { outcome: common.length ? 'common_time_found' : 'no_common_time', meeting: common[0] ?? null, receipts: [a.id, b.id] }; t.status = 'completed';
    } else if (t.type === 'select_presentation') {
      const a = messages.find(m => m.from === 'Alice' && m.resourceId === 'report-interests'); const b = messages.find(m => m.from === 'Bob' && m.resourceId === 'report-interests');
      if (!a || !b || !t.mappings.some(m => m.id === 'individual-presentation')) return;
      const ids = a.payload.reportIds.filter(id => b.payload.reportIds.includes(id));
      const report = w.conference.reports.find(r => ids.includes(r.id));
      t.result = { outcome: report ? 'presentation_selected' : 'no_shared_presentation', report: clone(report ?? null), mappings: clone(t.mappings), receipts: [a.id, b.id] }; t.status = 'completed';
    } else if (t.type === 'prepare_discussion') {
      const reservation = w.reservations.find(r => r.taskId === t.id);
      const agendas = w.artifacts.filter(a => a.taskId === t.id && a.kind === 'agenda');
      if (reservation && agendas.length && ROLE_NAMES.every(role => messages.some(m => m.from === role))) { t.status = 'completed'; t.result = { outcome: 'discussion_prepared', reservation: clone(reservation.receipt),
        artifacts: agendas.map(a => ({ id: a.id, owner: a.owner, version: a.version })), receipts: messages.map(m => m.id) }; }
      else if (reservation) t.result = { outcome: 'reservation_confirmed_preparation_pending', reservation: clone(reservation.receipt) };
    }
  }
  async tool(id, taskId, role, name, args = {}) {
    const w = this.get(id); requireThat(ROLE_NAMES.includes(role), 'RESEARCH_ROLE', 'Invalid agent role.');
    return this.lock(w, async () => {
      const t = this.task(w, taskId);
      requireThat(t.type !== 'research_work' || t.initiator === role, 'RESEARCH_PRIVATE_TASK', 'This research task belongs to the other owner.', 403);
      const readOnly = ['knowledge_search', 'ontology_describe', 'peer_describe', 'authorization_list', 'receipt_inspect', 'task_status', 'resource_search'];
      requireThat(!['cancelled', 'completed', 'partial'].includes(t.status) || readOnly.includes(name), 'RESEARCH_TASK_CLOSED', 'This task is closed.', 409);
      const result = await this.toolUnlocked(w, t, role, name, args);
      await this.flush(w); await this.save(w); return clone(result);
    });
  }
  async toolUnlocked(w, t, role, name, args) {
    // The visible trace records real tool boundaries, never the model's private reasoning.
    // Query-only owner requests have no task and do not create collaboration activity.
    if (!w.tasks.some(task => task.id === t.id)) return this.toolImplementation(w, t, role, name, args);
    const started = this.activity(w, { taskId: t.id, role, kind: 'tool', direction: 'local', from: role,
      to: 'local-tools', name, status: 'started', details: { arguments: args } });
    await this.save(w);
    try {
      const result = await this.toolImplementation(w, t, role, name, args);
      this.activity(w, { taskId: t.id, role, kind: 'tool', direction: 'local', from: 'local-tools', to: role,
        name, status: 'completed', callId: started.id, details: { result } });
      if ((name === 'authorization_request' || name === 'authorization_propose_policy') && result.status === 'pending'
        && !w.activity.some(e => e.taskId === t.id && e.kind === 'approval' && e.name === name && e.requestId === result.id && e.revision === result.revision)) {
        this.activity(w, { taskId: t.id, role, kind: 'approval', direction: 'outgoing', from: role, to: `owner:${role}`,
          name, status: 'pending', requestId: result.id, revision: result.revision, details: result });
      }
      if (name === 'task_checkpoint') this.activity(w, { taskId: t.id, role, kind: 'checkpoint', direction: 'outgoing',
        from: role, to: `owner:${role}`, name, status: result.status, text: result.summary });
      await this.save(w); return result;
    } catch (error) {
      this.activity(w, { taskId: t.id, role, kind: 'tool', direction: 'local', from: 'local-tools', to: role,
        name, status: 'failed', callId: started.id, details: { code: error.code ?? 'RESEARCH_FAILURE', message: error.message } });
      await this.save(w); throw error;
    }
  }
  async toolImplementation(w, t, role, name, args) {
    const profile = w.profiles[role];
    if (name === 'knowledge_search') {
      let nodes = clone(profile.knowledge.nodes);
      const received = w.messages.filter(m => m.to === role).map(m => ({ id: m.id, type: 'ReceivedInformation', label: m.resourceId, properties: m.payload, source: m.receipt, version: m.sourceVersion }));
      nodes.push(...received);
      const q = String(args.query ?? '').toLowerCase();
      let selected = nodes.filter(n => (!args.type || n.type === args.type || n.type.endsWith(`:${args.type}`)) && (!args.ids || args.ids.includes(n.id)) && (!q || JSON.stringify(n).toLowerCase().includes(q)));
      const ids = new Set(selected.map(n => n.id));
      for (let i = 0; i < Math.min(2, Math.max(0, Number(args.hops ?? 1))); i++) {
        const frontier = new Set(ids);
        for (const edge of profile.knowledge.edges) if (frontier.has(edge.source) || frontier.has(edge.target)) { ids.add(edge.source); ids.add(edge.target); }
      }
      selected = nodes.filter(n => ids.has(n.id));
      return { owner: role, ontologyVersion: profile.ontology.version, nodes: selected, edges: profile.knowledge.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
        materials: profile.materials.filter(m => !q || JSON.stringify(m).toLowerCase().includes(q)), calendar: clone(profile.calendar),
        authorizations: w.authorizationProjection.filter(x => x.role === role && (!q || JSON.stringify(x).toLowerCase().includes(q))) };
    }
    if (name === 'knowledge_record') {
      const nodes = args.nodes ?? [], edges = args.edges ?? [];
      requireThat(Array.isArray(nodes) && Array.isArray(edges) && nodes.length + edges.length > 0 && nodes.length <= 32 && edges.length <= 64,
        'KNOWLEDGE_RECORD', 'Record a bounded set of typed research facts.');
      const concepts = new Map(profile.ontology.modules.flatMap(m => m.concepts).map(c => [c.id, c]));
      const relations = new Map(profile.ontology.modules.flatMap(m => m.relations).map(r => [r.id, r]));
      const prefix = role.toLowerCase() + ':';
      const knownSources = new Set([...profile.knowledge.nodes.map(n => n.id), ...profile.materials.map(m => m.id), ...w.messages.filter(m => m.to === role).map(m => m.id)]);
      const prepared = nodes.map(node => {
        requireThat(node && typeof node.id === 'string' && node.id.startsWith(prefix) && /^[A-Za-z0-9:_-]{1,160}$/.test(node.id), 'KNOWLEDGE_ID', 'A fact ID must belong to the current researcher.');
        const concept = concepts.get(node.type);
        requireThat(concept && !/Permission|Authorization|Grant|Policy|AgentSkill|ToolCapability/.test(node.type), 'KNOWLEDGE_TYPE', 'Use a declared research-domain type; authorization is issued separately.');
        requireThat(typeof node.label === 'string' && node.label.length > 0 && node.label.length <= 300, 'KNOWLEDGE_LABEL', 'Provide a short fact label.');
        const old = profile.knowledge.nodes.find(n => n.id === node.id);
        requireThat(!old || String(node.expectedVersion) === String(old.version), 'KNOWLEDGE_VERSION', 'Review the current fact version before changing it.', 409);
        const properties = node.properties ?? {}; const declared = new Map(); let current = concept;
        for (let i = 0; current && i < concepts.size; i++) { for (const p of current.properties ?? []) declared.set(p.key ?? p.id.split('.').at(-1), p); current = concepts.get(current.parent); }
        requireThat(properties && typeof properties === 'object' && !Array.isArray(properties) && Object.keys(properties).length <= 32, 'KNOWLEDGE_PROPERTIES', 'Use declared typed properties.');
        for (const [key, value] of Object.entries(properties)) {
          const property = declared.get(key);
          requireThat(property && !['__proto__', 'prototype', 'constructor'].includes(key), 'KNOWLEDGE_PROPERTY', 'The property is not declared in this ontology.');
          const type = property.datatype;
          requireThat(type === 'string[]' ? Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === 'string' && v.length <= 1000)
            : type === 'integer' ? Number.isSafeInteger(value) : ['number', 'decimal', 'float', 'double'].includes(type) ? typeof value === 'number' && Number.isFinite(value)
            : type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && value.length <= 8000, 'KNOWLEDGE_DATATYPE', 'The value does not match its ontology datatype.');
          const constraints = property.constraints ?? {};
          requireThat((!constraints.enum || constraints.enum.includes(value)) && (constraints.minimum === undefined || value >= constraints.minimum)
            && (constraints.maximum === undefined || value <= constraints.maximum) && (constraints.maxLength === undefined || typeof value !== 'string' || value.length <= constraints.maxLength), 'KNOWLEDGE_CONSTRAINT', 'The value violates its ontology constraints.');
          if (constraints.pattern === 'HH:MM–HH:MM') {
            requireThat(typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d[–-]([01]\d|2[0-3]):[0-5]\d$/.test(value)
              && interval({ time: value })[0] < interval({ time: value })[1], 'KNOWLEDGE_CONSTRAINT', 'Provide a valid same-day time interval.');
          }
        }
        const refs = node.sourceRefs ?? [];
        requireThat(Array.isArray(refs) && refs.length > 0 && refs.length <= 32 && refs.every(ref => knownSources.has(ref)), 'KNOWLEDGE_SOURCE', 'Facts require existing local or actually received sources.');
        return { id: node.id, type: node.type, label: node.label, properties: clone(properties), source: { taskId: t.id, references: clone(refs) }, version: String(Number(old?.version ?? 0) + 1), visibility: 'private' };
      });
      requireThat(new Set(prepared.map(n => n.id)).size === prepared.length, 'KNOWLEDGE_ID', 'A fact ID cannot be repeated.');
      const all = new Map([...profile.knowledge.nodes, ...prepared].map(n => [n.id, n]));
      const isType = (type, allowed) => {
        const visited = new Set(); while (type && !visited.has(type)) { if (allowed.includes(type) || allowed.includes('*')) return true; visited.add(type); type = concepts.get(type)?.parent; } return false;
      };
      const preparedEdges = edges.map(edge => {
        const relation = relations.get(edge.relation), source = all.get(edge.source), target = all.get(edge.target);
        requireThat(relation && source && target && isType(source.type, relation.domain) && isType(target.type, relation.range), 'KNOWLEDGE_RELATION', 'Relationship endpoints must satisfy the local ontology.');
        return { id: `${prefix}edge-${hashPayload([edge.source, edge.target, edge.relation]).slice(0, 24)}`, source: edge.source, target: edge.target, relation: edge.relation, sourceRecord: `task:${t.id}`, version: '1' };
      });
      if (this.knowledge?.record) await this.knowledge.record(role, { workspaceId: w.id, nodes: prepared, edges: preparedEdges });
      for (const node of prepared) { const index = profile.knowledge.nodes.findIndex(n => n.id === node.id); if (index < 0) profile.knowledge.nodes.push(node); else profile.knowledge.nodes[index] = node; }
      for (const edge of preparedEdges) if (!profile.knowledge.edges.some(e => e.id === edge.id)) profile.knowledge.edges.push(edge);
      return { owner: role, ontologyHash: profile.ontology.hash, nodes: prepared, edges: preparedEdges };
    }
    if (name === 'ontology_describe') return this.workingOntology(w, role, args.taskType ?? t.type);
    if (name === 'peer_describe') return { role: other(role), skills: w.profiles[other(role)].skills, ontology: t.ontology[other(role)] };
    if (name === 'artifact_prepare' || name === 'artifact_revise') {
      const fields = cleanFields(args.fields); const refs = args.sourceRefs ?? [];
      requireThat(Array.isArray(refs) && refs.length <= 32, 'ARTIFACT_SOURCES', 'Use a bounded source list.');
      const control = this.ledger(w, role).list();
      const controlSources = ['policies', 'requests', 'decisions', 'grants', 'operations'].flatMap(kind => control[kind].map(record => record.id));
      const known = new Set([...profile.knowledge.nodes.map(n => n.id), ...profile.materials.map(m => m.id), ...w.messages.filter(m => m.to === role).map(m => m.id), ...w.artifacts.filter(a => a.owner === role).map(a => a.id), ...controlSources]);
      requireThat(refs.every(ref => known.has(ref)), 'ARTIFACT_SOURCE', 'Only own or actually received sources may be used.');
      let artifact;
      if (name === 'artifact_revise') {
        artifact = w.artifacts.find(a => a.id === args.artifactId && a.owner === role && a.taskId === t.id);
        requireThat(artifact && artifact.version === args.expectedVersion, 'ARTIFACT_REVISION', 'Reload the current artifact version.', 409);
        if (artifact.kind === 'reservation') validateReservationFields(fields);
        artifact.history ??= []; artifact.history.push({ version: artifact.version, fields: artifact.fields, sourceRefs: artifact.sourceRefs }); artifact.version++;
        artifact.fields = fields; if (args.sourceRefs) artifact.sourceRefs = clone(refs);
      } else {
        requireThat(['brief', 'agenda', 'reservation'].includes(args.kind), 'ARTIFACT_KIND', 'Choose a supported artifact kind.');
        if (args.kind === 'reservation') validateReservationFields(fields);
        requireThat(typeof args.title === 'string' && args.title.length > 0 && args.title.length <= 200, 'ARTIFACT_TITLE', 'Provide a short artifact title.');
        artifact = { id: `artifact:${randomUUID()}`, taskId: t.id, owner: role, kind: args.kind, title: args.title, version: 1, fields, sourceRefs: clone(refs), visibility: 'private' }; w.artifacts.push(artifact);
      }
      this.reconcile(w, t); return artifact;
    }
    if (name === 'peer_request') {
      requireThat(['availability', 'report_interests', 'research_material', 'agenda_review'].includes(args.kind), 'PEER_REQUEST', 'Choose a structured request kind.');
      requireThat(!args.recipient || args.recipient === other(role), 'RESEARCH_RECIPIENT', 'Request information only from the paired agent.');
      const request = { id: randomUUID(), taskId: t.id, from: role, to: other(role), kind: args.kind };
      t.requests ??= []; t.requests.push(request);
      this.conversation(w, t, role, other(role), name, request, request.id);
      t.wakeRoles[other(role)] = true; return request;
    }
    if (name === 'peer_send') return this.send(w, t, role, args);
    if (name === 'alignment_propose') {
      requireThat(Array.isArray(args.mappingIds) && args.mappingIds.length > 0 && args.mappingIds.length <= 12, 'RESEARCH_MAPPING', 'Choose mapping candidates.');
      const candidates = this.mappingCandidates(t); const mappings = args.mappingIds.map(id => candidates.find(m => m.id === id));
      requireThat(mappings.every(Boolean), 'RESEARCH_MAPPING', 'Unknown mapping candidate.');
      const proposal = { id: randomUUID(), from: role, mappings: clone(mappings), ontologyHashes: Object.fromEntries(ROLE_NAMES.map(r => [r, t.ontology[r].hash])), status: 'proposed' };
      t.proposals.push(proposal);
      this.conversation(w, t, role, other(role), name, proposal, proposal.id);
      t.wakeRoles[other(role)] = true; return proposal;
    }
    if (name === 'alignment_accept') {
      const proposal = t.proposals.find(p => p.id === args.proposalId); requireThat(proposal && proposal.from !== role, 'RESEARCH_MAPPING_PEER', 'The paired agent must review a proposal.');
      proposal.status = proposal.mappings.every(m => m.valid) ? 'accepted' : 'rejected'; proposal.reviewedBy = role;
      if (proposal.status === 'accepted') t.mappings = clone(proposal.mappings);
      this.conversation(w, t, role, other(role), name, proposal, proposal.id);
      this.reconcile(w, t); t.wakeRoles[other(role)] = true; return proposal;
    }
    if (name === 'authorization_list') {
      const records = this.ledger(w, role).list();
      w.events.push({ role, taskId: t.id, kind: 'authorization_recalled', policyIds: records.policies.map(p => p.id), at: new Date().toISOString() });
      return { ...records, policyCandidates: clone(w.policyCandidates[role]) };
    }
    if (name === 'authorization_propose_policy') {
      requireThat(['allow', 'ask', 'deny'].includes(args.effect) && Array.isArray(args.actions) && args.actions.length > 0 && args.actions.every(a => ['peer.send', 'reservation.submit'].includes(a)), 'POLICY_CANDIDATE', 'Use a supported policy effect and action.');
      requireThat(Array.isArray(args.recipients) && args.recipients.length > 0 && args.recipients.every(r => [other(role), 'conference-reservations'].includes(r))
        && Array.isArray(args.purposes) && args.purposes.length > 0 && args.purposes.every(p => p === purpose), 'POLICY_CANDIDATE', 'Use explicit known recipients and purpose.');
      requireThat((Array.isArray(args.resources) && args.resources.length > 0 && args.resources.length <= 32 && args.resources.every(id => typeof id === 'string'))
        || ['public', 'availability'].includes(args.resourceClass), 'POLICY_CANDIDATE', 'Select explicit resources or a trusted public/availability classification.');
      requireThat(args.fields === undefined || Array.isArray(args.fields) && args.fields.length > 0 && args.fields.length <= 32
        && new Set(args.fields).size === args.fields.length && args.fields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)), 'POLICY_CANDIDATE', 'Use a bounded selection of source fields.');
      const policy = { effect: args.effect, actions: clone(args.actions), recipients: clone(args.recipients), purposes: clone(args.purposes), projectId: w.projectId,
        ...(args.resources?.length ? { resources: clone(args.resources) } : {}), ...(args.resourceClass ? { resourceClass: args.resourceClass } : {}),
        ...(args.fields ? { fields: clone(args.fields) } : {}),
        ...(args.label ? { label: String(args.label).slice(0, 300) } : {}) };
      const hash = hashPayload(policy); let candidate = w.policyCandidates[role].find(c => c.hash === hash && c.taskId === t.id);
      if (!candidate) { candidate = { id: randomUUID(), taskId: t.id, owner: role, status: 'pending', hash, policy, createdAt: new Date().toISOString() }; w.policyCandidates[role].push(candidate); }
      if (candidate.status === 'pending') t.status = 'needs_owner'; return candidate;
    }
    if (name === 'authorization_check' || name === 'authorization_request') {
      const intent = this.intent(w, t, role, args); const ledger = this.ledger(w, role);
      const check = ledger.check(intent);
      if (name === 'authorization_check') {
        w.events.push({ role, taskId: t.id, kind: 'authorization_checked', resourceId: intent.resourceId, fields: intent.fields,
          status: check.status, basisId: check.basisId ?? null, at: new Date().toISOString() });
        return { ...check, intent };
      }
      if (check.status === 'allowed') return { ...check, intent };
      const request = ledger.request(intent); if (request.status === 'pending') t.status = 'needs_owner'; return request;
    }
    if (name === 'resource_search') return w.conference.venues.filter(v => (v.capacity ?? 0) >= (args.capacity ?? 0) && (args.equipment ?? []).every(e => (v.equipment ?? []).includes(e)));
    if (name === 'reservation_submit') {
      const intent = this.intent(w, t, role, { ...args, action: 'reservation.submit' });
      const receipt = await this.execute(w, t, role, intent, async operationId => {
        const day = intent.values.day; const time = intent.values.time;
        const venue = w.conference.venues.find(v => v.id === args.venueId);
        requireThat(typeof day === 'string' && typeof time === 'string' && /^\d{2}:\d{2}[–-]\d{2}:\d{2}$/.test(time), 'RESERVATION_TIME', 'The reservation needs a valid day and time.');
        const [start, end] = interval({ time });
        requireThat(start < end && venue.availableTimes.some(row => row.day === day && interval(row)[0] <= start && interval(row)[1] >= end)
          && Number(intent.values.attendees) <= venue.capacity, 'VENUE_UNAVAILABLE', 'The room does not meet the requested time or capacity.', 409);
        requireThat(!w.reservations.some(r => r.venueId === args.venueId && r.day === day && interval(r)[0] < end && interval(r)[1] > start), 'VENUE_UNAVAILABLE', 'The room is no longer available.', 409);
        const receipt = { operationId, status: 'confirmed', reservationId: `CONF-${randomUUID().slice(0, 8).toUpperCase()}`, venueId: args.venueId, day, time, confirmedAt: new Date().toISOString() };
        w.reservations.push({ operationId, owner: role, taskId: t.id, venueId: args.venueId, day, time, values: clone(intent.values), receipt }); return receipt;
      });
      this.reconcile(w, t); return receipt;
    }
    if (name === 'receipt_inspect') return { messages: w.messages.filter(m => m.taskId === t.id && (m.from === role || m.to === role) && (!args.operationId || args.operationId === m.id)),
      reservations: w.reservations.filter(r => r.taskId === t.id && (!args.operationId || args.operationId === r.operationId)).map(r => ({ ...clone(r), ...(r.owner !== role ? { values: undefined } : {}) })) };
    if (name === 'task_checkpoint') {
      requireThat(['working', 'waiting_peer', 'needs_owner', 'complete'].includes(args.status), 'TASK_CHECKPOINT', 'Choose a checkpoint state.');
      t.checkpoints[role] = { status: args.status, summary: String(args.summary ?? '').slice(0, 1500), at: new Date().toISOString() };
      if (t.type === 'research_work' && args.status === 'complete') {
        const artifacts = w.artifacts.filter(a => a.taskId === t.id && a.owner === role).map(a => ({ id: a.id, version: a.version }));
        const facts = profile.knowledge.nodes.filter(n => n.source?.taskId === t.id).map(n => ({ id: n.id, version: n.version }));
        requireThat(artifacts.length + facts.length > 0, 'RESEARCH_RESULT_REQUIRED', 'Save a sourced research artifact or fact before completing the task.');
        t.status = 'completed'; t.result = { outcome: 'research_work_saved', owner: role, artifacts, facts };
      }
      if (args.status === 'needs_owner' && (this.ledger(w, role).pendingRequests().some(r => r.intent.taskId === t.id)
        || w.policyCandidates[role].some(c => c.taskId === t.id && c.status === 'pending'))) t.status = 'needs_owner';
      return t.checkpoints[role];
    }
    if (name === 'task_status') {
      const { ontology, mappingReview, ...task } = this.taskView(t, role);
      task.ontologyVersions = Object.fromEntries(ROLE_NAMES.map(r => [r, { id: t.ontology[r].id, version: t.ontology[r].version, hash: t.ontology[r].hash }]));
      return { task, received: w.messages.filter(m => m.to === role && m.taskId === t.id),
      artifacts: w.artifacts.filter(a => a.owner === role && a.taskId === t.id), requests: (t.requests ?? []).filter(r => r.to === role),
      pending: this.ledger(w, role).pendingRequests(), policyCandidates: clone(w.policyCandidates[role]), conference: w.conference, mappingCandidates: this.mappingCandidates(t),
      authorizationDecisions: this.ledger(w, role).list().requests.filter(r => r.intent.taskId === t.id && r.status !== 'pending'),
      ownCalendar: clone(profile.calendar),
      sourceResources: [
        { id: 'availability', version: profile.ontology.version, label: 'Scoped offered availability', fields: ['slots'], description: 'Use peer_send({resourceId:"availability"}); server projects only day, time and status.' },
        { id: 'report-interests', version: profile.ontology.version, label: 'Independently relevant presentation IDs and local interest terms', fields: ['reportIds', 'interests'] },
        ...profile.materials.map(m => ({ id: m.id, version: m.version, label: m.label, fields: Object.keys(m.fields) })),
        ...w.artifacts.filter(a => a.owner === role && a.taskId === t.id).map(a => ({ id: a.id, version: a.version, kind: a.kind, label: a.title, fields: Object.keys(a.fields) }))],
      relatedResults: { schedule: w.tasks.find(item => item.id === t.input.scheduleTask)?.result ?? null,
        presentation: w.tasks.find(item => item.id === t.input.reportTask)?.result?.report ?? null } };
    }
    throw new AppError('RESEARCH_TOOL', 'The tool is not registered.', 404);
  }
  async decide(id, role, requestId, input) {
    const w = this.get(id);
    await this.lock(w, async () => {
      const currentRequest = this.ledger(w, role).getRequest(requestId);
      requireThat(currentRequest, 'AUTHORIZATION_NOT_FOUND', 'This request does not belong to this owner.', 404);
      const currentTask = this.task(w, currentRequest.intent.taskId);
      requireThat(!['completed', 'partial', 'cancelled'].includes(currentTask.status), 'TASK_FINISHED', 'The task has finished.', 409);
      if (currentRequest.intent.action === 'reservation.submit' && input.decision !== 'deny' && input.fields) {
        requireThat(input.fields.length === currentRequest.intent.fields.length && currentRequest.intent.fields.every(f => input.fields.includes(f)), 'RESERVATION_FIELDS', 'Review and approve the complete reservation form.');
      }
      const result = this.ledger(w, role).decide(requestId, input, `${w.id}:${role}`);
      const request = result.request; const t = this.task(w, request.intent.taskId);
      this.activity(w, { taskId: t.id, role, kind: 'approval', direction: 'incoming', from: `owner:${role}`, to: role,
        name: 'owner_decision', requestId, status: request.status,
        details: { requestId, decision: input.decision, approvedIntent: request.approvedIntent ?? null } });
      t.wakeRoles[role] = true; t.status = 'running'; await this.flush(w); await this.save(w);
    });
    if (this.blockedRoles.has(role)) {
      try { await this.recoverRole(role); }
      catch (error) { const task = this.task(w, this.ledger(w, role).getRequest(requestId).intent.taskId); task.status = 'paused'; task.error = `${error.code ?? 'HERMES_RUN_UNSETTLED'}: 许可已保存，等待核验之前的原生运行。`; await this.save(w); }
    }
    const t = w.tasks.findLast(item => item.status === 'running');
    if (t?.mode === 'controlled') await this.drive(w, t); else this.wakeNative(w);
    return this.view(w, role);
  }
  async ownerPolicy(id, role, input) {
    const w = this.get(id); await this.lock(w, async () => { this.ledger(w, role).policy({ ...input, projectId: w.projectId }, `${w.id}:${role}`); await this.flush(w); }); return this.view(w, role);
  }
  async decidePolicy(id, role, candidateId, input) {
    const w = this.get(id);
    await this.lock(w, async () => {
      const c = w.policyCandidates[role].find(item => item.id === candidateId);
      requireThat(c && c.status === 'pending' && c.hash === input.expectedHash, 'POLICY_CANDIDATE_STALE', 'Review the current proposed rule.', 409);
      requireThat(['allow', 'deny'].includes(input.decision), 'POLICY_CANDIDATE', 'Confirm or decline the rule.');
      const t = this.task(w, c.taskId); requireThat(!['completed', 'partial', 'cancelled'].includes(t.status) && !w.endedAt, 'TASK_FINISHED', 'This request has ended.', 409);
      if (input.decision === 'allow') c.policyId = this.ledger(w, role).policy(c.policy, `${w.id}:${role}`).id;
      c.status = input.decision === 'allow' ? 'approved' : 'denied'; c.decidedAt = new Date().toISOString();
      this.activity(w, { taskId: t.id, role, kind: 'approval', direction: 'incoming', from: `owner:${role}`, to: role,
        name: 'owner_policy_decision', requestId: c.id, status: c.status, details: { decision: input.decision, policyId: c.policyId ?? null, policy: c.policy } });
      if (t.type === 'research_work') { t.status = 'completed'; t.result = { outcome: input.decision === 'allow' ? 'policy_remembered' : 'policy_not_adopted', owner: role, policyId: c.policyId ?? null }; }
      else { t.status = 'running'; t.wakeRoles[role] = true; }
      await this.flush(w); await this.save(w);
    });
    this.wakeNative(w); return this.view(w, role);
  }
  async revoke(id, role, recordId) { const w = this.get(id); await this.lock(w, async () => { this.ledger(w, role).revoke(recordId, {}, `${w.id}:${role}`); await this.flush(w); }); return this.view(w, role); }
  async end(id) {
    const w = this.get(id);
    await this.lock(w, async () => {
      for (const t of w.tasks) if (!['completed', 'partial', 'cancelled'].includes(t.status)) { t.status = 'cancelled'; t.wakeRoles = { Alice: false, Bob: false }; }
      for (const [role, assignment] of this.assignments) if (assignment.workspaceId === w.id) {
        assignment.retired = true; this.controllers.get(assignment.assignmentId)?.abort('workspace_ended');
      }
      w.endedAt = new Date().toISOString(); await this.save(w);
    });
    return this.view(w, 'Alice');
  }
  async resume(id, taskId) {
    const w = this.get(id); const t = this.task(w, taskId);
    requireThat(!w.endedAt, 'RESEARCH_ENDED', 'This experience has ended.', 409);
    if (t.mode === 'native') {
      requireThat(this.nativeClient, 'RESEARCH_MODE', 'Configure native Hermes before resuming this task.', 409);
      for (const role of [...this.blockedRoles]) await this.recoverRole(role);
    }
    await this.lock(w, async () => {
      requireThat(!['completed', 'cancelled', 'partial'].includes(t.status), 'TASK_FINISHED', 'The task has finished.', 409);
      t.status = 'running'; t.error = null; t.wakeRoles = { Alice: t.type !== 'research_work' || t.initiator === 'Alice', Bob: t.type !== 'research_work' || t.initiator === 'Bob' };
      for (const role of ROLE_NAMES.filter(r => t.wakeRoles[r])) this.activity(w, { taskId: t.id, role, kind: 'run', direction: 'incoming', from: 'controller', to: role, name: 'task_resume', status: 'resumed' });
      await this.save(w);
    });
    if (t.mode === 'controlled') await this.drive(w, t); else this.wakeNative(w); return this.view(w, 'Alice');
  }
  async controlledAction(w, t, role, action, args) {
    const intent = this.intent(w, t, role, { ...args, action }); const ledger = this.ledger(w, role);
    const existing = ledger.list().requests.find(r => r.intent.taskId === t.id && r.intent.resourceId === intent.resourceId && r.intent.action === action && r.status === 'approved');
    const effective = existing?.approvedIntent ?? intent;
    const previous = ledger.getOperation(this.operationId(effective));
    if (previous?.status === 'succeeded') return { status: 'allowed', receipt: previous.receipt };
    const check = ledger.check(effective);
    this.activity(w, { taskId: t.id, role, kind: 'tool', direction: 'local', from: 'local-tools', to: role,
      name: 'authorization_check', status: 'completed', details: { result: { ...check, intent: effective } } });
    if (check.status !== 'allowed') {
      if (check.status === 'needs_approval') {
        const request = ledger.request(intent);
        if (!w.activity.some(e => e.kind === 'approval' && e.name === 'authorization_request' && e.requestId === request.id && e.revision === request.revision)) {
          this.activity(w, { taskId: t.id, role, kind: 'approval', direction: 'outgoing', from: role, to: `owner:${role}`,
            name: 'authorization_request', status: request.status, requestId: request.id, revision: request.revision, details: request });
        }
      }
      t.status = check.status === 'denied' ? 'running' : 'needs_owner'; return { status: check.status };
    }
    const narrowed = { ...args, fields: effective.fields.filter(f => f !== 'venueId') };
    const receipt = await this.toolUnlocked(w, t, role, action === 'peer.send' ? 'peer_send' : 'reservation_submit', narrowed); return { status: 'allowed', receipt };
  }
  async drive(w, t) {
    return this.lock(w, async () => {
      if (t.status === 'completed') return;
      try {
        if (t.type === 'schedule') {
          for (const role of ROLE_NAMES) { const out = await this.controlledAction(w, t, role, 'peer.send', { resourceId: 'availability' }); if (out.status === 'needs_approval') break; if (out.status === 'denied') { t.status = 'partial'; t.result = { outcome: 'sharing_declined' }; break; } }
        } else if (t.type === 'select_presentation') {
          if (!t.mappings.length) {
            const mappings = this.mappingCandidates(t).filter(m => m.valid);
            const proposal = await this.toolUnlocked(w, t, 'Alice', 'alignment_propose', { mappingIds: mappings.map(m => m.id) });
            await this.toolUnlocked(w, t, 'Bob', 'alignment_accept', { proposalId: proposal.id });
          }
          for (const role of ROLE_NAMES) { const out = await this.controlledAction(w, t, role, 'peer.send', { resourceId: 'report-interests' }); if (out.status === 'needs_approval') break; if (out.status === 'denied') { t.status = 'partial'; t.result = { outcome: 'sharing_declined' }; break; } }
        } else {
          for (const role of ROLE_NAMES) {
            const intro = w.profiles[role].materials.find(m => m.visibility === 'public');
            if (intro) await this.controlledAction(w, t, role, 'peer.send', { resourceId: intro.id });
          }
          const material = w.profiles.Alice.materials.find(m => m.visibility !== 'public');
          if (material) {
            const out = await this.controlledAction(w, t, 'Alice', 'peer.send', { resourceId: material.id });
            if (out.status === 'needs_approval') { await this.flush(w); await this.save(w); return; }
          }
          let agenda = w.artifacts.find(a => a.taskId === t.id && a.kind === 'agenda');
          if (!agenda) agenda = await this.toolUnlocked(w, t, 'Bob', 'artifact_prepare', { kind: 'agenda', title: '可理解、可控的 Agent 语义协作',
            fields: { topic: '语义映射的依据与人的控制', agenda: '研究问题与方法概述；映射审阅交互；后续合作问题' },
            sourceRefs: w.messages.filter(m => m.taskId === t.id && m.to === 'Bob').map(m => m.id) });
          // The organizer prepares the final form using public topic information; restricted excerpts are not copied into it.
          let form = w.artifacts.find(a => a.taskId === t.id && a.kind === 'reservation');
          if (!form) form = await this.toolUnlocked(w, t, 'Alice', 'artifact_prepare', { kind: 'reservation', title: '会后专题讨论场地预约',
            fields: { title: 'Agent 语义协作专题讨论', day: 'Thu', time: '15:00–15:30', attendees: '8', agenda: '语义映射方法与人机交互设计交流' },
            sourceRefs: w.profiles.Alice.materials.filter(m => m.visibility === 'public').map(m => m.id) });
          const venue = w.conference.venues.find(v => v.capacity >= 8) ?? w.conference.venues[0];
          const out = await this.controlledAction(w, t, 'Alice', 'reservation.submit', { resourceId: form.id, venueId: venue.id });
          if (out.status === 'denied') { t.status = 'partial'; t.result = { outcome: 'prepared_not_submitted', agendaId: agenda.id, reservationSubmitted: false }; }
        }
        this.reconcile(w, t);
        if (t.type === 'select_presentation' && !t.mappings.some(m => m.id === 'individual-presentation') && t.status === 'running') {
          t.status = 'paused'; t.error = '当前本体定义没有可用的已登记报告映射，请先审阅并登记新的对应关系。';
        }
        await this.flush(w); await this.save(w);
      } catch (error) { t.status = 'paused'; t.error = `${error.code ?? 'RESEARCH_FAILURE'}: ${error.message}`; await this.save(w); throw error; }
    });
  }
  agentContext(token) {
    const role = ROLE_NAMES.find(r => this.agentTokens[r] && digest(this.agentTokens[r]) === digest(token ?? ''));
    requireThat(role, 'RESEARCH_AGENT_AUTH', 'The agent gateway credential is invalid.', 401);
    const assignment = this.assignments.get(role); requireThat(assignment && !assignment.retired, 'RESEARCH_ASSIGNMENT', 'No task is assigned to this agent.', 409); return clone(assignment);
  }
  async recoverRole(role) {
    requireThat(this.nativeClient?.reconcile, 'HERMES_RUN_UNSETTLED', 'The interrupted native run requires reconciliation.', 409);
    let adopted = false;
    for (const w of this.workspaces.values()) for (const task of w.tasks) {
      const record = task.nativeRuns?.[role]; if (!record || record.status === 'settled') continue;
      const result = await this.nativeClient.reconcile({ role, runId: record.runId, requestId: record.requestId, input: record.input, instructions: record.instructions });
      requireThat(result?.settled === true, 'HERMES_RUN_UNSETTLED', 'The interrupted native run has not been confirmed stopped.', 409);
      record.status = 'settled'; record.reconciledAt = new Date().toISOString(); adopted = true; await this.save(w);
    }
    if (!adopted) {
      const result = await this.nativeClient.reconcile({ role });
      requireThat(result?.settled === true, 'HERMES_RUN_UNSETTLED', 'The previous native run has not stopped.', 409);
    }
    this.blockedRoles.delete(role); this.assignments.delete(role);
  }
  stopAtCheckpoint(w, task, role, reason) {
    const targets = reason === 'verified_task_finished' ? ROLE_NAMES : [role];
    for (const target of targets) {
      const assignment = this.assignments.get(target);
      if (!assignment || assignment.workspaceId !== w.id || assignment.taskId !== task.id) continue;
      const assignmentId = assignment.assignmentId;
      // Give the tool response a chance to flush; the checkpoint is already durable.
      setTimeout(() => {
        const current = this.assignments.get(target);
        if (current?.assignmentId !== assignmentId) return;
        current.retired = true; this.controllers.get(assignmentId)?.abort(reason);
      }, 0).unref();
    }
  }
  async agentTool(token, input) {
    const assignment = this.agentContext(token);
    requireThat(input.assignmentId === assignment.assignmentId, 'RESEARCH_STALE_RUN', 'The agent run has been superseded.', 409);
    requireThat(assignment.toolBudget > 0, 'RESEARCH_BUDGET', 'The task tool budget has been exhausted.', 429);
    this.assignments.get(assignment.role).toolBudget--;
    const task = this.task(this.get(assignment.workspaceId), assignment.taskId);
    if (['completed', 'partial', 'cancelled'].includes(task.status)
      && !['task_status', 'knowledge_search', 'ontology_describe', 'peer_describe', 'authorization_list', 'receipt_inspect', 'resource_search'].includes(input.name)) {
      return { status: 'task_finished', task: this.taskView(task, assignment.role), instruction: 'The task has finished from verified records. End this run without further mutations.' };
    }
    const result = await this.tool(assignment.workspaceId, assignment.taskId, assignment.role, input.name, input.arguments ?? {});
    const w = this.get(assignment.workspaceId);
    if (['completed', 'partial'].includes(task.status)) this.stopAtCheckpoint(w, task, assignment.role, 'verified_task_finished');
    else if (['authorization_request', 'authorization_propose_policy'].includes(input.name) && result.status === 'pending') {
      task.checkpoints[assignment.role] = { status: 'needs_owner', requestId: result.id, summary: '已保存具体请求，等待主人决定。', at: new Date().toISOString() };
      await this.save(w); this.stopAtCheckpoint(w, task, assignment.role, 'owner_decision_required');
    } else if (input.name === 'task_checkpoint' && ['waiting_peer', 'needs_owner'].includes(input.arguments?.status)) {
      this.stopAtCheckpoint(w, task, assignment.role, 'checkpoint_saved');
    }
    this.wakeNative(w); return result;
  }
  wakeNative(w) {
    if (!this.nativeClient || this.closed) return;
    for (const role of ROLE_NAMES) {
      if (this.roleBusy.has(role) || this.blockedRoles.has(role)) continue;
      const task = w.tasks.find(t => t.mode === 'native' && t.status === 'running' && t.wakeRoles[role]);
      if (!task) continue;
      const run = this.runNative(w, task, role); this.roleBusy.set(role, run); this.running.add(run);
      run.finally(() => { this.roleBusy.delete(role); this.running.delete(run); if (!this.closed) for (const workspace of this.workspaces.values()) this.wakeNative(workspace); }).catch(() => {});
    }
  }
  async runNative(w, t, role) {
    const assignmentId = randomUUID(); t.wakeRoles[role] = false; t.runCounts[role]++;
    if (t.runCounts[role] > 12) { t.status = 'paused'; t.error = '原生协作运行预算已用尽。'; await this.save(w); return; }
    this.assignments.set(role, { assignmentId, workspaceId: w.id, taskId: t.id, role, toolBudget: 64 });
    const controller = new AbortController(); this.controllers.set(assignmentId, controller);
    try {
      this.activity(w, { taskId: t.id, role, kind: 'run', direction: 'local', from: 'controller', to: role, name: 'native_run', status: 'started' });
      await this.save(w);
      const instructions = `You are ${role}, the ${role === 'Alice' ? 'knowledge graph and semantic technologies' : 'human-computer interaction'} researcher’s personal agent. Use native research skills and tools. Your task type is ${t.type}. Start with task_status and research_skills_list/research_skill_view. Query your ontology, knowledge and current authorization. Only actual received facts may inform peer-dependent decisions. Do not claim a send/reservation without its receipt. Use structured peer requests and source/draft references. For schedule both sides send availability. For select_presentation review mapping candidates, propose/review valid mappings and exchange report-interests. For prepare_discussion exchange public introductions, request a selected Alice research brief, jointly prepare an agenda, and let Alice prepare a reservation draft and request owner approval. Use authorization_request for any unapproved disclosure or reservation; then task_checkpoint needs_owner and end this run. On receipt/owner decision resume from task_status and check authorization again; use approvedIntent.fields if narrowed. Final text is explanatory only. Do not recreate an existing artifact or action unnecessarily. Source ids and conference/venue ids are supplied by tools. Planning and drafting are autonomous; publishing or booking requires current authorization.`;
      const ownWork = t.type === 'research_work' ? ' For this private owner research task, do not coordinate with the peer unless the owner asks. Use knowledge_record for sourced domain facts and artifact_prepare for a sourced answer. For an instruction about future permissions, use authorization_propose_policy to propose the explicit rule, then checkpoint needs_owner. A proposed policy is not effective until the owner confirms it. Complete ordinary research work with a saved sourced artifact and task_checkpoint complete.' : '';
      const toolGuidance = ' Tools bind identity and task automatically. NEVER supply role, task_id, workspace_id or assignmentId in tool arguments. task_status({}) returns exact sourceResources and valid mappingCandidates. Load only one relevant skill per run; use targeted knowledge queries, and prioritize the current collaboration action. Do not write unrelated research notes during shared demo tasks; ordinary memory maintenance has separate private research_work tasks. Scheduling: authorization_check({action:"peer.send",resourceId:"availability"}), then peer_send({resourceId:"availability"}) if allowed. Report selection: source resource is "report-interests"; use mapping IDs returned by task_status and review your peer proposal. For prepare_discussion, after exchanging public-intro, Alice requests approval to share fields ["summary","method"] of alice:research-brief, then checkpoints needs_owner and ends this run; Bob requests research_material and checkpoints waiting_peer until actual reception. After disclosure, Bob prepares an agenda with received source refs and Alice prepares the final reservation form, requests reservation.submit approval with exact resourceId and venueId, checkpoints needs_owner and ends. Use relatedResults if provided. For owner approval pass the SAME action/resourceId/fields/venueId that execution will use. task_checkpoint requires status and summary. If already delivered, inspect its receipt instead of asking again. If task_status says completed/partial/cancelled, end the run immediately.';
      const reservationGuidance = ' A reservation artifact must use text fields title, day, time, attendees, agenda. Example shape only: {title:"Joint discussion",day:"Thu",time:"15:00–15:30",attendees:"8",agenda:"Methods and interaction review"}; choose actual values from task and venue data. Extra meeting/context fields cannot replace these required keys.';
      const input = `Continue task ${t.id} in workspace ${w.id}. Use task_status to retrieve checkpoint and actual state.${t.initiator === role && t.ownerGoal ? ` Authenticated owner request: ${t.ownerGoal}` : ''}`;
      const effectiveInstructions = instructions + ownWork + toolGuidance + reservationGuidance;
      t.nativeRuns ??= {}; t.nativeRuns[role] = { assignmentId, requestId: `research-${assignmentId}`, input, instructions: effectiveInstructions,
        runId: null, status: 'submitted', startedAt: new Date().toISOString() };
      await this.save(w);
      const output = await this.nativeClient.run({ role, input, instructions: effectiveInstructions,
        requestId: `research-${assignmentId}`, signal: controller.signal,
        onAdmitted: async ({ runId }) => { await this.lock(w, async () => { t.nativeRuns[role].runId = runId; await this.save(w); }); } });
      await this.lock(w, async () => {
        w.events.push({ role, taskId: t.id, kind: 'native_run_completed', at: new Date().toISOString(), status: output.status ?? 'completed' });
        this.activity(w, { taskId: t.id, role, kind: 'run', direction: 'local', from: role, to: 'controller', name: 'native_run', status: output.status ?? 'completed' });
        if (typeof output.output === 'string' && output.output.trim()) this.activity(w, { taskId: t.id, role, kind: 'response', direction: 'outgoing',
          from: role, to: `owner:${role}`, name: 'assistant_response', status: 'explanatory', text: output.output.slice(0, 12000) });
        this.reconcile(w, t); await this.save(w);
      });
    } catch (error) {
      const intentional = ['owner_decision_required', 'checkpoint_saved', 'verified_task_finished'].includes(controller.signal.reason);
      if (error.code === 'HERMES_RUN_UNSETTLED') { this.blockedRoles.add(role); if (this.assignments.get(role)) this.assignments.get(role).retired = true; }
      await this.lock(w, async () => {
        if (intentional && error.code !== 'HERMES_RUN_UNSETTLED') w.events.push({ role, taskId: t.id,
          kind: controller.signal.reason === 'verified_task_finished' ? 'native_run_completed' : 'native_run_checkpoint', status: controller.signal.reason, at: new Date().toISOString() });
        else if (!['completed', 'cancelled', 'partial'].includes(t.status)) { t.status = 'paused'; t.error = `${error.code ?? 'NATIVE_FAILURE'}: ${error.message}`; }
        this.activity(w, { taskId: t.id, role, kind: intentional ? 'checkpoint' : 'run', direction: 'local', from: role, to: 'controller',
          name: 'native_run', status: intentional ? controller.signal.reason : 'failed',
          ...(!intentional ? { details: { code: error.code ?? 'NATIVE_FAILURE', message: error.message } } : {}) });
        await this.save(w);
      });
    }
    finally {
      if (t.nativeRuns?.[role]?.assignmentId === assignmentId) { t.nativeRuns[role].status = this.blockedRoles.has(role) ? 'unsettled' : 'settled'; await this.save(w); }
      this.controllers.delete(assignmentId); if (this.assignments.get(role)?.assignmentId === assignmentId && !this.blockedRoles.has(role)) this.assignments.delete(role);
      if (!this.closed && t.status === 'running' && !ROLE_NAMES.some(r => this.assignments.get(r)?.taskId === t.id) && !ROLE_NAMES.some(r => t.wakeRoles[r])) {
        t.status = 'paused'; t.error = 'Agents 已结束本轮运行，但任务所需的交换或操作尚未完成；可查看记录后恢复。'; await this.save(w);
      }
    }
  }
  close() {
    this.closePromise ??= (async () => { this.closed = true; for (const controller of this.controllers.values()) controller.abort('service_closing');
      clearInterval(this.projectionTimer); await Promise.allSettled([...this.running]); for (const pending of this.queues.values()) await pending;
      await Promise.allSettled([...this.projectionRuns.values()]);
      for (const rows of this.ledgers.values()) for (const ledger of Object.values(rows)) ledger.close(); this.stateDB?.close(); })();
    return this.closePromise;
  }
}
