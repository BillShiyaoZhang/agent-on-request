import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';
import { DEFAULT_MODEL_CONFIG } from '../src/model-store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function promptDeadline(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('An interrupt waited for the held model instead of cancelling it.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const calls = [];
  const holds = [];
  const queued = [];
  const provider = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts).toString());
    const context = JSON.parse(input.messages[1].content);
    calls.push(context);
    const index = queued.findIndex(hold => hold.purpose === context.purpose && !context.ownCalendar);
    if (index >= 0) {
      const [hold] = queued.splice(index, 1);
      response.once('close', () => hold.closed.resolve({ aborted: !response.writableEnded }));
      hold.entered.resolve(context);
      await hold.release.promise;
      if (response.destroyed) return;
    }
    const first = context.sharedIntersection?.[0];
    const proposal = context.ownCalendar ? { message: 'Alice is ready. The participant chooses sharing.' }
      : context.purpose === 'brief' ? { message: 'PRIVATE_BRIEF_MUST_STAY_GATED', action: {
        type: 'share_brief', fields: ['topic'], values: { topic: context.ownBrief.topic }, resource: 'meeting_brief' } }
      : first ? { message: 'A shared meeting proposal.', action: { type: 'meeting', meeting: first } }
      : { message: 'No matching shared time.', action: { type: context.purpose === 'initial' ? 'request_more' : 'no_match' } };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelConfig = structuredClone(DEFAULT_MODEL_CONFIG);
  modelConfig.provider = 'openai_compatible';
  modelConfig.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  for (const settings of Object.values(modelConfig.agents)) Object.assign(settings, {
    model: 'local-interrupt-fixture', timeoutSeconds: 300, retryLimit: 3 });
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'interrupt-test-admin', modelConfig });
  await app.listen();
  t.after(async () => {
    await app.close();
    for (const hold of holds) hold.release.resolve();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, token, data) => {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const admin = (await call('/api/admin/login', null, { pin: 'interrupt-test-admin' })).data.token;
  const created = (await call('/api/sessions', null, { mode: 'live', researchConsent: false })).data;
  const session = app.engine.get(created.state.session.id);
  let cancellations = 0;
  const originalCancel = app.runtime.cancelPlanning;
  app.runtime.cancelPlanning = (...args) => { cancellations++; return originalCancel(...args); };
  return { app, session, call, admin, token: created.token, calls, cancelled: () => cancellations,
    hold(purpose) {
      const hold = { purpose, entered: deferred(), closed: deferred(), release: deferred() };
      holds.push(hold); queued.push(hold); return hold;
    },
    async choose(stage, choice) {
      const preview = await call(`/api/sessions/${session.id}/preview`, created.token, { stage, choice });
      assert.equal(preview.status, 200);
      const input = { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
        previewHash: preview.data.payloadHash, expectedVersion: preview.data.sessionVersion, requestId: randomUUID() };
      return { input, result: call(`/api/sessions/${session.id}/actions`, created.token, input) };
    },
  };
}

test('HTTP End preempts a held live model; invalid, unauthenticated, conflicting and duplicate requests do not cancel', async t => {
  const f = await fixture(t);
  const hold = f.hold('initial');
  const sharing = await f.choose('initial', 'free');
  await hold.entered.promise;
  const route = `/api/sessions/${f.session.id}/actions`;
  const ending = { action: 'end', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion };
  assert.equal((await promptDeadline(f.call(route, null, ending))).status, 401);
  assert.equal((await promptDeadline(f.call(route, f.token, { ...ending, requestId: 'bad' }))).status, 400);
  assert.equal((await promptDeadline(f.call(route, f.token, { ...ending, expectedVersion: ending.expectedVersion - 1 }))).status, 409);
  assert.equal((await promptDeadline(f.call(route, f.token, { ...ending, requestId: sharing.input.requestId }))).data.error.code, 'REQUEST_CONFLICT');
  assert.equal(f.cancelled(), 0);
  const ended = await promptDeadline(f.call(route, f.token, ending));
  assert.equal(ended.status, 200);
  assert.equal(ended.data.state.session.ended, true);
  assert.equal(ended.data.state.task.outcome, 'ended');
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  assert.equal((await sharing.result).status, 200);
  assert.equal(f.cancelled(), 1);
  assert.equal((await f.call(route, f.token, ending)).status, 200);
  assert.equal(f.cancelled(), 1);
  assert.equal(f.session.receipts.aliceToBob.length, 1);
  assert.equal(f.session.receipts.bobToAlice.length, 0);
  assert.equal(f.session.approvals.length, 0);
  assert.equal(f.calls.filter(context => !context.ownCalendar).length, 1);
  await assert.rejects(f.app.runtime.planBob({ sessionId: f.session.id, epoch: f.session.epoch,
    purpose: 'additional', configRevision: f.session.configRevision }), { code: 'STALE_EPOCH' });
});

test('withdrawal preempts meeting planning and keeps Bob received snapshots and immutable receipts', async t => {
  const f = await fixture(t);
  const first = await f.choose('initial', 'free'); await first.result;
  const hold = f.hold('additional');
  const sharing = await f.choose('additional', 'narrow');
  await hold.entered.promise;
  const result = await promptDeadline(f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'stop_sharing', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion }));
  assert.equal(result.status, 200);
  assert.equal(result.data.state.alice.stopped, true);
  assert.equal(result.data.state.task.outcome, 'boundary_kept');
  assert.equal(result.data.state.task.meeting, null);
  assert.equal(result.data.state.session.ended, false);
  await sharing.result;
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  assert.equal(f.session.receipts.aliceToBob.length, 2);
  assert.equal(f.session.receipts.bobToAlice.length, 0);
  assert.equal(f.session.continuation, null);
  for (const receipt of f.session.receipts.aliceToBob) {
    const found = await f.app.runtime.verifyReceipt({ sessionId: f.session.id, epoch: f.session.epoch,
      direction: 'bob', operationId: receipt.operationId, rows: receipt.rows, fields: receipt.fields,
      window: receipt.window, payloadHash: receipt.payloadHash });
    assert.equal(found.receipt.receivedAt, receipt.receivedAt);
  }
});

