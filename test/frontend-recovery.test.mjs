import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRecoveryHtml, recoveryPhase, confirmedRecoveryMeeting } from '../public/recovery-ui.js';
import { renderParticipantHtml } from '../public/participant-ui.js';
import { renderOntologyHtml } from '../public/ontology-ui.js';
import { renderApprovalHtml } from '../public/operator-ui.js';
import { translateText } from '../public/i18n.js';

const pausedState = () => ({
  session: { id: 'round', stage: 'paused', paused: true, ended: false, mode: 'live' },
  alice: { stopped: false }, bob: { online: true },
  waiting: { reason: 'model_output', code: 'MODEL_INVALID_OUTPUT', diagnostic: 'INCOMPLETE_MAPPING', detail: 'The model accepted an incomplete set of registered mapping identifiers.', step: 'alice_alignment', recovery: 'retry_planning' },
  ontology: { status: 'awaiting_alignment', scenario: 'distinct', task: { id: 'schedule', type: 'schedule', durationMinutes: 30 }, proposal: { mappings: [] }, selectedModules: [], excludedModules: [], registry: {}, protocol: [], transcript: [] },
  choices: {}, receipts: { aliceToBob: [], bobToAlice: [] }, messages: []
});

test('each recovery phase has a readable English and Chinese description', () => {
  for (const step of ['alice_intro', 'alice_alignment', 'bob_alignment', 'bob_initial', 'bob_additional', 'bob_brief', 'brief_alignment', 'calendar_delivery', 'reply_delivery']) {
    const label = recoveryPhase({ waiting: { step } });
    assert.notEqual(label, 'The current collaboration step', step);
    assert.match(translateText(label, 'zh'), /[\u4e00-\u9fff]/, step);
  }
});

