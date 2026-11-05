import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEngine } from '../src/research-engine.mjs';
import { researchProfile } from '../src/research-profiles.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

test('a native definition change invalidates its registered mapping while label-only edits preserve meaning', async t => {
  const profiles = Object.fromEntries(['Alice', 'Bob'].map(role => [role, researchProfile(role)]));
  const talk = profiles.Alice.ontology.modules.flatMap(m => m.concepts).find(c => c.id === 'alice:ResearchTalk');
  talk.definition = 'An entire conference session containing multiple presentations.';
  const { hash: previous, ...definition } = profiles.Alice.ontology;
  profiles.Alice.ontology.hash = hashPayload(definition);
  const engine = await new ResearchEngine({ persist: false, knowledge: {
    initialize: async () => {}, profile: async role => structuredClone(profiles[role]), project: async () => {},
  } }).init();
  t.after(() => engine.close());
  const created = await engine.create();
  const state = await engine.start(created.workspaceId, { type: 'select_presentation' });
  const task = state.tasks.at(-1);
  assert.equal(task.status, 'paused');
  assert.equal(task.result, null);
  assert(!task.mappings.some(m => m.id === 'individual-presentation'));
  const candidate = engine.mappingCandidates(task).find(m => m.id === 'individual-presentation');
  assert.equal(candidate.valid, false);
  assert.match(candidate.sourceDefinition, /entire conference session/);

  const baseline = new ResearchEngine({ persist: false }); await baseline.init(); t.after(() => baseline.close());
  const normal = await baseline.create();
  const term = baseline.get(normal.workspaceId).profiles.Alice.ontology.modules.flatMap(m => m.concepts).find(c => c.id === 'alice:ResearchTalk');
  term.label = 'Owner-edited display label';
  const normalState = await baseline.start(normal.workspaceId, { type: 'select_presentation' });
  assert.equal(normalState.tasks.at(-1).result.report.id, 'R3');
});