test('Pause discards a late proposal, preserves the continuation and resumes only explicitly', async t => {
  const f = await fixture(t);
  const first = await f.choose('initial', 'free'); await first.result;
  const originalPlan = f.app.runtime.planBob;
  f.app.runtime.planBob = async args => {
    try { return await originalPlan(args); }
    catch (error) {
      if (error.code === 'PLANNING_CANCELLED') return { message: 'LATE_REPLY', action: { type: 'meeting', meeting: { day: 'Thu', time: '15:00–15:30' } } };
      throw error;
    }
  };
  const hold = f.hold('additional');
  const sharing = await f.choose('additional', 'narrow');
  await hold.entered.promise;
  const route = `/api/admin/sessions/${f.session.id}/intervene`;
  const paused = await promptDeadline(f.call(route, f.admin, { action: 'pause' }));
  assert.equal(paused.status, 200);
  assert.equal(paused.data.state.waiting.reason, 'researcher');
  await sharing.result;
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  assert.equal(f.session.continuation, 'additional');
  assert.equal(f.session.receipts.aliceToBob.length, 2);
  assert.equal(f.session.receipts.bobToAlice.length, 0);
  assert.equal(f.session.approvals.length, 0);
  assert.equal(f.session.task.meeting, null);
  assert.equal(f.session.messages.some(item => item.text.includes('LATE_REPLY')), false);
  assert.equal((await f.call(route, f.admin, { action: 'pause' })).status, 200);
  assert.equal(f.cancelled(), 1);
  const resumed = await f.call(route, f.admin, { action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.state.session.stage, 'waiting_admin');
  assert.equal(f.session.receipts.bobToAlice.length, 1);
  assert.equal(f.session.approvals.filter(item => item.status === 'pending').length, 1);
});

test('withdrawal during optional brief planning preserves an already confirmed meeting', async t => {
  const f = await fixture(t);
  const first = await f.choose('initial', 'free'); await first.result;
  const hold = f.hold('brief');
  const sharing = await f.choose('additional', 'narrow');
  await hold.entered.promise;
  const stopped = await promptDeadline(f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'stop_sharing', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion }));
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.state.task.outcome, 'arranged');
  assert.deepEqual(stopped.data.state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  await sharing.result;
  assert.equal(f.session.receipts.bobToAlice.length, 1);
  assert.equal(f.session.approvals.length, 0);
  assert.equal(f.session.messages.some(item => item.text.includes('PRIVATE_BRIEF_MUST_STAY_GATED')), false);
});