test('recovery reports confirmed evidence and retains Live without claiming a hidden correction count', () => {
  const state = pausedState();
  state.waiting.message = 'Ignored provider-facing error text';
  state.receipts.aliceToBob = [{ status: 'received' }, { status: 'unconfirmed' }];
  state.receipts.bobToAlice = [{ status: 'received', fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00–15:30', status: 'Free' } }];
  const html = renderRecoveryHtml(state, { controls: true });
  assert.match(html, /This round remains in Live model mode/);
  assert.match(html, /Alice → Bob · 1 confirmed snapshots/);
  assert.match(html, /Bob → Alice · 1 confirmed snapshots/);
  assert.match(html, /1 unconfirmed snapshots/);
  assert.match(html, /Confirmed meeting/);
  assert.match(html, /Thu · 15:00–15:30/);
  assert.doesNotMatch(html, /Ignored provider-facing|budget exhausted|Controlled/);
  assert.match(html, /data-recovery-action="retry" >Retry/);
  assert.match(html, /Return without retrying/);
});

test('offline and revoked states disable retry while retaining confirmed receipts', () => {
  const state = pausedState();
  state.bob.online = false;
  let html = renderRecoveryHtml(state, { controls: true });
  assert.match(html, /data-recovery-action="retry" disabled/);
  assert.match(html, /data-recovery-action="restore_bob" >Restore/);
  state.alice.stopped = true;
  html = renderRecoveryHtml(state, { controls: true });
  assert.match(html, /Future sharing is stopped/);
  assert.match(html, /data-recovery-action="restore_bob" disabled/);
});

test('restoring the connection asks for the same explicit retry, without still claiming the peer is offline', () => {
  const state = pausedState();
  state.waiting.reason = 'peer_offline'; state.waiting.recovery = 'restore_connection';
  const html = renderRecoveryHtml(state, { controls: true });
  assert.match(html, /The connection is restored. Explicitly retry the same approved operation/);
  assert.doesNotMatch(html, /data-recovery-action="restore_bob"/);
  assert.match(html, /data-recovery-action="retry" >Retry/);
  assert.equal(translateText('The connection is restored. Explicitly retry the same approved operation.', 'zh'), '连接已恢复。请明确重试同一份已批准的操作。');
});

test('an unfinished or busy reply is not promoted to a confirmed meeting', () => {
  const state = pausedState();
  state.receipts.bobToAlice = [{ status: 'unconfirmed', fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00', status: 'Free' } }];
  assert.equal(confirmedRecoveryMeeting(state), null);
  state.receipts.bobToAlice[0].status = 'received';
  state.receipts.bobToAlice[0].values.status = 'Busy';
  assert.equal(confirmedRecoveryMeeting(state), null);
  assert.match(renderRecoveryHtml(state), /No meeting has been confirmed yet/);
});

test('optional context recovery can keep a receipt-confirmed meeting without another disclosure', () => {
  const state = pausedState();
  state.receipts.bobToAlice = [{ status: 'received', fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00–15:30', status: 'Free' } }];
  for (const step of ['bob_brief', 'brief_alignment']) {
    state.waiting.step = step;
    const html = renderRecoveryHtml(state);
    assert.match(html, /data-participant-action="skip_optional_brief" >Keep the meeting/);
    assert.match(html, /An unfinished optional context step does not undo it/);
    assert.match(renderRecoveryHtml(state, { busy: true }), /data-participant-action="skip_optional_brief" disabled/);
    assert.doesNotMatch(renderRecoveryHtml(state, { controls: true }), /data-participant-action="skip_optional_brief"/);
  }
  assert.equal(translateText('Keep the meeting and skip optional context', 'zh'), '保留会议，跳过可选简报');
  state.alice.stopped = true;
  assert.doesNotMatch(renderRecoveryHtml(state), /data-participant-action="skip_optional_brief"/);
});

test('skipping optional context is unavailable before a confirmed meeting or outside the optional phases', () => {
  const state = pausedState();
  state.waiting.step = 'brief_alignment';
  assert.doesNotMatch(renderRecoveryHtml(state), /data-participant-action="skip_optional_brief"/);
  state.receipts.bobToAlice = [{ status: 'unconfirmed', fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00–15:30', status: 'Free' } }];
  assert.doesNotMatch(renderRecoveryHtml(state), /data-participant-action="skip_optional_brief"/);
  state.receipts.bobToAlice[0].status = 'received';
  for (const step of ['alice_intro', 'alice_alignment', 'bob_initial', 'bob_additional', 'calendar_delivery', 'reply_delivery']) {
    state.waiting.step = step;
    assert.doesNotMatch(renderRecoveryHtml(state), /data-participant-action="skip_optional_brief"/, step);
  }
});

test('paused alignment stays on the meaning step and does not repeat an old Bob request', () => {
  const state = pausedState();
  state.ontology.status = 'accepted';
  state.messages = [{ from: 'Bob', text: 'Stale request to widen sharing', kind: 'status' }];
  const html = renderParticipantHtml({ state, heading: 'Paused', mode: 'Live', warnings: renderRecoveryHtml(state) });
  assert.match(html, /class="current"><span>1<\/span><strong>Confirm free-time meaning/);
  assert.doesNotMatch(html, /data-agent-facing-message/);
  assert.equal((html.match(/Stale request to widen sharing/g) || []).length, 1, 'history retains the old request only once');
});

test('free-time confirmation remains separate from disclosure and advanced mapping evidence is available', () => {
  const state = pausedState();
  state.session.stage = 'alignment'; state.session.paused = false;
  const html = renderOntologyHtml(state);
  assert.match(html, /Confirm how the two assistants understand free time/);
  assert.match(html, /Agree to use this rule to find a meeting time/);
  assert.match(html, /choose what calendar information to share next/);
  assert.match(html, /<details[^>]*><summary>Selected modules & all mapping rules/);
  assert.match(html, /data-participant-action="alignment_accept"/);
});

test('empty field approvals disable both allow choices but retain denial and closing', () => {
  const html = renderApprovalHtml({ id: 'approval', fields: ['topic'], values: { topic: 'actual topic' } }, '', { selectedFields: [] });
  assert.match(html, /data-approval-decision="allow_once" disabled/);
  assert.match(html, /data-approval-decision="allow_round" disabled/);
  assert.match(html, /data-approval-decision="deny">/);
  assert.match(html, /data-close-dialog="admin-dialog">Return without deciding/);
  assert.match(html, /Select at least one field/);
});

test('diagnostics are escaped and completed rounds do not expose recovery controls', () => {
  const state = pausedState();
  state.waiting.detail = '<script>bad()</script>';
  assert.match(renderRecoveryHtml(state), /&lt;script&gt;/);
  assert.doesNotMatch(renderRecoveryHtml(state), /<script>/);
  state.session.ended = true;
  assert.equal(renderRecoveryHtml(state), '');
});
