import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResearchEngine } from '../src/research-engine.mjs';
import { createDemoServer } from '../src/server.mjs';
import { resolveResearchCommand } from '../src/research-commands.mjs';

async function engineFixture(t, options = {}) {
  const engine = new ResearchEngine({ persist: false, ...options });
  await engine.init();
  t.after(() => engine.close());
  const created = await engine.create();
  return { engine, created, w: engine.get(created.workspaceId) };
}

async function httpFixture(t, options = {}) {
  const app = await createDemoServer({ host: '127.0.0.1', port: 0, persist: false,
    minimaxApiKey: '', adminPin: 'research-conversation-test-pin', ...options });
  await app.listen();
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, token, data, extraHeaders = {}) {
    const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  }
  async function create() {
    const created = (await call('/api/research/workspaces', null, {})).data;
    return { ...created, root: `/api/research/workspaces/${created.workspaceId}` };
  }
  return { app, call, create };
}

const decision = (request, fields) => ({ decision: 'allow', expectedRevision: request.revision,
  expectedPayloadHash: request.payloadHash, ...(fields ? { fields } : {}) });

test('manual and preset commands resolve the same three workflows while preserving actual owner text', () => {
  const cases = [
    ['  请和 Bob 约一次 30 分钟的学术讨论。  ', 'schedule'],
    ['Please schedule an academic discussion with Bob.', 'schedule'],
    ['请和 Bob 选择一场共同参加的报告。', 'select_presentation'],
    ['Choose a presentation to attend together with Bob.', 'select_presentation'],
    ['请和 Bob 筹备学术讨论，准备议程、分享获准资料并预约场地。', 'prepare_discussion'],
    ['Prepare our discussion agenda and book a venue.', 'prepare_discussion'],
  ];
  for (const [text, type] of cases) {
    const result = resolveResearchCommand({ text, mode: 'controlled' }, { nativeAvailable: true });
    assert.equal(result.type, type, text);
    assert.equal(result.command, text.trim());
    assert.equal(result.mode, 'controlled');
  }
  const explicit = resolveResearchCommand({ text: '按照今天讨论的方案继续', type: 'schedule', mode: 'controlled' }, { nativeAvailable: false });
  assert.equal(explicit.type, 'schedule');
  assert.equal(explicit.command, '按照今天讨论的方案继续');
  assert.throws(() => resolveResearchCommand({ text: '帮我整理实验依据', mode: 'controlled' }, { nativeAvailable: true }),
    { code: 'RESEARCH_COMMAND_INTENT', status: 422 });
  const privateWork = resolveResearchCommand({ text: '帮我整理实验依据', mode: 'native' }, { nativeAvailable: true });
  assert.equal(privateWork.type, 'research_work');
  assert.equal(privateWork.goal, '帮我整理实验依据');
  assert.throws(() => resolveResearchCommand({ text: '约一次讨论', mode: 'native' }, { nativeAvailable: false }), { status: 409 });
  assert.throws(() => resolveResearchCommand({ text: '整理资料', type: 'research_work', mode: 'controlled' }, { nativeAvailable: true }), { status: 409 });
  for (const input of [{ text: '' }, { text: '   ' }, { text: 123 }, { text: 'x'.repeat(4001) },
    { text: '约讨论', type: 'arbitrary_tool' }, { text: '约讨论', mode: 'unsafe' }]) {
    assert.throws(() => resolveResearchCommand(input, { nativeAvailable: true }), { status: 400 });
  }
});