test('a receipt arriving during withdrawal stays recorded and is not described as uncertain', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const interrupted = deferred();
  const originalCancel = f.app.runtime.cancelPlanning;
  f.app.runtime.cancelPlanning = (...args) => { const result = originalCancel(...args); interrupted.resolve(); return result; };
  const originalDeliver = f.app.runtime.deliverToBob;
  f.app.runtime.deliverToBob = async args => {
    const result = await originalDeliver(args);
    entered.resolve();
    await release.promise;
    return result;
  };
  const sharing = await f.choose('initial', 'free');
  await entered.promise;
  const stopping = f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'stop_sharing', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion });
  // This fixture holds a completed delivery acknowledgement, rather than a cancellable model call.
  // Releasing it must retain the genuine receipt and suppress any subsequent planning.
  await interrupted.promise;
  release.resolve();
  const stopped = await stopping;
  await sharing.result;
  assert.equal(stopped.status, 200);
  assert.equal(f.session.receipts.aliceToBob.length, 1);
  assert.equal(f.session.messages.some(item => item.text.includes('receipt status remains uncertain')), false);
  assert.equal(f.session.task.outcome, 'boundary_kept');
  assert.equal(f.calls.filter(context => !context.ownCalendar).length, 0);
});

test('End during optional brief planning preserves the already confirmed task before clearing contexts', async t => {
  const f = await fixture(t);
  const first = await f.choose('initial', 'free'); await first.result;
  const hold = f.hold('brief');
  const sharing = await f.choose('additional', 'narrow');
  await hold.entered.promise;
  const ended = await promptDeadline(f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'end', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion }));
  assert.equal(ended.status, 200);
  assert.equal(ended.data.state.session.ended, true);
  assert.equal(ended.data.state.task.outcome, 'arranged');
  assert.deepEqual(ended.data.state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  await sharing.result;
  assert.equal(f.session.receipts.bobToAlice.length, 1);
  assert.equal(f.session.approvals.length, 0);
  await assert.rejects(f.app.runtime.planBob({ sessionId: f.session.id, epoch: f.session.epoch,
    purpose: 'additional', configRevision: f.session.configRevision }), { code: 'STALE_EPOCH' });
});

test('an authorized confirmation arriving during End remains a real arranged result', async t => {
  const f = await fixture(t);
  const first = await f.choose('initial', 'free'); await first.result;
  const entered = deferred();
  const release = deferred();
  const interrupted = deferred();
  const originalCancel = f.app.runtime.cancelPlanning;
  f.app.runtime.cancelPlanning = (...args) => { const result = originalCancel(...args); interrupted.resolve(); return result; };
  const originalDeliver = f.app.runtime.deliverToAlice;
  f.app.runtime.deliverToAlice = async args => {
    const result = await originalDeliver(args);
    entered.resolve(); await release.promise; return result;
  };
  const sharing = await f.choose('additional', 'narrow');
  await entered.promise;
  const ending = f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'end', requestId: randomUUID(), expectedVersion: sharing.input.expectedVersion });
  await interrupted.promise;
  release.resolve();
  const ended = await ending;
  await sharing.result;
  assert.equal(ended.status, 200);
  assert.equal(ended.data.state.task.outcome, 'arranged');
  assert.deepEqual(ended.data.state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
  assert.equal(f.session.receipts.bobToAlice.length, 1);
  assert.equal(f.calls.some(context => context.purpose === 'brief'), false);
});

test('End never promotes a proposed meeting whose availability reply has not been approved and received', async t => {
  const f = await fixture(t);
  const config = structuredClone(f.session.config);
  config.permissions.confirmation = 'per_action';
  await f.call('/api/admin/config/apply', f.admin, { config, target: 'session', sessionId: f.session.id,
    expectedRevision: f.session.configRevision });
  await f.call(`/api/admin/sessions/${f.session.id}/intervene`, f.admin, { action: 'resume' });
  const first = await f.choose('initial', 'free'); await first.result;
  const additional = await f.choose('additional', 'narrow'); await additional.result;
  assert.equal(f.session.stage, 'waiting_admin');
  assert.deepEqual(f.session.preparedMeeting, { day: 'Thu', time: '15:00–15:30' });
  assert.equal(f.session.receipts.bobToAlice.length, 0);
  const ended = await f.call(`/api/sessions/${f.session.id}/actions`, f.token, {
    action: 'end', requestId: randomUUID(), expectedVersion: f.session.version });
  assert.equal(ended.status, 200);
  assert.equal(ended.data.state.task.outcome, 'ended');
  assert.equal(ended.data.state.task.meeting, null);
  assert.equal(f.session.approvals[0].status, 'cancelled');
});

