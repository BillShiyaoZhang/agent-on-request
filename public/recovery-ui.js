const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const array = value => Array.isArray(value) ? value : [];
const steps = {
  alice_intro: 'Alice is preparing the introduction',
  alice_alignment: 'Alice is proposing how to interpret free time',
  bob_alignment: 'Bob is checking the agreed free-time rule',
  bob_initial: 'Bob is finding a shared meeting time',
  bob_additional: 'Bob is checking the additional time window',
  bob_brief: 'Bob is preparing the optional meeting context',
  brief_alignment: 'The assistants are checking the separately approved meeting context',
  calendar_delivery: 'Bob is confirming Alice’s approved calendar snapshot',
  reply_delivery: 'Alice is confirming Bob’s approved reply'
};
const recoveryLabels = {
  retry_planning: 'Retry this planning step using the existing permissions and confirmed information.',
  retry_delivery: 'Check and retry the same approved transmission. Its content and scope stay unchanged.',
  review_configuration: 'Review Bob’s changed permission settings before resuming.',
  restore_connection: 'Restore the peer connection, then explicitly retry the same operation.'
};

export function recoveryPhase(state) {
  return steps[state?.waiting?.step] || 'The current collaboration step';
}

export function confirmedRecoveryMeeting(state) {
  if (state?.task?.outcome === 'arranged' && state.task.meeting) return state.task.meeting;
  const receipt = array(state?.receipts?.bobToAlice).findLast(item => item.status === 'received' && ['day', 'time', 'status'].every(field => array(item.fields).includes(field)));
  return receipt?.values?.status === 'Free' && receipt.values.day && receipt.values.time ? { day: receipt.values.day, time: receipt.values.time } : null;
}

export function renderRecoveryHtml(state, { busy = false, controls = false, showActions = true, message = '' } = {}) {
  if (!state?.session || !state.session.paused || state.session.ended) return '';
  const waiting = state.waiting || {};
  const stopped = Boolean(state.alice?.stopped);
  const failedOutput = waiting.reason === 'model_output' || waiting.code === 'MODEL_INVALID_OUTPUT' || waiting.code === 'MODEL_INVALID_MEETING';
  const connection = ['model_connection', 'model_timeout', 'peer_offline'].includes(waiting.reason);
  const title = failedOutput ? 'The assistant’s proposal could not be used' : connection ? 'This step could not finish' : 'The collaboration is paused';
  const sent = array(state.receipts?.aliceToBob).filter(receipt => receipt.status === 'received').length;
  const back = array(state.receipts?.bobToAlice).filter(receipt => receipt.status === 'received').length;
  const uncertain = [...array(state.receipts?.aliceToBob), ...array(state.receipts?.bobToAlice)].filter(receipt => receipt.status !== 'received').length;
  const meeting = confirmedRecoveryMeeting(state);
  const optionalContextPaused = Boolean(meeting && ['bob_brief', 'brief_alignment'].includes(waiting.step));
  const skipOptional = optionalContextPaused && !stopped && state.session.mode !== 'replay';
  const recovery = waiting.recovery || (waiting.reason === 'configuration_changed' ? 'review_configuration' : waiting.reason === 'peer_offline' ? 'restore_connection' : 'retry_planning');
  const peerOffline = state.runtime?.bob?.online === false || state.bob?.online === false;
  const recoveryAdvice = recovery === 'restore_connection' && !peerOffline ? 'The connection is restored. Explicitly retry the same approved operation.' : recoveryLabels[recovery] || recoveryLabels.retry_planning;
  const detail = waiting.detail || (failedOutput ? 'The proposed action did not match the allowed format for this step.' : waiting.message);
  const mode = state.session.mode === 'live' ? 'This round remains in Live model mode.' : 'This round keeps its selected mode.';
  const participantActions = '<button class="button" data-participant-action="recover" ' + (busy ? 'disabled' : '') + '>Open recovery controls</button>'
    + (skipOptional ? '<button class="button primary" data-participant-action="skip_optional_brief" ' + (busy ? 'disabled' : '') + '>Keep the meeting and skip optional context</button>' : '');
  const actions = !controls ? participantActions : '<button class="button" data-close-dialog="admin-dialog">Return without retrying</button>'
    + (peerOffline ? '<button class="button" data-recovery-action="restore_bob" ' + (busy || stopped ? 'disabled' : '') + '>Restore Bob’s connection</button>' : '')
    + (recovery === 'review_configuration' ? '<button class="button" data-recovery-action="configure" ' + (busy ? 'disabled' : '') + '>Review Bob’s settings</button>' : '')
    + '<button class="button primary" data-recovery-action="retry" ' + (busy || stopped || peerOffline ? 'disabled' : '') + '>' + (busy ? 'Checking the recovery result…' : 'Retry the paused step') + '</button>';
  return '<section class="panel recovery-panel" data-recovery-panel role="status"><div class="panel-heading"><div><p class="eyebrow">' + escapeHtml(mode) + '</p><h3>' + title + '</h3></div><span class="tag warn">Paused · no new sharing decision</span></div>'
    + (message ? '<p class="notice warning">' + escapeHtml(message) + '</p>' : '')
    + '<dl class="definition-list"><dt>Where it stopped</dt><dd data-recovery-phase>' + recoveryPhase(state) + '</dd>'
    + (detail ? '<dt>What happened</dt><dd>' + escapeHtml(detail) + '</dd>' : '') + '</dl>'
    + '<div class="recovery-receipts"><strong>What is already confirmed</strong><p>Alice → Bob · ' + sent + ' confirmed snapshots</p><p>Bob → Alice · ' + back + ' confirmed snapshots</p>'
    + (uncertain ? '<p class="tag warn">' + uncertain + ' unconfirmed snapshots</p>' : '')
    + (meeting ? '<p><strong>Confirmed meeting</strong><span data-i18n-ignore>' + escapeHtml(meeting.day + ' · ' + meeting.time) + '</span></p>' : '<p>No meeting has been confirmed yet.</p>') + '</div>'
    + (optionalContextPaused ? '<p class="notice">The meeting is already confirmed. An unfinished optional context step does not undo it. You may keep the meeting without receiving any further context.</p>' : '')
    + '<p class="recovery-explanation">' + (stopped ? 'Future sharing is stopped. You can inspect the receipts or end this round.' : escapeHtml(recoveryAdvice)) + '</p>'
    + '<p class="muted">Retrying keeps the sharing boundary. It does not approve extra fields or change the mode.</p>' + (showActions ? '<div class="toolbar section-actions">' + actions + '</div>' : '')
    + (waiting.code || waiting.diagnostic ? '<details data-disclosure-id="recovery-diagnostic"><summary>Technical diagnostic</summary><dl class="definition-list"><dt>Code</dt><dd><code>' + escapeHtml(waiting.code || waiting.diagnostic) + '</code></dd>' + (waiting.diagnostic ? '<dt>Diagnostic</dt><dd>' + escapeHtml(waiting.diagnostic) + '</dd>' : '') + '</dl></details>' : '') + '</section>';
}
