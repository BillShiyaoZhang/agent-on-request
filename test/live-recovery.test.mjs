import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';
import { DEFAULT_MODEL_CONFIG } from '../src/model-store.mjs';
import { MODEL_OUTPUT_DIAGNOSTICS } from '../src/model-provider.mjs';
import { sanitizeTraceSnapshot } from '../src/agent-observability.mjs';

const RAW = 'RAW_INVALID_MODEL_CONTENT_DO_NOT_SHOW';
const stageKey = context => context.purpose === 'ontology_alignment' ? `alignment_${context.stage}`
  : Object.hasOwn(context, 'ownCalendar') ? 'intro' : context.purpose;
function validProposal(context) {
  if (context.purpose === 'ontology_alignment') return { message: 'These task correspondences are acceptable.', decision: 'accept', selectedMappingIds: context.candidates.map(item => item.id) };
  if (Object.hasOwn(context, 'ownCalendar')) return { message: 'You decide which information may be shared.' };
  if (context.purpose === 'brief') return { message: 'An optional brief is prepared.', action: {
    type: 'share_brief', fields: ['topic'], values: { topic: context.ownBrief.topic }, resource: 'meeting_brief' } };
  const meeting = context.sharedIntersection[0];
  return meeting ? { message: 'A shared time is available.', action: { type: 'meeting', meeting } }
    : { message: 'No shared time is available in this scope.', action: { type: context.purpose === 'initial' ? 'request_more' : 'no_match' } };
}

