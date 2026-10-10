import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRuntimeManager, hashPayload } from '../src/runtime-manager.mjs';
import { createAgentRuntime } from '../src/agent-worker.mjs';
import { DEFAULT_BOB_CONFIG } from '../src/config.mjs';
import { startOntologyDialogue, resolveOntologyDialogue } from '../src/ontology-dialogue.mjs';

const calendar = [{ day: 'Tue', time: '10:00–11:00', status: 'Free', title: 'Alice private title', note: 'Alice private note' }];
const settings = retryLimit => ({ model: 'fixture-model', temperature: 0.2, maxTokens: 2048, timeoutSeconds: 2, retryLimit, thinking: 'disabled' });
const acceptedSelection = context => ({ message: 'Only registered task correspondences are proposed.', decision: 'accept', selectedMappingIds: context.candidates.map(item => item.id) });

async function provider(t, respond) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const context = JSON.parse(body.messages.find(item => item.role === 'user').content);
    const call = { body, context };
    calls.push(call);
    const result = await respond(call, calls.length);
    if (result?.status) {
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Fixture transport failure.' }));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function setup(t, respond, { retryLimit = 1, review = true } = {}) {
  const fixture = await provider(t, respond);
  const manager = createRuntimeManager();
  t.after(() => manager.close());
  await manager.configureModels({ revision: 1, apiKey: 'FIXTURE_ONLY', config: { provider: 'openai_compatible', baseUrl: fixture.baseUrl,
    agents: { Alice: settings(retryLimit), Bob: settings(retryLimit) } } });
  const ref = { sessionId: t.name, epoch: 1 };
  const config = structuredClone(DEFAULT_BOB_CONFIG);
  config.data.availableTimes = [{ day: 'Tue', time: '10:15–10:45' }];
  const pending = startOntologyDialogue();
  await manager.initialize({ ...ref, mode: 'live', configRevision: 1, aliceData: calendar, bobConfig: config,
    ontologyDialogue: review ? pending : resolveOntologyDialogue(pending, { decision: 'accept' }), alignReview: review });
  return { ...fixture, manager, ref, config, pending };
}

async function receiveFree(manager, ref) {
  const projection = await manager.projectAlice({ ...ref, stage: 'initial', choice: 'free' });
  await manager.deliverToBob({ ...ref, ...projection, operationId: 'approved-calendar', payloadHash: hashPayload(projection) });
}

test('both Live alignment roles correct malformed selections within their own shared retry budget before signing', async t => {
  const perStage = new Map();
  const { manager, ref, pending, calls } = await setup(t, ({ context }) => {
    const count = (perStage.get(context.stage) || 0) + 1;
    perStage.set(context.stage, count);
    return count === 1 ? { message: 'RAW_INVALID_REPLY_MARKER', decision: 'accept', selectedMappingIds: ['unregistered-map'] }
      : acceptedSelection(context);
  });
  const result = await manager.negotiateOntology({ ...ref, dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true });
  assert.equal(result.dialogue.status, 'accepted');
  assert.equal(result.protocol.length, 6);
  assert.equal(calls.length, 4);
  for (const stage of ['propose', 'decide']) {
    const attempts = calls.filter(call => call.context.stage === stage);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].context.proposalCorrection, undefined);
    assert.deepEqual(attempts[1].context.proposalCorrection.attempt, 2);
    assert.equal(attempts[1].context.proposalCorrection.maxAttempts, 2);
    assert.equal(attempts[1].context.proposalCorrection.code, 'MODEL_INVALID_OUTPUT');
    assert.ok(!JSON.stringify(attempts[1].body).includes('RAW_INVALID_REPLY_MARKER'));
    assert.ok(!JSON.stringify(attempts[1].body).includes('unregistered-map'));
  }
  assert.ok(result.protocol.every(item => item.verified));
  assert.equal((await manager.ontologyStatus(ref)).Bob.dialogues.schedule.registry.facts.length, 0);
});

test('zero configured retries preserves one attempt and exposes the failed alignment role without Guided fallback', async t => {
  const { manager, ref, pending, calls } = await setup(t, () => ({ message: 'Bad ontology result.', action: { type: 'meeting' } }), { retryLimit: 0 });
  await assert.rejects(manager.negotiateOntology({ ...ref, dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true }),
    error => error.code === 'MODEL_INVALID_OUTPUT' && error.planningStep === 'alice_alignment');
  assert.equal(calls.length, 1);
  const status = await manager.ontologyStatus(ref);
  assert.deepEqual(status.Alice.dialogues, {});
  assert.deepEqual(status.Bob.dialogues, {});
});

