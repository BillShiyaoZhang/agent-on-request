import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTimeline } from '../public/research-conversation.js';
import { ResearchEngine } from '../src/research-engine.mjs';

const task = overrides => ({ id: 'task-current', type: 'schedule', status: 'running',
  checkpoints: {}, result: null, ...overrides });
const event = (id, sequence, overrides = {}) => ({ id, sequence, taskId: 'task-current', role: 'Alice',
  kind: 'tool', direction: 'local', from: 'Alice', to: 'local-tools', name: 'knowledge_search',
  status: 'started', at: new Date(Date.UTC(2026, 10, 7, 10, 0, sequence)).toISOString(), ...overrides });
const timeline = (entries, overrides = {}) => conversationTimeline(entries,
  { role: 'Alice', task: task(), lang: 'en', ...overrides });
const steps = items => items.filter(item => item.kind === 'step');
const messages = items => items.filter(item => item.kind === 'message');
const entryIds = item => item.kind === 'step' ? item.entries.map(entry => entry.id) : [item.entry.id];
const publicCopy = items => items.map(item => `${item.title ?? ''}\n${item.summary ?? ''}`).join('\n');
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
async function engineFixture(t) {
  const engine = new ResearchEngine({ persist: false });
  await engine.init();
  t.after(() => engine.close());
  const created = await engine.create();
  return { engine, w: engine.get(created.workspaceId) };
}

test('real scheduling produces separate role-relative conversations with actual incoming and outgoing directions', async t => {
  const { engine, w } = await engineFixture(t);
  const state = await engine.start(w.id, { type: 'schedule', command: 'Schedule an academic discussion with Bob.' });
  const currentTask = state.tasks.at(-1);
  const source = structuredClone(state.activity);
  for (const role of ['Alice', 'Bob']) {
    const items = conversationTimeline(state.activity, { role, task: currentTask, lang: 'en' });
    const own = state.activity.filter(entry => entry.taskId === currentTask.id && entry.role === role);
    const expectedMessages = own.filter(entry => ['command', 'message', 'response', 'result', 'approval'].includes(entry.kind));
    assert.deepEqual(messages(items).map(item => item.entry.id), expectedMessages.map(entry => entry.id));
    for (const item of messages(items)) {
      assert.equal(item.direction, item.entry.direction, `${role}: ${item.entry.kind}/${item.entry.name}`);
      assert.equal(item.entry.role, role);
    }
    const positions = items.map(item => own.findIndex(entry => entry.id === entryIds(item)[0]));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])),
      'Cards keep the sequence of their first real event, even when a tool finishes after a message');
    assert.deepEqual(new Set(items.flatMap(entryIds)), new Set(own.map(entry => entry.id)));
    assert.equal(steps(items).reduce((count, step) => count + step.toolCallCount, 0), 2,
      'A standalone authorization check and a paired send are two calls, not three event rows');
    for (const step of steps(items)) assert.ok(step.entries.every(entry => entry.role === role));
  }
  const alice = messages(conversationTimeline(state.activity, { role: 'Alice', task: currentTask }));
  assert.equal(alice.find(item => item.entry.kind === 'command').direction, 'incoming');
  for (const delivery of state.messages) {
    for (const role of ['Alice', 'Bob']) {
      const item = messages(conversationTimeline(state.activity, { role, task: currentTask }))
        .find(item => item.entry.messageId === delivery.id);
      assert.equal(item.direction, role === delivery.from ? 'outgoing' : 'incoming');
    }
  }
  assert.deepEqual(state.activity, source, 'The presentation must not change engine records');
});

test('Alice and Bob each receive their own owner instruction and emit their own explanation', () => {
  for (const role of ['Alice', 'Bob']) {
    const entries = [
      event(`${role}-owner`, 1, { role, kind: 'command', name: 'owner_command', direction: 'incoming',
        from: `owner:${role}`, to: role, status: 'received', text: `Please continue, ${role}.` }),
      event(`${role}-answer`, 2, { role, kind: 'response', name: 'assistant_response', direction: 'outgoing',
        from: role, to: `owner:${role}`, status: 'explanatory', text: 'I saved the draft for your review.' }),
    ];
    const own = messages(timeline(entries, { role }));
    assert.deepEqual(own.map(item => item.direction), ['incoming', 'outgoing']);
    assert.deepEqual(own.map(item => item.entry.id), entries.map(entry => entry.id));
    assert.deepEqual(timeline(entries, { role: role === 'Alice' ? 'Bob' : 'Alice' }), []);
  }
});