test('two agent dialogues record actual commands, tools, paired deliveries and verified results in order', async t => {
  const { engine, created, w } = await engineFixture(t);
  const command = '请和 Bob 约一次 30 分钟的学术讨论。';
  const state = await engine.start(w.id, { type: 'schedule', command });
  const task = state.tasks.at(-1);
  const activity = state.activity.filter(event => event.taskId === task.id);
  const ownerCommand = activity.find(event => event.kind === 'command');
  assert.equal(ownerCommand.role, 'Alice');
  assert.equal(ownerCommand.direction, 'incoming');
  assert.equal(ownerCommand.from, 'owner:Alice');
  assert.equal(ownerCommand.to, 'Alice');
  assert.equal(ownerCommand.text, command);
  assert.equal(activity[0].id, ownerCommand.id);
  assert.deepEqual(new Set(activity.filter(event => event.kind === 'tool').map(event => event.role)), new Set(['Alice', 'Bob']));
  for (const message of w.messages) {
    const delivered = activity.filter(event => event.kind === 'message' && event.name === 'peer_send' && event.messageId === message.id);
    assert.equal(delivered.length, 2);
    const sent = delivered.find(event => event.direction === 'outgoing');
    const received = delivered.find(event => event.direction === 'incoming');
    assert.equal(sent.role, message.from);
    assert.equal(received.role, message.to);
    for (const event of delivered) {
      assert.equal(event.from, message.from);
      assert.equal(event.to, message.to);
      assert.deepEqual(event.details.payload, message.payload);
      assert.deepEqual(event.details.receipt, message.receipt);
      assert.equal(event.details.receipt.status, 'received');
    }
  }
  const results = activity.filter(event => event.kind === 'result');
  assert.ok(results.length > 0);
  assert.ok(results.every(event => event.details.outcome === task.result.outcome || event.details.result?.outcome === task.result.outcome));
  assert.equal(new Set(activity.map(event => event.id)).size, activity.length);
  assert.ok(activity.every((event, index) => index === 0 || event.sequence > activity[index - 1].sequence));
  assert.deepEqual(engine.view(w, 'Alice').activity, state.activity, 'Reading the view must not manufacture more conversation');
  assert.equal(engine.authorize(w.id, created.token).role, 'Alice');
});

test('shared observation reveals actual approved deliveries while owner-only instructions and decisions stay scoped', async t => {
  const { engine, w } = await engineFixture(t);
  const command = '请筹备讨论。仅供 Alice 主人阅读的补充说明-7c93';
  await engine.start(w.id, { type: 'prepare_discussion', command });
  const task = w.tasks.at(-1);
  await engine.tool(w.id, task.id, 'Alice', 'knowledge_search', { ids: ['alice:claim'], hops: 0 });
  await engine.tool(w.id, task.id, 'Alice', 'task_checkpoint', { status: 'needs_owner', summary: '只有 Alice 可见的工作笔记-a913' });
  const before = engine.view(w, 'Bob');
  assert.ok(before.activity.some(event => event.role === 'Alice' && event.kind === 'tool'));
  assert.ok(!JSON.stringify(before.activity).includes('仅供 Alice 主人阅读的补充说明-7c93'));
  assert.ok(!JSON.stringify(before.activity).includes('只有 Alice 可见的工作笔记-a913'));
  assert.ok(!JSON.stringify(before).includes('0.82'));
  assert.ok(!before.activity.some(event => event.name === 'peer_send' && event.details?.resourceId === 'alice:research-brief'));
  const request = engine.ledger(w, 'Alice').pendingRequests()[0];
  const after = await engine.decide(w.id, 'Alice', request.id, decision(request, ['summary']));
  assert.ok(after.activity.some(event => event.kind === 'approval' && event.name === 'owner_decision' && event.from === 'owner:Alice'));
  const bob = engine.view(w, 'Bob');
  const reception = bob.activity.find(event => event.role === 'Bob' && event.kind === 'message'
    && event.name === 'peer_send' && event.direction === 'incoming' && event.details?.resourceId === 'alice:research-brief');
  assert.ok(reception);
  assert.deepEqual(Object.keys(reception.details.payload), ['summary']);
  assert.ok(!JSON.stringify(bob).includes('0.82'));
  assert.ok(!JSON.stringify(bob.activity).includes('仅供 Alice 主人阅读的补充说明-7c93'));
  assert.ok(!bob.activity.some(event => event.role === 'Alice' && event.kind === 'approval' && event.details));
});

