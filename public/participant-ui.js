const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = role => '<span class="experience-avatar ' + role.toLowerCase() + '" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="7" y="10" width="18" height="16" rx="5"/><path d="M16 5v5m-5 7h1m8 0h1m-9 5h8"/></svg></span>';

export function scopeIconHtml(choice) {
  const paths = choice === 'none' || choice === 'keep' ? '<rect x="10" y="15" width="16" height="13" rx="3"/><path d="M14 15v-5a4 4 0 0 1 8 0v5m-4 6v3"/>' : choice === 'full' ? '<rect x="8" y="5" width="20" height="26" rx="4"/><path d="M13 12h10m-10 6h10m-10 6h6"/>' : choice === 'busy' ? '<rect x="5" y="8" width="26" height="24" rx="4"/><path d="M5 15h26M12 4v8M24 4v8m-12 9h5m5 0h3m-13 6h5"/>' : '<circle cx="18" cy="18" r="13"/><path d="M18 10v8l6 4"/>';
  return '<span class="scope-icon" aria-hidden="true"><svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></span>';
}

function messageHtml(state) {
  const approval = state.pendingApprovals?.find(item => item.status === 'pending');
  if (approval && state.waiting?.reason === 'admin') {
    const meeting = [...(state.receipts?.bobToAlice || [])].reverse().find(receipt => receipt.status === 'received' && ['day', 'time', 'status'].every(field => receipt.fields.includes(field)));
    const confirmed = approval.resource === 'meeting_brief' && meeting;
    return '<section class="panel agent-facing-message" data-agent-facing-message data-current-bob-request><div class="experience-message-heading">' + icon('Bob') + '<div><h3>' + (confirmed ? 'Shared time confirmed' : 'Bob’s sharing request') + '</h3><small>Bob’s owner reviews his agent’s outgoing information</small></div></div>'
      + (confirmed ? '<p><strong>' + escapeHtml(meeting.values.day) + ' · ' + escapeHtml(meeting.values.time) + '</strong></p><p>The optional meeting brief needs Bob’s owner approval. Your calendar choice stays unchanged.</p>' : '<p>' + escapeHtml(approval.summary) + '</p><p>Your calendar choice stays unchanged.</p>') + '</section>';
  }
  const messages = state.messages || [];
  const message = [...messages].reverse().find(item => !['receipt', 'technical', 'approval'].includes(item.kind));
  if (!message) return '';
  const role = message.from === 'Alice' ? 'Alice' : message.from === 'Bob' ? 'Bob' : 'system';
  return '<section class="panel agent-facing-message" data-agent-facing-message><div class="experience-message-heading">' + icon(role) + '<div><h3>' + (role === 'Alice' ? 'Alice · your agent' : role === 'Bob' ? 'A message for Alice' : 'Demo update') + '</h3><small>' + (role === 'Bob' ? 'Bob’s request, presented for your decision' : 'What matters at this step') + '</small></div></div><p>' + escapeHtml(message.text) + '</p></section>';
}

function deliverySummary(state) {
  if (state.session.mode === 'replay') return '';
  const sent = (state.receipts?.aliceToBob || []).filter(item => item.status === 'received').length;
  const back = (state.receipts?.bobToAlice || []).filter(item => item.status === 'received').length;
  const uncertain = [...(state.receipts?.aliceToBob || []), ...(state.receipts?.bobToAlice || [])].filter(item => item.status !== 'received').length;
  return '<div class="delivery-summary" aria-label="Confirmed sharing"><span class="delivery-point alice"><strong>Alice → Bob</strong><small>' + sent + ' confirmed snapshots</small></span><span class="delivery-link" aria-hidden="true">⇄</span><span class="delivery-point bob"><strong>Bob → Alice</strong><small>' + back + ' confirmed snapshots</small></span>' + (uncertain ? '<span class="tag warn">' + uncertain + ' unconfirmed snapshots</span>' : '<span class="tag">' + (sent || back ? 'Only confirmed receipts count' : 'Nothing shared yet') + '</span>') + '</div>';
}

function receivedValueHtml(value) {
  if (Array.isArray(value)) return value.length ? '<ul class="received-value-list">' + value.map(item => '<li>' + receivedValueHtml(item) + '</li>').join('') + '</ul>' : '<span class="muted">Empty list</span>';
  if (value !== null && typeof value === 'object') return Object.keys(value).length ? '<dl class="definition-list received-value-fields">' + Object.entries(value).map(([key, item]) => '<dt data-i18n-ignore>' + escapeHtml(key) + '</dt><dd>' + receivedValueHtml(item) + '</dd>').join('') + '</dl>' : '<span class="muted">No fields</span>';
  return '<span data-i18n-ignore>' + escapeHtml(value === null ? 'null' : value) + '</span>';
}

