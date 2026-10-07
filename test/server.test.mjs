import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';

test('HTTP roles enforce Bob owner authority, exact preview, origin and independent research consent', async t => {
  const app = await createDemoServer({ port: 0, adminPin: 'test-admin-pin', persist: false, bobUrl: '', modelBaseUrl: '', modelName: '' });
  await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, token, data, extra = {}) => {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call('/api/admin/sessions')).status, 401);
  assert.equal((await call('/api/admin/login', null, { pin: 'wrong' })).status, 401);
  const admin = (await call('/api/admin/login', null, { pin: 'test-admin-pin' })).data.token;
  const created = (await call('/api/sessions', null, { mode: 'controlled', researchConsent: false })).data;
  const id = created.state.session.id; const participant = created.token;
  const preview = (await call(`/api/sessions/${id}/preview`, participant, { stage: 'initial', choice: 'free' })).data;
  const input = { action: 'share_initial', choice: 'free', previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() };
  assert.equal((await call(`/api/sessions/${id}/actions`, admin, input)).status, 401);
  assert.equal((await call(`/api/sessions/${id}/actions`, participant, { ...input, previewHash: '0'.repeat(64) })).status, 409);
  assert.equal((await call(`/api/sessions/${id}/actions`, participant, input, { Origin: 'http://outside.invalid' })).status, 403);
  assert.equal((await call(`/api/sessions/${id}/actions`, participant, input)).status, 200);
  const next = (await call(`/api/sessions/${id}/preview`, participant, { stage: 'additional', choice: 'narrow' })).data;
  const result = await call(`/api/sessions/${id}/actions`, participant, { action: 'respond_additional', choice: 'narrow', previewHash: next.payloadHash, expectedVersion: next.sessionVersion, requestId: randomUUID() });
  assert.equal(result.data.state.session.stage, 'waiting_admin');
  assert.equal((await call(`/api/admin/sessions/${id}/approvals`, participant)).status, 401);
  const approval = (await call(`/api/admin/sessions/${id}/approvals`, admin)).data.approvals.find(item => item.status === 'pending');
  assert.equal((await call(`/api/admin/approvals/${approval.id}/decision`, admin, { decision: 'allow_once', fields: ['topic'], expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash })).data.state.task.outcome, 'arranged');
  assert.equal((await call('/api/admin/research', admin)).data.runs.length, 0);
  const config = (await call(`/api/admin/config?sessionId=${id}`, admin)).data;
  assert.equal(config.active.data.synthetic, true);
  const loggedOut = await call('/api/admin/logout', admin, {}); assert.equal(loggedOut.status, 200);
  assert.equal((await call('/api/admin/research', admin)).status, 401);
});