async function fixture(t, respond = ({ context }) => validProposal(context), { retryLimit = 1, timeoutSeconds = 2 } = {}) {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = JSON.parse(input.messages.find(message => message.role === 'user').content);
    const call = { input, context, key: stageKey(context) };
    calls.push(call);
    const result = await respond(call, calls.filter(item => item.key === call.key).length);
    if (result?.hold) return;
    if (res.destroyed) return;
    if (result?.httpStatus) {
      res.writeHead(result.httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: RAW }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Exercise both documented function arguments and the supported final-JSON transport.
    const message = calls.length % 2 ? { tool_calls: [{ type: 'function', function: {
      name: 'submit_proposal', arguments: typeof result === 'string' ? result : JSON.stringify(result) } }] }
      : { content: typeof result === 'string' ? result : JSON.stringify(result) };
    res.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelBaseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const modelConfig = structuredClone(DEFAULT_MODEL_CONFIG);
  modelConfig.provider = 'openai_compatible'; modelConfig.baseUrl = modelBaseUrl;
  for (const [role, settings] of Object.entries(modelConfig.agents)) Object.assign(settings, {
    model: `recovery-${role}`, temperature: 0.2, retryLimit, timeoutSeconds });
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'live-recovery-test-pin',
    modelBaseUrl, modelName: 'recovery-fixture', modelApiKey: '', modelConfig, environmentApiKey: '' });
  await app.listen();
  t.after(async () => {
    await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, token, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const admin = (await call('/api/admin/login', null, { pin: 'live-recovery-test-pin' })).data.token;
  const ok = async (route, token, body, status = 200) => {
    const result = await call(route, token, body); assert.equal(result.status, status, JSON.stringify(result.data)); return result.data;
  };
  return { app, calls, call, ok, admin,
    async create(options = {}) {
      const created = await ok('/api/sessions', admin, { mode: 'live', researchConsent: true, ...options }, 201);
      const session = app.engine.get(created.state.session.id), route = `/api/sessions/${session.id}`, token = created.token;
      return { session, route, token, state: created.state,
        async act(action, extra = {}) {
          return ok(`${route}/actions`, token, { action, requestId: randomUUID(), expectedVersion: session.version, ...extra });
        },
        async align() { return this.act('alignment_decision', { decision: 'accept', expectedAlignmentVersion: session.ontology.revision }); },
        async share(stage, choice) {
          const preview = await ok(`${route}/preview`, token, { stage, choice });
          return this.act(stage === 'initial' ? 'share_initial' : 'respond_additional', {
            choice, previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion });
        },
        async retry() { return ok(`/api/admin/sessions/${session.id}/intervene`, admin, { action: 'retry' }); },
      };
    },
  };
}

function assertPaused(state, { step, diagnostic, code = 'MODEL_INVALID_OUTPUT', reason = 'model_output' }) {
  assert.equal(state.session.mode, 'live');
  assert.equal(state.session.stage, 'paused');
  assert.equal(state.session.paused, true);
  assert.equal(state.waiting.reason, reason);
  assert.equal(state.waiting.code, code);
  assert.equal(state.waiting.step, step);
  assert.equal(typeof state.waiting.diagnostic, diagnostic ? 'string' : 'undefined');
  if (diagnostic) {
    assert.equal(state.waiting.diagnostic, diagnostic);
    assert.equal(state.waiting.detail, MODEL_OUTPUT_DIAGNOSTICS[diagnostic].message);
  }
  assert.equal(typeof state.waiting.detail, 'string');
  assert.match(state.waiting.detail, /^[\x20-\x7e]+$/);
  assert.equal(JSON.stringify(state).includes(RAW), false);
}
const counts = session => ({ alice: session.receipts.aliceToBob.length, bob: session.receipts.bobToAlice.length,
  aliceUses: session.aliceUses, policyUses: session.policyUses });
async function reviseBobObjective(f, run) {
  const config = structuredClone(run.session.config); config.objective += ' Updated owner objective.';
  return f.ok('/api/admin/config/apply', f.admin, { config, target: 'session', sessionId: run.session.id,
    expectedRevision: run.session.configRevision });
}
async function skipConfirmedOptionalBrief(f, run, staleApproval) {
  const meeting = f.app.engine.confirmedMeeting(run.session); assert(meeting);
  const before = { calls: f.calls.length, receipts: structuredClone(run.session.receipts), counts: counts(run.session),
    grants: structuredClone(run.session.grants), mappingVersion: run.session.ontology.registry.mappingVersion };
  const input = { action: 'skip_optional_brief', requestId: randomUUID(), expectedVersion: run.session.version };
  const { state } = await f.ok(`${run.route}/actions`, run.token, input);
  assert.equal(state.perspective, 'owner'); assert.equal(state.session.mode, 'live');
  assert.equal(state.session.stage, 'complete'); assert.equal(state.session.paused, false);
  assert.equal(state.task.outcome, 'arranged'); assert.equal(state.task.reason, 'optional_brief_skipped');
  assert.deepEqual(state.task.meeting, meeting);
  assert.equal(state.ontology.proposal.source, 'model');
  assert.equal(state.ontology.registry.mappingVersion, before.mappingVersion);
  assert.equal(run.session.pendingDelivery, null); assert.equal(run.session.continuation, null);
  assert.equal(run.session.approvals.filter(item => item.status === 'pending' && item.resource === 'meeting_brief').length, 0);
  assert.equal(f.calls.length, before.calls);
  assert.deepEqual(run.session.receipts, before.receipts); assert.deepEqual(counts(run.session), before.counts);
  assert.deepEqual(run.session.grants, before.grants);
  assert.equal(run.session.receipts.bobToAlice.length, 1);
  assert(!run.session.receipts.bobToAlice.some(receipt => receipt.fields.includes('topic') || receipt.fields.includes('agenda')));
  const duplicate = await f.ok(`${run.route}/actions`, run.token, input);
  assert.deepEqual(duplicate.state, state, 'a lost response can be retried with the same action ID without another transition');
  const lateRetry = await f.call(`/api/admin/sessions/${run.session.id}/intervene`, f.admin, { action: 'retry' });
  assert.equal(lateRetry.status, 409); assert.equal(lateRetry.data.error.code, 'NOT_PAUSED');
  const lateApproval = await f.call(`/api/admin/approvals/${staleApproval.id}/decision`, f.admin, { decision: 'allow_once',
    expectedPolicyRevision: staleApproval.policyRevision, expectedPayloadHash: staleApproval.payloadHash });
  assert.equal(lateApproval.status, 409); assert.equal(lateApproval.data.error.code, 'STALE_APPROVAL');
  assert.equal(f.calls.length, before.calls); assert.deepEqual(run.session.receipts, before.receipts);
  assert.deepEqual(run.session.grants, before.grants);
  const research = f.app.research.list().runs.find(item => item.events.some(event => event.reason === 'optional_brief_skipped'));
  assert(research); assert.equal(research.events.filter(event => event.kind === 'choice' && event.action === 'skip_optional_brief').length, 1);
  assert.equal(JSON.stringify(state).includes(RAW), false);
}

test('Controlled configuration recovery returns to concept review before preview, quota use or calendar transfer', async t => {
  const f = await fixture(t);
  const run = await f.create({ mode: 'controlled', alignmentReview: true });
  await reviseBobObjective(f, run);
  const { state } = await run.retry();
  assert.equal(state.session.mode, 'controlled'); assert.equal(state.session.stage, 'alignment');
  assert.equal(state.ontology.status, 'awaiting_alignment'); assert.equal(run.session.alignmentCandidate, null);
  assert.equal(f.calls.length, 0); assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  const rejected = await f.call(`${run.route}/preview`, run.token, { stage: 'initial', choice: 'free' });
  assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'STALE_STAGE');
  assert.equal((await run.align()).state.session.stage, 'initial');
  assert.equal(run.session.ontology.status, 'accepted');
  await run.share('initial', 'free');
  assert.deepEqual(counts(run.session), { alice: 1, bob: 0, aliceUses: 1, policyUses: 0 });
});

