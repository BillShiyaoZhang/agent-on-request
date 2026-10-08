import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionEngine } from '../src/session-engine.mjs';
import { createRuntimeManager } from '../src/runtime-manager.mjs';
import { ProfileStore } from '../src/profile-store.mjs';
import { ResearchStore } from '../src/research-store.mjs';

async function fixture(t, persist = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-'));
  const runtime = createRuntimeManager({ bobUrl: '', modelBaseUrl: '', modelName: '' });
  await runtime.start();
  const profiles = new ProfileStore({ directory, persist }); await profiles.init();
  const research = new ResearchStore({ directory: path.join(directory, 'research'), persist }); await research.init();
  const engine = new SessionEngine({ runtime, profiles, research });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, runtime, profiles, research, directory };
}
async function choose(engine, id, stage, choice) {
  const session = engine.get(id);
  const preview = await engine.preview(session, { stage, choice });
  const input = { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice, previewHash: preview.payloadHash, requestId: randomUUID(), expectedVersion: preview.sessionVersion };
  return { ...(await engine.action(session, input)), input };
}
async function reachApproval(engine, consent = false) {
  const created = await engine.create({ researchConsent: consent }); const id = created.state.session.id;
  await choose(engine, id, 'initial', 'free');
  const result = await choose(engine, id, 'additional', 'narrow');
  assert.equal(result.state.session.stage, 'waiting_admin');
  return { ...created, id, approval: engine.approvals(id).find(item => item.status === 'pending') };
}
function decision(approval, fields = ['topic']) { return { decision: 'allow_once', fields, expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash }; }