test('an incomplete accept is corrected as invalid output rather than presented as a semantic refusal', async t => {
  const { manager, ref, pending, calls } = await setup(t, ({ context }, count) => count === 1
    ? { message: 'I accept, but accidentally omitted one required mapping.', decision: 'accept', selectedMappingIds: context.candidates.slice(1).map(item => item.id) }
    : acceptedSelection(context));
  const result = await manager.negotiateOntology({ ...ref, dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true });
  assert.equal(result.dialogue.status, 'accepted');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].context.proposalCorrection.code, 'MODEL_INVALID_OUTPUT');
  assert.equal(result.protocol[2].payload.selectedMappingIds.length, 6);
  assert.equal(result.protocol[2].payload.reasonCode, 'MODEL_ACCEPTED_REGISTERED_MAPPING');
});

test('transport failures and invalid proposal JSON use a single total retry budget', async t => {
  const { manager, ref, pending, calls } = await setup(t, (_call, count) => count === 1 ? { status: 503 }
    : count === 2 ? 'THIS_IS_NOT_JSON' : { message: 'Would otherwise succeed.', decision: 'none', selectedMappingIds: [] }, { retryLimit: 1 });
  await assert.rejects(manager.negotiateOntology({ ...ref, dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true }),
    error => error.code === 'MODEL_INVALID_OUTPUT' && error.planningStep === 'alice_alignment');
  assert.equal(calls.length, 2);
  assert.deepEqual((await manager.ontologyStatus(ref)).Bob.dialogues, {});
});

test('an explicit none remains a rejection even with repeated known candidates and is never retried into acceptance', async t => {
  const { manager, ref, pending, calls } = await setup(t, ({ context }) => ({ message: 'I decline the offered mapping.', decision: 'none', selectedMappingIds: context.candidates.map(item => item.id) }), { retryLimit: 2 });
  const result = await manager.negotiateOntology({ ...ref, dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true });
  assert.equal(result.dialogue.status, 'rejected');
  assert.equal(calls.length, 1);
  assert.equal(result.protocol[2].payload.reasonCode, 'MODEL_CHOSE_NONE');
  assert.deepEqual(result.protocol[2].payload.selectedMappingIds, []);
  assert.equal(result.dialogue.registry.mappings.length, 0);
});

for (const stage of ['propose', 'decide']) {
  for (const decision of ['none', 'reject']) {
    test(`${stage} ${decision} terminates without correction even when the refusal violates the positive proposal schema`, async t => {
      const validMessage = 'I decline this task mapping until its meaning can be established.';
      const variants = [
        { name: 'blank message and missing identifiers', output: () => ({ decision, message: ' \t ' }) },
        { name: 'oversize message and non-array identifiers', output: () => ({ decision, message: 'x'.repeat(4001), selectedMappingIds: 123 }) },
        { name: 'missing message and invented identifiers', output: () => ({ decision, selectedMappingIds: ['RAW_REFUSAL_ID_MARKER'] }) },
        { name: 'unsupported grant fields', validMessage, output: context => ({ decision, message: validMessage,
          selectedMappingIds: context.candidates.map(item => item.id),
          authorization: { fields: ['title', 'note'], extra: 'RAW_REFUSAL_EXTRA_MARKER' } }) },
        { name: 'malformed identifier object', validMessage, output: () => ({ decision, message: validMessage,
          selectedMappingIds: { unauthorized: 'RAW_REFUSAL_ID_MARKER' } }) },
      ];
      for (const variant of variants) await t.test(variant.name, async inner => {
        let selectedStageCalls = 0;
        const { manager, ref, pending, calls } = await setup(inner, ({ context }) => context.stage === stage && ++selectedStageCalls === 1
          ? variant.output(context) : acceptedSelection(context), { retryLimit: 2 });
        const result = await manager.negotiateOntology({ ...ref,
          dialogue: resolveOntologyDialogue(pending, { decision: 'accept' }), liveProposal: true });
        assert.equal(result.dialogue.status, 'rejected');
        assert.equal(selectedStageCalls, 1);
        assert.equal(calls.length, stage === 'propose' ? 1 : 2);
        assert.ok(calls.every(call => call.context.proposalCorrection === undefined));
        const selection = result.protocol[stage === 'propose' ? 2 : 3].payload;
        assert.equal(selection.decision, 'rejected');
        assert.deepEqual(selection.selectedMappingIds, []);
        assert.equal(selection.reasonCode, decision === 'none' ? 'MODEL_CHOSE_NONE' : 'MODEL_REJECTED_OR_INCOMPLETE_MAPPING');
        assert.ok(typeof selection.message === 'string' && selection.message.trim() && selection.message.length <= 4000);
        if (variant.validMessage) assert.equal(selection.message, variant.validMessage);
        assert.ok(!JSON.stringify(result.protocol).includes('RAW_REFUSAL_EXTRA_MARKER'));
        assert.ok(!JSON.stringify(result.protocol).includes('RAW_REFUSAL_ID_MARKER'));
        assert.ok(!Object.hasOwn(selection, 'authorization'));
        assert.equal(result.dialogue.registry.mappings.length, 0);
        await assert.rejects(receiveFree(manager, ref), { code: 'ONTOLOGY_NOT_ALIGNED' });
        const status = await manager.ontologyStatus(ref);
        for (const role of ['Alice', 'Bob']) {
          assert.equal(status[role].dialogues.schedule.registry.mappings.length, 0);
          assert.equal(status[role].dialogues.schedule.registry.facts.length, 0);
          assert.equal(status[role].dialogues.schedule.registry.receipts.length, 0);
        }
      });
    });
  }
}

