import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDemoServer } from '../src/server.mjs';

// Exercise the participant's whole default decision tree through the same HTTP contract as the UI.
test('all default demo choices finish, refresh exactly, and start a clean replacement round', async t => {
  const app = await createDemoServer({ port: 0, persist: false, adminPin: 'demo-journey-test-pin', modelBaseUrl: '', modelName: '', minimaxApiKey: '' });
  await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, token, input) {
    const response = await fetch(base + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  async function ok(route, token, input, status = 200) {
    const response = await call(route, token, input);
    assert.equal(response.status, status, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const admin = (await ok('/api/admin/login', null, { pin: 'demo-journey-test-pin' })).token;
  const paths = [{ initial: 'none', additional: null }, ...['free', 'busy', 'full'].flatMap(initial => ['keep', 'narrow', 'week'].map(additional => ({ initial, additional })))];
  let previous;
  for (const path of paths) {
    await t.test(`${path.initial} → ${path.additional ?? 'decline'}`, async () => {
      const created = await ok('/api/sessions', null, {
        mode: 'controlled', researchConsent: false,
        ...(previous ? { previousSessionId: previous.id, previousToken: previous.token } : {})
      }, 201);
      if (previous) assert.equal((await call(`/api/sessions/${previous.id}`, previous.token)).status, 404);
      const id = created.state.session.id, token = created.token, route = `/api/sessions/${id}`;
      assert.deepEqual(created.state.receipts, { aliceToBob: [], bobToAlice: [] });
      assert.equal(created.state.session.researchConsent, false);
      let state = created.state;
      for (const [stage, choice] of [['initial', path.initial], ...(path.additional ? [['additional', path.additional]] : [])]) {
        const before = state.receipts;
        const preview = await ok(`${route}/preview`, token, { stage, choice });
        const refreshed = await ok(route, token);
        assert.deepEqual(refreshed.receipts, before, 'preview must not send anything');
        assert.equal(refreshed.session.version, state.session.version, 'preview must not change the round');
        const submission = { action: stage === 'initial' ? 'share_initial' : 'respond_additional', choice,
          previewHash: preview.payloadHash, expectedVersion: preview.sessionVersion, requestId: randomUUID() };
        state = (await ok(`${route}/actions`, token, submission)).state;
        const duplicate = (await ok(`${route}/actions`, token, submission)).state;
        assert.deepEqual(duplicate.receipts, state.receipts, 'resubmitting a confirmed choice must not resend');
        if (choice !== 'none' && choice !== 'keep') {
          const receipt = state.receipts.aliceToBob.at(-1);
          assert.deepEqual(receipt.rows, preview.rows);
          assert.deepEqual(receipt.fields, preview.fields);
          assert.equal(receipt.payloadHash, preview.payloadHash);
          assert.equal(receipt.status, 'received');
          if (choice === 'free' || choice === 'narrow') {
            assert.deepEqual(receipt.fields, ['day', 'time', 'status']);
            assert(receipt.rows.every(row => row.status === 'Free' && !('title' in row) && !('note' in row)));
          }
        }
        assert.deepEqual(await ok(route, token), state, 'refresh must restore exact state without replaying actions');
      }
      const arranged = path.additional === 'narrow' || path.additional === 'week';
      if (arranged) {
        assert.equal(state.session.stage, 'waiting_admin');
        const approval = (await ok(`/api/admin/sessions/${id}/approvals`, admin)).approvals.find(item => item.status === 'pending');
        // Alternate allow and deny so a declined optional brief also gets a complete default journey.
        const decision = path.initial === 'busy' ? 'deny' : 'allow_once';
        state = (await ok(`/api/admin/approvals/${approval.id}/decision`, admin, {
          decision, fields: ['topic'], expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash
        })).state;
        assert.deepEqual(state.task.meeting, { day: 'Thu', time: '15:00–15:30' });
        assert.equal(state.receipts.bobToAlice.length, decision === 'deny' ? 1 : 2);
        if (decision !== 'deny') assert.deepEqual(state.receipts.bobToAlice.at(-1).values, { topic: approval.values.topic });
      }
      assert.equal(state.session.stage, 'complete');
      assert.equal(state.task.outcome, arranged ? 'arranged' : path.initial === 'none' ? 'declined' : 'boundary_kept');
      assert.equal(state.receipts.aliceToBob.length, path.initial === 'none' ? 0 : path.additional === 'keep' ? 1 : 2);
      const end = { action: 'end', expectedVersion: state.session.version, requestId: randomUUID() };
      const ended = (await ok(`${route}/actions`, token, end)).state;
      assert.equal(ended.session.ended, true);
      assert.deepEqual(ended.receipts, state.receipts);
      assert.deepEqual(ended.task, state.task);
      assert.deepEqual((await ok(`${route}/actions`, token, end)).state, ended, 'End must be safe to retry after a lost response');
      assert.deepEqual(await ok(route, token), ended, 'refresh after End must keep the readable result');
      previous = { id, token };
    });
  }
  assert.equal((await ok('/api/admin/research', admin)).runs.length, 0);
  assert.equal(app.engine.sessions.size, 1, 'replacement rounds must release their predecessors');
});
