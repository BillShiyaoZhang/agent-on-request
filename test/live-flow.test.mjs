import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';

test('live application invokes both agents and gates the model-selected brief without exposing private model text', async t => {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); const context = JSON.parse(input.messages[1].content); calls.push({ input, context });
    let output;
    if (context.ownCalendar) output = { message: 'Alice is ready. You choose exactly what I share.' };
    else if (context.purpose === 'initial') output = { message: 'Model private message', action: { type: 'request_more' } };
    else if (context.purpose === 'additional') output = { message: 'Model private message', action: { type: 'meeting', meeting: { day: 'Thu', time: '15:00–15:30' } } };
    else output = { message: 'UNAPPROVED_MODEL_BRIEF_TEXT', action: { type: 'share_brief', fields: ['topic'], values: { topic: context.ownBrief.topic }, resource: 'meeting_brief' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'test-live-admin', bobUrl: '', modelBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, modelName: 'local-fixture-model', modelApiKey: '' });
  t.after(() => app.close());
  const created = await app.engine.create({ mode: 'live', researchConsent: true });
  const session = app.engine.get(created.state.session.id);
  for (const [stage, choice] of [['initial', 'free'], ['additional', 'narrow']]) {
    const preview = await app.engine.preview(session, { stage, choice });
    await app.engine.action(session, { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice, previewHash: preview.payloadHash, requestId: randomUUID(), expectedVersion: preview.sessionVersion });
  }
  assert.equal(calls.length, 4); assert.ok(calls[0].context.ownCalendar.length);
  assert(calls[1].input.messages[0].content.includes('"type":"request_more"'));
  assert(calls[2].input.messages[0].content.includes('"meeting":{"day":"Thu","time":"15:00–15:30"}'));
  assert(!calls.slice(1).some(call => call.input.messages[0].content.includes('"type":"allowed type"')));
  assert.equal(calls[1].context.ownBrief, undefined);
  assert.equal(calls[2].context.ownBrief, undefined);
  assert.equal(JSON.stringify(calls.slice(1).map(call => call.context.received)).includes('Personal appointment'), false);
  assert.ok(calls.every(call => call.input.store === false));
  const approval = app.engine.approvals(session.id).find(item => item.status === 'pending');
  assert.deepEqual(approval.fields, ['topic']);
  assert.equal(app.engine.view(session).messages.some(message => message.text.includes('UNAPPROVED_MODEL_BRIEF_TEXT')), false);
  assert.equal(session.task.meeting, null);
  await app.engine.decide(approval.id, { decision: 'allow_once', fields: ['topic'], expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash });
  assert.equal(session.task.outcome, 'arranged');
  assert.deepEqual(session.receipts.bobToAlice.at(-1).fields, ['topic']);
  await app.engine.action(session, { action: 'end', requestId: randomUUID(), expectedVersion: session.version });
  assert.equal(app.research.list().runs[0].mode, 'live');
});

test('malformed Live actions pause with useful safe diagnostics and never become a confirmed meeting', async t => {
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const context = JSON.parse(JSON.parse(body).messages[1].content);
    const proposal = context.ownCalendar ? { message: 'Alice is ready.' }
      : { message: 'MODEL_BODY_SECRET', action: { type: 'meeting' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'test-contract-pin',
    modelBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`, modelName: 'local-contract-model', modelApiKey: '' });
  t.after(() => app.close());
  const created = await app.engine.create({ mode: 'live' });
  const session = app.engine.get(created.state.session.id);
  const preview = await app.engine.preview(session, { stage: 'initial', choice: 'free' });
  const { state } = await app.engine.action(session, { action: 'share_initial', choice: 'free', previewHash: preview.payloadHash,
    requestId: randomUUID(), expectedVersion: preview.sessionVersion });
  assert.equal(state.session.stage, 'paused');
  assert.equal(state.waiting.code, 'MODEL_INVALID_MEETING');
  assert.equal(state.waiting.detail, 'The model meeting action is missing action.meeting.day or action.meeting.time.');
  assert.equal(state.task.meeting, null);
  assert.equal(state.receipts.aliceToBob.length, 1);
  assert.equal(state.receipts.bobToAlice.length, 0);
  assert.equal(JSON.stringify(state).includes('MODEL_BODY_SECRET'), false);
  await app.engine.suspend(session, Object.assign(new Error('ARBITRARY_PROVIDER_SECRET'), { code: 'MODEL_INVALID_OUTPUT' }));
  assert.equal(JSON.stringify(app.engine.view(session)).includes('ARBITRARY_PROVIDER_SECRET'), false);
});
