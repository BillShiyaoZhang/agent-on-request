import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const app = await createDemoServer({ host: '127.0.0.1', port: 0, persist: false,
    adminPin: 'synthetic-open-controls-pin', minimaxApiKey: '', ...options });
  await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, input, token, { method, headers } = {}) {
    const response = await fetch(base + route, { method: method ?? (input === undefined ? 'GET' : 'POST'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : await response.text() };
  }
  async function ok(route, input, token, options, expected = 200) {
    const response = await call(route, input, token, options);
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  return { app, call, ok };
}

test('local open controls expose all demo tools while exact participant sharing and Bob approval remain enforced', async t => {
  const { app, call, ok } = await fixture(t, { openControls: true });
  assert.equal((await ok('/api/meta')).openControls, true);
  for (const route of ['/api/admin/sessions', '/api/admin/config', '/api/admin/config/versions', '/api/admin/profiles',
    '/api/admin/conditions', '/api/admin/models', '/api/admin/research']) await ok(route);
  assert.equal(typeof await ok('/api/admin/research/export?format=csv'), 'string');
  assert.equal(typeof await ok('/api/admin/research/export?format=jsonl'), 'string');

  const initialConditions = { custom: { Bob: { data: { brief: { topic: 'Open demo synthetic topic', agenda: 'Scope and consent' } } } } };
  const initialPreview = await ok('/api/conditions/resolve', initialConditions);
  const created = await ok('/api/sessions', { mode: 'controlled', researchConsent: false, initialConditions,
    expectedConditionsHash: initialPreview.hash }, undefined, undefined, 201);
  const id = created.state.session.id, token = created.token, sessionRoute = `/api/sessions/${id}`;
  assert.equal((await ok(sessionRoute)).session.id, id, 'open controls can inspect a round without its participant credential');
  assert.equal((await ok(`/api/admin/sessions/${id}/approvals`)).approvals.length, 0);

  const paused = await ok(`/api/admin/sessions/${id}/intervene`, { action: 'pause' });
  assert.equal(paused.state.session.paused, true);
  await ok(`/api/admin/sessions/${id}/intervene`, { action: 'resume' });
  await ok(`/api/admin/sessions/${id}/intervene`, { action: 'disconnect_bob' });
  for (const [stage, choice] of [['initial', 'free'], ['additional', 'narrow']]) {
    const preview = await ok(`${sessionRoute}/preview`, { stage, choice });
    const input = { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
      previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() };
    assert.equal((await call(`${sessionRoute}/actions`, input)).status, 401, 'direct demo controls do not impersonate Alice sharing');
    assert.equal((await call(`${sessionRoute}/actions`, { ...input, previewHash: '0'.repeat(64) }, token)).status, 409);
    const submitted = await ok(`${sessionRoute}/actions`, input, token);
    if (stage === 'initial') {
      assert.equal(submitted.state.waiting.reason, 'peer_offline');
      assert.equal(submitted.state.receipts.aliceToBob.length, 0);
      const restored = await ok(`/api/admin/sessions/${id}/intervene`, { action: 'restore_bob' });
      assert.equal(restored.state.receipts.aliceToBob.length, 0, 'restoring connectivity is not delivery approval');
      const retried = await ok(`/api/admin/sessions/${id}/intervene`, { action: 'retry' });
      assert.equal(retried.state.receipts.aliceToBob.length, 1);
    } else assert.equal(submitted.state.session.stage, 'waiting_admin');
  }
  const approval = (await ok(`/api/admin/sessions/${id}/approvals`)).approvals.find(item => item.status === 'pending');
  const decision = { decision: 'allow_once', fields: ['topic'], expectedPolicyRevision: approval.policyRevision,
    expectedPayloadHash: approval.payloadHash };
  assert.equal((await call(`/api/admin/approvals/${approval.id}/decision`, { ...decision, fields: ['outside_scope'] })).status, 400);
  assert.equal((await call(`/api/admin/approvals/${approval.id}/decision`, { ...decision, expectedPayloadHash: '0'.repeat(64) })).status, 409);
  const approved = await ok(`/api/admin/approvals/${approval.id}/decision`, decision);
  assert.equal(approved.state.task.outcome, 'arranged');
  assert.deepEqual(approved.state.receipts.bobToAlice.at(-1).values, { topic: 'Open demo synthetic topic' });
  assert.equal(approved.state.receipts.bobToAlice.at(-1).fields.includes('agenda'), false);
  assert.equal((await call(`/api/admin/approvals/${approval.id}/decision`, decision)).status, 409);

  const configView = await ok(`/api/admin/config?sessionId=${id}`);
  const edited = structuredClone(configView.active); edited.objective = 'Arrange a synthetic demo follow-up.';
  assert.equal((await ok('/api/admin/config/validate', { config: edited, sessionId: id })).valid, true);
  const applied = await ok('/api/admin/config/apply', { config: edited, target: 'session', sessionId: id, expectedRevision: configView.activeRevision });
  assert.equal(applied.state.session.paused, true);
  const templateApplied = await ok('/api/admin/config/apply', { config: edited, target: 'template', expectedRevision: configView.templateRevision });
  assert.equal(templateApplied.template.objective, edited.objective);
  assert((await ok('/api/admin/config/versions')).versions.some(item => item.config.objective === edited.objective));
  const profile = await ok('/api/admin/profiles', { name: 'Open control fixture', config: edited });
  assert(profile.profiles.some(item => item.name === 'Open control fixture'));
  const saved = await ok('/api/admin/conditions', { name: 'Open control fixture pack', input: initialConditions });
  const deleted = await ok(`/api/admin/conditions/${saved.bundle.id}?expectedRevision=${saved.bundle.revision}`,
    undefined, undefined, { method: 'DELETE' });
  assert.equal(deleted.bundles.length, 0);
  assert.equal((await call('/api/admin/config/apply', { config: edited, target: 'template', expectedRevision: configView.templateRevision },
    undefined, { headers: { Origin: 'http://outside.invalid' } })).status, 403);
  for (const action of ['end', 'stop_sharing']) assert.equal((await call(`${sessionRoute}/actions`, {
    action, requestId: randomUUID(), expectedVersion: applied.state.session.version })).status, 401);
  assert.equal((await ok(sessionRoute)).session.ended, false);

  const reset = await ok(`/api/admin/sessions/${id}/intervene`, { action: 'reset' });
  assert.notEqual(reset.state.session.id, id);
  assert.deepEqual(reset.state.receipts, { aliceToBob: [], bobToAlice: [] });
  assert.equal(reset.state.session.researchConsent, false);
  assert.equal((await call(sessionRoute)).status, 404);
  await ok('/api/admin/logout', {});
  assert.equal((await ok('/api/meta')).openControls, true);
  assert.equal((await ok('/api/admin/research')).runs.length, 0, 'open controls do not imply research consent');
  assert.equal(app.engine.sessions.size, 1);
});

test('open model controls validate, save and probe both roles without login or credential disclosure', async t => {
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* synthetic request only */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"message":"SYNTHETIC_PRIVATE_PROVIDER_TEXT"}' } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const { ok } = await fixture(t, { openControls: true });
  const before = await ok('/api/admin/models');
  const config = structuredClone(before.config);
  config.provider = 'openai_compatible'; config.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  config.agents.Alice.model = 'synthetic-open-Alice'; config.agents.Bob.model = 'synthetic-open-Bob';
  assert.equal((await ok('/api/admin/models/validate', { config })).valid, true);
  const syntheticKey = 'SYNTHETIC_OPEN_CONTROL_KEY';
  const applied = await ok('/api/admin/models/apply', { config, apiKey: syntheticKey, expectedRevision: before.revision });
  assert.equal(applied.keyConfigured, true);
  assert.equal(JSON.stringify(applied).includes(syntheticKey), false);
  for (const role of ['Alice', 'Bob']) {
    const result = await ok('/api/admin/models/test', { role });
    assert.equal(result.role, role);
    assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER'), false);
    assert.equal(JSON.stringify(result).includes(syntheticKey), false);
  }
  const cleared = await ok('/api/admin/models/apply', { config, clearKey: true, expectedRevision: applied.revision });
  assert.equal(cleared.keyConfigured, false);
});

test('normal service stays PIN protected by default and never exposes a participant round without authorization', async t => {
  const { call, ok } = await fixture(t);
  assert.equal((await ok('/api/meta')).openControls, false);
  assert.equal((await call('/api/admin/config')).status, 401);
  assert.equal((await call('/api/admin/models')).status, 401);
  assert.equal((await call('/api/sessions', { initialConditions: { presetId: 'minimal' } })).status, 401);
  const admin = (await ok('/api/admin/login', { pin: 'synthetic-open-controls-pin' })).token;
  await ok('/api/admin/config', undefined, admin);
  const created = await ok('/api/sessions', { mode: 'controlled' }, undefined, undefined, 201);
  const route = `/api/sessions/${created.state.session.id}`;
  assert.equal((await call(route)).status, 401);
  await ok(route, undefined, created.token);
  await ok(route, undefined, admin);
  await ok('/api/admin/logout', {}, admin);
  assert.equal((await call('/api/admin/config', undefined, admin)).status, 401);
});

test('open controls cannot bind a public or non-local host', async t => {
  for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.com']) await t.test(host, async () => {
    let app;
    try {
      await assert.rejects(async () => { app = await createDemoServer({ host, port: 0, persist: false, openControls: true,
        minimaxApiKey: '', adminPin: 'synthetic-open-controls-pin' }); }, error => error.status === 400 || error.code?.includes('HOST'));
    } finally { await app?.close(); }
  });
  for (const host of ['127.0.0.1', 'localhost', '::1']) await t.test(host, async () => {
    const app = await createDemoServer({ host, port: 0, persist: false, openControls: true, minimaxApiKey: '', adminPin: 'synthetic-open-controls-pin' });
    await app.close();
  });
});