test('contiguous run and knowledge tool events form one step with paired calls and observed elapsed time', () => {
  const entries = [
    event('run-start', 1, { kind: 'run', name: 'native_run' }),
    event('search-start', 2),
    event('search-done', 3, { status: 'completed', callId: 'search-start' }),
    event('ontology-start', 4, { name: 'ontology_describe' }),
    event('ontology-done', 5, { name: 'ontology_describe', status: 'completed', callId: 'ontology-start' }),
    event('run-done', 6, { kind: 'run', name: 'native_run', status: 'completed' }),
  ];
  const result = timeline(entries);
  assert.equal(result.length, 1);
  const [step] = steps(result);
  assert.ok(step.title.trim());
  assert.deepEqual(step.entries.map(entry => entry.id), entries.map(entry => entry.id));
  assert.equal(step.toolCallCount, 2);
  assert.equal(step.startedAt, entries[0].at);
  assert.equal(step.endedAt, entries.at(-1).at);
  assert.equal(step.durationMs, 5000);
  assert.equal(step.status, 'completed');
  assert.doesNotMatch(publicCopy(result), /task complete|booking confirmed|discussion ready/i,
    'An execution step finishing is not proof that the owner’s task succeeded');
});

test('a run moving from source review to draft preparation keeps the current phase active until its real end', () => {
  const entries = [
    event('run-start', 1, { kind: 'run', name: 'native_run' }),
    event('search-start', 2),
    event('search-done', 3, { status: 'completed', callId: 'search-start' }),
    event('draft-start', 4, { name: 'artifact_prepare' }),
    event('draft-done', 5, { name: 'artifact_prepare', status: 'completed', callId: 'draft-start' }),
  ];
  const active = steps(timeline(entries));
  assert.equal(active.length, 2, 'Research review and preparing a draft are distinct work steps');
  assert.equal(active[0].status, 'completed');
  assert.equal(active[1].status, 'running', 'Returning a draft tool result does not end the agent run');
  assert.equal(active[1].endedAt, null);
  const finished = steps(timeline([...entries,
    event('run-done', 6, { kind: 'run', name: 'native_run', status: 'completed' }),
  ]));
  assert.deepEqual(finished.map(step => step.id), active.map(step => step.id));
  assert.equal(finished[1].status, 'completed');
  assert.equal(finished.reduce((count, step) => count + step.toolCallCount, 0), 2);
});

test('polling updates a stable step while an asynchronous completion returns across an incoming message', () => {
  const started = event('search-start', 1);
  const incoming = event('peer-message', 2, { kind: 'message', name: 'peer_request', direction: 'incoming',
    from: 'Bob', to: 'Alice', status: 'received', details: { kind: 'availability' } });
  const done = event('search-done', 3, { status: 'completed', callId: started.id });
  const before = timeline([started]);
  const during = timeline([started, incoming]);
  const after = timeline([started, incoming, done]);
  const original = steps(before)[0];
  assert.equal(original.status, 'running');
  assert.equal(original.endedAt, null);
  assert.equal(original.durationMs, null);
  assert.equal(steps(during)[0].id, original.id);
  assert.equal(steps(during)[0].status, 'running', 'A message arriving does not finish an active call');
  assert.equal(steps(after).length, 1, 'The completion belongs to the original call, not a new step');
  const updated = steps(after)[0];
  assert.equal(updated.id, original.id, 'Polling must preserve expansion identity');
  assert.deepEqual(updated.entries.map(entry => entry.id), [started.id, done.id]);
  assert.equal(updated.toolCallCount, 1);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.durationMs, 2000);
  assert.deepEqual(after.map(item => item.kind), ['step', 'message']);
  assert.deepEqual(original.entries.map(entry => entry.id), [started.id], 'A later projection must not mutate an earlier poll');

  const next = event('new-search', 4);
  const withNewCall = timeline([started, incoming, done, next]);
  assert.equal(steps(withNewCall).length, 2, 'New work after the message starts a new visible step');
  assert.equal(steps(withNewCall)[0].id, original.id);
  assert.equal(steps(withNewCall)[1].toolCallCount, 1);
  assert.notEqual(steps(withNewCall)[1].id, original.id);
});