test('real two-process round sends minimum projections, gates Bob brief and narrows one-time owner approval', async t => {
  const { engine } = await fixture(t);
  const { id, approval } = await reachApproval(engine);
  const before = engine.view(engine.get(id));
  assert.deepEqual(before.choices, { initial: 'free', additional: 'narrow' });
  assert.equal(before.receipts.aliceToBob.length, 2);
  assert.equal(before.receipts.aliceToBob[0].rows.some(row => 'title' in row), false);
  assert.equal(before.receipts.bobToAlice.length, 1);
  assert.deepEqual(before.receipts.bobToAlice[0].fields, ['day', 'time', 'status']);
  assert.equal(before.messages.some(message => message.text.includes(approval.values.agenda)), false);
  const { state } = await engine.decide(approval.id, decision(approval));
  assert.equal(state.task.outcome, 'arranged');
  assert.deepEqual(state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
  assert.deepEqual(state.receipts.bobToAlice.at(-1).values, { topic: approval.values.topic });
  assert.deepEqual(state.choices, before.choices);
  await assert.rejects(engine.decide(approval.id, decision(approval)), { code: 'STALE_APPROVAL' });
});

test('same submission remains idempotent and conflicting or stale intent never broadens sharing', async t => {
  const { engine } = await fixture(t);
  const created = await engine.create(); const session = engine.get(created.state.session.id);
  const { input } = await choose(engine, session.id, 'initial', 'busy');
  const once = engine.view(session);
  await engine.action(session, input);
  assert.equal(session.receipts.aliceToBob.length, 1);
  await assert.rejects(engine.action(session, { ...input, choice: 'full' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(engine.action(session, { ...input, requestId: randomUUID() }), { code: 'STALE_SESSION' });
  assert.deepEqual(engine.view(session).receipts, once.receipts);
});

test('Bob owner denial preserves valid meeting and Alice rejection is a valid completion', async t => {
  const { engine } = await fixture(t);
  const { id, approval } = await reachApproval(engine);
  const denied = await engine.decide(approval.id, { ...decision(approval), decision: 'deny' });
  assert.equal(denied.state.task.outcome, 'arranged');
  assert.equal(denied.state.receipts.bobToAlice.length, 1);
  const newRound = await engine.create();
  const result = await choose(engine, newRound.state.session.id, 'initial', 'none');
  assert.equal(result.state.task.outcome, 'declined');
  assert.equal(result.state.receipts.aliceToBob.length, 0);
});

test('current configuration supersedes approvals without changing received snapshots or next-round template', async t => {
  const { engine, profiles } = await fixture(t);
  const { id, approval } = await reachApproval(engine);
  const session = engine.get(id); const received = structuredClone(session.receipts);
  const config = structuredClone(session.config); config.data.brief.topic = 'New topic'; config.extensions.extra = { arbitrary: true };
  await engine.applyConfig({ config, target: 'session', sessionId: id, expectedRevision: session.configRevision });
  assert.equal(session.stage, 'paused');
  assert.deepEqual(session.receipts, received);
  assert.notEqual(profiles.template.data.brief.topic, 'New topic');
  await assert.rejects(engine.decide(approval.id, decision(approval)), { code: 'STALE_APPROVAL' });
  await engine.intervene(session, { action: 'resume' });
  const replacement = engine.approvals(id).find(item => item.status === 'pending');
  assert.equal(replacement.values.topic, 'New topic');
  assert.notEqual(replacement.id, approval.id);
  assert.deepEqual(session.receipts.aliceToBob, received.aliceToBob);
});

test('new-round template can match initial availability directly and keeps session override separate', async t => {
  const { engine, profiles } = await fixture(t);
  const config = structuredClone(profiles.template); config.data.availableTimes = [{ day: 'Tue', time: '10:00–10:30' }]; config.response.offerBrief = false;
  await engine.applyConfig({ config, target: 'template', expectedRevision: profiles.templateRevision });
  const round = await engine.create();
  const { state } = await choose(engine, round.state.session.id, 'initial', 'free');
  assert.equal(state.task.outcome, 'arranged'); assert.equal(state.choices.additional, null);
  assert.deepEqual(state.task.meeting, { day: 'Tue', time: '10:00–10:30' });
});

test('connection restoration never sends; retry keeps operation and revocation preserves received snapshots', async t => {
  const { engine } = await fixture(t);
  const { state: initial } = await engine.create(); const session = engine.get(initial.session.id);
  await engine.intervene(session, { action: 'disconnect_bob' });
  const result = await choose(engine, session.id, 'initial', 'free');
  assert.equal(result.state.waiting.reason, 'peer_offline');
  const operationId = session.pendingDelivery.operationId;
  await engine.intervene(session, { action: 'restore_bob' });
  assert.equal(session.receipts.aliceToBob.length, 0);
  await engine.intervene(session, { action: 'retry' });
  assert.equal(session.receipts.aliceToBob[0].operationId, operationId);
  await engine.action(session, { action: 'stop_sharing', requestId: randomUUID(), expectedVersion: session.version });
  assert.equal(session.task.outcome, 'boundary_kept'); assert.equal(session.receipts.aliceToBob.length, 1);
});

test('Alice revocation before peer receipt cancels pending disclosure even after restoration and retry', async t => {
  const { engine, runtime } = await fixture(t);
  const { state: initial } = await engine.create();
  const session = engine.get(initial.session.id);
  await engine.intervene(session, { action: 'disconnect_bob' });
  await choose(engine, session.id, 'initial', 'full');
  assert(session.pendingDelivery);
  assert.equal(session.receipts.aliceToBob.length, 0);
  await engine.action(session, { action: 'stop_sharing', requestId: randomUUID(), expectedVersion: session.version });
  assert.equal(session.stopped, true);
  assert.equal(session.pendingDelivery, null);
  await engine.intervene(session, { action: 'restore_bob' });
  if (session.paused) await engine.intervene(session, { action: 'retry' });
  else await assert.rejects(engine.intervene(session, { action: 'retry' }), { code: 'NOT_PAUSED' });
  assert.equal(session.receipts.aliceToBob.length, 0);
  assert.equal((await runtime.planBob({ sessionId: session.id, epoch: session.epoch, purpose: 'additional',
    configRevision: session.configRevision })).action.type, 'no_match');
});

test('a narrowed Bob availability grant cannot reveal or complete the unapproved meeting', async t => {
  const { engine, profiles } = await fixture(t);
  const config = structuredClone(profiles.template);
  config.permissions.confirmation = 'per_action';
  config.response.offerBrief = false;
  await engine.applyConfig({ config, target: 'template', expectedRevision: profiles.templateRevision });
  const created = await engine.create();
  const id = created.state.session.id;
  await choose(engine, id, 'initial', 'free');
  await choose(engine, id, 'additional', 'narrow');
  const approval = engine.approvals(id).find(item => item.status === 'pending');
  assert.equal(approval.resource, 'availability');
  const { state } = await engine.decide(approval.id, decision(approval, ['status']));
  assert.deepEqual(state.receipts.bobToAlice[0].values, { status: 'Free' });
  assert.deepEqual(state.receipts.bobToAlice[0].fields, ['status']);
  assert.equal(state.task.outcome, 'boundary_kept');
  assert.equal(state.task.meeting, null);
  assert(!state.messages.some(message => message.text.includes('15:00–15:30')));
});

test('reset clears two contexts, invalidates credentials and defaults new consent off; no-consent writes no files', async t => {
  const { engine, research, directory } = await fixture(t, true);
  const { id, token } = await reachApproval(engine);
  const fresh = await engine.intervene(engine.get(id), { action: 'reset' });
  assert.notEqual(fresh.state.session.id, id); assert.equal(fresh.state.session.researchConsent, false);
  assert.equal(fresh.state.receipts.aliceToBob.length, 0);
  assert.throws(() => engine.authorize(id, token), { code: 'SESSION_GONE' });
  assert.equal(research.list().runs.length, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('v2 research records consented synthetic state and post-task answers; replay is separate', async t => {
  const { engine, research } = await fixture(t);
  const { id, approval } = await reachApproval(engine, true);
  await engine.decide(approval.id, decision(approval)); const session = engine.get(id);
  for (const [action, answer] of [['answer_prediction', 'approved_snapshot'], ['answer_revocation', 'future_only']]) await engine.action(session, { action, answer, requestId: randomUUID(), expectedVersion: session.version });
  await engine.action(session, { action: 'end', requestId: randomUUID(), expectedVersion: session.version });
  const runs = research.list().runs; assert.equal(runs.length, 1); assert.equal(runs[0].status, 'arranged');
  assert.equal(runs[0].events.filter(event => event.kind === 'prediction').length, 2);
  assert.equal(runs[0].consentVersion, 'research-v2');
  assert.equal(JSON.stringify(runs[0].events).includes('Project review'), false);
  assert.equal(runs[0].initialConditions.agents.Alice.data.calendar.some(row => row.title === 'Project review'), true);
  assert.ok(runs[0].trace.length > 10);
  assert.equal(runs[0].trace.at(-1).snapshot.ended, true);
  const replay = await engine.create({ mode: 'replay', researchConsent: true });
  assert.equal(replay.state.session.researchConsent, false); assert.equal(research.list().runs.length, 1);
});

test('remote cleanup uncertainty closes research, blocks replacement, and revokes reset credentials', async t => {
  const { engine, runtime, research } = await fixture(t);
  const created = await engine.create({ researchConsent: true }); const session = engine.get(created.state.session.id);
  const realClear = runtime.clear.bind(runtime); let offline = true;
  runtime.clear = args => offline ? Promise.reject(Object.assign(new Error('Transport offline'), { code: 'PEER_OFFLINE' })) : realClear(args);
  await engine.action(session, { action: 'end', requestId: randomUUID(), expectedVersion: session.version });
  assert.equal(session.ended, true);
  assert.equal(research.list().runs[0].status, 'ended');
  assert.ok(research.list().runs[0].quality.includes('cleanup_uncertain'));
  assert.ok(session.messages.at(-1).text.includes('unconfirmed'));
  await assert.rejects(engine.create(), { code: 'CLEANUP_PENDING' });
  await assert.rejects(engine.intervene(session, { action: 'reset' }), { code: 'CLEANUP_PENDING' });
  assert.throws(() => engine.authorize(session.id, created.token), { code: 'SESSION_GONE' });
  offline = false;
  const fresh = await engine.create(); assert.equal(fresh.state.session.stage, 'initial'); assert.equal(engine.cleanupPending.size, 0);
});

test('round grant preserves narrowed fields and exact values, stops at its use budget, and never alters template', async t => {
  const { engine, profiles } = await fixture(t);
  const { id, approval } = await reachApproval(engine); const session = engine.get(id);
  await engine.decide(approval.id, { ...decision(approval), decision: 'allow_round', maxUses: 2, expiryMinutes: 5 });
  await engine.intervene(session, { action: 'inject_request' });
  assert.equal(session.approvals.filter(item => item.status === 'pending').length, 0);
  assert.deepEqual(session.receipts.bobToAlice.at(-1).fields, ['topic']);
  assert.deepEqual(session.receipts.bobToAlice.at(-1).values, { topic: approval.values.topic });
  await engine.intervene(session, { action: 'inject_request' });
  assert.equal(session.approvals.filter(item => item.status === 'pending').length, 1);
  assert.equal(profiles.template.permissions.resources.includes('meeting_brief'), false);
});

test('expired Bob permission queries receipt without transferring, then requests fresh permission if absent', async t => {
  const { engine, runtime } = await fixture(t);
  const { id, approval } = await reachApproval(engine); const session = engine.get(id);
  await runtime.setBobOnline(false);
  await engine.decide(approval.id, decision(approval));
  assert.equal(session.pendingDelivery.direction, 'alice');
  session.pendingDelivery.expiresAt = Date.now() - 1;
  const send = runtime.deliverToAlice.bind(runtime); let sent = 0;
  runtime.deliverToAlice = args => { sent++; return send(args); };
  await runtime.setBobOnline(true);
  await engine.intervene(session, { action: 'retry' });
  assert.equal(sent, 0); assert.equal(session.stage, 'waiting_admin');
  assert.equal(session.receipts.bobToAlice.length, 1);
  assert.notEqual(engine.approvals(id).find(item => item.status === 'pending').id, approval.id);
});

test('expired Bob permission can recover an already received signed proof without resending', async t => {
  const { engine, runtime } = await fixture(t);
  const { id, approval } = await reachApproval(engine); const session = engine.get(id);
  const send = runtime.deliverToAlice.bind(runtime); let sent = 0;
  runtime.deliverToAlice = async args => { sent++; await send(args); throw Object.assign(new Error('Response lost'), { code: 'PEER_OFFLINE' }); };
  await engine.decide(approval.id, decision(approval));
  assert.equal(session.stage, 'paused'); assert.equal(sent, 1);
  session.pendingDelivery.expiresAt = Date.now() - 1;
  await engine.intervene(session, { action: 'retry' });
  assert.equal(sent, 1); assert.equal(session.task.outcome, 'arranged');
  assert.equal(session.receipts.bobToAlice.length, 2);
});

test('configuration snapshots survive overrides and reload without persisting participant state', async t => {
  const { engine, profiles, directory } = await fixture(t, true);
  const created = await engine.create(); const session = engine.get(created.state.session.id);
  const config = structuredClone(session.config); config.data.brief.topic = 'Versioned condition';
  await engine.applyConfig({ config, target: 'session', sessionId: session.id, expectedRevision: session.configRevision });
  const loaded = await new ProfileStore({ directory }).init();
  assert.equal(loaded.listVersions().at(-1).revision, session.configRevision);
  assert.equal(loaded.listVersions().at(-1).config.data.brief.topic, 'Versioned condition');
  assert.deepEqual(loaded.template, profiles.template);
  assert.equal(JSON.stringify(loaded.listVersions()).includes(session.id), false);
});

test('an expired approval is renewed for fresh review and the old decision never carries over', async t => {
  const { engine } = await fixture(t);
  const { id, approval } = await reachApproval(engine); const session = engine.get(id);
  session.approvals.find(item => item.id === approval.id).expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(engine.decide(approval.id, decision(approval)), { code: 'STALE_APPROVAL' });
  const fresh = engine.approvals(id).find(item => item.status === 'pending');
  assert.notEqual(fresh.id, approval.id); assert.deepEqual(fresh.values, approval.values);
  assert.equal(session.receipts.bobToAlice.length, 1);
  await engine.decide(fresh.id, decision(fresh));
  assert.equal(session.task.outcome, 'arranged');
});
