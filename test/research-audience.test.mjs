import test from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity, describeAgentState, workspaceInventory } from '../public/research-conversation.js';
import { researchConference, researchProfile, researchWorkspaceManifest } from '../src/research-profiles.mjs';
import { ResearchEngine } from '../src/research-engine.mjs';

const currentTask = overrides => ({ id: 'task-current', type: 'prepare_discussion', status: 'running',
  checkpoints: {}, result: null, ...overrides });
const event = overrides => ({ id: 'event-current', taskId: 'task-current', role: 'Alice', kind: 'message',
  direction: 'outgoing', from: 'Alice', to: 'Bob', name: 'peer_send', status: 'received', sequence: 1,
  at: '2026-11-05T10:00:00.000Z', ...overrides });
const copy = result => `${result.title}\n${result.body}`;
const request = overrides => ({ id: 'request-current', status: 'pending', intent: {
  taskId: 'task-current', action: 'peer.send', recipient: 'Bob', resourceId: 'alice:research-brief',
  fields: ['summary'], ...overrides }, revision: 1 });
const pendingEvent = event({ kind: 'approval', name: 'authorization_request', direction: 'outgoing',
  from: 'Alice', to: 'owner:Alice', status: 'pending', requestId: 'request-current', details: request() });

test('ontology and capability exchanges summarize only actual received definitions and skills', () => {
  const ontology = { owner: 'Alice', version: '2.0.0', modules: [{ name: '研究问题', concepts: [] }, { name: '语义模型', concepts: [] }] };
  const sent = event({ details: { resourceId: 'working-ontology', payload: { ontology }, receipt: { status: 'received' } } });
  const described = copy(describeActivity(sent));
  assert.match(described, /2/);
  assert.match(described, /2\.0\.0/);
  assert.match(described, /研究问题/);
  assert.match(described, /语义模型/);
  assert.doesNotMatch(described, /"modules"|"concepts"|已(?:完成|接受)对齐|建立共同本体/);
  const capabilities = event({ details: { resourceId: 'capabilities', payload: { skills: [{ id: 'alice:review', label: '语义审阅' }] }, receipt: { status: 'received' } } });
  const summary = copy(describeActivity(capabilities));
  assert.match(summary, /1/);
  assert.match(summary, /语义审阅/);
  assert.doesNotMatch(summary, /用户研究整理|"skills"|"id"/);
  const hidden = copy(describeActivity({ ...sent, redacted: true }));
  assert.doesNotMatch(hidden, /研究问题|语义模型|2\.0\.0/);
});

test('actual peer rejection does not invent a semantic failure or an oracle validity result', () => {
  const rejected = event({ name: 'alignment_accept', details: { status: 'rejected', reviewedBy: 'Bob', mappings: [{ source: 'alice:A', target: 'bob:B', relation: 'close' }] } });
  const summary = copy(describeActivity(rejected));
  assert.match(summary, /拒绝|未被接受/);
  assert.doesNotMatch(summary, /定义不一致|不满足当前定义|未通过.*检查|词面相似/);
  const proposed = copy(describeActivity({ ...rejected, name: 'alignment_propose', details: { mappings: [{ source: 'alice:A', target: 'bob:B', relation: 'exact', valid: false }] } }));
  assert.match(proposed, /仍需.*审阅/);
  assert.doesNotMatch(proposed, /未通过|无效|不能接受/);
});

test('workspace inventory presents only the authenticated owner’s immutable seed and runtime records', () => {
  const profile = researchProfile('Alice'), manifest = researchWorkspaceManifest('Alice');
  const state = { owner: 'Alice', workspaceId: 'experience-one', profile,
    workspace: { role: 'Alice', seed: profile.seed, manifest, seedPath: 'workspaces/alice', runtimePath: 'runs/experience-one/alice', nativeNamespace: 'urn:test:alice:experience-one:' },
    messages: [{ from: 'Alice', to: 'Bob' }, { from: 'Bob', to: 'Alice' }], artifacts: [{ owner: 'Alice' }, { owner: 'Bob' }] };
  const inventory = workspaceInventory(state);
  assert.equal(inventory.role, 'Alice');
  assert.equal(inventory.seedHash, profile.seed.hash);
  assert.equal(inventory.seedVersion, manifest.version);
  assert.equal(inventory.inboxCount, 1);
  assert.equal(inventory.outboxCount, 1);
  assert.equal(inventory.artifactCount, 1);
  assert.ok(inventory.files.some(file => file.path === 'ontology.json'));
  assert.ok(inventory.files.some(file => file.path.startsWith('skills/')));
  assert.equal(workspaceInventory({ ...state, workspace: { ...state.workspace, role: 'Bob' } }), null);
  assert.equal(workspaceInventory({ ...state, workspace: { ...state.workspace, manifest: researchWorkspaceManifest('Bob') } }), null);
  assert.equal(workspaceInventory({ ...state, workspace: { ...state.workspace, seedPath: 'workspaces/bob' } }), null);
  const injected = { ...state, workspace: { ...state.workspace, manifest: { ...manifest, files: { ...manifest.files, '../bob/private.json': { sha256: 'forged' } } } } };
  assert.ok(!workspaceInventory(injected).files.some(file => file.path.includes('bob')));
});

