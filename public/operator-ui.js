const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = kind => {
  const paths = {
    key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/>',
    shield: '<path d="m12 3 8 3v6c0 5-4 8-8 10-4-2-8-5-8-10V6Z"/><path d="m8 12 3 3 5-6"/>',
    play: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="m10 8 6 4-6 4Z"/>',
    pause: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 8v8m6-8v8"/>',
    send: '<path d="m3 12 18-9-6 18-3-7Z"/><path d="m12 14 9-11"/>',
    receipt: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6m-12 9h8"/>',
    outcome: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    people: '<circle cx="8" cy="8" r="3"/><path d="M2 20v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m2 3a6 6 0 0 1 4 5v2"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[kind] + '</svg>';
};
const disclosure = (id, title, body, subtitle = 'Optional details') => '<details class="operator-detail" data-disclosure-id="' + escapeHtml(id) + '"><summary><span><strong>' + title + '</strong><small>' + subtitle + '</small></span></summary><div class="operator-detail-body">' + body + '</div></details>';

export function renderLoginHtml(message = '') {
  return '<div class="operator-access-intro"><span class="operator-icon operator-violet">' + icon('key') + '</span><div><h3>Manage Bob and review his requests</h3><small>Alice keeps control of her own sharing.</small></div></div>'
    + (message ? '<div class="notice error" role="alert">' + escapeHtml(message) + '</div>' : '')
    + '<form id="admin-login-form"><label class="field"><span>Researcher PIN</span><input id="admin-pin" type="password" autocomplete="off" required></label>'
    + disclosure('researcher-login-role', 'What researcher access allows', '<div class="operator-role-scope"><span class="operator-icon operator-violet">' + icon('shield') + '</span><p>The researcher controls Bob’s permissions. Alice’s data sharing still requires the participant’s own choice. The token stays in memory.</p></div>', 'Role & permission boundary')
    + '<div class="toolbar dialog-actions"><button class="button" type="button" data-close-dialog="admin-dialog">Cancel</button><button class="button primary" type="submit">Sign in</button></div></form>';
}

// Values stay literal, including string whitespace and nested keys. Presentation
// translation must never change what the researcher is actually approving.
function exactValueHtml(value) {
  if (Array.isArray(value)) return value.length ? '<ol class="operator-value-list">' + value.map(item => '<li>' + exactValueHtml(item) + '</li>').join('') + '</ol>' : '<code>[]</code>';
  if (value && typeof value === 'object') return Object.keys(value).length ? '<dl class="operator-value-object">' + Object.entries(value).map(([key, item]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + exactValueHtml(item) + '</dd>').join('') + '</dl>' : '<code>{}</code>';
  if (typeof value === 'string') return '<span class="operator-literal">' + (value === '' ? '""' : escapeHtml(value)) + '</span>';
  return '<code>' + escapeHtml(JSON.stringify(value) ?? 'undefined') + '</code>';
}
function approvalFieldsHtml(approval, selectedFields) {
  const values = approval.values || {};
  const labels = { day: 'Day', time: 'Time', status: 'Status', topic: 'Topic', agenda: 'Agenda', title: 'Title', note: 'Note' };
  const fields = approval.fields || [];
  const card = (field, selectable) => '<article class="operator-value-card" data-approval-value-field="' + escapeHtml(field) + '">' + (selectable ? '<label class="check"><input type="checkbox" name="approval-field" value="' + escapeHtml(field) + '"' + (selectedFields.includes(field) ? ' checked' : '') + '><span><strong' + (labels[field] ? '' : ' data-i18n-ignore') + '>' + escapeHtml(labels[field] || field) + '</strong><small class="mono" data-i18n-ignore>' + escapeHtml(field) + '</small><small class="operator-field-excluded">Excluded from approval</small></span></label>' : '<strong data-i18n-ignore>' + escapeHtml(field) + '</strong>') + '<div class="operator-exact-value" data-i18n-ignore>' + exactValueHtml(values[field]) + '</div></article>';
  return fields.map(field => card(field, true)).join('') + Object.keys(values).filter(field => !fields.includes(field)).map(field => card(field, false)).join('');
}
export function renderApprovalHtml(approval, message = '', { selectedFields = approval.fields || [], maxUses = 1, expiryMinutes = 5 } = {}) {
  const id = 'approval-' + approval.id;
  return '<div class="operator-access-intro"><span class="operator-icon operator-violet">' + icon('shield') + '</span><div><span class="tag">Owner Bob · Alice consent unchanged</span><h3>' + escapeHtml(approval.summary) + '</h3></div></div>'
    + (message ? '<div class="notice error" role="alert">' + escapeHtml(message) + '</div>' : '')
    + '<div class="operator-request-facts"><div><small>Recipient</small><strong>' + escapeHtml(approval.recipient) + '</strong></div><div><small>Purpose</small><strong>' + escapeHtml(approval.purpose) + '</strong></div><div class="operator-request-reason"><small>Reason</small><span>' + escapeHtml(approval.reason || 'Outside Bob’s current permission') + '</span></div></div>'
    + '<fieldset class="operator-approval-values"><legend>Exact content Bob wants to send</legend><p class="muted">Uncheck a field to exclude it. The values below are the pending request.</p><div class="operator-value-grid">' + approvalFieldsHtml(approval, selectedFields) + '</div></fieldset>'
    + '<p class="dialog-note">Allow once applies only to this pending Bob request. Closing leaves it pending.</p><div class="toolbar operator-approval-actions"><button class="button" data-close-dialog="admin-dialog">Return without deciding</button><button class="button danger" data-approval-decision="deny">Decline Bob’s request</button><button class="button primary" data-approval-decision="allow_once">Allow once</button></div>'
    + disclosure(id + '-round-grant', 'Allow matching replies within this round', '<p class="muted">The grant covers only matching selected fields and values for this purpose and resource. It stops at the use limit or expiry.</p><div class="form-grid"><label class="field"><span>Round grant · maximum uses</span><input id="approval-max-uses" type="number" min="1" max="100" step="1" value="' + escapeHtml(maxUses) + '"></label><label class="field"><span>Round grant · expiry minutes</span><input id="approval-expiry" type="number" min="1" max="60" step="any" value="' + escapeHtml(expiryMinutes) + '"></label></div><button class="button section-actions" data-approval-decision="allow_round">Allow within this round</button><small class="operator-boundary-note">A round grant never changes the reusable template or authorizes Alice’s data.</small>', 'Optional · bounded authorization')
    + disclosure(id + '-metadata', 'Request identity & exact JSON', '<dl class="definition-list"><dt>Resource</dt><dd>' + escapeHtml(approval.resource) + '</dd><dt>Policy revision</dt><dd>' + escapeHtml(approval.policyRevision) + '</dd><dt>Pending request expires</dt><dd class="mono" data-i18n-ignore>' + escapeHtml(approval.expiresAt || 'No deadline supplied') + '</dd><dt>Payload hash</dt><dd class="mono" data-i18n-ignore>' + escapeHtml(approval.payloadHash) + '</dd></dl><pre>' + escapeHtml(JSON.stringify(approval.values, null, 2)) + '</pre>', 'Technical details');
}

const consoleButton = (action, label, disabled = false, primary = false) => '<button class="button' + (primary ? ' primary' : '') + '" data-console-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
function signal(kind, tone, title, value) {
  return '<article class="operator-signal operator-' + tone + '"><span class="operator-icon">' + icon(kind) + '</span><div><small>' + title + '</small><strong>' + escapeHtml(value) + '</strong></div></article>';
}
export function renderConsoleHtml({ state, sessions = [], selectedSessionId, loading = false, openControls = false, modeLabel = value => value }) {
  const session = state?.session;
  const received = state?.receipts?.aliceToBob?.filter(receipt => receipt.status === 'received') || [];
  const submitted = state?.choices?.initial !== null && state?.choices?.initial !== undefined;
  const pendingCount = state?.pendingApprovals?.filter(approval => approval.status === 'pending').length || 0;
  const canIntervene = Boolean(session && !session.ended && session.mode !== 'replay');
  const bobSkills = state?.agentStates?.Bob?.skills;
  const canShareBrief = !Array.isArray(bobSkills) || bobSkills.some(skill => skill.id === 'share_brief' && skill.enabled !== false);
  const canInject = canIntervene && !session.paused && !pendingCount && canShareBrief;
  const sessionList = '<div class="session-list">' + sessions.map(item => '<div class="session-row ' + (item.id === selectedSessionId ? 'selected' : '') + '"><div><strong class="mono">' + escapeHtml(item.id.slice(0, 12)) + ' · epoch ' + escapeHtml(item.epoch) + '</strong><small>' + escapeHtml(modeLabel(item.mode)) + ' · ' + escapeHtml(item.stage) + ' · research ' + (item.researchConsent ? 'on' : 'off') + '</small></div><button class="button" data-console-select="' + escapeHtml(item.id) + '">Inspect</button></div>').join('') + '</div>' + (!sessions.length ? '<p class="empty">No current sessions.</p>' : '');
  const header = '<div class="panel-heading"><div><h2>Operator console</h2><small>Watch the selected round, then choose an action.</small></div>' + consoleButton('refresh', 'Refresh sessions') + '</div>';
  const round = session ? '<section class="panel operator-current-round"><div class="operator-round-heading"><span class="operator-icon ' + (session.paused ? 'operator-amber' : 'operator-teal') + '">' + icon(session.paused ? 'pause' : session.ended || session.stage === 'complete' ? 'outcome' : 'play') + '</span><div><p class="eyebrow">Selected round</p><h3>' + (session.ended ? 'Round ended' : session.paused ? 'Round paused' : session.stage === 'complete' ? 'Collaboration complete' : 'Round in progress') + '</h3><small>' + escapeHtml(modeLabel(session.mode)) + ' · ' + escapeHtml(session.stage) + '</small></div><span class="tag ' + (state.bob.online ? 'good' : 'warn') + '">' + (state.bob.online ? 'Bob connected' : 'Bob offline') + '</span></div>'
    + '<div class="operator-signals">' + signal('send', 'blue', 'Queued / submitted', submitted ? state.choices.initial === 'none' ? 'Sharing declined' : 'Confirmed action' : 'No confirmed action') + signal('receipt', 'teal', 'Bob received', received.length + ' actually received') + signal('outcome', 'violet', 'Business outcome', state.task?.outcome || 'Pending') + '</div>'
    + (state.waiting ? '<div class="notice warning">' + escapeHtml(state.waiting.message) + '</div>' : '')
    + '<div class="toolbar operator-main-actions">' + consoleButton(session.paused ? 'resume' : 'pause', session.paused ? 'Recheck Bob & resume' : 'Pause at safe point', !canIntervene, true) + consoleButton('approvals', 'Review Bob approvals') + (pendingCount ? '<span class="tag warn">' + pendingCount + ' pending requests</span>' : '') + consoleButton('reset', 'Start new round') + consoleButton('config', 'Configure Bob') + '</div><small class="operator-boundary-note">A new round clears both stores, revokes the old token and starts consent off.</small></section>' : '<section class="panel"' + (loading ? ' aria-busy="true" role="status"' : '') + '><div class="operator-access-intro"><span class="operator-icon operator-blue">' + icon('people') + '</span><div><h3>' + (loading ? 'Loading selected round…' : 'No round selected') + '</h3><small>' + (loading ? 'Controls become available after this round is confirmed.' : 'Select a current session.') + '</small></div></div></section>';
  const extras = session ? disclosure('operator-' + session.id + '-troubleshooting', 'Troubleshooting & simulation', '<p class="muted">These controls act on the selected round. Researcher interventions are saved only with research consent.</p><div class="toolbar section-actions">' + consoleButton(state.bob.online ? 'disconnect_bob' : 'restore_bob', state.bob.online ? 'Simulate Bob offline' : 'Restore Bob connection', !canIntervene) + consoleButton('retry', 'Verify / retry same request', !canIntervene || !session.paused) + consoleButton('inject_request', 'Inject researcher request', !canInject) + '</div><small class="operator-boundary-note">' + (!canIntervene ? 'Ended rounds and replay do not accept interventions. Start a new round to continue.' : 'Retry is available only for a paused round. Resolve pending deliveries and approvals before injecting a request.') + '</small>' + (!canShareBrief ? '<small class="operator-boundary-note">Bob’s brief sharing skill is disabled in this round.</small>' : ''), 'Connection, retries & test requests')
    + disclosure('operator-' + session.id + '-identity', 'Round identity & permissions', '<dl class="definition-list"><dt>Session</dt><dd class="mono" data-i18n-ignore>' + escapeHtml(session.id) + '</dd><dt>Run mode</dt><dd>' + escapeHtml(modeLabel(session.mode)) + '</dd><dt>Bob config</dt><dd>Active r' + escapeHtml(state.bob.configRevision) + ' · template r' + escapeHtml(state.bob.templateRevision) + '</dd><dt>Research consent</dt><dd>' + (session.researchConsent ? 'On · participant agreed' : 'Off · memory only') + '</dd><dt>Agent stores</dt><dd>Alice / Bob isolated</dd></dl><p class="muted">' + (openControls ? 'Direct demo controls · Alice sharing still needs confirmation' : 'Authenticated researcher · Bob control only') + '</p><p class="muted">Consented research records remain after a new round. Researcher interventions are recorded separately.</p>', 'IDs, versions & research consent')
    + disclosure('operator-' + session.id + '-receipts', 'Actual receipt state', '<p class="muted">Submitted actions and received content are separate facts.</p><pre>' + escapeHtml(JSON.stringify(state.receipts, null, 2)) + '</pre>', 'Exact receipt JSON') : '';
  return header + round + '<div class="operator-detail-grid">' + disclosure('operator-session-list', 'Switch or inspect another round', sessionList, sessions.length + ' current sessions') + extras + '</div>';
}