test('Worker refusal normalization does not depend on the parent provider parser', async t => {
  for (const stage of ['propose', 'decide']) await t.test(stage, async inner => {
    const calls = [];
    const modelCall = async ({ context }) => {
      calls.push(context);
      // This bypasses provider parsing and would accept if a correction were requested.
      return context.stage === stage && !context.proposalCorrection
        ? { decision: 'none', message: '', selectedMappingIds: { unsafe: 'RAW_DIRECT_REFUSAL_ID' }, grant: ['title', 'note'] }
        : acceptedSelection(context);
    };
    const alice = createAgentRuntime({ role: 'Alice', model: { available: true }, modelCall });
    const bob = createAgentRuntime({ role: 'Bob', model: { available: true }, modelCall });
    inner.after(() => { alice.close(); bob.close(); });
    const ref = { sessionId: inner.name, epoch: 1 };
    const pending = startOntologyDialogue();
    const ontologyContext = { scenario: pending.scenario, task: pending.task };
    const aliceIdentity = await alice.call('status'), bobIdentity = await bob.call('status');
    await alice.call('initialize', { ...ref, mode: 'live', modelAvailable: true, modelSettings: settings(2),
      aliceData: calendar, peerPublicKey: bobIdentity.publicKey, configRevision: 1, ontologyContext });
    await bob.call('initialize', { ...ref, mode: 'live', modelAvailable: true, modelSettings: settings(2),
      bobConfig: DEFAULT_BOB_CONFIG, peerPublicKey: aliceIdentity.publicKey, configRevision: 1, ontologyContext });
    const round = { ...ref, roundId: hashPayload(`direct-refusal-${stage}`), roundRevision: 1, ontologyContext };
    let sequence = 0, previousHash = null;
    async function exchange(sender, recipient, method, extra = {}) {
      const result = await sender.call(method, { ...round, sequence: ++sequence, previousHash, ...extra });
      await recipient.call('receiveOntology', { ...round, envelope: result.envelope });
      previousHash = hashPayload(result.envelope.body);
      return result;
    }
    await exchange(alice, bob, 'ontologyModule', { authorized: true });
    await exchange(bob, alice, 'ontologyModule', { authorized: true });
    const proposal = await exchange(alice, bob, 'proposeOntology', { liveProposal: true,
      interpretation: resolveOntologyDialogue(pending, { decision: 'accept' }).interpretation });
    const decision = await exchange(bob, alice, 'decideOntology', { liveProposal: true });
    const selection = stage === 'propose' ? proposal.selection : decision.selection;
    assert.equal(selection.decision, 'rejected');
    assert.deepEqual(selection.selectedMappingIds, []);
    assert.equal(selection.message, 'The model declined the proposed task-scoped mapping.');
    assert.equal(decision.selection.decision, 'rejected');
    assert.equal(calls.length, stage === 'propose' ? 1 : 2);
    assert.ok(calls.every(context => context.proposalCorrection === undefined));
    assert.ok(!JSON.stringify(selection).includes('RAW_DIRECT_REFUSAL_ID'));
    assert.ok(!Object.hasOwn(selection, 'grant'));
  });
});

