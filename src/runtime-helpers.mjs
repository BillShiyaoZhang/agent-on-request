import { createHash, createHmac, sign, verify, timingSafeEqual } from 'node:crypto';

export class RuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

export const PLANNING_STEPS = Object.freeze(['alice_intro', 'alice_alignment', 'bob_alignment', 'bob_initial',
  'bob_additional', 'bob_brief', 'brief_alignment', 'calendar_delivery', 'reply_delivery']);

export function tagPlanningError(error, step) {
  if (error instanceof RuntimeError && PLANNING_STEPS.includes(step)) error.planningStep = step;
  return error;
}

export function invariant(condition, code, message, status = 400) {
  if (!condition) throw new RuntimeError(code, message, status);
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function hashPayload(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function signObject(value, privateKey) {
  return sign(null, Buffer.from(canonical(value)), privateKey).toString('base64');
}

export function verifyObject(value, signature, publicKey) {
  try {
    return typeof signature === 'string' && verify(null, Buffer.from(canonical(value)), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function macObject(value, secret) {
  return createHmac('sha256', secret).update(canonical(value)).digest('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function verifyMac(value, signature, secret) {
  return safeEqual(macObject(value, secret), signature);
}

export function errorJSON(error) {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message, status: error.status,
    ...(PLANNING_STEPS.includes(error.planningStep) ? { planningStep: error.planningStep } : {}) };
  return { code: 'RUNTIME_ERROR', message: 'The isolated runtime could not complete this operation.', status: 500 };
}

export function fromErrorJSON(error) {
  return tagPlanningError(new RuntimeError(error?.code || 'RUNTIME_ERROR', error?.message || 'Runtime operation failed.', error?.status || 500), error?.planningStep);
}

export function validateSessionRef(args) {
  invariant(typeof args?.sessionId === 'string' && args.sessionId.length > 0 && args.sessionId.length <= 200,
    'INVALID_SESSION', 'A nonempty session ID is required.');
  invariant((typeof args.epoch === 'string' && args.epoch.length > 0 && args.epoch.length <= 200)
    || (Number.isSafeInteger(args.epoch) && args.epoch >= 0), 'INVALID_EPOCH', 'A valid session epoch is required.');
}

export function validateOperation(args) {
  validateSessionRef(args);
  invariant(typeof args.operationId === 'string' && args.operationId.length > 0 && args.operationId.length <= 200,
    'INVALID_OPERATION', 'A nonempty operation ID is required.');
  invariant(typeof args.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(args.payloadHash),
    'INVALID_PAYLOAD_HASH', 'The exact payload requires a SHA-256 hash.');
  invariant(Array.isArray(args.fields) && args.fields.length <= 100 && args.fields.every(field => typeof field === 'string')
    && new Set(args.fields).size === args.fields.length, 'INVALID_FIELDS', 'Fields must be unique strings.');
}

export const SESSION_RPC_METHODS = new Set(['initialize', 'projectAlice', 'prepareOutgoing', 'receive', 'verifyReceipt', 'planBob', 'planAlice', 'cancelPlanning', 'updateBob', 'clear',
  'ontologyModule', 'receiveOntology', 'proposeOntology', 'decideOntology', 'acknowledgeOntology', 'updateOntology', 'ontologyStatus']);
export const WORKER_RPC_METHODS = new Set(['status', 'configureModel', ...SESSION_RPC_METHODS]);
