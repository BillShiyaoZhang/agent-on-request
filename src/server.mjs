import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRuntimeManager } from './runtime-manager.mjs';
import { ResearchStore } from './research-store.mjs';
import { ProfileStore } from './profile-store.mjs';
import { SessionEngine } from './session-engine.mjs';
import { AppError, requireThat } from './errors.mjs';
import { validateConfig, hashValue } from './config.mjs';
import { conditionCatalog, conditionSchema, resolveConditions, conditionBobConfig } from './condition-service.mjs';
import { buildAgentStates } from './agent-observability.mjs';
import { ConditionStore } from './condition-store.mjs';
import { ModelStore, DEFAULT_MODEL_CONFIG } from './model-store.mjs';
import { probeModel } from './model-provider.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = text => createHash('sha256').update(String(text)).digest();
const bearer = req => /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '')?.[1];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function body(req) {
  requireThat((req.headers['content-type'] ?? '').startsWith('application/json'), 'CONTENT_TYPE', 'Requests must use JSON.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; requireThat(size <= 262144, 'BODY_LIMIT', 'The request exceeds 256 KiB.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireThat(value && typeof value === 'object' && !Array.isArray(value), 'BODY', 'The request body must be an object.'); return value; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('JSON', 'The JSON request could not be parsed.'); }
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function createDemoServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 4317);
  const openControls = options.openControls === true;
  requireThat(!openControls || ['127.0.0.1', '::1', 'localhost'].includes(host), 'OPEN_CONTROLS_HOST', 'Direct demo controls require a localhost listener.');
  const directory = options.directory ?? path.join(root, '.data');
  const adminPin = options.adminPin ?? process.env.AGENT_DEMO_ADMIN_PIN ?? randomBytes(5).toString('hex');
  requireThat(typeof adminPin === 'string' && adminPin.length >= 6 && adminPin.length <= 128, 'PIN_CONFIG', '管理员 PIN 需要 6–128 个字符。');
  // The event application always runs both Agents on this computer. Remote adapters are library fixtures only.
  const runtime = options.runtime ?? createRuntimeManager({ ...options, bobUrl: '' });
  const useHermes = Boolean(options.hermes);
  const legacyProvider = Boolean(options.modelBaseUrl && options.modelName);
  const initialModelConfig = options.modelConfig ?? (legacyProvider ? {
    provider: 'openai_compatible', baseUrl: options.modelBaseUrl,
    agents: Object.fromEntries(['Alice', 'Bob'].map(role => [role, { ...DEFAULT_MODEL_CONFIG.agents[role], model: options.modelName,
      temperature: 0.2, timeoutSeconds: (options.modelTimeoutMs ?? 20_000) / 1000 }]))
  } : DEFAULT_MODEL_CONFIG);
  const models = options.models ?? new ModelStore({ directory, persist: !useHermes && options.persist !== false, initialConfig: initialModelConfig,
    apiKey: legacyProvider ? options.modelApiKey ?? '' : options.minimaxApiKey ?? process.env.MINIMAX_TOKEN_PLAN_KEY ?? '',
    environmentApiKey: options.environmentApiKey });
  const profiles = options.profiles ?? new ProfileStore({ directory, persist: options.persist !== false });
  const research = options.research ?? new ResearchStore({ directory: path.join(directory, 'research'), persist: options.persist !== false });
  const conditionsStore = options.conditionsStore ?? new ConditionStore({ directory, persist: options.persist !== false });
  const initialized = await Promise.allSettled([models.init(), profiles.init(), research.init(), conditionsStore.init()]);
  const failure = initialized.find(result => result.status === 'rejected');
  if (failure) { await runtime.close(); throw failure.reason; }
  try { await runtime.configureModels?.(models.snapshot()); await runtime.start(); }
  catch (error) { await runtime.close(); throw error; }
  const engine = new SessionEngine({ runtime, profiles, research, conditionsStore });
  const adminTokens = new Map();
  const loginAttempts = new Map();
  const creations = new Map();
  const pinHash = digest(adminPin);
  let closing = false;
  let modelUpdates = Promise.resolve();
  const probes = new Set();

  function requireAdmin(req) {
    if (openControls) return 'local-demo-open-controls';
    const token = bearer(req); const expires = adminTokens.get(token);
    if (expires && expires <= Date.now()) adminTokens.delete(token);
    requireThat(expires > Date.now(), 'ADMIN_AUTH', 'Sign in through the researcher window.', 401);
    return token;
  }
  function participant(req, id) {
    if (openControls) return engine.get(id);
    if (adminTokens.get(bearer(req)) > Date.now()) return engine.get(id);
    return engine.authorize(id, bearer(req));
  }
  function limit(map, key, count, duration, code) {
    const time = Date.now();
    const entry = map.get(key);
    const current = entry?.until > time ? entry : { count: 0, until: time + duration };
    requireThat(current.count < count, code, 'Too many attempts. Please retry later.', 429);
    current.count++; map.set(key, current);
    if (map.size > 2000) for (const [item, value] of map) if (value.until <= time) map.delete(item);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try {
      requireThat(!closing, 'CLOSING', 'The service is closing.', 503);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;
      if (req.method !== 'GET' && req.headers.origin) {
        requireThat(new URL(req.headers.origin).host === req.headers.host, 'ORIGIN', 'The request origin does not match.', 403);
      }
      if (route === '/api/meta' && req.method === 'GET') {
        const status = runtime.status();
        return json(res, { title: 'Agent on Request', modes: [
          { id: 'controlled', label: 'Controlled', available: true, description: 'Offline rule-based planning with real process communication and receipt confirmation.' },
          { id: 'live', label: 'Live', available: status.live.available, description: useHermes
            ? 'Planning in two local Hermes profiles with direct agent-comm delivery.' : 'Configured model planning; the session controller still enforces permissions.' },
          { id: 'replay', label: 'Replay', available: true, description: 'A synthetic reference trace; no messages or research records.' }
        ], live: status.live, openControls, consentVersion: 'research-v2', runtime: status });
      }
      if (route === '/api/conditions/catalog' && req.method === 'GET') return json(res, { ...conditionCatalog(profiles.template), templateRevision: profiles.templateRevision });
      if (route === '/api/conditions/schema' && req.method === 'GET') return json(res, conditionSchema(profiles.template));
      if (route === '/api/conditions/resolve' && req.method === 'POST') {
        const conditions = resolveConditions(await body(req), profiles.template);
        const defaults = resolveConditions(undefined, profiles.template);
        const config = conditionBobConfig(conditions, profiles.template);
        return json(res, { conditions, hash: hashValue(conditions), templateRevision: profiles.templateRevision,
          requiresResearcher: hashValue(conditions.agents.Bob) !== hashValue(defaults.agents.Bob),
          agentStates: buildAgentStates({ conditions, config, aliceCalendar: conditions.agents.Alice.data.calendar, receipts: { aliceToBob: [], bobToAlice: [] }, approvals: [], grants: [], policyUses: 0, aliceUses: 0, startedAt: new Date().toISOString() }) });
      }
      if (route === '/api/sessions' && req.method === 'POST') {
        limit(creations, req.socket.remoteAddress, 100, 60_000, 'CREATE_LIMIT');
        const input = await body(req);
        if (!openControls && Object.hasOwn(input, 'initialConditions')) {
          const conditions = resolveConditions(input.initialConditions, profiles.template);
          if (hashValue(conditions.agents.Bob) !== hashValue(resolveConditions(undefined, profiles.template).agents.Bob)) {
            const token = req.headers['x-researcher-token'] ?? bearer(req);
            requireThat(typeof token === 'string' && adminTokens.get(token) > Date.now(), 'BOB_CONDITIONS_AUTH', 'Sign in as researcher to initialize Bob with different knowledge, data, skills or authorization.', 401);
          }
        }
        const created = await engine.create(input);
        created.state = engine.view(engine.get(created.state.session.id), { perspective: 'owner' });
        return json(res, created, 201);
      }
      if (route === '/api/admin/login' && req.method === 'POST') {
        limit(loginAttempts, req.socket.remoteAddress, 10, 60_000, 'LOGIN_LIMIT');
        const input = await body(req);
        requireThat(typeof input.pin === 'string' && timingSafeEqual(digest(input.pin), pinHash), 'PIN_INVALID', 'The researcher PIN is incorrect.', 401);
        const token = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 4 * 60 * 60_000;
        adminTokens.set(token, expiresAt);
        if (adminTokens.size > 100) for (const [key, value] of adminTokens) if (value < Date.now()) adminTokens.delete(key);
        return json(res, { token, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (route.startsWith('/api/admin/')) {
        const token = requireAdmin(req);
        if (route === '/api/admin/logout' && req.method === 'POST') { adminTokens.delete(token); return json(res, { ok: true }); }
        if (route === '/api/admin/sessions' && req.method === 'GET') return json(res, engine.list());
        if (route === '/api/admin/runtime' && req.method === 'GET') return json(res, runtime.status());
        if (route === '/api/admin/conditions/default' && req.method === 'GET') return json(res, conditionsStore.getDefault());
        if (route === '/api/admin/conditions/default' && req.method === 'PUT') return json(res, await conditionsStore.setDefault(await body(req), profiles.template));
        if (route === '/api/admin/conditions' && req.method === 'GET') return json(res, { bundles: conditionsStore.list() });
        if (route === '/api/admin/conditions' && req.method === 'POST') return json(res, { bundle: await conditionsStore.save(await body(req), profiles.template), bundles: conditionsStore.list() });
        const conditionMatch = /^\/api\/admin\/conditions\/([a-f0-9-]{36})$/.exec(route);
        if (conditionMatch && req.method === 'DELETE') {
          await conditionsStore.delete(conditionMatch[1], Number(url.searchParams.get('expectedRevision')));
          return json(res, { bundles: conditionsStore.list() });
        }
        if (useHermes && /^\/api\/admin\/models(?:\/|$)/.test(route)) {
          throw new AppError('HERMES_MANAGED_MODELS', 'Configure models in the two local Hermes profiles.', 409);
        }
        if (route === '/api/admin/models' && req.method === 'GET') return json(res, models.view());
        if (route === '/api/admin/models/validate' && req.method === 'POST') return json(res, models.validate((await body(req)).config));
        if (route === '/api/admin/models/apply' && req.method === 'POST') {
          const input = await body(req);
          const update = modelUpdates.then(async () => { const view = await models.apply(input); await runtime.configureModels?.(models.snapshot()); return view; });
          modelUpdates = update.catch(() => {});
          return json(res, await update);
        }
        if (route === '/api/admin/models/test' && req.method === 'POST') {
          limit(creations, `model-test:${token}`, 12, 60_000, 'MODEL_TEST_LIMIT');
          const input = await body(req);
          const controller = new AbortController();
          const disconnect = () => { if (!res.writableEnded) controller.abort('client_disconnected'); };
          probes.add(controller); res.once('close', disconnect);
          if (res.destroyed || closing) controller.abort('service_closing');
          try { return json(res, await probeModel(models.snapshot(), input.role, controller.signal)); }
          finally { probes.delete(controller); res.off('close', disconnect); }
        }
        if (route === '/api/admin/config' && req.method === 'GET') return json(res, engine.configView(url.searchParams.get('sessionId')));
        if (route === '/api/admin/config/versions' && req.method === 'GET') return json(res, { versions: profiles.listVersions() });
        if (route === '/api/admin/config/validate' && req.method === 'POST') { const input = await body(req); return json(res, engine.validate(input.config, input.sessionId)); }
        if (route === '/api/admin/config/apply' && req.method === 'POST') return json(res, await engine.applyConfig(await body(req)));
        if (route === '/api/admin/profiles' && req.method === 'GET') return json(res, { profiles: profiles.list() });
        if (route === '/api/admin/profiles' && req.method === 'POST') {
          const input = await body(req); const validation = validateConfig(input.config);
          requireThat(validation.valid, 'CONFIG_INVALID', 'The profile configuration is invalid.', 422, validation.errors);
          return json(res, { profiles: await profiles.saveProfile(input.name, input.config) });
        }
        if (route === '/api/admin/research' && req.method === 'GET') return json(res, research.list());
        if (route === '/api/admin/research/export' && req.method === 'GET') {
          const format = url.searchParams.get('format') ?? 'jsonl';
          requireThat(['jsonl', 'csv'].includes(format), 'FORMAT', 'Choose CSV or JSONL.');
          res.writeHead(200, { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson', 'Content-Disposition': `attachment; filename="agent-on-request.${format}"`, 'Cache-Control': 'no-store' });
          return res.end(research.export(format));
        }
        let match = /^\/api\/admin\/sessions\/([^/]+)\/approvals$/.exec(route);
        if (match && req.method === 'GET') return json(res, { approvals: engine.approvals(match[1]) });
        match = /^\/api\/admin\/approvals\/([^/]+)\/decision$/.exec(route);
        if (match && req.method === 'POST') return json(res, await engine.decide(match[1], await body(req)));
        match = /^\/api\/admin\/sessions\/([^/]+)\/intervene$/.exec(route);
        if (match && req.method === 'POST') {
          const result = await engine.intervene(engine.get(match[1]), await body(req));
          if (result.token) result.state = engine.view(engine.get(result.state.session.id), { perspective: 'owner' });
          return json(res, result);
        }
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(preview|actions))?$/.exec(route);
      if (match) {
        const session = participant(req, match[1]);
        if (!match[2] && req.method === 'GET') {
          const perspective = url.searchParams.get('perspective') ?? 'owner';
          requireThat(['owner', 'observer'].includes(perspective), 'PERSPECTIVE', 'Choose owner or observer view.');
          if (perspective === 'observer') requireAdmin(req);
          return json(res, engine.view(session, { perspective }));
        }
        if (match[2] === 'preview' && req.method === 'POST') return json(res, await engine.preview(session, await body(req)));
        if (match[2] === 'actions' && req.method === 'POST') {
          // Administrators never impersonate Alice to authorize participant sharing.
          engine.authorize(match[1], bearer(req));
          const result = await engine.action(session, await body(req));
          result.state = engine.view(session, { perspective: 'owner' });
          return json(res, result);
        }
      }
      if (route.startsWith('/api/')) throw new AppError('NOT_FOUND', 'The API route does not exist.', 404);
      requireThat(req.method === 'GET' || req.method === 'HEAD', 'METHOD', 'The request method is not supported.', 405);
      const relative = route === '/' ? 'index.html' : route === '/console' || route === '/console/' ? 'console.html' : decodeURIComponent(route.slice(1));
      requireThat(/^[A-Za-z0-9_./-]+$/.test(relative) && !relative.split('/').includes('..') && !relative.startsWith('.'), 'NOT_FOUND', 'The file does not exist.', 404);
      const filename = path.join(root, 'public', relative);
      const type = MIME[path.extname(filename)]; requireThat(type, 'NOT_FOUND', 'The file does not exist.', 404);
      const content = await readFile(filename);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error.status ?? error.statusCode ?? (error.code === 'ENOENT' ? 404 : 500);
      const safe = status < 500 || error.code?.startsWith('MODEL_') || error.code === 'PEER_OFFLINE';
      json(res, { error: { code: status === 500 ? 'INTERNAL' : error.code ?? 'ERROR', message: safe ? error.message : 'The service could not complete this operation. Ask the researcher to inspect the runtime.', ...(error.details && status < 500 ? { details: error.details } : {}) } }, status);
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  const cleanup = setInterval(async () => {
    for (const session of [...engine.sessions.values()]) if (Date.now() - Date.parse(session.startedAt) > engine.sessionTtlMs) await engine.expire(session).catch(() => {});
    for (const [token, expires] of adminTokens) if (expires < Date.now()) adminTokens.delete(token);
  }, 60_000);
  cleanup.unref();
  return {
    server, engine, runtime, research, profiles, models, conditionsStore, adminPin,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); return server.address(); },
    async close() { closing = true; clearInterval(cleanup); for (const probe of probes) probe.abort('service_closing'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    app = await createDemoServer();
    const address = await app.listen();
    console.log(`Agent on Request: http://${address.address === '0.0.0.0' ? 'localhost' : address.address}:${address.port}`);
    console.log(`管理员 PIN: ${app.adminPin}`);
    console.log('配置与已同意研究记录保存于 .data；未同意的会话只在内存中。');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(`启动失败: ${error.code ?? 'ERROR'} — ${error.message}`); await app?.close(); process.exitCode = 1; }
}