test('an invented meeting is corrected from received facts before any outgoing meeting is prepared', async t => {
  const { manager, ref, calls } = await setup(t, ({ context }, count) => count === 1
    ? { message: 'RAW_INVENTED_MEETING', action: { type: 'meeting', meeting: { day: 'Fri', time: '08:00–08:30' } } }
    : { message: 'A valid shared interval is available.', action: { type: 'meeting', meeting: context.sharedIntersection[0] } }, { review: false });
  await receiveFree(manager, ref);
  const planned = await manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 });
  assert.deepEqual(planned.action.meeting, { day: 'Tue', time: '10:15–10:45' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].context.proposalCorrection.code, 'MODEL_INVALID_MEETING');
  assert.ok(!JSON.stringify(calls[1].body).includes('RAW_INVENTED_MEETING'));
  const status = await manager.ontologyStatus(ref);
  assert.equal(status.Bob.dialogues.schedule.registry.facts.length, 1);
  assert.equal(status.Alice.dialogues.schedule.registry.facts.length, 0);
});

test('invented brief values are rejected then corrected without granting extra fields or delivering them', async t => {
  const { manager, ref, calls, config } = await setup(t, ({ context }, count) => ({ message: 'Optional brief proposal.', action: {
    type: 'share_brief', resource: 'meeting_brief', fields: ['topic'], values: { topic: count === 1 ? 'RAW_INVENTED_BRIEF_VALUE' : context.ownBrief.topic },
  } }), { review: false });
  const planned = await manager.planBob({ ...ref, purpose: 'brief', configRevision: 1 });
  assert.deepEqual(planned.action.values, { topic: config.data.brief.topic });
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(calls[1].body).includes('RAW_INVENTED_BRIEF_VALUE'));
  assert.equal((await manager.ontologyStatus(ref)).Alice.dialogues.schedule.registry.facts.length, 0);
});

test('exhausted semantic retries retain an explicit error and do not make invented data received knowledge', async t => {
  const { manager, ref, calls } = await setup(t, () => ({ message: 'Invalid meeting.', action: { type: 'meeting', meeting: { day: 'Fri', time: '08:00–08:30' } } }), { retryLimit: 2, review: false });
  await receiveFree(manager, ref);
  await assert.rejects(manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 }),
    error => error.code === 'MODEL_INVALID_MEETING' && error.planningStep === 'bob_initial');
  assert.equal(calls.length, 3);
  const status = await manager.ontologyStatus(ref);
  assert.equal(status.Bob.dialogues.schedule.registry.facts.length, 1);
  assert.equal(status.Alice.dialogues.schedule.registry.facts.length, 0);
});

test('unsupported grant fields cannot be smuggled through an otherwise valid meeting proposal', async t => {
  const { manager, ref, calls } = await setup(t, ({ context }, count) => ({ message: 'Meeting proposal.', action: {
    type: 'meeting', meeting: context.sharedIntersection[0], ...(count === 1 ? { authorization: { fields: ['title', 'note'] } } : {}),
  } }), { review: false });
  await receiveFree(manager, ref);
  const planned = await manager.planBob({ ...ref, purpose: 'initial', configRevision: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(planned.action).sort(), ['meeting', 'type']);
  assert.ok(!Object.hasOwn(planned, 'authorization'));
});

test('Alice message validation is inside the retry loop and keeps the role budget independent', async t => {
  const { manager, ref, calls } = await setup(t, (_call, count) => count === 1 ? { message: 123 }
    : { message: 'You still choose what may be shared.' }, { review: false });
  const response = await manager.planAlice({ ...ref, purpose: 'intro' });
  assert.equal(response.message, 'You still choose what may be shared.');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].context.proposalCorrection.code, 'MODEL_INVALID_OUTPUT');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cancelling a corrected attempt prevents late completion and further retries', async t => {
  const held = deferred(), entered = deferred();
  let calls = 0;
  const alice = createAgentRuntime({ role: 'Alice', model: { available: true }, modelCall: async () => {
    if (++calls === 1) return { message: 123 };
    entered.resolve();
    await held.promise;
    return { message: 'A late valid message.' };
  } });
  t.after(() => { held.resolve(); alice.close(); });
  const ref = { sessionId: t.name, epoch: 1 };
  const identity = await alice.call('status');
  await alice.call('initialize', { ...ref, mode: 'live', modelAvailable: true, modelSettings: settings(2), aliceData: calendar,
    peerPublicKey: identity.publicKey, configRevision: 1 });
  const planning = assert.rejects(alice.call('planAlice', { ...ref, purpose: 'intro' }), { code: 'PLANNING_CANCELLED' });
  await entered.promise;
  await alice.call('cancelPlanning', ref);
  held.resolve();
  await planning;
  assert.equal(calls, 2);
});
