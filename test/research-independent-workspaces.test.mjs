import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research-engine.mjs';
import { researchProfile, researchSeedHash } from '../src/research-profiles.mjs';
import { canonical, hashPayload } from '../src/runtime-helpers.mjs';

const clone = value => structuredClone(value);
const roles = ['Alice', 'Bob'];
const artifactRoot = fileURLToPath(new URL('../artifacts/', import.meta.url));
const transportFixture = () => ({
  calls: [], online: true,
  async start() {},
  async transfer(from, value, { beforeSend } = {}) {
    beforeSend?.();
    this.calls.push({ from, value: clone(value) });
    if (!this.online) throw Object.assign(new Error('The test peer is offline'), { code: 'PEER_OFFLINE' });
    return clone(value);
  },
});
const passiveNative = {
  async check() { return { ready: true }; },
  async reconcile() { return { settled: true }; },
  run({ signal }) {
    return new Promise((resolve, reject) => {
      const stopped = () => reject(Object.assign(new Error('The test run stopped'), { code: 'MODEL_CANCELLED' }));
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) stopped();
    });
  },
};
async function fixture(t, options = {}) {
  const engine = new ResearchEngine({ persist: false, nativeClient: passiveNative, ...options });
  await engine.init();
  t.after(() => engine.close());
  const created = await engine.create();
  return { engine, created, w: engine.get(created.workspaceId) };
}
async function begin(engine, w, type = 'select_presentation') {
  await engine.start(w.id, { type, mode: 'native' });
  return w.tasks.at(-1);
}
const send = (engine, w, task, role, resourceId) => engine.tool(w.id, task.id, role, 'peer_send', { resourceId });
const peer = (engine, w, task, role) => engine.tool(w.id, task.id, role, 'peer_describe');
const mapping = () => ({
  source: 'alice:ResearchTalk', target: 'bob:PresentationActivity', relation: 'conditional',
  condition: 'The same individual research presentation, identified by its conference and report ID.',
  reason: 'Both received definitions describe an individual research presentation, under this stated condition.',
});
async function exchangeDefinitions(engine, w, task) {
  await send(engine, w, task, 'Alice', 'working-ontology');
  await send(engine, w, task, 'Bob', 'working-ontology');
}
async function temporaryDirectory() {
  await mkdir(artifactRoot, { recursive: true });
  return mkdtemp(path.join(artifactRoot, 'independent-workspaces-'));
}
async function removeTemporaryDirectory(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(artifactRoot) + path.sep));
  assert.ok(path.basename(directory).startsWith('independent-workspaces-'));
  await rm(directory, { recursive: true, force: true });
}

test('each new audience initializes native KG from reviewed own seeds instead of the current mutable base', async t => {
  const createdProfiles = [], nativeProfiles = new Map();
  let baseReads = 0;
  const knowledge = {
    async initialize() {},
    async profile() { baseReads++; throw new Error('New audience creation must not export mutable base knowledge'); },
    async createWorkspace(role, { workspaceId, profile }) {
      createdProfiles.push({ role, workspaceId, seed: clone(profile) });
      const result = { ...clone(profile), nativeWorkspace: { workspaceId, namespace: `urn:test:${role.toLowerCase()}:experience-${workspaceId}:`, seedHash: hashPayload(profile) } };
      nativeProfiles.set(`${workspaceId}:${role}`, result);
      return result;
    },
    async project() {},
  };
  const { engine, w: first } = await fixture(t, { knowledge });
  first.profiles.Alice.calendar[0].status = 'Busy';
  first.profiles.Alice.ontology.modules[0].concepts[0].definition = 'A first-audience-only edit.';
  first.profiles.Alice.materials[0].fields.summary = 'A first-audience-only private material edit.';
  first.profiles.Bob.interests.length = 0;
  nativeProfiles.get(`${first.id}:Bob`).calendar[0].status = 'Changed';
  const next = await engine.create();
  const second = engine.get(next.workspaceId);
  assert.equal(baseReads, 0);
  assert.equal(createdProfiles.length, 4);
  assert.notEqual(first.id, second.id);
  for (const role of roles) {
    const initial = createdProfiles.find(item => item.workspaceId === first.id && item.role === role);
    const fresh = createdProfiles.find(item => item.workspaceId === second.id && item.role === role);
    assert.equal(initial.seed.seed.hash, researchSeedHash(role));
    assert.deepEqual(fresh.seed, initial.seed);
    assert.deepEqual(second.profiles[role].calendar, researchProfile(role).calendar);
    assert.deepEqual(second.profiles[role].interests, researchProfile(role).interests);
    assert.notEqual(first.profiles[role].nativeWorkspace.namespace, second.profiles[role].nativeWorkspace.namespace);
    assert.equal(engine.ledger(second, role).list().grants.length, 0);
  }
  assert.equal(second.messages.length, 0);
  assert.equal(second.artifacts.length, 0);
  assert.equal(second.reservations.length, 0);
});