test('configuration recovery discards a failed Live alignment candidate and requires a fresh owner confirmation', async t => {
  let failing = true;
  const f = await fixture(t, ({ context, key }) => key === 'alignment_propose' && failing
    ? { message: RAW, decision: 'accept', selectedMappingIds: 'invalid-array' } : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  assertPaused((await run.align()).state, { step: 'alice_alignment', diagnostic: 'ONTOLOGY_SELECTION' });
  assert(run.session.alignmentCandidate);
  await reviseBobObjective(f, run); failing = false;
  const priorCalls = f.calls.length;
  const { state } = await run.retry();
  assert.equal(state.session.mode, 'live'); assert.equal(state.session.stage, 'alignment');
  assert.equal(state.ontology.status, 'awaiting_alignment'); assert.equal(run.session.alignmentCandidate, null);
  assert.equal(run.session.continuation, null); assert.equal(f.calls.length, priorCalls);
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  assert.equal((await run.align()).state.session.stage, 'initial');
  assert.equal(run.session.ontology.status, 'accepted'); assert.equal(run.session.ontology.proposal.source, 'model');
  await run.share('initial', 'free');
  assert.deepEqual(counts(run.session), { alice: 1, bob: 0, aliceUses: 1, policyUses: 0 });
});

test('a Bob configuration update preserves an unfinished Alice intro before concept review', async t => {
  let failing = true;
  const f = await fixture(t, ({ context, key }) => key === 'intro' && failing ? { message: 123 } : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  assertPaused(run.state, { step: 'alice_intro', diagnostic: 'MISSING_MESSAGE' });
  await reviseBobObjective(f, run); failing = false;
  const { state } = await run.retry();
  assert.equal(state.session.mode, 'live'); assert.equal(state.session.stage, 'alignment');
  assert.equal(f.calls.filter(item => item.key === 'intro').length, 3);
  assert.equal(f.calls.filter(item => item.key.startsWith('alignment_')).length, 0);
  assert.equal(state.ontology.status, 'awaiting_alignment');
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  assert.equal((await run.align()).state.session.stage, 'initial');
  assert.equal(run.session.aliceUses, 0);
});

test('the calendar gate rejects preview and submission before quota use even with an inconsistent initial stage', async t => {
  const f = await fixture(t);
  const run = await f.create({ mode: 'controlled', alignmentReview: true });
  // Simulate a stale or incorrectly restored stage to verify the invariant beneath UI controls.
  run.session.stage = 'initial';
  const preview = await f.call(`${run.route}/preview`, run.token, { stage: 'initial', choice: 'free' });
  assert.equal(preview.status, 409); assert.equal(preview.data.error.code, 'ONTOLOGY_NOT_ALIGNED');
  const submitted = await f.call(`${run.route}/actions`, run.token, { action: 'share_initial', choice: 'free',
    previewHash: '0'.repeat(64), requestId: randomUUID(), expectedVersion: run.session.version });
  assert.equal(submitted.status, 409); assert.equal(submitted.data.error.code, 'ONTOLOGY_NOT_ALIGNED');
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  assert.equal(run.session.pendingDelivery, null); assert.equal(run.session.choices.initial, null);
  assert.equal(run.session.paused, false); assert.equal(run.session.waiting, null);
  run.session.stage = 'alignment';
  assert.equal((await run.align()).state.session.stage, 'initial');
});

test('reviewed Live alignment corrects each role before signing and never starts calendar disclosure', async t => {
  const f = await fixture(t, ({ context, key }, count) => key.startsWith('alignment_') && count === 1
    ? { message: RAW, decision: 'accept', selectedMappingIds: 'not-an-array' } : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  assert.equal(run.state.session.stage, 'alignment');
  assert.equal(f.calls.filter(call => call.key.startsWith('alignment_')).length, 0);
  const { state } = await run.align();
  assert.equal(state.session.stage, 'initial');
  assert.equal(state.ontology.status, 'accepted');
  assert.equal(state.ontology.proposal.source, 'model');
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  const evidence = run.session.ontology.protocol;
  assert.equal(evidence.length, 6);
  assert(evidence.every(item => item.verified));
  for (const key of ['alignment_propose', 'alignment_decide']) {
    const attempts = f.calls.filter(call => call.key === key);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].context.proposalCorrection.attempt, 2);
    assert.equal(attempts[1].context.proposalCorrection.maxAttempts, 2);
    assert.equal(JSON.stringify(attempts[1].input).includes(RAW), false);
  }
  assert.equal(JSON.stringify(state).includes(RAW), false);
});

for (const [role, key] of [['alice', 'alignment_propose'], ['bob', 'alignment_decide']]) {
  test(`exhausted ${role} alignment exposes safe diagnostics and explicit retry resumes the same Live round`, async t => {
    let failing = true;
    const f = await fixture(t, ({ context, key: current }) => current === key && failing
      ? { message: RAW, decision: 'accept', selectedMappingIds: context.candidates.slice(1).map(item => item.id) } : validProposal(context));
    const run = await f.create({ alignmentReview: true });
    const { state } = await run.align();
    assertPaused(state, { step: `${role}_alignment`, diagnostic: 'INCOMPLETE_MAPPING' });
    assert.equal(state.waiting.recovery, 'retry_planning');
    assert.equal(f.calls.filter(call => call.key === key).length, 2);
    assert.equal(run.session.ontology.registry.mappings.length, 0);
    assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
    const trace = f.app.research.list().runs.find(item => item.sessionId === run.session.id)
      ?? f.app.research.list().runs[0];
    const paused = trace.trace.find(item => item.snapshot.waiting?.diagnostic === 'INCOMPLETE_MAPPING').snapshot;
    assert.equal(paused.waiting.step, `${role}_alignment`);
    assert.deepEqual(sanitizeTraceSnapshot(paused), paused);
    const corrupt = structuredClone(paused); corrupt.waiting.diagnostic = RAW; corrupt.waiting.step = RAW;
    const reloaded = sanitizeTraceSnapshot(corrupt);
    assert.equal(reloaded.waiting.diagnostic, undefined); assert.equal(reloaded.waiting.step, undefined);
    assert.equal(JSON.stringify(trace).includes(RAW), false);
    assert(trace.events.some(event => event.kind === 'technical' && event.diagnostic === 'INCOMPLETE_MAPPING' && event.step === `${role}_alignment`));
    failing = false;
    const resumed = (await run.retry()).state;
    assert.equal(resumed.session.id, state.session.id); assert.equal(resumed.session.epoch, state.session.epoch);
    assert.equal(resumed.session.mode, 'live'); assert.equal(resumed.session.stage, 'initial');
    assert.equal(resumed.waiting, null); assert.equal(resumed.ontology.status, 'accepted');
    assert.equal(run.session.ontology.protocol.length, 6);
    assert.equal(f.calls.filter(call => call.key === key).length, 3);
    assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
    const before = f.calls.length;
    const extraRetry = await f.call(`/api/admin/sessions/${run.session.id}/intervene`, f.admin, { action: 'retry' });
    assert.equal(extraRetry.status, 409); assert.equal(extraRetry.data.error.code, 'NOT_PAUSED');
    assert.equal(f.calls.length, before);
  });
}

test('a genuine semantic refusal completes the boundary without retrying into acceptance', async t => {
  const f = await fixture(t, ({ context, key }) => key === 'alignment_propose'
    ? { message: 'I decline these supplied correspondences.', decision: 'none', selectedMappingIds: context.candidates.map(item => item.id) }
    : validProposal(context), { retryLimit: 3 });
  const run = await f.create({ alignmentReview: true });
  const { state } = await run.align();
  assert.equal(state.session.stage, 'complete'); assert.equal(state.session.paused, false);
  assert.equal(state.task.reason, 'alignment_rejected'); assert.equal(state.ontology.status, 'rejected');
  assert.equal(f.calls.filter(call => call.key === 'alignment_propose').length, 1);
  assert.equal(f.calls.filter(call => call.key === 'alignment_decide').length, 0);
  assert.equal(run.session.ontology.registry.mappings.length, 0);
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
});

test('a blank malformed Bob brief-alignment refusal remains terminal and retains only the confirmed meeting', async t => {
  const f = await fixture(t, ({ context, key }) => key === 'alignment_decide' && context.task.type === 'brief'
    ? { decision: 'none', message: '', selectedMappingIds: [], reasoning_content: RAW }
    : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  await run.align(); await run.share('initial', 'free'); await run.share('additional', 'narrow');
  const approval = run.session.approvals.find(item => item.status === 'pending' && item.resource === 'meeting_brief');
  assert(approval);
  const { state } = await f.ok(`/api/admin/approvals/${approval.id}/decision`, f.admin, { decision: 'allow_once',
    fields: ['topic'], expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assert.equal(state.session.mode, 'live'); assert.equal(state.session.stage, 'complete'); assert.equal(state.session.paused, false);
  assert.equal(state.task.outcome, 'arranged'); assert.equal(state.briefOntology.status, 'rejected');
  const briefCalls = f.calls.filter(item => item.context.purpose === 'ontology_alignment' && item.context.task.type === 'brief');
  assert.deepEqual(briefCalls.map(item => item.context.stage), ['propose', 'decide']);
  assert.equal(briefCalls[1].context.proposalCorrection, undefined);
  assert.equal(run.session.receipts.bobToAlice.length, 1);
  assert.deepEqual(run.session.receipts.bobToAlice[0].fields, ['day', 'time', 'status']);
  assert.equal(run.session.briefOntology.protocol[3].payload.reasonCode, 'MODEL_CHOSE_NONE');
  assert.equal(JSON.stringify(state).includes(RAW), false);
});

test('invalid Alice introduction pauses before any disclosure and resumes only its original step', async t => {
  let failing = true;
  const f = await fixture(t, ({ context, key }) => key === 'intro' && failing ? { message: RAW, action: { type: 'request_more' } } : validProposal(context));
  const run = await f.create();
  assertPaused(run.state, { step: 'alice_intro', diagnostic: 'INVALID_ALICE_REPLY' });
  assert.equal(f.calls.length, 2); assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
  const mappingVersion = run.session.ontology.registry.mappingVersion;
  failing = false;
  const { state } = await run.retry();
  assert.equal(state.session.stage, 'initial'); assert.equal(state.session.mode, 'live');
  assert.equal(state.ontology.registry.mappingVersion, mappingVersion); assert.equal(f.calls.length, 3);
  assert.deepEqual(counts(run.session), { alice: 0, bob: 0, aliceUses: 0, policyUses: 0 });
});

for (const purpose of ['initial', 'additional', 'brief']) {
  test(`Bob ${purpose} recovery preserves received snapshots and consumed sharing grants`, async t => {
    let failing = true;
    const f = await fixture(t, ({ context, key }) => key === purpose && failing
      ? purpose === 'brief' ? { message: RAW, action: { type: 'share_brief', fields: ['topic'], values: { topic: RAW }, resource: 'meeting_brief' } }
        : { message: RAW, action: { type: 'meeting' } } : validProposal(context));
    const run = await f.create(purpose === 'brief' ? { initialConditions: { presetId: 'conference', custom: { Bob: { authorization: { confirmation: 'per_action' } } } } } : {});
    let result = await run.share('initial', 'free');
    if (purpose !== 'initial') result = await run.share('additional', 'narrow');
    if (purpose === 'brief') {
      const approval = run.session.approvals.find(item => item.status === 'pending' && item.resource === 'availability');
      assert(approval);
      result = await f.ok(`/api/admin/approvals/${approval.id}/decision`, f.admin, { decision: 'allow_round', maxUses: 2,
        expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
      assert.equal(run.session.grants.length, 1); assert.equal(run.session.grants[0].uses, 1); assert.equal(run.session.grants[0].remaining, 1);
    }
    assertPaused(result.state, { step: `bob_${purpose}`, diagnostic: purpose === 'brief' ? 'BRIEF_SOURCE_MISMATCH' : 'INVALID_MEETING_SHAPE',
      code: purpose === 'brief' ? 'MODEL_INVALID_OUTPUT' : 'MODEL_INVALID_MEETING' });
    const before = counts(run.session), aliceSnapshots = structuredClone(run.session.receipts.aliceToBob);
    const bobSnapshots = structuredClone(run.session.receipts.bobToAlice), grants = structuredClone(run.session.grants);
    assert.equal(before.alice, purpose === 'initial' ? 1 : 2); assert.equal(before.bob, purpose === 'brief' ? 1 : 0);
    assert.equal(f.calls.filter(call => call.key === purpose).length, 2);
    failing = false;
    const { state } = await run.retry();
    assert.equal(state.session.mode, 'live'); assert.equal(state.session.paused, false);
    assert.equal(state.session.stage, purpose === 'initial' ? 'additional' : 'waiting_admin');
    assert.equal(f.calls.filter(call => call.key === purpose).length, 3);
    assert.deepEqual(run.session.receipts.aliceToBob, aliceSnapshots);
    assert.deepEqual(run.session.receipts.bobToAlice.slice(0, bobSnapshots.length), bobSnapshots);
    assert.deepEqual(run.session.grants, grants);
    assert.equal(run.session.aliceUses, before.aliceUses);
    assert.equal(run.session.receipts.bobToAlice.length, purpose === 'initial' ? 0 : 1);
    assert.equal(new Set(run.session.receipts.bobToAlice.map(item => item.operationId)).size, run.session.receipts.bobToAlice.length);
    assert.equal(JSON.stringify(state).includes(RAW), false);
  });
}

test('the participant can skip failed Bob brief planning while retaining the exact confirmed meeting and grant counts', async t => {
  const f = await fixture(t, ({ context, key }) => key === 'brief' ? { message: RAW, action: { type: 'share_brief',
    fields: ['topic'], values: { topic: RAW }, resource: 'meeting_brief' } } : validProposal(context));
  const run = await f.create({ alignmentReview: true,
    initialConditions: { presetId: 'conference', custom: { Bob: { authorization: { confirmation: 'per_action' } } } } });
  await run.align(); await run.share('initial', 'free'); await run.share('additional', 'narrow');
  const approval = run.session.approvals.find(item => item.status === 'pending' && item.resource === 'availability'); assert(approval);
  const { state } = await f.ok(`/api/admin/approvals/${approval.id}/decision`, f.admin, { decision: 'allow_round', maxUses: 2,
    expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assertPaused(state, { step: 'bob_brief', diagnostic: 'BRIEF_SOURCE_MISMATCH' });
  assert.equal(run.session.pendingDelivery, null);
  assert.equal(run.session.grants[0].uses, 1); assert.equal(run.session.grants[0].remaining, 1);
  await skipConfirmedOptionalBrief(f, run, approval);
});

test('the participant can skip failed approved brief alignment without sending brief data or retrying the models', async t => {
  const f = await fixture(t, ({ context, key }) => key === 'alignment_decide' && context.task.type === 'brief'
    ? { message: RAW, decision: 'accept', selectedMappingIds: 'invalid-array' } : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  await run.align(); await run.share('initial', 'free'); await run.share('additional', 'narrow');
  const approval = run.session.approvals.find(item => item.status === 'pending' && item.resource === 'meeting_brief'); assert(approval);
  const { state } = await f.ok(`/api/admin/approvals/${approval.id}/decision`, f.admin, { decision: 'allow_round', fields: ['topic'], maxUses: 2,
    expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assertPaused(state, { step: 'brief_alignment', diagnostic: 'ONTOLOGY_SELECTION' });
  assert.equal(run.session.pendingDelivery.direction, 'alice'); assert.equal(run.session.pendingDelivery.resource, 'meeting_brief');
  assert.equal(run.session.grants[0].uses, 1); assert.equal(run.session.grants[0].remaining, 1);
  await skipConfirmedOptionalBrief(f, run, approval);
});

test('skip optional brief cannot create a meeting from an initial pause, an unconfirmed receipt, a stopped boundary or Replay', async t => {
  const f = await fixture(t, ({ context, key }) => key === 'initial' ? { message: RAW, action: { type: 'meeting' } } : validProposal(context));
  const run = await f.create({ alignmentReview: true });
  await run.align(); await run.share('initial', 'free');
  assert.equal(run.session.waiting.step, 'bob_initial'); assert.equal(f.app.engine.confirmedMeeting(run.session), null);
  const before = { calls: f.calls.length, counts: counts(run.session), grants: structuredClone(run.session.grants) };
  const reject = async () => {
    const result = await f.call(`${run.route}/actions`, run.token, { action: 'skip_optional_brief', requestId: randomUUID(), expectedVersion: run.session.version });
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPTIONAL_BRIEF_STAGE');
    assert.equal(f.calls.length, before.calls); assert.deepEqual(counts(run.session), before.counts); assert.deepEqual(run.session.grants, before.grants);
  };
  await reject();
  // A stale UI step and prepared proposal alone cannot manufacture a received meeting.
  run.session.waiting.step = 'bob_brief'; run.session.preparedMeeting = { day: 'Thu', time: '15:00–15:30' };
  await reject(); assert.equal(run.session.task.meeting, null);
  await run.act('stop_sharing'); assert.equal(run.session.task.outcome, 'boundary_kept');
  await reject();
  const replay = await f.create({ mode: 'replay' });
  const blockedReplay = await f.call(`${replay.route}/actions`, replay.token, { action: 'skip_optional_brief', requestId: randomUUID(), expectedVersion: replay.session.version });
  assert.equal(blockedReplay.status, 409); assert.equal(blockedReplay.data.error.code, 'OPTIONAL_BRIEF_STAGE');
  assert.equal(replay.session.task.outcome, null); assert.equal(f.calls.length, before.calls);
});

for (const failure of ['connection', 'timeout']) {
  test(`provider ${failure} is classified separately from invalid output and remains explicitly retryable`, async t => {
    let failing = true;
    const f = await fixture(t, ({ context, key }) => key === 'intro' && failing
      ? failure === 'connection' ? { httpStatus: 503 } : { hold: true } : validProposal(context), { retryLimit: 0, timeoutSeconds: 1 });
    const run = await f.create();
    assertPaused(run.state, { step: 'alice_intro', reason: failure === 'connection' ? 'model_connection' : 'model_timeout',
      code: failure === 'connection' ? 'MODEL_PROVIDER_ERROR' : 'MODEL_TIMEOUT' });
    assert.equal(f.calls.length, 1); assert.equal(run.state.waiting.recovery, 'retry_planning');
    failing = false;
    assert.equal((await run.retry()).state.session.stage, 'initial');
    assert.equal(f.calls.length, 2);
  });
}

test('an unavailable provider rejects Live creation before a round exists and preserves explicit Controlled choice', async t => {
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'unavailable-recovery-pin',
    minimaxApiKey: '', environmentApiKey: '' });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body, token) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.live.available, false);
  const unavailable = await post('/api/sessions', { mode: 'live' });
  assert.equal(unavailable.status, 409); assert.equal(unavailable.data.error.code, 'LIVE_UNAVAILABLE');
  assert.equal(app.engine.sessions.size, 0, 'availability failure does not manufacture a Controlled fallback session');
  const login = await post('/api/admin/login', { pin: 'unavailable-recovery-pin' });
  const probe = await post('/api/admin/models/test', { role: 'Alice' }, login.data.token);
  assert.equal(probe.status, 503); assert.equal(probe.data.error.code, 'MODEL_UNAVAILABLE');
  const chosen = await post('/api/sessions', { mode: 'controlled' });
  assert.equal(chosen.status, 201); assert.equal(chosen.data.state.session.mode, 'controlled');
  assert.deepEqual(chosen.data.state.receipts, { aliceToBob: [], bobToAlice: [] });
});

test('stopping a paused round blocks model recovery and researcher reset rotates owner credentials', async t => {
  let failing = true;
  const f = await fixture(t, ({ context, key }) => key === 'intro' && failing ? { message: 123 } : validProposal(context), { retryLimit: 0 });
  const run = await f.create();
  assertPaused(run.state, { step: 'alice_intro', diagnostic: 'MISSING_MESSAGE' });
  await run.act('stop_sharing');
  const before = f.calls.length;
  const blocked = await f.call(`/api/admin/sessions/${run.session.id}/intervene`, f.admin, { action: 'retry' });
  assert.equal(blocked.status, 409); assert(['NOT_PAUSED', 'SHARING_STOPPED'].includes(blocked.data.error.code));
  assert.equal(f.calls.length, before);
  failing = false;
  const reset = await f.ok(`/api/admin/sessions/${run.session.id}/intervene`, f.admin, { action: 'reset' });
  assert.notEqual(reset.state.session.id, run.session.id); assert.notEqual(reset.token, run.token);
  assert.equal(reset.state.perspective, 'owner'); assert.equal(reset.state.agentStates.Bob, null);
  assert.equal(reset.state.session.mode, 'live'); assert.equal(reset.state.session.researchConsent, false);
  assert.deepEqual(reset.state.receipts, { aliceToBob: [], bobToAlice: [] });
  assert.equal((await f.call(run.route, run.token)).status, 404);
  const newRoute = `/api/sessions/${reset.state.session.id}`;
  assert.equal((await f.call(newRoute, run.token)).status, 401);
  assert.equal((await f.call(newRoute, reset.token)).status, 200);
});
