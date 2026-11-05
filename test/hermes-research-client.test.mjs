import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesResearchClient, RESEARCH_TOOL_NAMES } from '../src/hermes-research-client.mjs';

const endpoints = {
  alice: { url: 'http://127.0.0.1:8642/p/alice/v1/', apiKey: 'alice-fixture' },
  bob: { url: 'http://[::1]:8643/', apiKey: 'bob-fixture' },
};
const tools = { object: 'list', platform: 'api_server', data: [
  { name: 'research', enabled: true, configured: true, tools: [...RESEARCH_TOOL_NAMES] },
  { name: 'terminal', enabled: false, tools: ['terminal', 'process_manage'] },
] };
const capabilities = { object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true },
  features: { run_submission: true, run_status: true, run_stop: true, runs_idempotency: { supported: true, durable: true } } };
const completed = { run_id: 'run_research', status: 'completed', completed: true, output: 'The task service contains the actual results.' };
const input = { role: 'Alice', input: 'Continue task fixture from checkpoint. Retrieve your own state and load the relevant research skill.', requestId: 'research:fixture:1' };
function fixture(respond, inventory = tools) {
  const calls = [];
  const client = createHermesResearchClient({ endpoints, pollIntervalMs: 5,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const route = new URL(url).pathname;
      return route.endsWith('/v1/toolsets') ? Response.json(inventory) : respond(route, options);
    } });
  return { client, calls };
}

test('native readiness requires durable runs, healthy profile and the exact read-only tool surface', async () => {
  const { client, calls } = fixture(route => Response.json(route.endsWith('/capabilities') ? capabilities
    : { platform: 'hermes-agent', status: 'ok', readiness: { status: 'ok' } }));
  assert.deepEqual(await client.check({ role: 'Bob' }), { ready: true, tools: [...RESEARCH_TOOL_NAMES] });
  assert(calls.every(({ options }) => options.headers.Authorization === 'Bearer bob-fixture' && options.redirect === 'error'));
  for (const unsafe of [
    { ...tools, data: [...tools.data, { name: 'skills', enabled: true, tools: ['skills_list', 'skill_view', 'skill_manage'] }] },
    { ...tools, data: [{ ...tools.data[0], tools: [...RESEARCH_TOOL_NAMES, 'terminal'] }] },
    { ...tools, data: [{ ...tools.data[0], tools: RESEARCH_TOOL_NAMES.slice(1) }] },
    { ...tools, data: [{ ...tools.data[0], configured: false }] },
  ]) {
    const unsafeClient = fixture(() => assert.fail('Must not submit a native run'), unsafe);
    await assert.rejects(unsafeClient.client.run(input), { code: 'HERMES_RESEARCH_TOOLS' });
    assert.equal(unsafeClient.calls.length, 1);
    assert.deepEqual(unsafeClient.client.active(), []);
  }
});

test('native run supports multi-step Hermes output without treating it as an execution receipt', async () => {
  let polls = 0;
  const { client, calls } = fixture((_route, options) => options.method === 'POST'
    ? Response.json({ run_id: 'run_research', status: 'queued' }, { status: 202 })
    : Response.json(++polls === 1 ? { run_id: 'run_research', status: 'running' } : completed));
  const result = await client.run(input);
  assert.deepEqual(result, { runId: 'run_research', status: 'completed', output: completed.output });
  const admitted = calls.find(({ options }) => options.method === 'POST');
  assert.equal(admitted.options.headers['Idempotency-Key'], input.requestId);
  assert.equal(JSON.parse(admitted.options.body).input, input.input);
  assert(!JSON.stringify(admitted.options.body).includes('alice-fixture'));
  assert(!Object.hasOwn(result, 'receipt'));
  assert.deepEqual(client.active(), []);
});

test('run admission is awaited by the durable callback before status polling', async () => {
  let persist;
  const persisted = new Promise(resolve => { persist = resolve; });
  let admitted;
  const entered = new Promise(resolve => { admitted = resolve; });
  const { client, calls } = fixture((_route, options) => options.method === 'POST'
    ? Response.json({ run_id: 'run_research' }, { status: 202 }) : Response.json(completed));
  const running = client.run({ ...input, onAdmitted: async value => {
    assert.deepEqual(value, { runId: 'run_research', requestId: input.requestId });
    admitted(); await persisted;
  } });
  await entered;
  assert.equal(calls.filter(call => call.url.endsWith('/run_research')).length, 0);
  assert.deepEqual(client.active(), [{ role: 'alice', requestId: input.requestId, runId: 'run_research' }]);
  persist(); await running;
  assert.deepEqual(client.active(), []);
});

test('a new client adopts a persisted interrupted run and confirms its stop without submitting another', async () => {
  let stopped = false;
  const { client, calls } = fixture((route, options) => {
    assert(!route.endsWith('/v1/runs'), 'Known run recovery must not submit a run');
    if (route.endsWith('/stop')) { stopped = true; return new Response(null, { status: 202 }); }
    assert.equal(options.method, 'GET');
    return Response.json({ run_id: 'run_persisted', status: stopped ? 'cancelled' : 'running' });
  });
  assert.deepEqual(await client.reconcile({ role: 'Alice', runId: 'run_persisted', requestId: 'durable-request-1' }),
    { settled: true, runId: 'run_persisted' });
  assert.equal(calls[0].options.method, 'GET');
  assert(calls.some(call => call.url.endsWith('/run_persisted/stop')));
  assert.deepEqual(client.active(), []);
});