test('current config validates before preempting and resumes with the new policy over the same received data', async t => {
  const f = await fixture(t);
  const hold = f.hold('initial');
  const sharing = await f.choose('initial', 'free');
  await hold.entered.promise;
  const config = structuredClone(f.session.config);
  config.collaboration.acceptInvitations = false;
  const input = { config, target: 'session', sessionId: f.session.id, expectedRevision: f.session.configRevision };
  assert.equal((await promptDeadline(f.call('/api/admin/config/apply', f.admin, { ...input, expectedRevision: input.expectedRevision - 1 }))).status, 409);
  assert.equal((await promptDeadline(f.call('/api/admin/config/apply', f.admin, { ...input, config: { bad: true } }))).status, 422);
  assert.equal(f.cancelled(), 0);
  const applied = await promptDeadline(f.call('/api/admin/config/apply', f.admin, input));
  assert.equal(applied.status, 200);
  assert.equal(applied.data.state.waiting.reason, 'configuration_changed');
  await sharing.result;
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  assert.equal(f.session.receipts.aliceToBob.length, 1);
  assert.equal(f.app.profiles.template.collaboration.acceptInvitations, true);
  assert.equal(f.session.config.collaboration.acceptInvitations, false);
  const resumed = await f.call(`/api/admin/sessions/${f.session.id}/intervene`, f.admin, { action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.state.task.outcome, 'boundary_kept');
  assert.equal(f.session.receipts.bobToAlice.length, 0);
  assert.equal(f.calls.filter(context => !context.ownCalendar).length, 1);
});

test('Reset preempts planning, retires old credentials and starts both agents with empty received ledgers', async t => {
  const f = await fixture(t);
  const hold = f.hold('initial');
  const sharing = await f.choose('initial', 'free');
  await hold.entered.promise;
  const reset = await promptDeadline(f.call(`/api/admin/sessions/${f.session.id}/intervene`, f.admin, { action: 'reset' }));
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.state.session.id, f.session.id);
  assert.notEqual(reset.data.token, f.token);
  assert.deepEqual(reset.data.state.receipts, { aliceToBob: [], bobToAlice: [] });
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  await sharing.result;
  assert.equal((await f.call(`/api/sessions/${f.session.id}`, f.token)).status, 404);
  const next = reset.data.state.session;
  await f.app.runtime.planBob({ sessionId: next.id, epoch: next.epoch, purpose: 'additional', configRevision: reset.data.state.bob.configRevision });
  assert.deepEqual(f.calls.at(-1).received, []);
});

test('service close cancels active planning before draining session queues and terminates both workers', async t => {
  const f = await fixture(t);
  const hold = f.hold('initial');
  const sharing = await f.choose('initial', 'free');
  const sharingClosed = sharing.result.catch(() => null);
  await hold.entered.promise;
  await promptDeadline(f.app.close());
  await sharingClosed;
  assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
  assert.equal(f.app.runtime.status().alice.online, false);
  assert.equal(f.app.runtime.status().bob.online, false);
  assert.equal(f.app.engine.sessions.size, 0);
});

test('expired round cleanup preempts held planning both directly and when a new round is created', async t => {
  for (const path of ['timer_cleanup', 'new_round']) await t.test(path, async t => {
    const f = await fixture(t);
    const hold = f.hold('initial');
    const sharing = await f.choose('initial', 'free');
    await hold.entered.promise;
    assert.deepEqual(await f.app.engine.expire(f.session), { expired: false }, 'An unexpired round cannot be cancelled through lifecycle cleanup.');
    assert.equal(f.cancelled(), 0);
    f.session.startedAt = new Date(Date.now() - f.app.engine.sessionTtlMs - 1000).toISOString();
    if (path === 'timer_cleanup') assert.deepEqual(await promptDeadline(f.app.engine.expire(f.session)), { expired: true });
    else {
      const next = await promptDeadline(f.call('/api/sessions', null, { mode: 'controlled', researchConsent: false }));
      assert.equal(next.status, 201); assert.notEqual(next.data.state.session.id, f.session.id);
      assert.deepEqual(next.data.state.receipts, { aliceToBob: [], bobToAlice: [] });
    }
    assert.equal((await promptDeadline(hold.closed.promise)).aborted, true);
    await sharing.result;
    assert.equal((await f.call(`/api/sessions/${f.session.id}`, f.token)).status, 404);
    assert.equal(f.calls.filter(call => !call.ownCalendar).length, 1, 'Cancellation never spends the configured retry budget.');
  });
});