test('before actual exchange neither agent can inspect peer ontology, skills, annotations or prepared mappings', async t => {
  const { engine, w } = await fixture(t);
  for (const role of roles) {
    const view = engine.view(w, role);
    assert.deepEqual(view.peer.skills, []);
    assert.ok(!view.peer.ontology || !view.peer.ontology.modules?.length);
  }
  const task = await begin(engine, w);
  for (const role of roles) {
    const unknown = await peer(engine, w, task, role);
    assert.equal(unknown.known, false);
    assert.deepEqual(unknown.skills, []);
    assert.equal(unknown.ontology, null);
    const status = await engine.tool(w.id, task.id, role, 'task_status');
    const peerRole = role === 'Alice' ? 'bob' : 'alice';
    const visible = JSON.stringify({ view: engine.view(w, role), status });
    assert.ok(!visible.includes(`${peerRole}:ResearchTalk`));
    assert.ok(!visible.includes(`${peerRole}:PresentationActivity`));
    assert.ok(!visible.includes(`${peerRole}:topic-alignment`));
    assert.ok(!status.mappingCandidates?.length);
    assert.equal(task.mappings.length, 0);
    assert.ok(!status.conference.reports.some(report => report.topics && ('Alice' in report.topics || 'Bob' in report.topics)));
  }
});

test('working definitions and capabilities become known only to the actual recipient with message sources', async t => {
  const transport = transportFixture();
  const { engine, w } = await fixture(t, { peerTransport: transport });
  const task = await begin(engine, w);
  const own = await engine.tool(w.id, task.id, 'Alice', 'ontology_describe');
  const receipt = await engine.tool(w.id, task.id, 'Alice', 'peer_send', { resourceId: 'working-ontology', payload: { ontology: { modules: ['forged peer schema'] } } });
  const received = await peer(engine, w, task, 'Bob');
  assert.equal(received.known, true);
  assert.deepEqual(received.ontology.modules, own.modules);
  assert.ok(received.sources.includes(receipt.operationId));
  assert.ok(!JSON.stringify(received).includes('forged peer schema'));
  assert.equal((await peer(engine, w, task, 'Alice')).known, false);
  assert.deepEqual(received.skills, []);
  await send(engine, w, task, 'Alice', 'capabilities');
  const capable = await peer(engine, w, task, 'Bob');
  assert.ok(capable.skills.length > 0);
  assert.deepEqual(capable.skills.map(skill => skill.id), w.profiles.Alice.skills.map(skill => skill.id));
  for (const message of w.messages) {
    assert.ok(transport.calls.some(call => JSON.stringify(call.value).includes(message.id)), 'An actual message must pass through agent-comm transport');
  }
});

