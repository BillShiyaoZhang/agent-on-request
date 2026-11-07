import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEngine } from '../src/research-engine.mjs';
import { researchProfile } from '../src/research-profiles.mjs';

const agentTokens = { Alice: 'native-alice-service-token-1234567890', Bob: 'native-bob-service-token-1234567890' };
async function drained(engine) {
  const deadline = Date.now() + 4000;
  while (engine.running.size) {
    assert(Date.now() < deadline, 'Native test runs must settle');
    await Promise.allSettled([...engine.running]);
    await new Promise(resolve => setImmediate(resolve));
  }
}
async function harness(t, execute) {
  let engine;
  const calls = [];
  const nativeClient = {
    async check() { return { ready: true }; },
    async reconcile() { return { settled: true }; },
    async run(context) {
      const assignment = engine.agentContext(agentTokens[context.role]);
      const call = async (name, args = {}) => {
        calls.push({ role: context.role, assignmentId: assignment.assignmentId, name, args });
        return engine.agentTool(agentTokens[context.role], { assignmentId: assignment.assignmentId, name, arguments: args });
      };
      await execute({ ...context, assignment, call, engine });
      return { runId: `run_${assignment.assignmentId}`, status: 'completed', output: 'Any success claimed here must be verified from service records.' };
    },
  };
  engine = new ResearchEngine({ directory: '', persist: false, nativeClient, agentTokens });
  await engine.init(); t.after(() => engine.close());
  const created = await engine.create();
  return { engine, created, calls };
}

test('both native roles invoke scoped tools and scheduling completes from their actual received availability', async t => {
  const assignments = [];
  const { engine, created, calls } = await harness(t, async ({ role, assignment, call, engine }) => {
    assignments.push(assignment);
    await assert.rejects(engine.agentTool(agentTokens[role], { assignmentId: `${assignment.assignmentId}-stale`, name: 'task_status', arguments: {} }),
      { code: 'RESEARCH_STALE_RUN' });
    await call('task_status');
    await call('ontology_describe');
    await call('knowledge_search', { type: 'ResearchQuestion' });
    const authorization = await call('authorization_check', { action: 'peer.send', resourceId: 'availability' });
    assert.equal(authorization.status, 'allowed');
    await call('peer_send', { resourceId: 'availability' });
  });
  await engine.start(created.workspaceId, { type: 'schedule', mode: 'native' });
  await drained(engine);
  const workspace = engine.get(created.workspaceId); const task = workspace.tasks[0];
  assert.equal(task.status, 'completed');
  assert.equal(task.result.outcome, 'common_time_found');
  assert.deepEqual(new Set(calls.map(call => call.role)), new Set(['Alice', 'Bob']));
  assert.equal(workspace.messages.filter(message => message.taskId === task.id).length, 2);
  assert.equal(task.result.receipts.length, 2);
  assert(task.result.receipts.every(id => workspace.messages.some(message => message.id === id && message.receipt.status === 'received')));
  for (const assignment of assignments) {
    await assert.rejects(engine.agentTool(agentTokens[assignment.role], { assignmentId: assignment.assignmentId, name: 'task_status' }),
      { code: 'RESEARCH_ASSIGNMENT' });
  }
});

test('an invented final model explanation cannot create a receipt or task outcome', async t => {
  const { engine, created } = await harness(t, async ({ call }) => {
    await call('task_status');
    // Model emits no send or reservation tool call, even though its final text may claim success.
  });
  await engine.start(created.workspaceId, { type: 'schedule', mode: 'native' });
  await drained(engine);
  const workspace = engine.get(created.workspaceId);
  assert.equal(workspace.tasks[0].result, null);
  assert.notEqual(workspace.tasks[0].status, 'completed');
  assert.equal(workspace.messages.length, 0);
  assert.equal(workspace.reservations.length, 0);
});

