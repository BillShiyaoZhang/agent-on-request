import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResearchEngine } from '../src/research-engine.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

async function fixture(t, { selectFirst = false } = {}) {
  const engine = await new ResearchEngine({ persist: false }).init();
  t.after(() => engine.close());
  const created = await engine.create(), w = engine.get(created.workspaceId);
  let selection;
  if (selectFirst) {
    await engine.start(w.id, { type: 'select_presentation' });
    selection = w.tasks.at(-1);
    assert.equal(selection.status, 'completed');
  }
  await engine.start(w.id, { type: 'prepare_discussion' });
  const task = w.tasks.at(-1);
  assert.equal(task.status, 'needs_owner');
  const record = (role, node) => engine.tool(w.id, task.id, role, 'knowledge_record', { nodes: [node] });
  return { engine, w, task, selection, record };
}
const note = (role = 'Alice', references = ['alice:experiment']) => ({
  id: `${role.toLowerCase()}:record-${randomUUID()}`, type: `${role.toLowerCase()}:ResearchNote`, label: 'A sourced research note',
  properties: { summary: 'Keep evidence and the reviewed correspondence together.' }, sourceRefs: references,
});

test('a sourced own artifact can support a private fact while unsourced or foreign drafts cannot', async t => {
  const { engine, w, task, record } = await fixture(t);
  const draft = await engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', {
    kind: 'brief', title: 'Evidence summary', fields: { summary: 'Experiment supports the research question.' }, sourceRefs: ['alice:experiment'] });
  const result = await record('Alice', note('Alice', [draft.id]));
  assert.deepEqual(result.nodes[0].source.references, [draft.id]);
  await assert.rejects(record('Bob', note('Bob', [draft.id])), { code: 'KNOWLEDGE_SOURCE' });
  const unsourced = await engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', {
    kind: 'brief', title: 'Unverified scratchpad', fields: { summary: 'A tentative idea.' }, sourceRefs: [] });
  await assert.rejects(record('Alice', note('Alice', [unsourced.id])), { code: 'KNOWLEDGE_SOURCE' });
});

test('knowledge datatype errors identify the property, required datatype and actual value type', async t => {
  const { record } = await fixture(t);
  const cases = [
    ['alice:ResearchNote', 'summary', { nested: 'object' }, 'string', 'object'],
    ['alice:ResearchNote', 'summary', ['an array'], 'string', 'array'],
    ['alice:ResearchNote', 'summary', null, 'string', 'null'],
    ['alice:MetricObservation', 'value', '0.82', 'number', 'string'],
    ['alice:Place', 'capacity', 2.5, 'integer', 'number'],
    ['alice:Place', 'equipment', { projector: true }, 'string[]', 'object'],
    ['alice:SourceRecord', 'synthetic', 'true', 'boolean', 'string'],
  ];
  for (const [type, key, value, expected, actualType] of cases) {
    await assert.rejects(record('Alice', { ...note(), type, properties: { [key]: value } }), error => {
      assert.equal(error.code, 'KNOWLEDGE_DATATYPE');
      assert.ok(error.message.includes(key));
      assert.ok(error.message.includes(expected));
      assert.ok(error.message.includes(actualType));
      assert.deepEqual(error.details, { property: key, expectedDatatype: expected, actualType });
      return true;
    });
  }
});

test('unknown knowledge properties identify the exact key and the applicable own type', async t => {
  const { record } = await fixture(t);
  await assert.rejects(record('Alice', { ...note(), properties: { inventedCitationField: 'not declared' } }), error => {
    assert.equal(error.code, 'KNOWLEDGE_PROPERTY');
    assert.match(error.message, /inventedCitationField/);
    assert.match(error.message, /alice:ResearchNote/);
    assert.match(error.message, /summary/);
    return true;
  });
});

test('a later task can cite real prior proposal and review exchanges from the same audience', async t => {
  const { engine, w, task, selection, record } = await fixture(t, { selectFirst: true });
  const proposal = selection.proposals.find(item => item.status === 'accepted');
  assert.ok(proposal);
  const review = selection.exchanges.find(exchange => exchange.kind === 'alignment_accept' && exchange.payload.id === proposal.id);
  assert.equal(review.receipt.status, 'received');
  for (const role of ['Alice', 'Bob']) {
    const result = await record(role, note(role, [`proposal:${proposal.id}`, review.id]));
    assert.deepEqual(result.nodes[0].source.references, [proposal.id, review.id]);
    assert.equal(result.nodes[0].source.taskId, task.id);
    assert.equal(result.nodes[0].visibility, 'private');
    const stored = w.profiles[role].knowledge.nodes.find(node => node.id === result.nodes[0].id);
    assert.deepEqual(stored.source.references, [proposal.id, review.id]);
  }
  assert.ok(engine.view(w, 'Alice').profile.knowledge.nodes.some(node => node.source?.references?.includes(proposal.id)));
});