test('lost admission after a process restart reuses the exact durable request and original run', async () => {
  const posts = []; const existing = new Map(); let createdRuns = 0; let stopped = false;
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/v1/toolsets')) return Response.json(tools);
    if (route.endsWith('/v1/runs')) {
      const key = options.headers['Idempotency-Key']; posts.push({ key, body: options.body });
      if (!existing.has(key)) {
        createdRuns++; existing.set(key, { id: 'run_original', body: options.body });
        throw new TypeError('Admission committed but the response was lost');
      }
      assert.equal(options.body, existing.get(key).body);
      return Response.json({ run_id: existing.get(key).id }, { status: 202 });
    }
    if (route.endsWith('/stop')) { stopped = true; return Response.json({ stopped: true }); }
    return Response.json({ run_id: 'run_original', status: stopped ? 'cancelled' : 'running' });
  };
  const original = { ...input, instructions: 'Use only scoped tools and actual receipts.' };
  const oldProcess = createHermesResearchClient({ endpoints, fetchImpl, pollIntervalMs: 5 });
  await assert.rejects(oldProcess.run(original), { code: 'HERMES_RUN_UNSETTLED' });
  const restartedProcess = createHermesResearchClient({ endpoints, fetchImpl, pollIntervalMs: 5 });
  assert.deepEqual(await restartedProcess.reconcile({ ...original, runId: null }), { settled: true, runId: 'run_original' });
  assert.equal(createdRuns, 1);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].key, original.requestId);
  assert.deepEqual(posts[1], posts[0]);
  assert.deepEqual(restartedProcess.active(), []);
});

test('unconfirmed persisted recovery keeps the role occupied, including on malformed references', async () => {
  const { client } = fixture(() => Response.json({ run_id: 'run_unknown', status: 'unknown' }));
  await assert.rejects(client.reconcile({ role: 'Alice', runId: 'run_unknown', requestId: 'persisted-unknown' }), { code: 'HERMES_RUN_UNSETTLED' });
  await assert.rejects(client.run(input), { code: 'HERMES_RESEARCH_BUSY' });
  assert.deepEqual(await client.reconcile({ role: 'Alice' }), { settled: false, runId: 'run_unknown' });
  const malformed = fixture(() => assert.fail('Malformed run identifiers cannot be dispatched')).client;
  await assert.rejects(malformed.reconcile({ role: 'Bob', runId: '../another-role', requestId: 'persisted-malformed' }), { code: 'HERMES_RUN_UNSETTLED' });
  assert.equal(malformed.active().length, 1);
});

test('a role is exclusive until its active run settles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client } = fixture(async (_route, options) => {
    if (options.method === 'POST') return Response.json({ run_id: 'run_research' }, { status: 202 });
    await gate; return Response.json(completed);
  });
  const first = client.run(input);
  await assert.rejects(client.run({ ...input, requestId: 'research:fixture:2' }), { code: 'HERMES_RESEARCH_BUSY' });
  release(); await first;
});

test('cancellation stops and confirms the native run before releasing its assignment', async () => {
  const controller = new AbortController(); let stopped = false;
  const { client, calls } = fixture((route, options) => {
    if (route.endsWith('/stop')) { stopped = true; return new Response(null, { status: 202 }); }
    if (options.method === 'POST') return Response.json({ run_id: 'run_research' }, { status: 202 });
    if (stopped) return Response.json({ run_id: 'run_research', status: 'cancelled' });
    controller.abort(); return Response.json({ run_id: 'run_research', status: 'running' });
  });
  await assert.rejects(client.run({ ...input, signal: controller.signal }), { code: 'MODEL_CANCELLED' });
  assert(calls.some(({ url }) => url.endsWith('/stop')));
  assert.deepEqual(client.active(), []);
});

test('lost admission remains occupied instead of allowing a duplicate task run', async () => {
  const { client } = fixture(() => { throw new TypeError('connection closed after POST'); });
  await assert.rejects(client.run(input), { code: 'HERMES_RUN_UNSETTLED' });
  assert.equal(client.active().length, 1);
  assert.deepEqual(await client.reconcile({ role: 'Alice' }), { settled: false, runId: null });
  await assert.rejects(client.run({ ...input, requestId: 'next-run' }), { code: 'HERMES_RESEARCH_BUSY' });
});

test('definite idempotency conflict does not keep a non-admitted role occupied', async () => {
  const { client } = fixture(() => Response.json({ error: 'conflict' }, { status: 409 }));
  await assert.rejects(client.run(input), { code: 'HERMES_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(client.active(), []);
});

test('malformed or failed terminal result cannot be reported as a completed native run', async () => {
  for (const result of [{ ...completed, status: 'failed' }, { ...completed, partial: true }, { ...completed, output: { receipt: 'invented' } }]) {
    const { client } = fixture((_route, options) => options.method === 'POST'
      ? Response.json({ run_id: 'run_research' }, { status: 202 }) : Response.json(result));
    await assert.rejects(client.run(input), error => ['HERMES_RESEARCH_FAILED', 'HERMES_RESEARCH_TRANSPORT'].includes(error.code));
    assert.deepEqual(client.active(), []);
  }
});

test('rejects unsafe origins and non-independent Hermes identities', () => {
  for (const url of ['http://localhost:8642', 'http://outside.test', 'http://127.0.0.1:8642/?key=secret', 'http://secret:token@127.0.0.1:8642']) {
    assert.throws(() => createHermesResearchClient({ endpoints: { ...endpoints, alice: { ...endpoints.alice, url } } }), { code: 'HERMES_CONFIGURATION' });
  }
  assert.throws(() => createHermesResearchClient({ endpoints: { ...endpoints, bob: { ...endpoints.bob, apiKey: endpoints.alice.apiKey } } }), { code: 'HERMES_CONFIGURATION' });
});
