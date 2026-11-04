import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RuntimeError, invariant, macObject, verifyMac, fromErrorJSON,
  errorJSON, validateSessionRef,
} from './runtime-helpers.mjs';

const workerFile = new URL('./agent-worker.mjs', import.meta.url);
const helperFile = new URL('./runtime-helpers.mjs', import.meta.url);
const ontologyFile = new URL('./ontology-dialogue.mjs', import.meta.url);

function isolationFlags(codeFiles) {
  invariant(process.allowedNodeEnvironmentFlags.has('--permission')
    && process.allowedNodeEnvironmentFlags.has('--allow-net'), 'ISOLATION_UNSUPPORTED',
  'The isolated workers require Node.js with enforceable network permissions (Node.js 26 or newer).', 503);
  return ['--permission', '--no-addons', '--no-experimental-sqlite', '--no-experimental-ffi',
    '--disable-sigusr1', '--no-global-search-paths', '--disallow-code-generation-from-strings',
    ...codeFiles.map(path => `--allow-fs-read=${path}`)];
}

export class WorkerClient {
  constructor(role, model = {}, options = {}) {
    this.role = role;
    this.secret = randomBytes(32).toString('hex');
    this.pending = new Map();
    this.modelPending = new Map();
    this.onModelCall = options.onModelCall;
    this.online = false;
    this.closed = false;
    const entrypoint = realpathSync(options.workerFile ? fileURLToPath(new URL(options.workerFile, import.meta.url)) : fileURLToPath(workerFile));
    const codeFiles = [...new Set([entrypoint, realpathSync(fileURLToPath(helperFile)), realpathSync(fileURLToPath(ontologyFile)),
      ...(options.codeFiles || []).map(path => realpathSync(path))])];
    const execArgv = isolationFlags(codeFiles);
    const env = {};
    for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    this.cwd = realpathSync(mkdtempSync(join(tmpdir(), `agent-demo-${role.toLowerCase()}-`)));
    chmodSync(this.cwd, 0o700);
    this.isolation = { mechanism: 'node-permissions', osSandbox: false, privateCwd: true,
      network: false, fsWrite: false, childProcesses: false, workerThreads: false,
      addons: false, inspector: false, codeReadOnly: true };
    try {
      this.child = fork(entrypoint, [], {
        cwd: this.cwd,
        env: { ...env, TMPDIR: this.cwd, TMP: this.cwd, TEMP: this.cwd,
          AGENT_DEMO_ROLE: role, AGENT_DEMO_RPC_SECRET: this.secret,
          AGENT_DEMO_WORKER_MODEL: JSON.stringify({ name: model.name || null,
            available: model.available ?? Boolean(model.baseUrl && model.name), timeoutMs: model.timeoutMs || 20_000 }) },
        execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
    } catch (error) {
      this.cleanupCwd();
      throw error;
    }
    this.child.on('message', envelope => {
      const { body, signature } = envelope || {};
      if (!body || body.role !== this.role || body.target !== 'controller' || !verifyMac(body, signature, this.secret)) return;
      if (body.kind === 'model_request') { this.handleModelRequest(body); return; }
      if (body.kind === 'model_cancel') {
        const request = this.modelPending.get(body.id);
        if (request && request.ref.sessionId === body.sessionId && request.ref.epoch === body.epoch
          && request.ref.modelRevision === body.modelRevision) {
          this.modelPending.delete(body.id);
          request.abort.abort('worker_cancelled');
        }
        return;
      }
      const request = this.pending.get(body.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(body.id);
      if (body.ok) request.resolve(body.result);
      else request.reject(fromErrorJSON(body.error));
    });
    this.child.on('error', () => this.failPending());
    this.child.on('exit', () => { this.failPending(); this.cleanupCwd(); });
  }

  cleanupCwd() {
    if (this.cwd) rmSync(this.cwd, { recursive: true, force: true });
  }

  async handleModelRequest(body) {
    if (this.modelPending.has(body.id) || this.closed) return;
    const abort = new AbortController();
    const ref = { sessionId: body.sessionId, epoch: body.epoch, modelRevision: body.modelRevision };
    const entry = { abort, ref };
    this.modelPending.set(body.id, entry);
    const answer = { id: body.id, role: 'controller', target: this.role, kind: 'model_response', ...ref };
    try {
      validateSessionRef(ref);
      invariant(Number.isSafeInteger(ref.modelRevision) && ref.modelRevision > 0 && typeof body.id === 'string'
        && body.id.length <= 200 && typeof body.system === 'string' && body.system.length <= 100_000
        && body.context && typeof body.context === 'object', 'MODEL_INVALID_REQUEST', 'The isolated model request is invalid.');
      invariant(typeof this.onModelCall === 'function', 'MODEL_UNAVAILABLE', 'There is no parent model broker.', 503);
      answer.result = await this.onModelCall({ role: this.role, ...ref, requestId: body.id, system: body.system,
        context: body.context, legacyRuntime: body.legacyRuntime, signal: abort.signal });
      answer.ok = true;
    } catch (error) {
      answer.ok = false;
      answer.error = errorJSON(error);
    }
    if (this.modelPending.get(body.id) !== entry || abort.signal.aborted || this.closed || !this.child.connected) return;
    this.modelPending.delete(body.id);
    this.child.send({ body: answer, signature: macObject(answer, this.secret) }, () => {});
  }

  failPending() {
    this.online = false;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RuntimeError('RUNTIME_OFFLINE', `${this.role} isolated process is unavailable.`, 503));
    }
    this.pending.clear();
    for (const request of this.modelPending.values()) request.abort.abort('worker_closed');
    this.modelPending.clear();
  }

  async start() {
    const status = await this.call('status', {}, 5000);
    this.identity = status.publicKey;
    this.online = true;
    return status;
  }

  call(method, args = {}, timeoutMs = 30_000) {
    if (this.closed || !this.child.connected) return Promise.reject(new RuntimeError('RUNTIME_OFFLINE', `${this.role} process is closed.`, 503));
    const body = { id: randomUUID(), role: 'controller', target: this.role, method, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(body.id);
        reject(new RuntimeError('RUNTIME_TIMEOUT', `${this.role} did not acknowledge this operation. Verify the original operation before retrying.`, 504));
      }, timeoutMs);
      timer.unref();
      this.pending.set(body.id, { resolve, reject, timer });
      this.child.send({ body, signature: macObject(body, this.secret) }, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(body.id);
        reject(new RuntimeError('RUNTIME_OFFLINE', `${this.role} process cannot receive this operation.`, 503));
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failPending();
    if (this.child.exitCode !== null || this.child.signalCode !== null) { this.cleanupCwd(); return; }
    await new Promise(resolve => {
      const killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
      this.child.once('exit', () => { clearTimeout(killTimer); resolve(); });
      if (this.child.connected) this.child.disconnect();
      else this.child.kill('SIGTERM');
    });
    this.cleanupCwd();
  }
}

export class RemoteBobClient {
  constructor(url, token) {
    this.role = 'Bob';
    invariant(typeof token === 'string' && token.length >= 16, 'BOB_AUTH_CONFIGURATION', 'Remote Bob requires a dedicated peer secret of at least 16 characters.');
    this.url = new URL(url);
    invariant(['http:', 'https:'].includes(this.url.protocol) && !this.url.username && !this.url.password
      && !this.url.search && !this.url.hash, 'BOB_URL_CONFIGURATION', 'Bob URL must be a plain HTTP or HTTPS base URL.');
    this.token = token;
    this.online = false;
    this.closed = false;
    this.calls = new Set();
  }