test('mapping proposals require actual definitions in both directions and an explicit peer decision', async t => {
  const transport = transportFixture();
  const { engine, w } = await fixture(t, { peerTransport: transport });
  const task = await begin(engine, w);
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'alignment_propose', { mappings: [mapping()] }));
  await send(engine, w, task, 'Alice', 'working-ontology');
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'alignment_propose', { mappings: [mapping()] }));
  await send(engine, w, task, 'Bob', 'working-ontology');
  const proposal = await engine.tool(w.id, task.id, 'Alice', 'alignment_propose', { mappings: [mapping()] });
  assert.equal(task.mappings.length, 0, 'Proposing a correspondence does not accept it');
  assert.equal(proposal.mappings[0].source, mapping().source);
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'alignment_accept', { proposalId: proposal.id, decision: 'accept', reason: 'Self-approval is invalid' }));
  const reviewed = await engine.tool(w.id, task.id, 'Bob', 'alignment_accept', { proposalId: proposal.id, decision: 'accept', reason: 'The received definitions agree for the stated individual-presentation condition.' });
  assert.equal(reviewed.status, 'accepted');
  assert.ok(task.mappings.some(item => item.source === mapping().source && item.target === mapping().target));
  assert.ok(transport.calls.some(call => JSON.stringify(call.value).includes(proposal.id)));
  assert.ok(transport.calls.some(call => JSON.stringify(call.value).includes('accepted')));
});

test('requests, delivered content and mapping review all cross the supplied transport boundary', async t => {
  const transport = transportFixture();
  const { engine, w } = await fixture(t, { peerTransport: transport });
  const task = await begin(engine, w);
  const request = await engine.tool(w.id, task.id, 'Alice', 'peer_request', { kind: 'ontology' });
  assert.ok(transport.calls.some(call => call.from === 'Alice' && JSON.stringify(call.value).includes(request.id)));
  await exchangeDefinitions(engine, w, task);
  const proposal = await engine.tool(w.id, task.id, 'Alice', 'alignment_propose', { mappings: [mapping()] });
  const beforeReview = transport.calls.length;
  await engine.tool(w.id, task.id, 'Bob', 'alignment_accept', { proposalId: proposal.id, decision: 'reject', reason: 'I need to clarify which presentation granularity is intended.' });
  assert.ok(transport.calls.length > beforeReview);
  assert.ok(transport.calls.slice(beforeReview).some(call => call.from === 'Bob' && JSON.stringify(call.value).includes(proposal.id)));
  assert.equal(task.mappings.length, 0);
});

test('a failed transport never fabricates reception, peer knowledge or a visible delivered message', async t => {
  const transport = transportFixture();
  const { engine, w } = await fixture(t, { peerTransport: transport });
  const task = await begin(engine, w);
  transport.online = false;
  await assert.rejects(send(engine, w, task, 'Alice', 'working-ontology'), { code: 'PEER_OFFLINE' });
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'peer_request', { kind: 'ontology' }), { code: 'PEER_OFFLINE' });
  assert.equal(w.messages.length, 0);
  assert.equal((await peer(engine, w, task, 'Bob')).known, false);
  assert.equal(engine.view(w, 'Bob').activity.filter(entry => entry.kind === 'message').length, 0);
  assert.ok(!task.requests?.length);
});