test('native peers reject same-word alignment and accept task-scoped relations before selecting a report', async t => {
  let proposalReady;
  const aliceProposed = new Promise(resolve => { proposalReady = resolve; });
  let definitionsReady;
  const definitionsExchanged = new Promise(resolve => { definitionsReady = resolve; });
  const definitionsSent = new Set();
  const { engine, created, calls } = await harness(t, async ({ role, call }) => {
    let status = await call('task_status');
    if (status.task.status === 'completed') return;
    assert.equal(status.mappingCandidates, undefined);
    if (!definitionsSent.has(role)) {
      await call('peer_send', { resourceId: 'working-ontology' });
      definitionsSent.add(role);
      if (definitionsSent.size === 2) definitionsReady();
    }
    await definitionsExchanged;
    if (role === 'Bob') await aliceProposed;
    status = await call('task_status');
    if (status.task.status === 'completed') return;
    if (role === 'Alice') {
      const peerProposal = status.task.proposals.find(proposal => proposal.from === 'Bob' && proposal.status === 'proposed');
      if (peerProposal) { await call('alignment_accept', { proposalId: peerProposal.id, decision: 'accept', reason: 'The actual received definitions support only the specified presentation and related-evidence conditions.' }); return; }
      if (status.task.proposals.some(proposal => proposal.from === 'Alice')) return;
      await call('alignment_propose', { mappings: [{ id: 'same-label-hypothesis', source: 'alice:OntologyAlignmentTopic', target: 'bob:MentalModelAlignmentTopic', relation: 'exact', reason: 'A deliberately incomplete lexical hypothesis to be reviewed by the peer.' }] });
      proposalReady();
      await call('peer_send', { resourceId: 'report-interests' });
      return;
    }
    for (const proposal of status.task.proposals.filter(item => item.from === 'Alice' && item.status === 'proposed')) {
      const review = await call('alignment_accept', { proposalId: proposal.id, decision: 'reject', reason: 'The received source concerns ontology-term correspondences; my target concerns a person’s mental model of a system.' });
      assert.equal(review.status, 'rejected');
    }
    if (status.task.proposals.some(proposal => proposal.from === 'Bob')) return;
    await call('alignment_propose', { mappings: [
      { id: 'presentation-identity', source: 'bob:PresentationActivity', target: 'alice:ResearchTalk', relation: 'conditional', condition: 'One individual presentation identified by the same conference and report ID.', reason: 'Both actual definitions identify an individual research presentation.' },
      { id: 'understanding-and-evidence', source: 'bob:TransparencyTopic', target: 'alice:MappingProvenanceTopic', relation: 'related', reason: 'Recorded mapping evidence can contribute to understanding, without making the two concepts identical.' },
    ] });
    await call('peer_send', { resourceId: 'report-interests' });
  });
  await engine.start(created.workspaceId, { type: 'select_presentation', mode: 'native' });
  await drained(engine);
  const workspace = engine.get(created.workspaceId); const task = workspace.tasks[0];
  assert.equal(task.status, 'completed');
  assert.equal(task.result.report.id, 'R3');
  assert(task.proposals.some(proposal => proposal.status === 'rejected'));
  assert(task.mappings.some(mapping => mapping.id === 'presentation-identity' && mapping.relation === 'conditional'));
  assert(task.proposals.some(proposal => proposal.status === 'accepted' && proposal.reviewedBy === 'Alice'));
  for (const role of ['Alice', 'Bob']) assert(workspace.messages.some(message => message.from === role && message.resourceId === 'working-ontology'));
  assert.equal(new Set(calls.filter(call => call.name === 'alignment_accept').map(call => call.role)).size, 2);
});

test('native task_status protects peer checkpoint summaries just like the owner view', async t => {
  const { engine, created } = await harness(t, async () => {});
  await engine.start(created.workspaceId, { type: 'prepare_discussion', mode: 'native' });
  await drained(engine);
  const workspace = engine.get(created.workspaceId); const task = workspace.tasks[0];
  task.checkpoints.Alice = { status: 'working', summary: 'ALICE-PRIVATE-CHECKPOINT-NOTE', at: new Date().toISOString() };
  const own = await engine.tool(workspace.id, task.id, 'Alice', 'task_status');
  const peer = await engine.tool(workspace.id, task.id, 'Bob', 'task_status');
  assert(JSON.stringify(own).includes('ALICE-PRIVATE-CHECKPOINT-NOTE'));
  assert(!JSON.stringify(peer).includes('ALICE-PRIVATE-CHECKPOINT-NOTE'));
  assert(!JSON.stringify(engine.view(workspace, 'Bob')).includes('ALICE-PRIVATE-CHECKPOINT-NOTE'));
});