test('conversation survives service restart without repeating deliveries or result messages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aor-conversation-'));
  let engine = new ResearchEngine({ directory });
  t.after(async () => {
    await engine.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('aor-conversation-'));
    await rm(directory, { recursive: true, force: true });
  });
  await engine.init();
  const created = await engine.create();
  const before = await engine.start(created.workspaceId, { type: 'schedule', command: '请和 Bob 约一次讨论。' });
  await engine.close();
  engine = new ResearchEngine({ directory });
  await engine.init();
  const restored = engine.view(engine.get(created.workspaceId), 'Alice');
  assert.deepEqual(restored.activity, before.activity);
  assert.deepEqual(restored.messages, before.messages);
  assert.deepEqual(restored.tasks.at(-1).result, before.tasks.at(-1).result);
  assert.equal(engine.authorize(created.workspaceId, created.token).role, 'Alice');
});

test('command HTTP endpoint starts the chosen task through Alice and rejects invalid or foreign commands', async t => {
  const { app, call, create } = await httpFixture(t);
  const created = await create();
  const text = '  请和 Bob 约一次 30 分钟的学术讨论。  ';
  const started = await call(`${created.root}/commands`, created.token, { text, mode: 'controlled' });
  assert.equal(started.status, 201);
  assert.equal(started.data.tasks.at(-1).type, 'schedule');
  assert.equal(started.data.tasks.at(-1).status, 'completed');
  assert.equal(started.data.activity.find(event => event.kind === 'command').text, text.trim());
  const explicit = await call(`${created.root}/commands`, created.token, { text: '请继续下一步', type: 'select_presentation', mode: 'controlled' });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.data.tasks.at(-1).result.report.id, 'R3');
  const count = app.collaboration.get(created.workspaceId).tasks.length;
  for (const input of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 42 }, { text: '约讨论', type: 'unknown' }, { text: '约讨论', mode: 'unsafe' }]) {
    assert.equal((await call(`${created.root}/commands`, created.token, input)).status, 400);
  }
  assert.equal((await call(`${created.root}/commands`, created.token, { text: '帮我写个随意的句子', mode: 'controlled' })).status, 422);
  assert.equal((await call(`${created.root}/commands`, created.token, { text: '约讨论', mode: 'controlled' }, { Origin: 'https://outside.invalid' })).status, 403);
  assert.equal(app.collaboration.get(created.workspaceId).tasks.length, count);
  const admin = (await call('/api/admin/login', null, { pin: 'research-conversation-test-pin' })).data.token;
  const bob = (await call(`/api/admin/research/workspaces/${created.workspaceId}/claim/Bob`, admin, {})).data.token;
  assert.equal((await call(`${created.root}/commands`, bob, { text: '请约一次讨论', mode: 'controlled' })).status, 403);
  assert.equal((await call(`${created.root}/commands`, admin, { text: '请约一次讨论', mode: 'controlled' })).status, 401);
});

test('an unrecognized native command becomes private research work with no peer dialogue exposure', async t => {
  const { app, call, create } = await httpFixture(t, { researchNative: { run: async () => ({ status: 'completed' }) } });
  const created = await create();
  const goal = '追踪我的实验依据，只写给我。private-goal-d402';
  const response = await call(`${created.root}/commands`, created.token, { text: goal, mode: 'native' });
  assert.equal(response.status, 201);
  const task = response.data.tasks.at(-1);
  assert.equal(task.type, 'research_work');
  assert.equal(task.ownerGoal, goal);
  assert.ok(response.data.activity.some(event => event.kind === 'command' && event.text === goal));
  await Promise.allSettled([...app.collaboration.running]);
  const bob = app.collaboration.view(app.collaboration.get(created.workspaceId), 'Bob');
  assert.ok(!bob.tasks.some(item => item.id === task.id));
  assert.ok(!bob.activity.some(event => event.taskId === task.id));
  assert.ok(!JSON.stringify(bob).includes('private-goal-d402'));
});