test('readable role runtime folders preserve own seed, ledger and actual inbox without exposing peer internals', async t => {
  const directory = await temporaryDirectory();
  const { engine, w } = await fixture(t, { directory, persist: true });
  t.after(() => removeTemporaryDirectory(directory));
  const task = await begin(engine, w);
  await exchangeDefinitions(engine, w, task);
  await send(engine, w, task, 'Alice', 'alice:public-intro');
  await engine.save(w);
  for (const role of roles) {
    const base = path.join(directory, 'runs', w.id, role.toLowerCase());
    const names = await readdir(base);
    for (const expected of ['seed', 'authorization.sqlite', 'manifest.json', 'profile.json', 'inbox.json', 'outbox.json', 'artifacts.json', 'tasks.json']) assert.ok(names.includes(expected), `${role} runtime is missing ${expected}`);
    const manifest = JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8'));
    const original = JSON.parse(await readFile(path.join(base, 'seed', 'manifest.json'), 'utf8'));
    assert.equal(manifest.role, role);
    assert.equal(manifest.experienceId, w.id);
    assert.equal(manifest.seed.hash, researchSeedHash(role));
    assert.equal(original.role, role);
    const inbox = JSON.parse(await readFile(path.join(base, 'inbox.json'), 'utf8'));
    assert.ok(inbox.every(message => message.to === role));
    assert.deepEqual(inbox, w.messages.filter(message => message.to === role));
    const tasks = await readFile(path.join(base, 'tasks.json'), 'utf8');
    assert.ok(!tasks.includes('instructions'));
    assert.ok(!tasks.includes(w.keys.Alice.private));
    assert.ok(!tasks.includes(w.keys.Bob.private));
    const ownProfile = JSON.parse(await readFile(path.join(base, 'profile.json'), 'utf8'));
    assert.equal(ownProfile.role, role);
    assert.ok(!JSON.stringify(ownProfile.knowledge).includes(role === 'Alice' ? 'bob:Observation' : 'alice:ExperimentRun'));
  }
});

test('service restart restores received peer definitions while a new audience starts without them', async t => {
  const directory = await temporaryDirectory();
  let engine = await new ResearchEngine({ directory, nativeClient: passiveNative }).init();
  t.after(async () => { await engine.close(); await removeTemporaryDirectory(directory); });
  const created = await engine.create(), w = engine.get(created.workspaceId);
  const task = await begin(engine, w);
  await send(engine, w, task, 'Alice', 'working-ontology');
  const received = clone(w.messages);
  await engine.close();
  engine = await new ResearchEngine({ directory, nativeClient: passiveNative }).init();
  const restored = engine.get(w.id);
  assert.equal(canonical(restored.messages), canonical(received));
  const described = await peer(engine, restored, restored.tasks[0], 'Bob');
  assert.equal(described.known, true);
  assert.equal(described.ontology.owner, 'Alice');
  assert.equal(engine.authorize(w.id, created.token).role, 'Alice');
  const fresh = await engine.create();
  assert.deepEqual(fresh.state.messages, []);
  assert.deepEqual(fresh.state.peer.skills, []);
  assert.ok(!fresh.state.peer.ontology || !fresh.state.peer.ontology.modules?.length);
  assert.equal(fresh.state.profile.seed.hash, researchSeedHash('Alice'));
});

test('later tasks retain knowledge actually received in this audience without accepting old mappings automatically', async t => {
  const { engine, w } = await fixture(t);
  const selected = await begin(engine, w);
  await exchangeDefinitions(engine, w, selected);
  const proposal = await engine.tool(w.id, selected.id, 'Alice', 'alignment_propose', { mappings: [mapping()] });
  await engine.tool(w.id, selected.id, 'Bob', 'alignment_accept', { proposalId: proposal.id, decision: 'accept' });
  await send(engine, w, selected, 'Alice', 'report-interests'); await send(engine, w, selected, 'Bob', 'report-interests');
  assert.equal(selected.status, 'completed');
  const previous = w.messages.find(message => message.from === 'Bob' && message.resourceId === 'working-ontology');
  await engine.start(w.id, { type: 'prepare_discussion', mode: 'controlled' });
  const next = w.tasks.at(-1), remembered = await peer(engine, w, next, 'Alice');
  assert.equal(remembered.ontology.receivedSource, previous.id);
  assert.equal(remembered.known, true);
  assert.deepEqual(next.mappings, [], 'An earlier scoped review is knowledge, not an automatic decision for this task.');
  const fresh = await engine.create();
  assert.equal(fresh.state.peer.known, false);
});

