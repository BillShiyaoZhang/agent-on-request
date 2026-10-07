import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WorkerClient } from './runtime-client.mjs';
import { RuntimeError, invariant, safeEqual, verifyMac, macObject, errorJSON, WORKER_RPC_METHODS } from './runtime-helpers.mjs';

async function readJSON(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    invariant(size <= 2_097_152, 'BODY_TOO_LARGE', 'The runtime message is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RuntimeError('INVALID_JSON', 'The runtime message must be JSON.', 400); }
}

function sendJSON(response, status, value) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

/** Authenticated, signed RPC to one isolated Bob process; no browser or personal data store. */
export function createBobServer(options = {}) {
  const token = options.token ?? process.env.BOB_TOKEN;
  invariant(typeof token === 'string' && token.length >= 16, 'BOB_AUTH_CONFIGURATION', 'Set a dedicated BOB_TOKEN of at least 16 characters.');
  const worker = new WorkerClient('Bob', {
    baseUrl: options.modelBaseUrl ?? process.env.MODEL_BASE_URL ?? '',
    apiKey: options.modelApiKey ?? process.env.MODEL_API_KEY ?? '',
    name: options.modelName ?? process.env.MODEL_NAME ?? '',
    timeoutMs: options.modelTimeoutMs ?? 20_000,
  });
  const nonces = new Map();
  let started = false;
  let stopped = false;
  let server;
  const service = {
    async start() {
      invariant(!stopped, 'RUNTIME_CLOSED', 'This Bob server was closed.', 503);
      if (started) return service;
      try {
        await worker.start();
        server = http.createServer(async (request, response) => {
          try {
            invariant(safeEqual(request.headers.authorization, `Bearer ${token}`), 'BOB_AUTH_FAILED', 'A valid dedicated peer secret is required.', 401);
            const path = new URL(request.url, 'http://bob.local').pathname;
            if (request.method === 'GET' && path === '/health') {
              const status = await worker.call('status');
              sendJSON(response, 200, { ready: true, role: 'Bob', online: status.online });
              return;
            }
            invariant(request.method === 'POST' && path === '/rpc', 'NOT_FOUND', 'No such Bob runtime endpoint.', 404);
            invariant(request.headers['content-type']?.split(';')[0].trim() === 'application/json',
              'INVALID_CONTENT_TYPE', 'Runtime RPC requires application/json.', 415);
            const envelope = await readJSON(request);
            const body = envelope?.body;
            invariant(body && verifyMac(body, envelope.signature, token), 'INVALID_RPC_SIGNATURE', 'The runtime RPC signature is invalid.', 401);
            invariant(body.version === 1 && body.role === 'controller' && body.target === 'Bob'
              && typeof body.id === 'string' && body.id.length <= 200 && body.id.length > 0
              && Number.isFinite(body.createdAt) && Math.abs(Date.now() - body.createdAt) <= 60_000,
            'INVALID_RPC_ENVELOPE', 'The runtime RPC envelope is invalid or expired.', 401);
            for (const [nonce, at] of nonces) if (Date.now() - at > 60_000) nonces.delete(nonce);
            const answer = { version: 1, id: body.id, role: 'Bob', target: 'controller', createdAt: Date.now() };
            try {
              invariant(!nonces.has(body.id), 'RPC_REPLAY', 'This signed runtime request was already processed.', 409);
              invariant(nonces.size < 10_000, 'RPC_BUSY', 'The peer request budget is full. Try again after a minute.', 429);
              nonces.set(body.id, Date.now());
              invariant(WORKER_RPC_METHODS.has(body.method), 'UNKNOWN_METHOD', 'No such isolated runtime method.', 404);
              // Bob's own configuration stays in his worker. Allow the schema's maximum
              // planning budget without keeping a duplicate provider-context store here.
              const timeout = body.method === 'planBob' ? 3_303_000 : 30_000;
              answer.result = await worker.call(body.method, body.args, timeout);
              answer.ok = true;
            } catch (error) { answer.ok = false; answer.error = errorJSON(error); }
            sendJSON(response, 200, { body: answer, signature: macObject(answer, token) });
          } catch (error) {
            const safe = errorJSON(error);
            sendJSON(response, safe.status, { error: { code: safe.code, message: safe.message } });
          }
        });
        server.requestTimeout = 30_000;
        server.headersTimeout = 15_000;
        await new Promise((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(options.port ?? Number(process.env.BOB_PORT || 4318), options.host ?? process.env.BOB_HOST ?? '127.0.0.1', resolveListen);
        });
        started = true;
        return service;
      } catch (error) {
        await worker.close();
        throw error;
      }
    },
    address() { return server?.address(); },
    async close() {
      if (stopped) return;
      stopped = true;
      const httpClose = server ? new Promise(resolveClose => {
        server.close(resolveClose);
        server.closeAllConnections();
      }) : Promise.resolve();
      await worker.close();
      await httpClose;
      nonces.clear();
      started = false;
    },
  };
  return service;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let service;
  try {
    service = createBobServer();
    await service.start();
    const address = service.address();
    console.log(`Bob runtime ready on ${address.address}:${address.port}. No dialogue or state logs are written.`);
    const shutdown = async () => { await service.close(); process.exit(0); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(errorJSON(error).message);
    await service?.close();
    process.exitCode = 1;
  }
}
