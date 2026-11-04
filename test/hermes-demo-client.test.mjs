import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesDemoClient } from '../src/hermes-demo-client.mjs';

const endpoints = {
  alice: { url: 'http://127.0.0.1:8642/p/alice/v1/', apiKey: 'alice-fixture' },
  bob: { url: 'http://[::1]:8643/', apiKey: 'bob-fixture' },
};
const args = { role: 'Alice', input: '{"purpose":"fixture"}', instructions: 'Return one JSON proposal.', requestId: 'exact-attempt-01' };
const completed = { run_id: 'run_fixture', status: 'completed', completed: true, partial: false,
  output: '{"message":"fixture"}' };
const capabilities = { object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true },
  features: { run_submission: true, run_status: true, run_stop: true, runs_idempotency: { supported: true, durable: true } } };
const toolsets = { object: 'list', platform: 'api_server', data: [{ name: 'terminal', enabled: false }] };

function fixture(respond, inventory = toolsets) {
  const calls = [];
  const client = createHermesDemoClient({ endpoints, pollIntervalMs: 5, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    return path.endsWith('/v1/toolsets') ? Response.json(inventory) : respond(path, options);
  } });
  return { calls, client };
}

test('checks authenticated Hermes run capabilities and readiness without inference', async () => {
  const { calls, client } = fixture(path => Response.json(path.endsWith('/capabilities') ? capabilities
    : { platform: 'hermes-agent', status: 'ok', readiness: { status: 'ok' } }));
  assert.deepEqual(await client.check({ role: 'Bob' }), { ready: true });
  assert.deepEqual(calls.map(call => call.url), ['http://[::1]:8643/v1/capabilities', 'http://[::1]:8643/health/detailed', 'http://[::1]:8643/v1/toolsets']);
  assert(calls.every(({ options }) => options.method === 'GET' && options.redirect === 'error'
    && options.headers.Authorization === 'Bearer bob-fixture'));
  const unavailable = fixture(path => path.endsWith('/capabilities') ? Response.json(capabilities)
    : Response.json({ platform: 'hermes-agent', status: 'degraded', readiness: { status: 'degraded' } }));
  await assert.rejects(unavailable.client.check({ role: 'Alice' }), { code: 'HERMES_NOT_READY' });
});

test('submits one idempotent proposal, polls the same role, and returns only the parsed object', async () => {
  let polls = 0;
  const { calls, client } = fixture((_path, options) => options.method === 'POST'
    ? Response.json({ run_id: 'run_fixture', status: 'queued' }, { status: 202 })
    : Response.json(++polls === 1 ? { run_id: 'run_fixture', status: 'running' } : completed));
  assert.deepEqual(await client.propose(args), { message: 'fixture' });
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['http://127.0.0.1:8642/p/alice/v1/toolsets', 'GET'],
    ['http://127.0.0.1:8642/p/alice/v1/runs', 'POST'],
    ['http://127.0.0.1:8642/p/alice/v1/runs/run_fixture', 'GET'],
    ['http://127.0.0.1:8642/p/alice/v1/runs/run_fixture', 'GET'],
  ]);
  assert(calls.every(({ options }) => options.headers.Authorization === 'Bearer alice-fixture'));
  assert.equal(calls[1].options.headers['Idempotency-Key'], args.requestId);
  assert.deepEqual(JSON.parse(calls[1].options.body), { input: args.input, instructions: args.instructions,
    author: { id: 'bot:agent-on-request', name: 'Agent on Request', is_bot: true } });
});

test('rejects incomplete runs and text around a JSON proposal', async () => {
  for (const result of [
    { ...completed, status: 'failed', completed: false },
    { ...completed, partial: true },
    { ...completed, output: '```json\n{"message":"fixture"}\n```' },
  ]) {
    const { calls, client } = fixture((_path, options) => options.method === 'POST'
      ? Response.json({ run_id: 'run_fixture' }, { status: 202 }) : Response.json(result));
    await assert.rejects(client.propose(args), error => ['MODEL_PROVIDER_ERROR', 'MODEL_INVALID_OUTPUT'].includes(error.code));
    assert.equal(calls.length, 3);
  }
});

test('passes an explicit decline to the caller for conservative projection', async () => {
  const output = '{"decision":"none","selectedMappingIds":["ignored"],"__proto__":{}}';
  const { client } = fixture((_path, options) => options.method === 'POST'
    ? Response.json({ run_id: 'run_fixture' }, { status: 202 }) : Response.json({ ...completed, output }));
  assert.deepEqual(await client.propose(args), JSON.parse(output));
});

test('stops an active run when a deadline or cancellation interrupts it', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const { calls, client } = fixture((path, options) => {
      if (path.endsWith('/stop')) return new Response(null, { status: 202 });
      if (options.method === 'POST') return Response.json({ run_id: 'run_fixture' }, { status: 202 });
      if (abort) controller.abort();
      return Response.json({ run_id: 'run_fixture', status: 'running' });
    });
    await assert.rejects(client.propose({ ...args, timeoutMs: 80, signal: controller.signal }),
      { code: abort ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT' });
    const stop = calls.at(-1);
    assert(stop.url.endsWith('/run_fixture/stop'));
    assert.equal(stop.options.method, 'POST');
    assert.equal(stop.options.signal.aborted, false);
  }
});

test('rejects redirects and non-loopback or credential-bearing endpoint URLs', async () => {
  for (const url of ['http://localhost:8642', 'http://192.168.1.2:8642', 'http://127.0.0.1:8642@external.test',
    'http://name:secret@127.0.0.1:8642', 'http://127.0.0.1:8642?query', 'http://127.0.0.1:8642/p/alice/other']) {
    assert.throws(() => createHermesDemoClient({ endpoints: { ...endpoints, alice: { ...endpoints.alice, url } } }),
      { code: 'HERMES_CONFIGURATION' });
  }
  assert.throws(() => createHermesDemoClient({ endpoints: { ...endpoints, bob: { ...endpoints.bob,
    url: 'http://[::1]:8642' } } }), { code: 'HERMES_CONFIGURATION' });
  const { calls, client } = fixture(() => new Response(null, { status: 307, headers: { Location: 'https://external.test' } }));
  await assert.rejects(client.propose(args), { code: 'MODEL_PROVIDER_ERROR' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.redirect, 'error');
});

test('refuses to submit if the current Hermes profile exposes a toolset', async () => {
  const { calls, client } = fixture(() => assert.fail('A proposal must not be submitted'),
    { ...toolsets, data: [{ name: 'terminal', enabled: true }] });
  await assert.rejects(client.propose(args), { code: 'HERMES_TOOLSETS' });
  assert.deepEqual(calls.map(call => call.options.method), ['GET']);
});