function receivedInformationHtml(state) {
  const labels = { topic: 'Topic', agenda: 'Agenda' };
  const received = (state.receipts?.bobToAlice || []).filter(receipt => receipt.status === 'received' && Object.keys(receipt.values || {}).some(key => !['day', 'time', 'status'].includes(key)));
  if (!received.length) return '';
  return '<section class="panel alice-received-information" data-alice-received><div class="experience-message-heading">' + icon('Alice') + '<div><h3>Information Alice received</h3><small>Confirmed information from Bob</small></div></div>' + received.map((receipt, index) => '<dl class="definition-list">' + Object.entries(receipt.values || {}).filter(([key]) => !['day', 'time', 'status'].includes(key)).map(([key, value]) => '<dt>' + escapeHtml(labels[key] || key) + '</dt><dd>' + (value !== null && typeof value === 'object' ? '<details class="received-structured" data-disclosure-id="received-info-' + escapeHtml(receipt.operationId || index) + '-' + escapeHtml(key) + '"><summary>View information details</summary>' + receivedValueHtml(value) + '</details>' : receivedValueHtml(value)) + '</dd>').join('') + '</dl>').join('') + '</section>';
}

function inspectionHtml(state, role, contents = '') {
  const agent = state.agentStates?.[role];
  const received = (agent?.kg?.nodes || []).filter(node => node.origin === 'received').length;
  const calendar = contents ? '<details class="experience-calendar" data-disclosure-id="participant-calendar"><summary>Your calendar at a glance</summary><div class="disclosure-body">' + contents + '</div></details>' : '';
  return '<details class="experience-inspection ' + role.toLowerCase() + ' configuration-disclosure" data-disclosure-id="participant-' + role + '"><summary><span class="experience-inspection-title">' + icon(role) + '<span><strong>' + (role === 'Alice' ? 'Inside Alice · optional' : 'Inside Bob · further detail') + '</strong><small>' + (role === 'Alice' ? 'Your agent’s calendar, knowledge and permissions' : 'The peer’s separate knowledge and permissions') + '</small></span></span><span class="tag">' + (agent ? received + ' received facts' : 'Snapshot unavailable') + '</span></summary><div class="disclosure-body"><div id="' + (role === 'Alice' ? 'live-alice-state' : 'live-bob-state') + '"></div>' + calendar + '</div></details>';
}

export function renderParticipantHtml({ state, heading, mode, warnings = '', controls = '', outcome = '', choices = '', questions = '', receipts = '', calendar = '', replay = '', modeDisclosure = '', perspective = '', ontology = '', contribution = '' }) {
  const session = state.session;
  const complete = Boolean(state.task?.outcome);
  const choseScope = state.choices?.initial != null;
  const hasAlignment = Boolean(state.ontology);
  const step = complete ? hasAlignment ? 3 : 2 : choseScope || ['additional', 'waiting_admin'].includes(session.stage) ? hasAlignment ? 2 : 1 : session.stage === 'alignment' ? 0 : hasAlignment ? 1 : 0;
  const labels = hasAlignment ? ['Align meanings', 'Choose scope', 'Follow progress', 'See the result'] : ['Choose scope', 'Follow progress', 'See the result'];
  const progress = session.mode === 'replay' ? '' : '<ol class="experience-progress" aria-label="Collaboration steps">' + labels.map((label, index) => {
    const skipped = complete && !choseScope && index < (hasAlignment ? 3 : 2) && !(hasAlignment && index === 0 && state.ontology.status === 'accepted');
    const done = !skipped && (complete || index < step);
    return '<li class="' + (skipped ? 'skipped' : done ? 'done' : index === step ? 'current' : '') + '"><span>' + (skipped ? '—' : done ? '✓' : index + 1) + '</span><strong>' + label + '</strong></li>';
  }).join('') + '</ol>';
  const history = '<section class="conversation-history"><h4>Earlier updates</h4><ol class="conversation">' + (state.messages || []).map(message => '<li class="message" data-from="' + escapeHtml(message.from) + '"><header><strong>' + escapeHtml(message.from) + '</strong></header><p>' + escapeHtml(message.text) + '</p></li>').join('') + '</ol></section>';
  return perspective + '<div class="panel-heading experience-heading"><div><p class="eyebrow">' + escapeHtml(mode) + ' · fictional scenario</p><h2>' + heading + '</h2></div><div class="toolbar">' + controls + '</div></div>' + progress + warnings + '<div class="participant-main-flow">' + (outcome ? '<section class="panel experience-outcome" data-outcome>' + outcome + '</section>' : session.stage === 'alignment' ? '' : messageHtml(state)) + ontology + choices + replay + receivedInformationHtml(state) + contribution + questions + deliverySummary(state) + '</div>'
    + '<div class="participant-inspection-stack"><p class="inspection-intro">Curious about the details?</p>' + inspectionHtml(state, 'Alice', calendar) + (state.agentStates?.Bob ? inspectionHtml(state, 'Bob') : '<section class="peer-private-boundary"><strong>Bob has a separate owner and private store</strong><p>Only confirmed exchanges and the task-scoped ontology dialogue are visible here. Use the observer view to inspect the fictional experimental setup.</p></section>') + '<details class="experience-evidence configuration-disclosure" data-disclosure-id="participant-evidence"><summary><span><strong>Sharing receipts & earlier updates</strong><small>Exact deliveries, the full conversation and round details</small></span></summary><div class="disclosure-body">' + receipts + history + '<details data-disclosure-id="participant-round-details"><summary>Round details</summary><p class="muted">' + escapeHtml(modeDisclosure) + '</p><span class="tag">Research ' + (session.researchConsent ? 'on' : 'off') + '</span><span class="tag mono">Epoch ' + escapeHtml(session.epoch) + '</span></details></div></details></div>';
}
