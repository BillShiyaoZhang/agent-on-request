import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRuntimeManager, hashPayload } from '../src/runtime-manager.mjs';
import { WorkerClient } from '../src/runtime-client.mjs';
import { DEFAULT_BOB_CONFIG } from '../src/config.mjs';
import { ALICE_CALENDAR } from '../src/scenario.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixtureProvider(t) {
  const calls = [];
  const holds = [];
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const record = { path: request.url, authorization: request.headers.authorization, body, context };
    calls.push(record);
    const hold = holds.shift();
    if (hold) {
      response.once('close', () => hold.closed.resolve({ aborted: !response.writableEnded }));
      hold.entered.resolve(record);
      await hold.release.promise;
      if (response.destroyed) return;
    }
    const proposal = Object.hasOwn(context, 'ownCalendar')
      ? { message: 'Alice received a model proposal; sharing still requires participant approval.' }
      : { message: 'Bob has only the actually received projection.', action: { type: 'request_more' } };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      tool_calls: [{ id: 'synthetic-proposal', type: 'function', function: {
        name: 'submit_proposal', arguments: JSON.stringify(proposal) } }] } }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const hold of holds) hold.release.resolve();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls,
    holdNext() {
      const hold = { entered: deferred(), release: deferred(), closed: deferred() };
      holds.push(hold);
      return hold;
    },
  };
}

function modelSnapshot(baseUrl, revision, suffix, provider = 'minimax_cn_token_plan') {
  // Internal manager fixtures use loopback even for the MiniMax wire format; ModelStore enforces the production endpoint.
  return { revision, apiKey: `FIXTURE_PARENT_SECRET_${suffix}`, config: { provider, baseUrl,
    agents: {
      Alice: { model: `Alice-${suffix}`, temperature: 0.15, maxTokens: 111, timeoutSeconds: 3, retryLimit: 0, thinking: 'disabled' },
      Bob: { model: `Bob-${suffix}`, temperature: 0.85, maxTokens: 222, timeoutSeconds: 4, retryLimit: 0, thinking: 'adaptive' },
    } } };
}

async function round(manager, sessionId, epoch = 1) {
  const ref = { sessionId, epoch };
  const bobConfig = structuredClone(DEFAULT_BOB_CONFIG);
  bobConfig.runtime = { model: 'legacy-must-not-win', temperature: 0.99, timeoutSeconds: 20, retryLimit: 3 };
  await manager.initialize({ ...ref, mode: 'live', configRevision: 1,
    aliceData: ALICE_CALENDAR, bobConfig });
  return ref;
}

async function deliverFree(manager, ref) {
  const projection = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'free' });
  await manager.deliverToBob({ ...ref, ...projection, operationId: 'approved-free', payloadHash: hashPayload(projection) });
  return projection;
}

function assertRoleRequest(record, snapshot, role) {
  const settings = snapshot.config.agents[role];
  assert.equal(record.path, '/v1/chat/completions');
  assert.equal(record.authorization, `Bearer ${snapshot.apiKey}`);
  assert.equal(record.body.model, settings.model);
  assert.equal(record.body.temperature, settings.temperature);
  assert.equal(record.body.stream, false);
  assert.equal(record.body.tools[0].function.name, 'submit_proposal');
  if (snapshot.config.provider === 'minimax_cn_token_plan') {
    assert.equal(record.body.max_completion_tokens, settings.maxTokens);
    assert.deepEqual(record.body.thinking, { type: settings.thinking });
    assert.equal(record.body.reasoning_split, true);
    assert(!Object.hasOwn(record.body, 'response_format'));
  } else {
    assert.equal(record.body.max_tokens, settings.maxTokens);
    assert.deepEqual(record.body.response_format, { type: 'json_object' });
    assert.equal(record.body.store, false);
  }
}