test('audience availability messages state actual time choices without a JSON payload', () => {
  const received = event({ role: 'Bob', direction: 'incoming', details: {
    resourceId: 'availability', fields: ['slots'], payload: { slots: [
      { day: 'Thu', time: '15:00–16:00', status: 'Free' },
      { day: 'Fri', time: '09:00–09:30', status: 'Free' },
    ] }, receipt: { status: 'received', operationId: 'op:availability' },
  } });
  const zh = copy(describeActivity(received, { lang: 'zh' }));
  assert.match(zh, /周四|星期四/);
  assert.match(zh, /周五|星期五/);
  assert.match(zh, /15:00[–—-]16:00/);
  assert.match(zh, /09:00[–—-]09:30/);
  assert.doesNotMatch(zh, /"slots"|"status"|\{"|\[\{/);
  assert.doesNotMatch(zh, /10:30|17:00/);
  const en = copy(describeActivity(received, { lang: 'en' }));
  assert.match(en, /Thu(?:rsday)?/i);
  assert.match(en, /15:00[–—-]16:00/);
});

test('presentation summaries resolve only the exchanged report IDs against the conference', () => {
  const conference = researchConference();
  const selected = event({ details: { resourceId: 'report-interests', payload: { reportIds: ['R1', 'R3'] },
    receipt: { status: 'received' } } });
  const text = copy(describeActivity(selected, { lang: 'zh', conference }));
  assert.ok(text.includes(conference.reports.find(report => report.id === 'R1').title));
  assert.ok(text.includes(conference.reports.find(report => report.id === 'R3').title));
  assert.ok(!text.includes(conference.reports.find(report => report.id === 'R2').title));
  assert.doesNotMatch(text, /"reportIds"|"payload"/);
  assert.doesNotMatch(text, /已共同(?:选定|选择)|双方已选/);
});

test('material summaries contain only delivered fields and never reconstruct redacted content', () => {
  const summary = '我们希望用户在接受语义映射前检查定义和证据。';
  const delivered = event({ details: { resourceId: 'alice:research-brief', fields: ['summary'],
    payload: { summary }, receipt: { status: 'received' } } });
  const visible = copy(describeActivity(delivered, { lang: 'zh' }));
  assert.ok(visible.includes(summary));
  assert.doesNotMatch(visible, /0\.82|未公开实验结果|method|results|Private draft/);
  const redacted = event({ kind: 'response', name: 'assistant_response', redacted: true,
    direction: 'outgoing', to: 'owner:Alice' });
  const concealed = copy(describeActivity(redacted, { lang: 'zh' }));
  assert.ok(concealed.trim());
  assert.ok(!concealed.includes(summary));
  assert.doesNotMatch(concealed, /0\.82|已发送摘要|已经分享/);
});

test('owner permission summaries distinguish approval or refusal from a completed delivery', () => {
  const approved = event({ kind: 'approval', name: 'owner_decision', direction: 'incoming',
    from: 'owner:Alice', to: 'Alice', status: 'approved', details: {
      requestId: 'request-current', decision: 'allow', approvedIntent: {
        action: 'peer.send', recipient: 'Bob', fields: ['summary'],
      },
    } });
  const allowed = copy(describeActivity(approved, { lang: 'zh' }));
  assert.match(allowed, /批准|允许|许可/);
  assert.doesNotMatch(allowed, /(?:已经|已)(?:发送|交付|分享)|(?:预约|预订)已成功|场地已确认/);
  const denied = copy(describeActivity({ ...approved, status: 'denied', details: {
    requestId: 'request-current', decision: 'deny', approvedIntent: null,
  } }, { lang: 'zh' }));
  assert.match(denied, /拒绝|不允许|未获/);
  assert.doesNotMatch(denied, /(?:已经|已)(?:发送|交付|分享)|(?:预约|预订)已成功|场地已确认/);
});

test('one owner approval highlights that agent while its peer waits for the right person', () => {
  const task = currentTask({ status: 'needs_owner', checkpoints: { Alice: { status: 'needs_owner' }, Bob: { status: 'waiting_peer' } } });
  const alice = describeAgentState({ role: 'Alice', owner: 'Alice', task, entries: [pendingEvent], requests: [request()] });
  assert.equal(alice.needsOwner, true);
  assert.equal(alice.tone, 'approval');
  assert.ok(alice.requestIds.includes('request-current'));
  const bob = describeAgentState({ role: 'Bob', owner: 'Alice', task, entries: [pendingEvent], requests: [request()] });
  assert.equal(bob.needsOwner, false);
  assert.equal(bob.tone, 'waiting');
  assert.deepEqual(bob.requestIds, []);
  assert.match(`${bob.label}\n${bob.body}`, /Alice|对方|合作方/);
  const observer = describeAgentState({ role: 'Alice', owner: 'Bob', task,
    entries: [{ ...pendingEvent, redacted: true, details: undefined }], requests: [] });
  assert.equal(observer.needsOwner, false, 'Another owner cannot approve Alice’s operation');
  assert.match(`${observer.label}\n${observer.body}`, /Alice/);
});

test('stale requests and checkpoints do not override later actual work in the selected task', () => {
  const task = currentTask({ checkpoints: { Alice: { status: 'needs_owner', at: '2026-11-05T09:59:00.000Z' } } });
  const oldRequest = request({ taskId: 'task-previous' });
  const approved = event({ id: 'decision', sequence: 2, kind: 'approval', name: 'owner_decision',
    direction: 'incoming', from: 'owner:Alice', to: 'Alice', status: 'approved',
    requestId: 'request-current',
    details: { requestId: 'request-current', decision: 'allow', approvedIntent: { action: 'peer.send', fields: ['summary'] } } });
  const working = event({ id: 'next-work', sequence: 3, kind: 'tool', name: 'artifact_prepare', direction: 'local',
    status: 'started', from: 'Alice', to: 'local-tools', at: '2026-11-05T10:01:00.000Z' });
  const state = describeAgentState({ role: 'Alice', owner: 'Alice', task, requests: [oldRequest],
    entries: [pendingEvent, approved, working] });
  assert.equal(state.needsOwner, false);
  assert.equal(state.tone, 'working');
  assert.deepEqual(state.requestIds, []);
});

test('tool or run completion cannot claim business success without a verified task result', () => {
  const task = currentTask();
  const completedTool = event({ kind: 'tool', name: 'peer_send', status: 'completed', direction: 'local' });
  const completedRun = event({ id: 'run-done', kind: 'run', name: 'native_run', status: 'completed', sequence: 2 });
  const running = describeAgentState({ role: 'Alice', owner: 'Alice', task, entries: [completedTool, completedRun] });
  assert.notEqual(running.tone, 'done');
  assert.equal(running.needsOwner, false);
  const verifiedTask = currentTask({ status: 'completed', result: { outcome: 'discussion_prepared',
    reservation: { status: 'confirmed', reservationId: 'CONF-TEST' }, receipts: ['op:received'] } });
  const done = describeAgentState({ role: 'Alice', owner: 'Alice', task: verifiedTask,
    entries: [pendingEvent, completedTool, completedRun], requests: [request()] });
  assert.equal(done.tone, 'done');
  assert.equal(done.needsOwner, false);
  assert.deepEqual(done.requestIds, []);
  const paused = describeAgentState({ role: 'Alice', owner: 'Alice',
    task: currentTask({ status: 'paused', error: 'Native connection unavailable.' }), entries: [completedRun] });
  assert.equal(paused.tone, 'error');
});

test('policy confirmation requests are scoped to their owner and current task', () => {
  const candidate = { id: 'candidate-current', taskId: 'task-current', status: 'pending',
    policy: { effect: 'allow', actions: ['peer.send'], fields: ['summary'] } };
  const own = describeAgentState({ role: 'Alice', owner: 'Alice', task: currentTask({ status: 'needs_owner' }),
    entries: [], policyCandidates: [candidate, { ...candidate, id: 'candidate-old', taskId: 'task-old' }] });
  assert.equal(own.needsOwner, true);
  assert.ok(own.requestIds.includes('candidate-current'));
  assert.ok(!own.requestIds.includes('candidate-old'));
  const peer = describeAgentState({ role: 'Bob', owner: 'Alice', task: currentTask({ status: 'needs_owner' }),
    entries: [], policyCandidates: [candidate] });
  assert.equal(peer.needsOwner, false);
});

test('audience summaries consume real engine message and approval records without changing their facts', async t => {
  const engine = new ResearchEngine({ persist: false });
  await engine.init();
  t.after(() => engine.close());
  const created = await engine.create();
  const schedule = await engine.start(created.workspaceId, { type: 'schedule' });
  const message = schedule.activity.find(entry => entry.kind === 'message' && entry.name === 'peer_send');
  const actual = copy(describeActivity(message, { lang: 'zh', task: schedule.tasks.at(-1), conference: schedule.conference }));
  for (const slot of message.details.payload.slots) assert.ok(actual.includes(slot.time));
  assert.doesNotMatch(actual, /"slots"|"status"/);
  const preparation = await engine.start(created.workspaceId, { type: 'prepare_discussion' });
  const task = preparation.tasks.at(-1);
  const state = describeAgentState({ role: 'Alice', owner: 'Alice', task, entries: preparation.activity,
    requests: preparation.authorizations.requests, policyCandidates: preparation.policyCandidates });
  assert.equal(state.needsOwner, true);
  assert.equal(state.requestIds.length, 1);
  const peer = describeAgentState({ role: 'Bob', owner: 'Alice', task, entries: preparation.activity,
    requests: preparation.authorizations.requests, policyCandidates: preparation.policyCandidates });
  assert.equal(peer.needsOwner, false);
  assert.equal(peer.tone, 'waiting');
});
