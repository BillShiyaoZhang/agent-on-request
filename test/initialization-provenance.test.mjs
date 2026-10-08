import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntimeManager } from '../src/runtime-manager.mjs';
import { SessionEngine } from '../src/session-engine.mjs';
import { ProfileStore } from '../src/profile-store.mjs';
import { ResearchStore } from '../src/research-store.mjs';
import { hashValue } from '../src/config.mjs';

async function fixture(t) {
  const runtime = createRuntimeManager({ bobUrl: '', modelBaseUrl: '', modelName: '' });
  await runtime.start();
  const profiles = new ProfileStore({ persist: false });
  const research = new ResearchStore({ persist: false });
  const engine = new SessionEngine({ runtime, profiles, research });
  t.after(() => engine.close());
  return { runtime, profiles, research, engine };
}
test('initial-condition provenance uses one owner template snapshot across asynchronous cleanup', async t => {
  const { engine, runtime, profiles } = await fixture(t);
  let entered, release;
  const entering = new Promise(done => { entered = done; });
  const held = new Promise(done => { release = done; });
  const clear = runtime.clear.bind(runtime);
  let wait = true;
  runtime.clear = async args => { if (wait) { wait = false; entered(); await held; } return clear(args); };
  engine.cleanupPending.set('previous-cleanup', { sessionId: 'previous-cleanup', epoch: 1 });
  const creating = engine.create();
  await entering;
  const changed = structuredClone(profiles.template);
  changed.data.availableTimes = [{ day: 'Tue', time: '10:00–10:30' }];
  await profiles.applyTemplate(changed, profiles.templateRevision);
  release();
  const old = (await creating).state;
  assert.equal(old.bob.templateRevision, 1);
  assert.equal(old.bob.configRevision, 1);
  assert.deepEqual(old.initialConditions.agents.Bob.data.availableTimes, [{ day: 'Thu', time: '15:00–15:30' }]);
  const next = (await engine.create()).state;
  assert.equal(next.bob.templateRevision, 2);
  assert.deepEqual(next.initialConditions.agents.Bob.data.availableTimes, changed.data.availableTimes);
});

test('largest supported Alice fixture remains readable and fully traceable beyond per-configuration output size', async t => {
  const { engine, research } = await fixture(t);
  const calendar = Array.from({ length: 500 }, (_, i) => ({ day: 'Tue', time: '10:00–10:30', status: 'Free', title: 'Fictional entry ' + i, note: 'Own context ' + i }));
  const { state } = await engine.create({ researchConsent: true, initialConditions: { custom: { Alice: { data: { calendar } } } } });
  assert.equal(state.alice.calendar.length, 500);
  assert.equal(state.agentStates.Alice.data[0].count, 500);
  assert.equal(state.agentStates.Alice.kg.nodes.filter(node => node.type === 'calendar_slot').length, 500);
  const session = engine.get(state.session.id);
  const preview = await engine.preview(session, { stage: 'initial', choice: 'none' });
  await engine.action(session, { action: 'share_initial', choice: 'none', previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() });
  await engine.action(session, { action: 'end', expectedVersion: session.version, requestId: randomUUID() });
  const run = research.list().runs[0];
  assert.equal(run.initialConditions.agents.Alice.data.calendar.length, 500);
  assert.equal(run.conditionsHash, hashValue(state.initialConditions));
  assert.equal(run.trace.at(-1).snapshot.agentStates.Alice.data[0].count, 500);
  assert.equal(run.trace.at(-1).snapshot.ended, true);
  assert.equal(run.status, 'declined');
});