test('a current task can cite its actually transmitted request without claiming a disclosure occurred', async t => {
  const { engine, w, task, record } = await fixture(t);
  const request = await engine.tool(w.id, task.id, 'Bob', 'peer_request', { kind: 'agenda_review' });
  const exchange = task.exchanges.find(item => item.id === request.id);
  assert.ok(exchange);
  for (const role of ['Alice', 'Bob']) {
    const result = await record(role, note(role, [request.id]));
    assert.deepEqual(result.nodes[0].source.references, [request.id]);
  }
  assert.ok(!w.messages.some(message => message.resourceId === 'alice:research-brief'));
});

test('proposal aliases cannot manufacture a source from an unknown UUID or an unsent local proposal', async t => {
  const { w, task, record } = await fixture(t);
  const orphanId = randomUUID();
  task.proposals.push({ id: orphanId, from: 'Alice', status: 'proposed', mappings: [] });
  const initialCount = w.profiles.Alice.knowledge.nodes.length;
  for (const ref of [`proposal:${randomUUID()}`, `proposal:${orphanId}`, orphanId, 'proposal:alice:experiment']) {
    await assert.rejects(record('Alice', note('Alice', [ref])), { code: 'KNOWLEDGE_SOURCE' });
  }
  assert.equal(w.profiles.Alice.knowledge.nodes.length, initialCount);
});

test('unreceived, altered or unrelated exchange records cannot be used as knowledge evidence', async t => {
  const { w, task, record } = await fixture(t);
  const fake = (overrides = {}) => {
    const id = randomUUID(), payload = { id, kind: 'ontology' };
    return { id, workspaceId: w.id, taskId: task.id, from: 'Alice', to: 'Bob', kind: 'peer_request', payload,
      receipt: { operationId: id, receiver: 'Bob', status: 'received', payloadHash: hashPayload(payload) }, ...overrides };
  };
  const missingReceipt = fake({ receipt: { status: 'pending' } });
  const altered = fake(); altered.receipt.payloadHash = '0'.repeat(64);
  const wrongWorkspace = fake({ workspaceId: randomUUID() });
  const wrongTask = fake({ taskId: randomUUID() });
  const noParticipant = fake({ from: 'Nobody', to: 'Somebody' });
  task.exchanges ??= [];
  task.exchanges.push(missingReceipt, altered, wrongWorkspace, wrongTask, noParticipant);
  for (const exchange of [missingReceipt, altered, wrongWorkspace, wrongTask, noParticipant]) {
    await assert.rejects(record('Alice', note('Alice', [exchange.id])), { code: 'KNOWLEDGE_SOURCE' });
  }
});

test('actual proposal IDs from a different audience remain unavailable to a fresh identity', async t => {
  const { engine, selection } = await fixture(t, { selectFirst: true });
  const proposal = selection.proposals[0];
  const second = await engine.create(), w = engine.get(second.workspaceId);
  await engine.start(w.id, { type: 'prepare_discussion' });
  const task = w.tasks.at(-1);
  for (const source of [proposal.id, `proposal:${proposal.id}`]) {
    await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'knowledge_record', { nodes: [note('Alice', [source])] }), { code: 'KNOWLEDGE_SOURCE' });
  }
});

test('an agent can cite its own real sent message receipt as well as actual received content', async t => {
  const { w, selection, record } = await fixture(t, { selectFirst: true });
  const sent = w.messages.find(message => message.taskId === selection.id && message.from === 'Alice' && message.resourceId === 'report-interests');
  const received = w.messages.find(message => message.taskId === selection.id && message.to === 'Alice' && message.resourceId === 'report-interests');
  assert.equal(sent.receipt.status, 'received');
  assert.equal(received.receipt.status, 'received');
  const result = await record('Alice', note('Alice', [sent.id, received.id]));
  assert.deepEqual(result.nodes[0].source.references, [sent.id, received.id]);
  await assert.rejects(record('Alice', note('Alice', [`op:${'f'.repeat(64)}`])), { code: 'KNOWLEDGE_SOURCE' });
});

test('actual public conference, report, program source and venue IDs are valid knowledge sources', async t => {
  const { w, record } = await fixture(t);
  const references = [...new Set([w.conference.id, ...w.conference.reports.flatMap(report => [report.id, report.source]), ...w.conference.venues.map(venue => venue.id)])];
  const recorded = await record('Alice', note('Alice', references));
  assert.deepEqual(recorded.nodes[0].source.references, references);
  assert.equal(recorded.nodes[0].visibility, 'private');
  for (const invented of ['alice:presentation:R1', 'R999', 'room-imaginary', 'synthetic:conference:program:missing']) {
    await assert.rejects(record('Alice', note('Alice', [invented])), { code: 'KNOWLEDGE_SOURCE' });
  }
});