test('native disclosure pauses for a narrowed owner grant, resumes, then independently requests booking', async t => {
  const profile = researchProfile('Alice');
  const alicePublic = profile.materials.find(item => item.visibility === 'public');
  const alicePrivate = profile.materials.find(item => item.visibility !== 'public');
  const bobPublic = researchProfile('Bob').materials.find(item => item.visibility === 'public');
  const { engine, created, calls } = await harness(t, async ({ role, call }) => {
    const status = await call('task_status');
    if (status.task.status === 'completed') return;
    if (role === 'Bob') {
      if (!status.received.some(message => message.resourceId === alicePublic.id)) {
        await call('peer_request', { kind: 'research_material', recipient: 'Alice' });
      }
      try { await call('peer_send', { resourceId: bobPublic.id }); }
      catch (error) { if (error.code !== 'RESEARCH_TASK_CLOSED') throw error; }
      return;
    }
    // Repeating an already confirmed send reconciles the exact operation.
    await call('peer_send', { resourceId: alicePublic.id });
    const grants = await call('authorization_list');
    const request = grants.requests.find(item => item.intent.action === 'peer.send' && item.intent.resourceId === alicePrivate.id);
    if (!request || request.status === 'pending') {
      await call('authorization_request', { action: 'peer.send', resourceId: alicePrivate.id });
      await call('task_checkpoint', { status: 'needs_owner', summary: 'Prepared an exact research excerpt for owner review.' });
      return;
    }
    if (request.status === 'approved') {
      await call('peer_send', { resourceId: alicePrivate.id, fields: request.approvedIntent.fields });
    }
    const current = await call('task_status');
    let agenda = current.artifacts.find(item => item.kind === 'agenda');
    if (!agenda) agenda = await call('artifact_prepare', { kind: 'agenda', title: 'Joint semantics and HCI discussion',
      fields: { topic: 'Reviewable semantic collaboration', agenda: 'Mapping evidence and understandable human control' }, sourceRefs: [alicePublic.id, ...current.received.map(message => message.id)] });
    let form = current.artifacts.find(item => item.kind === 'reservation');
    if (!form) form = await call('artifact_prepare', { kind: 'reservation', title: 'Discussion venue draft',
      fields: { title: 'Joint research discussion', day: 'Thu', time: '15:00–15:30', attendees: '8', agenda: 'Semantics and HCI research exchange' }, sourceRefs: [alicePublic.id] });
    const check = await call('authorization_check', { action: 'reservation.submit', resourceId: form.id, venueId: 'room-a' });
    if (check.status !== 'allowed') {
      await call('authorization_request', { action: 'reservation.submit', resourceId: form.id, venueId: 'room-a' });
      await call('task_checkpoint', { status: 'needs_owner', summary: 'The final venue form is ready for owner approval.' });
      return;
    }
    await call('reservation_submit', { resourceId: form.id, venueId: 'room-a' });
  });
  await engine.start(created.workspaceId, { type: 'prepare_discussion', mode: 'native' });
  await drained(engine);
  const workspace = engine.get(created.workspaceId); const task = workspace.tasks[0];
  assert.equal(task.status, 'needs_owner');
  const ledger = engine.ledger(workspace, 'Alice');
  const first = ledger.pendingRequests().find(item => item.intent.action === 'peer.send');
  assert(first);
  assert(!workspace.messages.some(message => message.resourceId === alicePrivate.id));
  await engine.decide(workspace.id, 'Alice', first.id, { decision: 'allow', fields: ['summary'], expectedRevision: first.revision, expectedPayloadHash: first.payloadHash });
  await drained(engine);
  const disclosed = workspace.messages.find(message => message.resourceId === alicePrivate.id);
  assert.deepEqual(disclosed.fields, ['summary']);
  assert.deepEqual(Object.keys(disclosed.payload), ['summary']);
  assert(!Object.hasOwn(disclosed.payload, 'results'));
  assert.equal(workspace.reservations.length, 0);
  const booking = ledger.pendingRequests().find(item => item.intent.action === 'reservation.submit');
  assert(booking);
  await engine.decide(workspace.id, 'Alice', booking.id, { decision: 'allow', expectedRevision: booking.revision, expectedPayloadHash: booking.payloadHash });
  await drained(engine);
  assert.equal(task.status, 'completed');
  assert.equal(task.result.outcome, 'discussion_prepared');
  assert.equal(workspace.reservations.length, 1);
  assert.equal(task.result.reservation.status, 'confirmed');
  assert(calls.filter(call => call.role === 'Alice' && call.name === 'authorization_request').length >= 2);
});