test('artifact errors identify the invalid field and genuine public program provenance is accepted', async t => {
  const { engine, w } = await fixture(t);
  const task = await begin(engine, w, 'prepare_discussion');
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'reservation', title: 'Discussion',
    fields: { title: 'Discussion', day: 'Thu', time: '15:00–15:30', attendees: 2, agenda: 'Research questions' }, sourceRefs: [] }),
  error => error.code === 'ARTIFACT_FIELDS' && /attendees.*text.*number/.test(error.message));
  const source = w.conference.reports[0].source;
  const draft = await engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'agenda', title: 'Public program discussion',
    fields: { agenda: 'Discuss the publicly listed presentation.' }, sourceRefs: [source] });
  assert.deepEqual(draft.sourceRefs, [source]);
  await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'agenda', title: 'Unknown source',
    fields: { agenda: 'A draft.' }, sourceRefs: ['synthetic:invented-program-source'] }), { code: 'ARTIFACT_SOURCE' });
});

test('native task context retains ready drafts without duplicating the full received ontologies', async t => {
  const { engine, w } = await fixture(t);
  const task = await begin(engine, w);
  await exchangeDefinitions(engine, w, task);
  const receipt = w.messages.find(message => message.to === 'Alice' && message.resourceId === 'working-ontology');
  const draft = await engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'brief', title: 'Current research note',
    fields: { summary: 'Review the definitions received from the collaborator.' }, sourceRefs: [receipt.id] });
  const status = await engine.tool(w.id, task.id, 'Alice', 'task_status');
  assert.deepEqual(status.artifacts.find(item => item.id === draft.id).fields, draft.fields);
  assert.equal(status.task.exchanges, undefined);
  assert.equal(status.received.find(message => message.id === receipt.id).payload, undefined);
  assert(status.peer.ontology.modules.every(module => !module.concepts));
  const definitions = await peer(engine, w, task, 'Alice');
  assert(definitions.ontology.modules.some(module => module.concepts.length > 0));
  assert.equal(definitions.ontology.receivedSource, receipt.id);
});

test('task execution metadata identifies the booking organizer and preserves each owner private resource capability', async t => {
  const shared = await fixture(t);
  const task = await begin(shared.engine, shared.w, 'prepare_discussion');
  const fields = { title: 'Research discussion', day: 'Thu', time: '15:00–15:30', attendees: '2', agenda: 'Discuss research questions.' };
  for (const role of roles) {
    const status = await shared.engine.tool(shared.w.id, task.id, role, 'task_status');
    assert.equal(status.execution.reservationOrganizer, 'Alice');
  }
  const peerDraft = await shared.engine.tool(shared.w.id, task.id, 'Bob', 'artifact_prepare', {
    kind: 'reservation', title: fields.title, fields, sourceRefs: [shared.w.conference.id] });
  await assert.rejects(shared.engine.tool(shared.w.id, task.id, 'Bob', 'authorization_check', {
    action: 'reservation.submit', resourceId: peerDraft.id, venueId: 'room-a' }), { code: 'RESERVATION_ORGANIZER' });

  const own = await fixture(t);
  await own.engine.start(own.w.id, { type: 'research_work', mode: 'native', goal: 'Prepare a room proposal for my own research.' }, 'Bob');
  const ownTask = own.w.tasks.at(-1);
  const status = await own.engine.tool(own.w.id, ownTask.id, 'Bob', 'task_status');
  assert.equal(status.execution.reservationOrganizer, 'Bob');
  const proposal = await own.engine.tool(own.w.id, ownTask.id, 'Bob', 'artifact_prepare', {
    kind: 'reservation', title: fields.title, fields, sourceRefs: [own.w.conference.id] });
  const check = await own.engine.tool(own.w.id, ownTask.id, 'Bob', 'authorization_check', {
    action: 'reservation.submit', resourceId: proposal.id, venueId: 'room-a' });
  assert.equal(check.status, 'needs_approval');
  assert.equal(own.w.reservations.length, 0);
});