  async start() {
    const status = await this.call('status', {}, 5000);
    invariant(status.role === 'Bob' && typeof status.publicKey === 'string', 'INVALID_BOB_IDENTITY', 'The peer did not identify itself as Bob.', 401);
    this.identity = status.publicKey;
    this.online = true;
    return status;
  }

  async call(method, args = {}, timeoutMs = 30_000) {
    invariant(!this.closed, 'RUNTIME_OFFLINE', 'Remote Bob connection is closed.', 503);
    const body = { version: 1, id: randomUUID(), role: 'controller', target: 'Bob', method, args, createdAt: Date.now() };
    const abort = new AbortController();
    this.calls.add(abort);
    const timer = setTimeout(() => abort.abort('timeout'), timeoutMs);
    timer.unref();
    try {
      const endpoint = new URL(`${this.url.pathname.replace(/\/$/, '')}/rpc`, this.url);
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ body, signature: macObject(body, this.token) }),
      });
      invariant(response.status !== 401, 'BOB_AUTH_FAILED', 'The remote Bob pairing secret was rejected.', 401);
      invariant(response.status === 200, 'PEER_UNAVAILABLE', 'Remote Bob is unavailable for this operation.', 503);
      const envelope = await response.json();
      const answer = envelope?.body;
      invariant(answer && answer.id === body.id && answer.role === 'Bob' && answer.target === 'controller'
        && verifyMac(answer, envelope.signature, this.token), 'INVALID_BOB_RESPONSE', 'The remote Bob response could not be authenticated.', 401);
      this.online = true;
      if (!answer.ok) throw fromErrorJSON(answer.error);
      return answer.result;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      this.online = false;
      if (abort.signal.aborted && abort.signal.reason === 'timeout') throw new RuntimeError('PEER_TIMEOUT', 'Remote Bob did not acknowledge. Verify the original operation before retrying.', 504);
      throw new RuntimeError('PEER_UNAVAILABLE', 'Remote Bob could not be reached. Restore the connection and retry explicitly.', 503);
    } finally {
      clearTimeout(timer);
      this.calls.delete(abort);
    }
  }

  async close() {
    this.closed = true;
    this.online = false;
    for (const abort of this.calls) abort.abort('closed');
    this.calls.clear();
  }
}
