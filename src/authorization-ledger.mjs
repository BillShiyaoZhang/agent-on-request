import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError, requireThat } from './errors.mjs';

const clone = value => structuredClone(value);
const id = prefix => `${prefix}-${randomUUID()}`;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = (code, message, status = 409) => { throw new AppError(code, message, status); };
const string = (value, label, limit = 500) => {
  requireThat(typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f]/.test(value), 'AUTHORIZATION_INPUT', `${label} must be a bounded nonempty string.`, 422);
  return value;
};
function safeJSON(value, depth = 0) {
  requireThat(depth < 24, 'AUTHORIZATION_INPUT', 'Authorization content is too deeply nested.', 422);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'AUTHORIZATION_INPUT', 'Authorization numbers must be finite.', 422); return value; }
  if (Array.isArray(value)) return value.map(item => safeJSON(item, depth + 1));
  requireThat(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'AUTHORIZATION_INPUT', 'Authorization content must contain JSON values.', 422);
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    requireThat(!forbidden.has(key), 'AUTHORIZATION_INPUT', 'Unsafe authorization content key.', 422);
    return [key, safeJSON(value[key], depth + 1)];
  }));
}
const canonical = value => JSON.stringify(safeJSON(value));
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function strings(value, label, { empty = false } = {}) {
  requireThat(Array.isArray(value) && value.length <= 100 && (empty || value.length > 0), 'AUTHORIZATION_INPUT', `${label} must be a bounded list.`, 422);
  const result = value.map(item => string(item, label));
  requireThat(new Set(result).size === result.length, 'AUTHORIZATION_INPUT', `${label} must be unique.`, 422);
  return result.sort();
}
function timestamp(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  requireThat(Number.isFinite(parsed) && parsed >= 0, 'AUTHORIZATION_INPUT', 'Use a valid authorization expiry.', 422);
  return parsed;
}
function uses(value, fallback = 1) {
  if (value === undefined) return fallback;
  requireThat(Number.isSafeInteger(value) && value > 0 && value <= 100_000, 'AUTHORIZATION_INPUT', 'Authorization usage limits must be positive bounded integers.', 422);
  return value;
}

/** Only the trusted tool backend may construct an intent, including its resource classification. */
export function canonicalIntent(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'AUTHORIZATION_INPUT', 'An action intent is required.', 422);
  const allowed = ['taskId', 'projectId', 'action', 'resourceId', 'resourceVersion', 'resourceClass', 'recipient', 'purpose', 'fields', 'values'];
  requireThat(Object.keys(input).every(key => allowed.includes(key)), 'AUTHORIZATION_INPUT', 'An intent cannot choose its owner or add execution authority.', 422);
  const result = Object.fromEntries(allowed.slice(0, 8).map(key => [key, string(key === 'resourceVersion' ? String(input[key] ?? '') : input[key], key)]));
  result.fields = strings(input.fields ?? [], 'fields', { empty: true });
  requireThat(input.values && typeof input.values === 'object' && !Array.isArray(input.values), 'AUTHORIZATION_INPUT', 'An intent must include its exact values.', 422);
  requireThat(Object.keys(input.values).sort().join('\0') === result.fields.join('\0'), 'AUTHORIZATION_INPUT', 'Intent fields and values must agree exactly.', 422);
  result.values = safeJSON(input.values);
  requireThat(Buffer.byteLength(canonical(result)) <= 256 * 1024, 'AUTHORIZATION_INPUT', 'Authorization content exceeds the size limit.', 422);
  return result;
}
export const hashIntent = input => digest(canonicalIntent(input));

/**
 * Durable per-owner control records. Ordinary KG memory is a rebuildable projection,
 * never a source of execution authority. Owner mutation methods are controller-only.
 */
