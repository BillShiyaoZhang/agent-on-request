import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResearchEngine } from '../src/research-engine.mjs';

async function fixture(t) {
  const engine = await new ResearchEngine({ persist: false,
    nativeClient: { run: async () => ({ status: 'completed' }) } }).init();
  t.after(() => engine.close());
  const created = await engine.create();
  const state = await engine.start(created.workspaceId, { type: 'select_presentation', mode: 'native' });
  await Promise.allSettled([...engine.running]);
  const w = engine.get(created.workspaceId), task = w.tasks.at(-1);
  const call = (role, name, args = {}) => engine.tool(w.id, task.id, role, name, args);
  return { engine, w, task, state, call };
}

async function exchangedProposal(call) {
  for (const role of ['Alice', 'Bob']) await call(role, 'peer_send', { resourceId: 'working-ontology' });
  return call('Alice', 'alignment_propose', { mappings: [{ id: 'actual-individual-presentation',
    source: 'alice:ResearchTalk', target: 'bob:PresentationActivity', relation: 'conditional',
    condition: 'The same individual presentation within the public conference.',
  }] });
}

const noUnrelatedCollections = result => {
  assert.equal(result.calendar?.length ?? 0, 0);
  assert.equal(result.reportAnnotations?.length ?? 0, 0);
  assert.equal(result.authorizations?.length ?? 0, 0);
};

test('default knowledge search summarizes received definitions and capabilities while explicit peer inspection retains their real contents', async t => {
  const { call, w } = await fixture(t);
  for (const resourceId of ['working-ontology', 'capabilities']) await call('Bob', 'peer_send', { resourceId });
  const received = w.messages.filter(message => message.to === 'Alice');
  assert.equal(received.length, 2);
  const result = await call('Alice', 'knowledge_search');
  for (const message of received) {
    const node = result.nodes.find(item => item.id === message.id);
    assert.ok(node, 'The actual received record remains discoverable.');
    assert.equal(node.label, message.resourceId);
    assert.equal(node.properties.resourceId, message.resourceId);
    assert.equal(node.properties.sourceRef, message.id);
    assert.equal(node.properties.inspect, 'peer_describe');
    assert.equal(node.properties.ontology, undefined);
    assert.equal(node.properties.skills, undefined);
    assert.ok(!JSON.stringify(node).includes('bob:MentalModelAlignmentTopic'));
    assert.ok(JSON.stringify(node).length < 2000, 'Metadata must not repeat the many-definition payload.');
  }
  const description = await call('Alice', 'peer_describe');
  const ontologyMessage = received.find(message => message.resourceId === 'working-ontology');
  const capabilityMessage = received.find(message => message.resourceId === 'capabilities');
  assert.equal(description.known, true);
  assert.equal(description.ontology.hash, ontologyMessage.payload.ontology.hash);
  assert.deepEqual(description.ontology.modules, ontologyMessage.payload.ontology.modules);
  assert.deepEqual(description.skills, capabilityMessage.payload.skills);
  assert.deepEqual(new Set(description.sources), new Set(received.map(message => message.id)));
});

test('exact record queries return only requested nodes or materials rather than repeating unrelated personal context', async t => {
  const { call, w } = await fixture(t);
  const claim = await call('Alice', 'knowledge_search', { ids: ['alice:claim'], hops: 0 });
  assert.deepEqual(claim.nodes.map(node => node.id), ['alice:claim']);
  assert.deepEqual(claim.edges, []);
  assert.equal(claim.materials?.length ?? 0, 0);
  noUnrelatedCollections(claim);
  const materialId = w.profiles.Alice.materials.find(material => material.visibility === 'private').id;
  const material = await call('Alice', 'knowledge_search', { ids: [materialId], hops: 0 });
  assert.equal(material.nodes.length, 0);
  assert.deepEqual(material.materials.map(item => item.id), [materialId]);
  noUnrelatedCollections(material);
  const missing = await call('Alice', 'knowledge_search', { ids: ['alice:missing-record'], hops: 0 });
  assert.deepEqual(missing.nodes, []);
  assert.deepEqual(missing.materials, []);
  noUnrelatedCollections(missing);
  const questions = await call('Alice', 'knowledge_search', { type: 'ResearchQuestion', hops: 0 });
  assert.ok(questions.nodes.length > 0);
  assert.ok(questions.nodes.every(node => node.type === 'alice:ResearchQuestion'));
  assert.equal(questions.materials?.length ?? 0, 0);
  assert.equal(questions.calendar?.length ?? 0, 0);
  assert.equal(questions.reportAnnotations?.length ?? 0, 0);
});

