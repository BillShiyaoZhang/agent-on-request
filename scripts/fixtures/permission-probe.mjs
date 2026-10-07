// An executable Worker fixture, outside Node's automatic test-file discovery.
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import * as inspector from 'node:inspector';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../../src/agent-worker.mjs';
import { macObject, verifyMac, errorJSON } from '../../src/runtime-helpers.mjs';

const role = process.env.AGENT_DEMO_ROLE;
const secret = process.env.AGENT_DEMO_RPC_SECRET;
const modelMetadata = JSON.parse(process.env.AGENT_DEMO_WORKER_MODEL);
delete process.env.AGENT_DEMO_RPC_SECRET;
delete process.env.AGENT_DEMO_WORKER_MODEL;
const runtime = createAgentRuntime({ role });
const attempt = callback => {
  try { callback(); return 'ALLOWED'; }
  catch (error) { return error.code; }
};
const networkAttempt = () => new Promise(resolve => {
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
    socket.once('error', error => { socket.destroy(); resolve(error.code); });
    socket.once('connect', () => { socket.destroy(); resolve('ALLOWED'); });
  } catch (error) { resolve(error.code); }
});

process.on('message', async envelope => {
  const { body, signature } = envelope || {};
  if (!body || body.target !== role || body.role !== 'controller' || !verifyMac(body, signature, secret)) return;
  const answer = { id: body.id, role, target: 'controller' };
  try {
    if (body.method === 'probe') {
      answer.result = {
        cwd: process.cwd(), flags: process.execArgv, envKeys: Object.keys(process.env), modelMetadata,
        permission: Object.fromEntries(['net', 'fs.write', 'child', 'worker', 'addons', 'inspector', 'wasi', 'ffi']
          .map(scope => [scope, process.permission.has(scope)])),
        readOwnCode: process.permission.has('fs.read', fileURLToPath(import.meta.url)),
        readOutside: process.permission.has('fs.read', body.args.outsideFile),
        readOtherCwd: process.permission.has('fs.read', body.args.otherCwd),
        denied: {
          read: attempt(() => fs.readFileSync(body.args.outsideFile)),
          write: attempt(() => fs.writeFileSync(`${process.cwd()}/should-not-exist`, 'no')),
          child: attempt(() => execFileSync(process.execPath, ['-e', 'process.exit(0)'])),
          worker: attempt(() => new Worker('0', { eval: true })),
          inspector: attempt(() => inspector.open(0)),
          addon: attempt(() => process.dlopen({ exports: {} }, '/not-an-addon.node')),
          net: await networkAttempt(),
        },
      };
    } else answer.result = await runtime.call(body.method, body.args);
    answer.ok = true;
  } catch (error) { answer.ok = false; answer.error = errorJSON(error); }
  if (process.connected) process.send({ body: answer, signature: macObject(answer, secret) });
});
process.on('disconnect', () => { runtime.close(); process.exit(0); });
process.on('SIGTERM', () => { runtime.close(); process.exit(0); });