test('repeat delivery of a call completion does not inflate the number of actual calls', () => {
  const started = event('search-start', 1);
  const done = event('search-done', 2, { status: 'completed', callId: started.id });
  const replay = event('search-done-replayed', 3, { status: 'completed', callId: started.id });
  const [step] = steps(timeline([started, done, replay]));
  assert.equal(step.toolCallCount, 1);
  assert.equal(step.status, 'completed');
});

test('owner authorization requests and actual decisions remain visible boundaries between work steps', async t => {
  const { engine, w } = await engineFixture(t);
  const pendingState = await engine.start(w.id, { type: 'prepare_discussion', command: 'Prepare our discussion and ask before sharing.' });
  const currentTask = pendingState.tasks.at(-1);
  const request = engine.ledger(w, 'Alice').pendingRequests()[0];
  const pendingTimeline = conversationTimeline(pendingState.activity, { role: 'Alice', task: currentTask, lang: 'en' });
  const requestCard = messages(pendingTimeline).find(item => item.entry.requestId === request.id);
  assert.ok(requestCard);
  assert.equal(requestCard.direction, 'outgoing');
  assert.equal(requestCard.entry.status, 'pending');

  const state = await engine.decide(w.id, 'Alice', request.id, { decision: 'allow', fields: ['summary'],
    expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  const items = conversationTimeline(state.activity, { role: 'Alice', task: state.tasks.at(-1), lang: 'en' });
  const decisionCard = messages(items).find(item => item.entry.name === 'owner_decision' && item.entry.requestId === request.id);
  assert.ok(decisionCard);
  assert.equal(decisionCard.direction, 'incoming');
  assert.equal(decisionCard.entry.status, 'approved');
  assert.deepEqual(decisionCard.entry.details.approvedIntent.fields, ['summary']);
  assert.ok(items.findIndex(item => item.id === requestCard.id) < items.indexOf(decisionCard));
  assert.ok(steps(items).every(step => step.entries.every(entry => entry.kind !== 'approval')),
    'Authorization cannot disappear inside a collapsed execution step');
  for (const boundary of messages(items).filter(item => item.entry.kind === 'approval')) {
    for (const step of steps(items)) {
      const sequences = step.entries.filter(entry => !entry.callId).map(entry => entry.sequence);
      assert.ok(!sequences.some(sequence => sequence < boundary.entry.sequence)
        || !sequences.some(sequence => sequence > boundary.entry.sequence),
      'A new call after a human decision belongs to a later step');
    }
  }
});

test('a real saved checkpoint exposes its recorded summary only to the authorized owner', async t => {
  const { engine, w } = await engineFixture(t);
  await engine.start(w.id, { type: 'prepare_discussion' });
  const currentTask = w.tasks.at(-1);
  const summary = 'Reviewed the source evidence and saved a draft for owner review. checkpoint-c285';
  await engine.tool(w.id, currentTask.id, 'Alice', 'task_checkpoint', { status: 'needs_owner', summary });
  const aliceState = engine.view(w, 'Alice');
  const bobState = engine.view(w, 'Bob');
  const own = conversationTimeline(aliceState.activity, { role: 'Alice', task: aliceState.tasks.at(-1), lang: 'en' });
  assert.ok(steps(own).some(step => step.summary?.includes(summary)), 'Recorded progress is useful visible context');
  const redacted = bobState.activity.find(entry => entry.role === 'Alice' && entry.kind === 'checkpoint' && entry.name === 'task_checkpoint');
  assert.equal(redacted.redacted, true);
  const peer = conversationTimeline(bobState.activity, { role: 'Alice', task: bobState.tasks.at(-1), lang: 'en' });
  assert.ok(!JSON.stringify(peer).includes(summary), 'The counterpart timeline cannot reconstruct the private note');
  assert.doesNotMatch(publicCopy(peer), /(?:agent|Alice)(?:’s|'s)? (?:private )?(?:thinking|thoughts|reasoning)/i);
});

test('hidden thought fields and redacted text cannot become a public step summary', () => {
  const secret = 'PRIVATE-THOUGHT-91bf';
  const returnedSummary = 'A normal evidence summary returned by the tool. result-summary-a5f0';
  const entries = [
    event('run', 1, { kind: 'run', name: 'native_run', details: { reasoning_content: secret, thinking: secret, summary: secret } }),
    event('search', 2, { details: { arguments: { query: 'evidence' }, reasoning_content: secret } }),
    event('thought', 3, { kind: 'thinking', text: secret }),
    event('reasoning', 4, { kind: 'reasoning', text: secret, details: { summary: secret } }),
    event('done', 5, { status: 'completed', callId: 'search', details: { result: { reasoning_content: secret, summary: returnedSummary } } }),
    event('redacted-checkpoint', 6, { kind: 'checkpoint', name: 'task_checkpoint', status: 'waiting_peer',
      redacted: true, text: secret, details: { summary: secret, reasoning_content: secret } }),
  ];
  const result = timeline(entries);
  assert.ok(steps(result).length);
  assert.ok(!publicCopy(result).includes(secret));
  assert.ok(!publicCopy(result).includes(returnedSummary), 'An arbitrary tool summary is not a saved progress checkpoint');
  assert.doesNotMatch(publicCopy(result), /(?:private )?(?:thinking|thoughts|reasoning) (?:summary|revealed|available)/i);
  assert.doesNotMatch(JSON.stringify(result), /"(?:reasoning_content|thinking)"/,
    'Explicit private fields are excluded from expandable execution details as well');
  const inspectedResult = steps(result).flatMap(step => step.entries).find(entry => entry.id === 'done');
  assert.equal(inspectedResult.details.result.summary, returnedSummary, 'Ordinary business evidence remains inspectable');
  for (const redacted of steps(result).flatMap(step => step.entries).filter(entry => entry.redacted)) {
    assert.equal(redacted.text, undefined);
    assert.equal(redacted.details, undefined);
  }
});

test('selected-task projections are deterministic, sorted, scoped and leave frozen engine input intact', () => {
  const entries = deepFreeze([
    event('own-done', 3, { status: 'completed', callId: 'own-start' }),
    event('other-task', 1, { taskId: 'task-old', kind: 'checkpoint', text: 'OLD-TASK-SECRET' }),
    event('bob-private', 2, { role: 'Bob', kind: 'checkpoint', text: 'BOB-PRIVATE-SECRET' }),
    event('own-start', 1),
  ]);
  const original = structuredClone(entries);
  const first = timeline(entries);
  const second = timeline(entries);
  assert.deepEqual(second, first, 'Unchanged polls keep all group IDs, content and duration stable');
  assert.deepEqual(entries, original);
  assert.deepEqual(first.flatMap(entryIds), ['own-start', 'own-done']);
  assert.ok(!JSON.stringify(first).includes('OLD-TASK-SECRET'));
  assert.ok(!JSON.stringify(first).includes('BOB-PRIVATE-SECRET'));
});

test('failed, active and checkpoint waiting steps preserve their observed state without fake completion', () => {
  const scenarios = [
    { name: 'active call', entries: [event('start', 1)], status: 'running' },
    { name: 'failed call', entries: [event('start', 1), event('failure', 2, { status: 'failed', callId: 'start',
      details: { code: 'EVIDENCE_UNAVAILABLE', message: 'Source is unavailable.' } })], status: 'failed' },
    { name: 'run failed while its tool was active', entries: [
      event('run', 1, { kind: 'run', name: 'native_run' }), event('start', 2),
      event('run-failure', 3, { kind: 'run', name: 'native_run', status: 'failed' }),
    ], status: 'failed' },
    { name: 'waiting peer', entries: [event('checkpoint', 1, { kind: 'checkpoint', name: 'task_checkpoint', status: 'waiting_peer' })], status: 'waiting_peer' },
    { name: 'owner decision', entries: [event('checkpoint', 1, { kind: 'checkpoint', name: 'task_checkpoint', status: 'needs_owner' })], status: 'needs_owner' },
    { name: 'paused run', entries: [event('run', 1, { kind: 'run', name: 'native_run', status: 'paused' })], status: 'paused' },
  ];
  for (const scenario of scenarios) {
    const result = timeline(scenario.entries);
    assert.equal(steps(result).at(-1)?.status, scenario.status, scenario.name);
    assert.doesNotMatch(publicCopy(result), /task complete|booking confirmed|discussion ready/i, scenario.name);
  }
});