export class AuthorizationLedger {
  constructor({ filename = ':memory:', owner, clock = Date.now } = {}) {
    this.owner = string(owner, 'owner'); this.clock = clock;
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,status TEXT NOT NULL,intent TEXT NOT NULL,payload_hash TEXT NOT NULL,approved_intent TEXT,decision_id TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,intent TEXT NOT NULL,basis_kind TEXT NOT NULL,basis_id TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,record_id TEXT NOT NULL,data TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS operations_status ON operations(status);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('owner', this.owner);
      const stored = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('owner');
      requireThat(stored?.value === this.owner, 'AUTHORIZATION_OWNER', 'This authorization ledger belongs to a different owner.', 403);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  init() { return this; }
  now() { const value = this.clock(); requireThat(Number.isFinite(value), 'AUTHORIZATION_CLOCK', 'Authorization clock is unavailable.', 503); return value; }
  trusted(owner) { requireThat((typeof owner === 'object' ? owner?.owner : owner) === this.owner, 'AUTHORIZATION_OWNER', 'Only the bound human owner can decide this request.', 403); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  emit(topic, record) {
    this.db.prepare('INSERT INTO outbox(topic,record_id,data,created_at) VALUES(?,?,?,?)').run(topic, record.id, canonical({ ...record, owner: this.owner }), this.now());
  }
  policyView(row) {
    if (!row) return null;
    const data = JSON.parse(row.data);
    return { ...data, id: row.id, owner: this.owner, revision: row.revision, status: row.status === 'active' && data.expiresAt !== null && data.expiresAt <= this.now() ? 'expired' : row.status,
      uses: row.uses, reserved: row.reserved, remaining: data.maxUses === null ? null : Math.max(0, data.maxUses - row.uses - row.reserved) };
  }
  grantView(row) {
    if (!row) return null;
    const data = JSON.parse(row.data);
    let status = row.status;
    if (status === 'active' && data.expiresAt <= this.now()) status = 'expired';
    if (status === 'active' && row.uses + row.reserved >= data.maxUses) status = 'exhausted';
    return { ...data, id: row.id, owner: this.owner, requestId: row.request_id, revision: row.revision, status,
      uses: row.uses, reserved: row.reserved, remaining: Math.max(0, data.maxUses - row.uses - row.reserved) };
  }
  requestView(row) {
    return row ? { id: row.id, owner: this.owner, revision: row.revision, status: row.status, intent: JSON.parse(row.intent), payloadHash: row.payload_hash,
      ...(row.approved_intent ? { approvedIntent: JSON.parse(row.approved_intent) } : {}), decisionId: row.decision_id, createdAt: row.created_at } : null;
  }
  operationView(row) {
    return row ? { id: row.id, owner: this.owner, intentHash: row.intent_hash, intent: JSON.parse(row.intent), basisKind: row.basis_kind, basisId: row.basis_id,
      status: row.status, receipt: row.receipt ? JSON.parse(row.receipt) : null, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  policy(input, trustedOwner = this.owner) {
    this.trusted(trustedOwner);
    requireThat(input && ['allow', 'ask', 'deny'].includes(input.effect), 'AUTHORIZATION_INPUT', 'Choose an allow, ask or deny policy.', 422);
    const data = { effect: input.effect, actions: strings(input.actions, 'actions'), recipients: strings(input.recipients, 'recipients'), purposes: strings(input.purposes, 'purposes'),
      projectId: string(input.projectId, 'projectId'), resources: input.resources ? strings(input.resources, 'resources') : [],
      resourceClass: input.resourceClass === undefined ? null : string(input.resourceClass, 'resourceClass'),
      fields: input.fields === undefined ? null : strings(input.fields, 'fields', { empty: true }),
      resourceVersion: input.resourceVersion === undefined ? null : string(String(input.resourceVersion), 'resourceVersion'),
      expiresAt: timestamp(input.expiresAt), maxUses: input.maxUses === undefined ? null : uses(input.maxUses), createdAt: this.now(),
      ...(input.label === undefined ? {} : { label: string(input.label, 'label') }) };
    requireThat(data.resources.length || data.resourceClass, 'AUTHORIZATION_INPUT', 'A policy needs explicit resources or a trusted resource classification.', 422);
    const policyId = input.id === undefined ? id('policy') : string(input.id, 'policy id');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM policies WHERE id=?').get(policyId);
      if (input.expectedRevision !== undefined) requireThat(old?.revision === input.expectedRevision, 'AUTHORIZATION_STALE', 'The policy changed. Review its current version.', 409);
      // A policy revision does not reset already consumed or reserved uses.
      this.db.prepare(`INSERT INTO policies(id,revision,status,data) VALUES(?,1,'active',?) ON CONFLICT(id) DO UPDATE SET revision=policies.revision+1,status='active',data=excluded.data`).run(policyId, canonical(data));
      const result = this.policyView(this.db.prepare('SELECT * FROM policies WHERE id=?').get(policyId)); this.emit('policy', result); return result;
    });
  }
  matches(policy, intent) {
    return policy.projectId === intent.projectId && policy.actions.includes(intent.action) && policy.recipients.includes(intent.recipient) && policy.purposes.includes(intent.purpose)
      && (policy.resources.includes(intent.resourceId) || policy.resourceClass === intent.resourceClass)
      && (!policy.resourceVersion || policy.resourceVersion === intent.resourceVersion)
      && (policy.fields === null || (policy.effect === 'allow' && policy.status !== 'revoked'
        ? intent.fields.every(field => policy.fields.includes(field))
        : intent.fields.some(field => policy.fields.includes(field))));
  }
  evaluate(intent, { reservedOperation } = {}) {
    const intentHash = digest(intent), current = this.now();
    const policies = this.db.prepare('SELECT * FROM policies').all().map(row => this.policyView(row));
    const matching = policies.filter(policy => this.matches(policy, intent));
    const forbiddenPolicy = matching.find(policy => policy.status === 'revoked' || policy.status === 'active' && policy.effect === 'deny');
    if (forbiddenPolicy) return { status: 'denied', basisKind: 'policy', basisId: forbiddenPolicy.id, revision: forbiddenPolicy.revision, reason: forbiddenPolicy.status === 'revoked' ? 'policy_revoked' : 'explicit_prohibition' };
    const requests = this.db.prepare("SELECT * FROM requests WHERE status='denied' AND fingerprint=?").get(intentHash);
    if (requests) return { status: 'denied', basisKind: 'decision', basisId: requests.decision_id, revision: requests.revision, reason: 'owner_declined_this_request' };
    const grants = this.db.prepare('SELECT * FROM grants').all().map(row => this.grantView(row)).filter(grant => digest(grant.intent) === intentHash);
    const revoked = grants.find(grant => grant.status === 'revoked');
    if (revoked) return { status: 'denied', basisKind: 'grant', basisId: revoked.id, revision: revoked.revision, reason: 'grant_revoked' };
    const grant = grants.find(item => item.expiresAt > current && (item.status === 'active' && item.remaining > 0 || reservedOperation?.basisKind === 'grant' && reservedOperation.basisId === item.id && item.status === 'exhausted'));
    if (grant) return { status: 'allowed', basisKind: 'grant', basisId: grant.id, revision: grant.revision, reason: 'exact_owner_grant' };
    const ask = matching.find(item => item.status === 'active' && item.effect === 'ask');
    if (ask) return { status: 'needs_approval', basisKind: 'policy', basisId: ask.id, revision: ask.revision, reason: 'owner_review_required' };
    const allow = matching.find(item => item.status === 'active' && item.effect === 'allow' && (item.remaining === null || item.remaining > 0 || reservedOperation?.basisKind === 'policy' && reservedOperation.basisId === item.id));
    if (allow) return { status: 'allowed', basisKind: 'policy', basisId: allow.id, revision: allow.revision, reason: 'standing_owner_policy' };
    return { status: 'needs_approval', reason: grants.some(item => item.expiresAt <= current) ? 'grant_expired' : 'no_current_permission' };
  }
  check(input) { return { owner: this.owner, ...this.evaluate(canonicalIntent(input)) }; }
  request(input) {
    const intent = canonicalIntent(input), fingerprint = digest(intent);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM requests WHERE fingerprint=?').get(fingerprint);
      const result = this.evaluate(intent);
      if (existing) {
        // A narrowed approval is deliberately returned with its approved view.
        // Re-requesting its larger original is not a way to undo that decision.
        const approved = existing.approved_intent ? JSON.parse(existing.approved_intent) : null;
        if (existing.status === 'approved' && approved && digest(approved) === fingerprint && result.status === 'needs_approval') {
          this.db.prepare("UPDATE requests SET revision=revision+1,status='pending',approved_intent=NULL,decision_id=NULL WHERE id=?").run(existing.id);
          const renewed = this.getRequest(existing.id); this.emit('request', renewed); return renewed;
        }
        return this.requestView(existing);
      }
      requireThat(result.status !== 'allowed', 'AUTHORIZATION_ALREADY_ALLOWED', 'A current permission already covers this action.', 409);
      const requestId = id('request'), denied = result.status === 'denied';
      this.db.prepare('INSERT INTO requests(id,fingerprint,revision,status,intent,payload_hash,created_at) VALUES(?,?,1,?,?,?,?)').run(requestId, fingerprint, denied ? 'denied' : 'pending', canonical(intent), fingerprint, this.now());
      const request = this.requestView(this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId)); this.emit('request', request); return request;
    });
  }
  getRequest(requestId) { return this.requestView(this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId)); }
  decide(requestId, input, trustedOwner = this.owner) {
    this.trusted(trustedOwner);
    requireThat(input && ['allow', 'deny', 'allow_once', 'allow_round'].includes(input.decision), 'AUTHORIZATION_INPUT', 'Choose allow or deny.', 422);
    return this.transaction(() => {
      const request = this.getRequest(requestId);
      requireThat(request, 'AUTHORIZATION_NOT_FOUND', 'The authorization request does not exist.', 404);
      requireThat(request.status === 'pending' && request.revision === input.expectedRevision && request.payloadHash === input.expectedPayloadHash, 'AUTHORIZATION_STALE', 'The approval is stale or already decided.', 409);
      const permitted = input.decision !== 'deny';
      const selected = input.fields === undefined ? request.intent.fields : strings(input.fields, 'fields', { empty: true });
      requireThat(selected.every(field => request.intent.fields.includes(field)), 'AUTHORIZATION_WIDENING', 'A decision can only narrow the displayed fields.', 422);
      const approvedIntent = permitted ? canonicalIntent({ ...request.intent, fields: selected, values: Object.fromEntries(selected.map(field => [field, request.intent.values[field]])) }) : null;
      if (approvedIntent) requireThat(this.evaluate(approvedIntent).status !== 'denied', 'AUTHORIZATION_DENIED', 'A current prohibition prevents this action.', 403);
      const decisionId = id('decision');
      const decision = { id: decisionId, owner: this.owner, requestId, requestRevision: request.revision, decision: permitted ? 'allow' : 'deny', fields: selected,
        originalPayloadHash: request.payloadHash, approvedPayloadHash: approvedIntent ? digest(approvedIntent) : null, at: this.now(), source: 'authenticated_owner' };
      this.db.prepare('INSERT INTO decisions(id,request_id,data) VALUES(?,?,?)').run(decisionId, requestId, canonical(decision));
      this.db.prepare('UPDATE requests SET revision=revision+1,status=?,approved_intent=?,decision_id=? WHERE id=?').run(permitted ? 'approved' : 'denied', approvedIntent ? canonical(approvedIntent) : null, decisionId, requestId);
      let grant;
      if (approvedIntent) {
        const maxUses = uses(input.maxUses, 1), expiresAt = timestamp(input.expiresAt, this.now() + 30 * 60_000);
        requireThat(expiresAt > this.now(), 'AUTHORIZATION_INPUT', 'A new permission must expire in the future.', 422);
        const grantId = id('grant'), data = { intent: approvedIntent, payloadHash: digest(approvedIntent), decisionId, expiresAt, maxUses, createdAt: this.now() };
        this.db.prepare("INSERT INTO grants(id,request_id,revision,status,data) VALUES(?,?,1,'active',?)").run(grantId, requestId, canonical(data));
        grant = this.grantView(this.db.prepare('SELECT * FROM grants WHERE id=?').get(grantId)); this.emit('grant', grant);
      }
      this.emit('decision', decision); const updated = this.getRequest(requestId); this.emit('request', updated);
      return { request: updated, decision, ...(grant ? { grant } : {}) };
    });
  }
  revoke(recordId, options = {}, trustedOwner = this.owner) {
    this.trusted(trustedOwner);
    return this.transaction(() => {
      for (const table of ['policies', 'grants']) {
        const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(recordId);
        if (!row) continue;
        if (options.expectedRevision !== undefined) requireThat(row.revision === options.expectedRevision, 'AUTHORIZATION_STALE', 'The permission changed.', 409);
        if (row.status !== 'revoked') this.db.prepare(`UPDATE ${table} SET status='revoked',revision=revision+1 WHERE id=?`).run(recordId);
        const result = table === 'policies' ? this.policyView(this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(recordId)) : this.grantView(this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(recordId));
        this.emit(table === 'policies' ? 'policy' : 'grant', result); return result;
      }
      fail('AUTHORIZATION_NOT_FOUND', 'The permission does not exist.', 404);
    });
  }
  getOperation(operationId) { return this.operationView(this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId)); }
  prepare(operationId, input) {
    string(operationId, 'operationId'); const intent = canonicalIntent(input), intentHash = digest(intent);
    return this.transaction(() => {
      const old = this.getOperation(operationId);
      if (old) { requireThat(old.intentHash === intentHash, 'AUTHORIZATION_OPERATION_CONFLICT', 'An operation ID cannot be reused with changed content.', 409); return old; }
      const result = this.evaluate(intent);
      requireThat(result.status === 'allowed', result.status === 'denied' ? 'AUTHORIZATION_DENIED' : 'AUTHORIZATION_REQUIRED', 'This exact action has no current execution permission.', 403);
      const table = result.basisKind === 'grant' ? 'grants' : 'policies';
      this.db.prepare(`UPDATE ${table} SET reserved=reserved+1 WHERE id=?`).run(result.basisId);
      this.db.prepare("INSERT INTO operations(id,intent_hash,intent,basis_kind,basis_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)").run(operationId, intentHash, canonical(intent), result.basisKind, result.basisId, this.now(), this.now());
      const operation = this.getOperation(operationId); this.emit('operation', operation); return operation;
    });
  }
  dispatch(operationId) {
    const result = this.transaction(() => {
      const operation = this.getOperation(operationId);
      requireThat(operation, 'AUTHORIZATION_NOT_FOUND', 'The operation does not exist.', 404);
      if (['dispatching', 'uncertain', 'succeeded'].includes(operation.status)) return operation;
      requireThat(operation.status === 'prepared', 'AUTHORIZATION_OPERATION_STATE', 'This operation cannot be dispatched.', 409);
      const current = this.evaluate(operation.intent, { reservedOperation: operation });
      if (current.status !== 'allowed' || current.basisKind !== operation.basisKind || current.basisId !== operation.basisId) {
        const table = operation.basisKind === 'grant' ? 'grants' : 'policies';
        this.db.prepare(`UPDATE ${table} SET reserved=max(0,reserved-1) WHERE id=?`).run(operation.basisId);
        this.db.prepare("UPDATE operations SET status='blocked',updated_at=? WHERE id=?").run(this.now(), operationId);
        const blocked = this.getOperation(operationId); this.emit('operation', blocked); return blocked;
      }
      this.db.prepare("UPDATE operations SET status='dispatching',updated_at=? WHERE id=?").run(this.now(), operationId);
      const dispatched = this.getOperation(operationId); this.emit('operation', dispatched); return dispatched;
    });
    requireThat(result.status !== 'blocked', 'AUTHORIZATION_DENIED', 'Permission expired or was withdrawn before dispatch.', 403);
    return result;
  }
  complete(operationId, { receipt = null, status = 'succeeded' } = {}) {
    requireThat(['succeeded', 'failed', 'uncertain'].includes(status), 'AUTHORIZATION_INPUT', 'Use a confirmed success, confirmed failure, or uncertain result.', 422);
    const receiptJSON = receipt === null ? null : canonical(receipt);
    requireThat(status !== 'succeeded' || receiptJSON !== null, 'AUTHORIZATION_RECEIPT', 'A successful operation requires an actual receipt.', 422);
    requireThat(receipt === null || !Object.hasOwn(receipt, 'operationId') || receipt.operationId === operationId, 'AUTHORIZATION_RECEIPT', 'The receipt belongs to a different operation.', 422);
    return this.transaction(() => {
      const operation = this.getOperation(operationId);
      requireThat(operation, 'AUTHORIZATION_NOT_FOUND', 'The operation does not exist.', 404);
      if (['succeeded', 'failed'].includes(operation.status)) {
        requireThat(operation.status === status && canonical(operation.receipt) === canonical(receipt), 'AUTHORIZATION_RECEIPT_CONFLICT', 'The completed operation has a different result.', 409); return operation;
      }
      requireThat(['dispatching', 'uncertain'].includes(operation.status), 'AUTHORIZATION_OPERATION_STATE', 'Only a dispatched operation can have an external result.', 409);
      if (status !== 'uncertain') {
        const table = operation.basisKind === 'grant' ? 'grants' : 'policies';
        this.db.prepare(`UPDATE ${table} SET reserved=max(0,reserved-1),uses=uses+? WHERE id=?`).run(status === 'succeeded' ? 1 : 0, operation.basisId);
      }
      this.db.prepare('UPDATE operations SET status=?,receipt=?,updated_at=? WHERE id=?').run(status, receiptJSON, this.now(), operationId);
      const result = this.getOperation(operationId); this.emit('operation', result); return result;
    });
  }
  list({ taskId, includeInactive = true } = {}) {
    const state = { owner: this.owner, policies: this.db.prepare('SELECT * FROM policies ORDER BY id').all().map(row => this.policyView(row)),
      requests: this.db.prepare('SELECT * FROM requests ORDER BY created_at,id').all().map(row => this.requestView(row)),
      decisions: this.db.prepare('SELECT data FROM decisions ORDER BY rowid').all().map(row => JSON.parse(row.data)),
      grants: this.db.prepare('SELECT * FROM grants ORDER BY rowid').all().map(row => this.grantView(row)),
      operations: this.db.prepare('SELECT * FROM operations ORDER BY created_at,id').all().map(row => this.operationView(row)) };
    if (taskId) {
      state.requests = state.requests.filter(item => item.intent.taskId === taskId); state.grants = state.grants.filter(item => item.intent.taskId === taskId);
      state.operations = state.operations.filter(item => item.intent.taskId === taskId); const requests = new Set(state.requests.map(item => item.id)); state.decisions = state.decisions.filter(item => requests.has(item.requestId));
    }
    if (!includeInactive) { state.policies = state.policies.filter(item => item.status === 'active'); state.grants = state.grants.filter(item => item.status === 'active'); }
    return clone(state);
  }
  pendingRequests() { return this.db.prepare("SELECT * FROM requests WHERE status='pending' ORDER BY created_at,id").all().map(row => this.requestView(row)); }
  pendingOutbox() { return this.db.prepare('SELECT * FROM outbox WHERE delivered=0 ORDER BY id').all().map(row => ({ id: row.id, topic: row.topic, recordId: row.record_id, owner: this.owner, record: JSON.parse(row.data), createdAt: row.created_at })); }
  acknowledgeOutbox(outboxId) { this.db.prepare('UPDATE outbox SET delivered=1 WHERE id=?').run(outboxId); return { ok: true }; }
  close() { this.db.close(); }
}