test('active rounds keep their parent provider snapshot; new rounds use independent new role settings', async t => {
  const oldProvider = await fixtureProvider(t);
  const nextProvider = await fixtureProvider(t);
  const oldSnapshot = modelSnapshot(oldProvider.baseUrl, 7, 'old');
  const nextSnapshot = modelSnapshot(nextProvider.baseUrl, 8, 'next', 'openai_compatible');
  const rpcMessages = [];
  const originalCall = WorkerClient.prototype.call;
  WorkerClient.prototype.call = function (method, args, ...rest) {
    if (['initialize', 'configureModel'].includes(method)) rpcMessages.push({ role: this.role, method, args: structuredClone(args) });
    return originalCall.call(this, method, args, ...rest);
  };
  t.after(() => { WorkerClient.prototype.call = originalCall; });
  const manager = createRuntimeManager();
  t.after(() => manager.close());
  await manager.configureModels(oldSnapshot);
  const active = await round(manager, 'old-round');
  const hold = oldProvider.holdNext();
  const pending = manager.planAlice({ ...active, purpose: 'intro' });
  await hold.entered.promise;
  await manager.configureModels(nextSnapshot);
  hold.release.resolve();
  assert.match((await pending).message, /participant approval/);
  const projection = await deliverFree(manager, active);
  assert.equal((await manager.planBob({ ...active, purpose: 'initial', configRevision: 1 })).action.type, 'request_more');
  assert.equal(nextProvider.calls.length, 0);
  assertRoleRequest(oldProvider.calls[0], oldSnapshot, 'Alice');
  assertRoleRequest(oldProvider.calls[1], oldSnapshot, 'Bob');
  assert.deepEqual(oldProvider.calls[1].context.received.map(item => item.rows), [projection.rows]);
  assert(!Object.hasOwn(oldProvider.calls[1].context, 'ownCalendar'));
  assert(!JSON.stringify(oldProvider.calls[1].context).includes('title'));
  assert.equal(manager.modelInfo(active).revision, 7);
  assert.equal(manager.modelInfo().revision, 8);

  const next = await round(manager, 'next-round');
  await manager.planAlice({ ...next, purpose: 'intro' });
  await deliverFree(manager, next);
  await manager.planBob({ ...next, purpose: 'initial', configRevision: 1 });
  assert.equal(oldProvider.calls.length, 2);
  assertRoleRequest(nextProvider.calls[0], nextSnapshot, 'Alice');
  assertRoleRequest(nextProvider.calls[1], nextSnapshot, 'Bob');
  for (const message of rpcMessages.filter(item => item.method === 'initialize')) {
    const snapshot = message.args.sessionId === 'old-round' ? oldSnapshot : nextSnapshot;
    assert.equal(message.args.modelRevision, snapshot.revision);
    assert.deepEqual(message.args.modelSettings, snapshot.config.agents[message.role]);
  }
  const workerMessages = JSON.stringify(rpcMessages);
  for (const snapshot of [oldSnapshot, nextSnapshot]) {
    assert(!workerMessages.includes(snapshot.apiKey));
    assert(!workerMessages.includes(snapshot.config.baseUrl));
    assert(!JSON.stringify(manager.status()).includes(snapshot.apiKey));
  }
  assert.equal(manager.status().alice.isolation.network, false);
  assert.equal(manager.status().bob.isolation.network, false);
});

test('clearing global credentials blocks new live rounds while an active round retains its fixed snapshot', async t => {
  const provider = await fixtureProvider(t);
  const snapshot = modelSnapshot(provider.baseUrl, 1, 'active');
  const manager = createRuntimeManager();
  t.after(() => manager.close());
  await manager.configureModels(snapshot);
  const active = await round(manager, 'credential-snapshot');
  const cleared = structuredClone(snapshot);
  cleared.revision = 2;
  cleared.apiKey = '';
  await manager.configureModels(cleared);
  assert.equal(manager.status().live.available, false);
  assert.match((await manager.planAlice({ ...active, purpose: 'proposal' })).message, /participant approval/);
  assertRoleRequest(provider.calls[0], snapshot, 'Alice');
  await assert.rejects(round(manager, 'no-key-new-round'), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(provider.calls.length, 1);
  assert.equal(manager.modelInfo(active).revision, 1);
});

test('clear cancels the manager parent network request and rejects its late model result', async t => {
  const provider = await fixtureProvider(t);
  const manager = createRuntimeManager();
  t.after(() => manager.close());
  await manager.configureModels(modelSnapshot(provider.baseUrl, 1, 'clear'));
  const ref = await round(manager, 'clear-parent-request');
  const hold = provider.holdNext();
  const pending = assert.rejects(manager.planAlice({ ...ref, purpose: 'intro' }), { code: 'STALE_EPOCH' });
  await hold.entered.promise;
  await manager.clear(ref);
  await pending;
  assert.equal((await hold.closed.promise).aborted, true);
  hold.release.resolve();
  assert.equal(provider.calls.length, 1);
  await assert.rejects(manager.planAlice({ ...ref, purpose: 'intro' }), { code: 'STALE_EPOCH' });
});

test('applying a Bob policy revision cancels only Bob planning and cannot accept the old result', async t => {
  const provider = await fixtureProvider(t);
  const manager = createRuntimeManager();
  t.after(() => manager.close());
  await manager.configureModels(modelSnapshot(provider.baseUrl, 1, 'policy'));
  const ref = await round(manager, 'bob-policy-parent-request');
  await deliverFree(manager, ref);
  const hold = provider.holdNext();
  const pending = assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }), { code: 'CONFIGURATION_CHANGED' });
  await hold.entered.promise;
  const revised = structuredClone(DEFAULT_BOB_CONFIG);
  revised.collaboration.acceptInvitations = false;
  await manager.updateBob({ ...ref, bobConfig: revised, configRevision: 2 });
  await pending;
  assert.equal((await hold.closed.promise).aborted, true);
  hold.release.resolve();
  assert.equal((await manager.planBob({ ...ref, purpose: 'initial', configRevision: 2 })).action.type, 'no_match');
  await manager.planAlice({ ...ref, purpose: 'intro' });
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].body.model, 'Alice-policy');
});
