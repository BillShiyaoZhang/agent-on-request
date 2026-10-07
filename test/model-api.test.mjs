import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDemoServer } from '../src/server.mjs';

test('model administration is authenticated, defaults to China M3, redacts secrets, probes roles and fixes new-round snapshots', async t => {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); calls.push({ input, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"message":"PROVIDER_PRIVATE_TEXT"}' } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'synthetic-admin-pin', bobUrl: 'http://must-not-connect.invalid' });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, token, data) => {
    const reply = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: reply.status, data: await reply.json() };
  };
  const meta = (await call('/api/meta')).data;
  assert.equal(meta.runtime.bob.transport, 'ipc');
  assert.equal(meta.runtime.bob.isolation.network, false);
  assert.equal(meta.live.available, false);
  assert.equal((await call('/api/admin/models')).status, 401);
  const admin = (await call('/api/admin/login', null, { pin: 'synthetic-admin-pin' })).data.token;
  const before = (await call('/api/admin/models', admin)).data;
  assert.equal(before.config.baseUrl, 'https://api.minimax.cn/v1');
  assert.equal(before.config.agents.Alice.model, 'MiniMax-M3');
  assert.equal(before.config.agents.Bob.model, 'MiniMax-M3');
  assert.equal(before.keyConfigured, false);
  assert.equal((await call('/api/admin/models/test', admin, { role: 'Alice' })).data.error.code, 'MODEL_UNAVAILABLE');
  const round = (await call('/api/sessions', null, { mode: 'controlled' })).data;
  assert.equal((await call('/api/admin/models', round.token)).status, 401);
  assert.equal((await call('/api/admin/models/apply', round.token, { config: before.config, expectedRevision: 1 })).status, 401);
  const config = structuredClone(before.config);
  config.provider = 'openai_compatible'; config.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  config.agents.Alice = { ...config.agents.Alice, model: 'synthetic-alice', temperature: 0.7, maxTokens: 512 };
  config.agents.Bob = { ...config.agents.Bob, model: 'synthetic-bob', temperature: 1.3, maxTokens: 1024 };
  const invalid = await call('/api/admin/models/validate', admin, { config: { ...config, apiKey: 'DO_NOT_ECHO_SECRET' } });
  assert.equal(invalid.data.valid, false);
  assert.equal(JSON.stringify(invalid.data).includes('DO_NOT_ECHO_SECRET'), false);
  const secret = 'SYNTHETIC_PROVIDER_SECRET';
  const applied = await call('/api/admin/models/apply', admin, { config, apiKey: secret, expectedRevision: 1 });
  assert.equal(applied.status, 200); assert.equal(applied.data.revision, 2); assert.equal(applied.data.keyConfigured, true);
  assert.equal(JSON.stringify(applied.data).includes(secret), false);
  assert.equal((await call('/api/admin/models/apply', admin, { config, expectedRevision: 1 })).status, 409);
  for (const role of ['Alice', 'Bob']) {
    const probe = await call('/api/admin/models/test', admin, { role });
    assert.equal(probe.status, 200); assert.equal(probe.data.role, role);
    assert.equal(probe.data.model, config.agents[role].model);
    assert.equal(JSON.stringify(probe.data).includes('PROVIDER_PRIVATE'), false);
    const request = calls.at(-1); assert.equal(request.authorization, `Bearer ${secret}`);
    assert.equal(request.input.temperature, config.agents[role].temperature);
    assert.equal(request.input.max_tokens, config.agents[role].maxTokens);
    assert.equal(JSON.parse(request.input.messages[1].content).synthetic, true);
  }
  assert.equal((await call(`/api/sessions/${round.state.session.id}`, round.token)).data.session.modelRevision, 1);
  const newRound = (await call('/api/sessions', null, { mode: 'controlled' })).data;
  assert.equal(newRound.state.session.modelRevision, 2);
  assert.equal(newRound.state.models.agents.Bob.model, 'synthetic-bob');
  assert.equal(JSON.stringify(newRound).includes(secret), false);
  const endpointChanged = { ...config, baseUrl: `${config.baseUrl}/other` };
  assert.equal((await call('/api/admin/models/apply', admin, { config: endpointChanged, expectedRevision: 2 })).data.error.code, 'MODEL_KEY_RECONFIRM');
  assert.equal((await call('/api/admin/models/apply', admin, { config: before.config, expectedRevision: 2, clearKey: true })).data.keyConfigured, false);
  assert.equal((await call('/api/admin/models/test', admin, { role: 'Mallory' })).status, 400);
  assert.equal(JSON.stringify(app.research.list()).includes(secret), false);
});

test('disconnecting a connectivity test or closing the app cancels its parent provider request', async t => {
  for (const scenario of ['client_disconnect', 'app_close']) await t.test(scenario, async t => {
    let enteredResolve, closedResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const closed = new Promise(resolve => { closedResolve = resolve; });
    const provider = http.createServer(async (req, res) => {
      for await (const chunk of req) { /* Consume the synthetic request without completing it. */ }
      res.once('close', () => closedResolve(!res.writableEnded));
      enteredResolve();
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
    const app = await createDemoServer({ port: 0, persist: false, adminPin: 'synthetic-probe-pin' });
    await app.listen(); let appClosed = false;
    t.after(async () => { if (!appClosed) await app.close(); });
    const config = app.models.view().config;
    config.provider = 'openai_compatible'; config.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    config.agents.Alice.timeoutSeconds = 300;
    await app.models.apply({ config, expectedRevision: 1 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"synthetic-probe-pin"}' });
    const token = (await login.json()).token;
    const client = new AbortController();
    const request = fetch(`${base}/api/admin/models/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{"role":"Alice"}', signal: client.signal });
    const rejected = assert.rejects(request);
    await entered;
    if (scenario === 'client_disconnect') client.abort();
    else { await app.close(); appClosed = true; }
    let deadline;
    try { assert.equal(await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Provider request was not cancelled promptly.')), 1500); })]), true); }
    finally { clearTimeout(deadline); }
    await rejected;
  });
});
