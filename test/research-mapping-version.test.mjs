import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEngine } from '../src/research-engine.mjs';
import { researchProfile } from '../src/research-profiles.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

test('new audiences initialize the same reviewed seed even when the mutable base KG was changed', async t => {
  const base = Object.fromEntries(['Alice', 'Bob'].map(role => [role, researchProfile(role)]));
  const talk = base.Alice.ontology.modules.flatMap(module => module.concepts).find(term => term.id === 'alice:ResearchTalk');
  talk.definition = 'An unrelated changed base definition that the next audience must not inherit.';
  base.Alice.calendar[0].status = 'Changed outside this experience';
  let mutableBaseReads = 0;
  const initializations = [];
  const engine = await new ResearchEngine({ persist: false, knowledge: {
    initialize: async () => {},
    profile: async role => { mutableBaseReads++; return structuredClone(base[role]); },
    createWorkspace: async (role, { workspaceId, profile }) => {
      initializations.push({ role, workspaceId, profile: structuredClone(profile) });
      return { ...structuredClone(profile), nativeWorkspace: { workspaceId, namespace: `urn:test:${role.toLowerCase()}:experience-${workspaceId}:`, seedHash: hashPayload(profile) } };
    },
    project: async () => {},
  } }).init();
  t.after(() => engine.close());
  const first = await engine.create(), second = await engine.create();
  assert.equal(mutableBaseReads, 0, 'Starting conditions must not be exported from a mutable base KG.');
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal(initializations.length, 4);
  const original = researchProfile('Alice');
  for (const initialization of initializations.filter(item => item.role === 'Alice')) {
    assert.equal(initialization.profile.ontology.hash, original.ontology.hash);
    assert.deepEqual(initialization.profile.calendar, original.calendar);
    assert.equal(initialization.profile.seed.hash, original.seed.hash);
  }
  const selected = await engine.start(first.workspaceId, { type: 'select_presentation' });
  assert.equal(selected.tasks.at(-1).result.report.id, 'R3');
});

test('mapping proposals bind actual exchanged definition versions and semantic rejection is performed by the reviewer', async t => {
  const engine = await new ResearchEngine({ persist: false, nativeClient: { run: async () => ({ status: 'completed' }) } }).init();
  t.after(() => engine.close());
  const created = await engine.create();
  const state = await engine.start(created.workspaceId, { type: 'select_presentation', mode: 'native' });
  await Promise.allSettled([...engine.running]);
  const w = engine.get(created.workspaceId), task = w.tasks.at(-1);
  const bob = w.profiles.Bob;
  const talk = bob.ontology.modules.flatMap(module => module.concepts).find(term => term.id === 'bob:PresentationActivity');
  talk.definition = 'An entire conference session containing several individually identified presentations.';
  const { hash: previous, ...definition } = bob.ontology;
  bob.ontology.hash = hashPayload(definition);
  for (const role of ['Alice', 'Bob']) await engine.tool(w.id, task.id, role, 'peer_send', { resourceId: 'working-ontology' });
  const bobDisclosure = w.messages.find(message => message.from === 'Bob' && message.resourceId === 'working-ontology');
  const proposal = await engine.tool(w.id, task.id, 'Alice', 'alignment_propose', { mappings: [{
    id: 'presentation-granularity', source: 'alice:ResearchTalk', target: 'bob:PresentationActivity', relation: 'exact',
    reason: 'Candidate equivalence submitted for peer review using the actual disclosed versions.',
  }] });
  assert.equal(proposal.mappings[0].ontologyHashes.Bob, bobDisclosure.payload.ontology.hash);
  assert.match(proposal.mappings[0].targetDefinition, /entire conference session/);
  const rejected = await engine.tool(w.id, task.id, 'Bob', 'alignment_accept', { proposalId: proposal.id,
    decision: 'reject', reason: 'One individual presentation and a whole session containing several presentations have different granularity.' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewedBy, 'Bob');
  assert.equal(task.mappings.length, 0);
  assert.equal(task.result, null);
  const context = await engine.tool(w.id, task.id, 'Alice', 'task_status');
  assert.equal(context.mappingCandidates, undefined);
  assert.equal(state.tasks.at(-1).id, task.id);
});