test('authorization search projections deduplicate latest record state and refer to formal retrieval without embedding exact payload values', async t => {
  const { engine, w, task, call } = await fixture(t);
  const request = await call('Alice', 'authorization_request', { resourceId: 'alice:research-brief', fields: ['summary'] });
  await engine.decide(w.id, 'Alice', request.id, { decision: 'allow', fields: ['summary'],
    expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
  const grant = engine.ledger(w, 'Alice').list().grants.find(item => item.intent.resourceId === 'alice:research-brief');
  await engine.revoke(w.id, 'Alice', grant.id);
  assert.ok(w.authorizationProjection.filter(row => row.role === 'Alice' && row.recordId === request.id).length >= 2,
    'The fixture contains both pending and approved outbox events for this record.');
  const summary = await call('Alice', 'knowledge_search');
  assert.equal(new Set(summary.authorizations.map(row => row.recordId)).size, summary.authorizations.length);
  assert.equal(summary.authorizations.find(row => row.recordId === request.id).status, 'approved');
  assert.equal(summary.authorizations.find(row => row.recordId === grant.id).status, 'revoked');
  for (const row of summary.authorizations) {
    assert.ok(row.recordId && row.kind);
    assert.equal(row.inspect, 'authorization_list');
    assert.equal(row.record, undefined);
    assert.equal(row.intent, undefined);
    assert.equal(row.values, undefined);
  }
  const privateSummary = request.intent.values.summary;
  assert.ok(!JSON.stringify(summary.authorizations).includes(privateSummary));
  const exact = await call('Alice', 'knowledge_search', { ids: [request.id], hops: 0 });
  assert.deepEqual(exact.authorizations.map(row => row.recordId), [request.id]);
  assert.equal(exact.authorizations[0].taskId, task.id);
  assert.equal(exact.authorizations[0].resourceId, 'alice:research-brief');
  const formal = await call('Alice', 'authorization_list');
  assert.equal(formal.grants.find(item => item.id === grant.id).intent.values.summary, privateSummary);
  const bob = await call('Bob', 'knowledge_search');
  assert.ok(!bob.authorizations.some(row => [request.id, grant.id].includes(row.recordId)));
});

test('artifact sources normalize real proposal aliases for the proposer and its actual recipient and retain other delivered exchange references', async t => {
  const { call, w } = await fixture(t);
  const proposal = await exchangedProposal(call);
  const delivery = w.tasks.flatMap(task => task.exchanges ?? []).find(exchange => exchange.id === proposal.id);
  assert.equal(delivery.receipt.status, 'received');
  for (const role of ['Alice', 'Bob']) {
    const draft = await call(role, 'artifact_prepare', { kind: 'brief', title: 'Review of an actually exchanged proposal',
      fields: { summary: 'A sourced review of the recorded proposal.' }, sourceRefs: [`proposal:${proposal.id}`] });
    assert.deepEqual(draft.sourceRefs, [proposal.id]);
    const revised = await call(role, 'artifact_revise', { artifactId: draft.id, expectedVersion: draft.version,
      fields: { summary: 'Revised review retaining the actual source.' }, sourceRefs: [`proposal:${proposal.id}`] });
    assert.deepEqual(revised.sourceRefs, [proposal.id]);
  }
  const request = await call('Bob', 'peer_request', { kind: 'agenda_review' });
  const response = await call('Alice', 'artifact_prepare', { kind: 'agenda', title: 'Agenda responding to a real request',
    fields: { agenda: 'Discuss the received collaboration request.' }, sourceRefs: [request.id] });
  assert.deepEqual(response.sourceRefs, [request.id]);
});

test('fabricated proposal aliases and proposals belonging to another audience cannot become artifact evidence', async t => {
  const { engine, call } = await fixture(t);
  const proposal = await exchangedProposal(call);
  const argumentsFor = ref => ({ kind: 'brief', title: 'Unverified source', fields: { summary: 'Must not be saved.' }, sourceRefs: [ref] });
  await assert.rejects(call('Alice', 'artifact_prepare', argumentsFor(`proposal:${randomUUID()}`)), { code: 'ARTIFACT_SOURCE' });
  await assert.rejects(call('Alice', 'artifact_prepare', argumentsFor('proposal:alice:claim')), { code: 'ARTIFACT_SOURCE' });
  const other = await engine.create();
  await engine.start(other.workspaceId, { type: 'select_presentation', mode: 'native' });
  const second = engine.get(other.workspaceId), secondTask = second.tasks.at(-1);
  await assert.rejects(engine.tool(second.id, secondTask.id, 'Alice', 'artifact_prepare', argumentsFor(`proposal:${proposal.id}`)), { code: 'ARTIFACT_SOURCE' });
  assert.equal(second.artifacts.length, 0);
});
