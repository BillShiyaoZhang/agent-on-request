import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { invariant, RuntimeError } from './runtime-helpers.mjs';

const MAX_PAYLOAD = 512 * 1024;
const MAX_LINE = 6 * MAX_PAYLOAD + 1024;
const ROLES = ['Alice', 'Bob'];
const OFFLINE = () => new RuntimeError('PEER_OFFLINE', 'The local agent-comm bridge is unavailable. Check the bridge and retry explicitly.', 503);
const PROTOCOL = () => new RuntimeError('PEER_PROTOCOL', 'The local agent-comm bridge returned an invalid peer transfer.', 502);
const TIMEOUT = () => new RuntimeError('PEER_TIMEOUT', 'The local peer transfer timed out.', 504);

function validPeers(peers) {
  const addresses = ROLES.map(role => peers?.[role]?.address);
  return addresses[0] !== addresses[1] && addresses.every(address => {
    const match = typeof address === 'string' && /^\/ip4\/127\.0\.0\.1\/tcp\/([1-9]\d{0,4})$/.exec(address);
    return match && Number(match[1]) <= 65535;
  });
}

/** Owns a local SDK bridge. A request is complete only after the peer receives the same bytes. */
export function createAgentCommDirect({ command, startupTimeoutMs = 20_000, timeoutMs = 12_000 }) {
  invariant(typeof command === 'string' && isAbsolute(command) && !command.includes('\0'), 'DIRECT_CONFIG',
    'Configure the absolute path to the local agent-comm bridge executable.');
  let current;
  let closed = false;
  const children = new Set();

  function fail(state, error) {
    if (current === state) current = undefined;
    clearTimeout(state.startTimer);
    state.rejectReady(error);
    if (state.pending) {
      clearTimeout(state.pending.timer);
      state.pending.reject(error);
      state.pending = undefined;
    }
    state.child.stdin.destroy();
    state.child.kill();
    // A bridge blocked in its SDK shutdown must not keep the app's error path
    // or service shutdown waiting forever. Only this owned helper is stopped.
    state.stopTimer ??= setTimeout(() => state.child.kill('SIGKILL'), 750);
    state.stopTimer.unref();
  }

  function handleLine(state, line) {
    let message;
    try { message = JSON.parse(line); } catch { fail(state, PROTOCOL()); return; }
    if (current !== state) return;
    if (!state.addresses) {
      if (message?.ready !== true || !validPeers(message.peers)) { fail(state, PROTOCOL()); return; }
      state.addresses = Object.fromEntries(ROLES.map(role => [role, message.peers[role].address]));
      clearTimeout(state.startTimer);
      state.resolveReady();
      return;
    }
    const pending = state.pending;
    if (!pending || message?.id !== pending.id || typeof message.ok !== 'boolean') { fail(state, PROTOCOL()); return; }
    if (message.ok && message.payload !== pending.payload) { fail(state, PROTOCOL()); return; }
    clearTimeout(pending.timer);
    state.pending = undefined;
    if (message.ok) pending.resolve(JSON.parse(message.payload));
    else if (message.code === 'PEER_OFFLINE') pending.reject(OFFLINE());
    else if (message.code === 'RUNTIME_TIMEOUT') pending.reject(TIMEOUT());
    else pending.reject(PROTOCOL());
  }

  async function start() {
    if (closed) throw OFFLINE();
    if (current) return current.ready;
    const cwd = mkdtempSync(join(tmpdir(), 'agent-comm-direct-'));
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'LANG'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    const state = { child: spawn(command, [], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }) };
    current = state;
    state.ready = new Promise((resolve, reject) => { state.resolveReady = resolve; state.rejectReady = reject; });
    state.done = new Promise(resolve => state.child.once('close', () => {
      if (current === state) fail(state, OFFLINE());
      clearTimeout(state.stopTimer);
      try { rmSync(cwd, { force: true, recursive: true, maxRetries: 3 }); }
      catch { /* Only ephemeral keys and hashed transport receipts may remain. */ }
      children.delete(state.done);
      resolve();
    }));
    children.add(state.done);
    state.startTimer = setTimeout(() => fail(state, OFFLINE()), startupTimeoutMs);
    state.child.once('error', error => fail(state, error.code === 'ENOENT'
      ? new RuntimeError('DIRECT_CONFIG', 'Build the agent-comm direct bridge or set DEMO_AGENT_COMM_DIRECT to its executable.', 503)
      : OFFLINE()));
    state.child.stdin.on('error', () => fail(state, OFFLINE()));
    state.child.stdout.setEncoding('utf8');
    let buffer = '';
    state.child.stdout.on('data', chunk => {
      if (current !== state) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE) { fail(state, PROTOCOL()); return; }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(state, line);
    });
    return state.ready;
  }

  return {
    start,
    status: () => ({ online: Boolean(current?.addresses), addresses: { ...current?.addresses } }),
    async transfer(from, value, { beforeSend } = {}) {
      invariant(ROLES.includes(from), 'DIRECT_PROTOCOL', 'An exact local sending role is required.');
      const payload = JSON.stringify(value);
      invariant(typeof payload === 'string' && Buffer.byteLength(payload) <= MAX_PAYLOAD, 'DIRECT_PROTOCOL',
        'The local peer transfer exceeds its 512 KiB limit.');
      await start();
      const state = current;
      if (!state?.addresses) throw OFFLINE();
      invariant(!state.pending, 'PEER_BUSY', 'The local peer is transferring another operation. Retry explicitly.', 503);
      beforeSend?.();
      const id = createHash('sha256').update(payload).digest('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(state, TIMEOUT()), timeoutMs);
        state.pending = { id, payload, timer, resolve, reject };
        state.child.stdin.write(JSON.stringify({ id, from, payload }) + '\n');
      });
    },
    async close() {
      closed = true;
      const state = current;
      if (state) fail(state, OFFLINE());
      await Promise.all(children);
    },
  };
}
