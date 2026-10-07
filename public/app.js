import { mountBobConfig } from './bob-config.js';
import { mountModelConfig } from './model-config.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const textValue = value => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const sessionKey = 'agent-on-request.session';
const pendingKey = 'agent-on-request.pending';
let meta, current, participantToken, adminToken, adminState, selectedSessionId, activeView = 'participant', configController, modelController;
let adminSessions = [], research = null, dialogContext = null, dialogOpener = null, requestBusy = false, interruptBusy = false, requestSequence = 0, interruptSequence = 0, pollBusy = false, planningNewRound = false;
let pending = readStorage(pendingKey);
const local = { mode: 'controlled', consent: false, initial: null, additional: null, preview: null, previewStage: null, previewChoice: null, prediction: null, revocation: null, predictionSubmitted: false, revocationSubmitted: false };
const researchFilters = { mode: 'all', status: 'all', quality: 'all' };

function readStorage(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
function writeStorage(key, value) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory operation remains available when session storage is blocked. */ } }
function rememberSession(token, state) { if (current?.session.id !== state.session.id) { requestSequence++; interruptSequence++; requestBusy = false; interruptBusy = false; } participantToken = token; current = state; writeStorage(sessionKey, { id: state.session.id, token }); }
function rememberPending(value) { pending = value; writeStorage(pendingKey, value); }
const isInterrupt = action => action === 'end' || action === 'stop_sharing';
function removePendingRequest(requestId) {
  // Only request IDs and their original action bodies are retained. A restriction
  // may preempt one unresolved action without losing either idempotency identity.
  const remove = value => {
    if (!value) return null;
    if (value.requestId === requestId) return remove(value.prior);
    const next = { ...value }; const prior = remove(value.prior);
    if (prior) next.prior = prior; else delete next.prior;
    return next;
  };
  rememberPending(remove(pending));
}
function newRequestId() { return globalThis.crypto?.randomUUID?.() || 'request-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
function notify(message, kind = '') { $('global-notice').textContent = message; $('global-notice').className = 'notice ' + kind; $('global-notice').hidden = !message; }

class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK', details) { super(message); this.status = status; this.code = code; this.details = details; }
}
async function api(path, { method = 'GET', body, admin = path.startsWith('/api/admin/'), token, auth = true } = {}) {
  const bearer = token ?? (admin ? adminToken : participantToken);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && bearer) headers.Authorization = 'Bearer ' + bearer;
  let response;
  try { response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
  catch { throw new ApiError('The connection was interrupted. The outcome of a submitted action may be unknown.'); }
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) {
    if (admin && response.status === 401) clearAdmin();
    throw new ApiError(value.error?.message || 'Request failed (' + response.status + ').', response.status, value.error?.code || 'HTTP_ERROR', value.error?.details);
  }
  return value;
}
function clearAdmin() {
  adminToken = null; adminState = null; adminSessions = []; research = null;
  document.querySelectorAll('[data-admin-nav]').forEach(node => { node.hidden = true; });
  $('admin-logout').hidden = true; $('admin-open').textContent = 'Researcher sign in';
  configController?.clear();
  modelController?.clear();
  if (activeView !== 'participant') setView('participant');
}
function setView(view) {
  if (view !== 'participant' && !adminToken) { openAdminDialog(); return; }
  if (activeView === 'models' && view !== 'models') modelController?.clearSecret();
  activeView = view;
  for (const name of ['participant', 'console', 'config', 'models', 'research']) $(name + '-view').hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(button => { button.toggleAttribute('aria-current', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); });
  if (view === 'console') loadAdminSessions();
  if (view === 'config') configController.load(selectedSessionId || current?.session.id);
  if (view === 'models') modelController.load();
  if (view === 'research') loadResearch();
}
function stateCanAdvance(next, previous) {
  if (!previous || next.session.id !== previous.session.id) return true;
  if (next.session.epoch < previous.session.epoch || next.session.version < previous.session.version) return false;
  if (previous.session.ended && !next.session.ended || previous.alice?.stopped && !next.alice?.stopped) return false;
  if (next.session.version === previous.session.version && previous.session.paused && !next.session.paused) return false;
  return true;
}
function applyState(state) {
  if (!state?.session) return;
  if (current && state.session.id === current.session.id && stateCanAdvance(state, current)) { current = state; renderParticipant(); }
  if (state.session.id === selectedSessionId && stateCanAdvance(state, adminState)) { adminState = state; if (activeView === 'console') renderConsole(); }
}
function clearPreview() { local.preview = null; local.previewStage = null; local.previewChoice = null; }
function modeLabel(mode) { return meta?.modes?.find(item => item.id === mode)?.label || mode; }
function modeDisclosure(mode) {
  const item = meta?.modes?.find(entry => entry.id === mode);
  if (mode === 'live' && !planningNewRound && current?.session.mode === 'live' && current.models?.disclosure) return current.models.disclosure;
  if (mode === 'live') return meta?.live?.disclosure || item?.description || 'Live model mode; the configured external provider receives the information described by the researcher.';
  return item?.description || (mode === 'replay' ? 'A labelled saved trace. Replay is not a new live collaboration.' : 'Controlled mode uses local deterministic agent planning.');
}
function tableRows(rows, className = '') {
  if (!Array.isArray(rows) || !rows.length) return '<p class="muted">No calendar rows in this payload.</p>';
  const priority = ['day', 'time', 'status', 'title', 'note', 'start', 'end'];
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].sort((a, b) => (priority.indexOf(a) < 0 ? 50 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 50 : priority.indexOf(b)));
  return '<div class="table-wrap"><table class="' + className + '"><thead><tr>' + columns.map(key => '<th scope="col">' + escapeHtml(key) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + columns.map(key => '<td>' + escapeHtml(row[key] === undefined ? '—' : typeof row[key] === 'object' ? textValue(row[key]) : row[key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
function calendarHtml() {
  const rows = current?.alice?.calendar || [];
  return '<section class="panel"><div class="panel-heading"><h3>Alice’s fictional calendar</h3><span class="tag">Synthetic data</span></div>' + tableRows(rows, 'calendar-table') + '<p class="private-label" style="margin-top:12px">Event titles and notes are fictional private information. Only your confirmed snapshot can be sent to Bob.</p></section>';
}
function renderStart() {
  const modes = meta?.modes || [];
  const selected = modes.find(mode => mode.id === local.mode);
  const ready = meta && selected?.available && meta.runtime?.alice?.online !== false && meta.runtime?.bob?.online !== false;
  $('participant-view').innerHTML = '<section class="panel"><p class="eyebrow">A short, fictional collaboration</p><h1>What may your agent share?</h1><p class="lead">You control Alice. Help her arrange a 30-minute discussion with Bob, then compare what you approved with what Bob actually received. Sharing less, declining and ending the demo are complete outcomes.</p><div class="identity-grid"><div class="identity"><strong>Your agent · Alice</strong><small>Your chosen fields and time window</small></div><div class="identity"><strong>Other agent · Bob</strong><small>Separate identity, calendar and permissions</small></div></div><div class="split-layout"><fieldset><legend>Run mode</legend><div class="choices">' + modes.map(mode => '<label class="choice' + (!mode.available ? ' dimmed' : '') + '"><input type="radio" name="start-mode" value="' + escapeHtml(mode.id) + '" ' + (local.mode === mode.id ? 'checked ' : '') + (!mode.available ? 'disabled ' : '') + '><span><strong>' + escapeHtml(mode.label) + '</strong><small>' + escapeHtml(mode.description) + (!mode.available ? ' · unavailable' : '') + '</small></span></label>').join('') + '</div></fieldset><div><h3>Research recording is your choice</h3><label class="check"><input id="start-consent" type="checkbox" ' + (local.consent ? 'checked ' : '') + (local.mode === 'replay' ? 'disabled ' : '') + '><span>Allow my choices and understanding answers to be recorded for this research demo.<small>No name or account is requested. Sharing permission is a separate decision. Without consent, no research record is written. Session state remains in memory until replacement, reset or expiry.</small></span></label><div class="notice">' + escapeHtml(modeDisclosure(local.mode)) + '</div><small>Consent version: ' + escapeHtml(meta?.consentVersion || 'Loading') + '</small></div></div><div class="toolbar section-actions"><button class="button primary" data-participant-action="start" ' + (!ready || requestBusy ? 'disabled' : '') + '>' + (requestBusy ? 'Starting isolated agents…' : 'Start the demo') + '</button><span class="muted">' + (!ready ? 'Waiting for an available mode and both agents.' : 'About 3–5 minutes · no personal calendar access') + '</span></div></section>';
}
function choicesHtml(stage) {
  const initial = stage === 'initial';
  const choices = initial ? [
    ['free', 'Free times only', 'Only free time intervals on Tuesday and Wednesday.'],
    ['busy', 'Free / busy status', 'Time intervals and their free or busy status on Tuesday and Wednesday.'],
    ['full', 'Calendar titles and notes', 'All calendar information on Tuesday and Wednesday.'],
    ['none', 'Share nothing', 'Decline calendar sharing and end this collaboration.']
  ] : [
    ['keep', 'Keep the current scope', 'Send no new calendar information. Bob will respect this boundary.'],
    ['narrow', 'Thursday free times only', 'Add only free intervals on Thursday.'],
    ['week', 'Full weekly calendar', 'Share event titles, notes and time intervals for the full week.']
  ];
  const selected = local[stage];
  const preview = local.previewStage === stage && local.previewChoice === selected ? local.preview : null;
  const stale = preview && preview.sessionVersion !== current.session.version;
  const blocked = requestBusy || interruptBusy || Boolean(pending) || current.session.paused || current.alice.stopped;
  return '<section class="panel"><fieldset ' + (blocked ? 'disabled' : '') + '><legend>' + (initial ? 'What may Alice send to Bob?' : 'Bob is requesting a wider time window') + '</legend><p class="muted" style="margin-bottom:13px">' + (initial ? 'Choose a field set for Tuesday–Wednesday. Nothing is selected by default.' : 'Review the new request independently. A wider scope is optional.') + '</p><div class="choices">' + choices.map(([value, title, detail]) => '<label class="choice"><input type="radio" name="' + stage + '-choice" value="' + value + '" ' + (selected === value ? 'checked' : '') + '><span><strong>' + title + '</strong><small>' + detail + '</small></span></label>').join('') + '</div></fieldset><div class="toolbar section-actions"><button class="button" data-participant-action="preview" data-stage="' + stage + '" ' + (!selected || blocked ? 'disabled' : '') + '>Preview exact information</button><span class="muted">Previewing does not authorize or send.</span></div>' + (preview ? '<div class="preview-box"><div class="panel-heading"><h3>Exact snapshot · recipient Bob</h3><span class="tag">Not yet sent</span></div><dl class="definition-list"><dt>Fields</dt><dd>' + escapeHtml(preview.fields?.join(', ') || 'None') + '</dd><dt>Time window</dt><dd>' + escapeHtml(textValue(preview.window)) + '</dd></dl>' + tableRows(preview.rows) + '<details><summary>Inspect exact payload and fingerprint</summary><pre>' + escapeHtml(JSON.stringify({ fields: preview.fields, window: preview.window, rows: preview.rows }, null, 2)) + '</pre><code>' + escapeHtml(preview.payloadHash) + '</code></details>' + (stale ? '<div class="notice warning">The session changed. Preview again before confirming; this snapshot will not be sent.</div>' : '') + '<div class="toolbar section-actions"><button class="button primary" data-participant-action="confirm" data-stage="' + stage + '" ' + (blocked || stale ? 'disabled' : '') + '>' + (initial && selected === 'none' ? 'Confirm no sharing' : !initial && selected === 'keep' ? 'Confirm current boundary' : 'Confirm and send this snapshot') + '</button></div></div>' : '') + '</section>';
}
function receiptsHtml() {
  const incoming = current.receipts?.aliceToBob || [], outgoing = current.receipts?.bobToAlice || [];
  if (!incoming.length && !outgoing.length) return '<section class="panel"><h3>Shared information receipt</h3><p class="empty">Nothing has been received yet. Choosing or previewing information does not count as delivery.</p></section>';
  return '<section class="panel"><div class="panel-heading"><h3>Approved → actually received</h3><span class="tag">Server receipts</span></div>' + incoming.map(receipt => '<article class="receipt"><div class="receipt-header"><strong>Alice → Bob</strong><span class="tag ' + (receipt.status === 'received' ? 'good' : 'warn') + '">' + escapeHtml(receipt.status) + '</span></div><dl class="definition-list"><dt>Approved fields</dt><dd>' + escapeHtml(receipt.fields?.join(', ') || 'None') + '</dd><dt>Approved window</dt><dd>' + escapeHtml(textValue(receipt.window)) + '</dd><dt>Received payload</dt><dd>' + (receipt.status === 'received' ? 'Exact snapshot below' : 'Not confirmed received') + '</dd></dl>' + (receipt.status === 'received' ? tableRows(receipt.rows) : '') + '<details><summary>Receipt identity and exact content</summary><pre>' + escapeHtml(JSON.stringify(receipt, null, 2)) + '</pre></details></article>').join('') + outgoing.map(receipt => '<article class="receipt"><div class="receipt-header"><strong>Bob → Alice</strong><span class="tag ' + (receipt.status === 'received' ? 'good' : 'warn') + '">' + escapeHtml(receipt.status) + '</span></div><p>Fields: ' + escapeHtml(receipt.fields?.join(', ') || 'None') + '</p><pre>' + escapeHtml(JSON.stringify(receipt.values, null, 2)) + '</pre><details><summary>Exact receipt</summary><pre>' + escapeHtml(JSON.stringify(receipt, null, 2)) + '</pre></details></article>').join('') + '</section>';
}
function questionsHtml() {
  if (!current.task?.outcome || current.session.mode === 'replay') return '';
  return '<section class="panel"><h3>Check your understanding</h3><p class="muted" style="margin:6px 0 12px">Optional. Answers are recorded only when research consent is on.</p><fieldset ' + (local.predictionSubmitted || current.session.ended ? 'disabled' : '') + '><legend>Could Bob read entries outside the scope you approved?</legend><div class="choices">' + [['approved_snapshot', 'Only the approved snapshot'], ['outside_scope', 'Entries outside the approved scope too'], ['not_sure', 'I am not sure']].map(([value, text]) => '<label class="choice"><input type="radio" name="prediction-answer" value="' + value + '" ' + (local.prediction === value ? 'checked' : '') + '><span>' + text + '</span></label>').join('') + '</div></fieldset><button class="button section-actions" data-participant-action="answer_prediction" ' + (!local.prediction || local.predictionSubmitted || requestBusy || interruptBusy || pending || current.session.ended ? 'disabled' : '') + '>' + (local.predictionSubmitted ? 'Answer received' : 'Submit answer') + '</button><fieldset style="margin-top:21px" ' + (local.revocationSubmitted || current.session.ended ? 'disabled' : '') + '><legend>What does stopping future sharing do?</legend><div class="choices">' + [['future_only', 'Stops new sharing; already received information remains'], ['delete_received', 'Deletes information already received by Bob'], ['not_sure', 'I am not sure']].map(([value, text]) => '<label class="choice"><input type="radio" name="revocation-answer" value="' + value + '" ' + (local.revocation === value ? 'checked' : '') + '><span>' + text + '</span></label>').join('') + '</div></fieldset><button class="button section-actions" data-participant-action="answer_revocation" ' + (!local.revocation || local.revocationSubmitted || requestBusy || interruptBusy || pending || current.session.ended ? 'disabled' : '') + '>' + (local.revocationSubmitted ? 'Answer received' : 'Submit answer') + '</button></section>';
}
function renderParticipant() {
  if (!current || planningNewRound) { renderStart(); return; }
  const session = current.session;
  if (current.answers?.received_scope) { local.prediction = current.answers.received_scope; local.predictionSubmitted = true; }
  if (current.answers?.withdrawal) { local.revocation = current.answers.withdrawal; local.revocationSubmitted = true; }
  $('runtime-status').textContent = 'Alice: ' + (current.runtime?.alice?.online ? 'ready' : 'offline') + ' · Bob: ' + (current.runtime?.bob?.online ? 'ready' : 'offline');
  const hasPending = pending?.sessionId === session.id;
  const endingPending = hasPending && pending.body.action === 'end';
  const stoppingPending = hasPending && pending.body.action === 'stop_sharing';
  $('end-confirm').disabled = interruptBusy;
  const messages = current.messages || [];
  let outcome = '';
  if (endingPending) outcome = '<h2>Waiting for End confirmation</h2><p class="lead">The restriction request is still being confirmed. The receipt history preserves what had actually arrived.</p>';
  else if (session.ended) outcome = '<h2>This demo has ended</h2><p class="lead">No further information will be sent. The receipts show what had already been delivered.</p>';
  else if (session.mode === 'replay' && current.task?.outcome) outcome = '<h2>Replay complete</h2><p class="lead">This saved trace illustrates a collaboration. It did not send a new payload or arrange a live meeting.</p>';
  else if (current.task?.outcome === 'arranged') outcome = '<h2>Discussion arranged</h2><p class="lead">' + escapeHtml(current.task.meeting?.day || '') + ' · ' + escapeHtml(current.task.meeting?.time || '') + '. Review what each agent actually received.</p>';
  else if (current.task?.outcome === 'boundary_kept') outcome = '<h2>Your boundary was kept</h2><p class="lead">No meeting was arranged with the information available. The wider sharing request was declined.</p>';
  else if (current.task?.outcome === 'declined') outcome = '<h2>Calendar sharing declined</h2><p class="lead">Your decision completed this collaboration. No calendar information was authorized.</p>';
  else if (current.task?.outcome === 'ended' || session.ended) outcome = '<h2>This demo has ended</h2><p class="lead">No further information will be sent. The receipts show what had already been delivered.</p>';
  const waiting = current.waiting;
  const approvalPending = current.pendingApprovals?.some(item => item.status === 'pending');
  const heading = session.stage === 'initial' ? 'Choose Alice’s sharing boundary' : session.stage === 'additional' ? 'Review Bob’s additional request' : session.stage === 'replay' ? 'Labelled replay' : 'Your collaboration';
  $('participant-view').innerHTML = '<div class="panel-heading"><div><p class="eyebrow">' + escapeHtml(modeLabel(session.mode)) + ' · fictional scenario</p><h2>' + heading + '</h2></div><div class="toolbar"><span class="tag">Research ' + (session.researchConsent ? 'on' : 'off') + '</span><span class="tag mono">Epoch ' + escapeHtml(session.epoch) + '</span>' + (endingPending ? '<span class="tag warn">End needs confirmation</span>' : !session.ended ? '<button class="button quiet" data-participant-action="end" ' + (interruptBusy ? 'disabled' : '') + '>End this demo</button>' + (!current.alice.stopped && session.mode !== 'replay' ? '<button class="button" data-participant-action="stop_sharing" ' + (interruptBusy ? 'disabled' : '') + '>Stop future sharing</button>' : '') : '<button class="button" data-participant-action="fresh" ' + (requestBusy || interruptBusy || pending ? 'disabled' : '') + '>New demo</button>') + '</div></div><div class="step-bar"><span class="step ' + (session.stage === 'initial' ? 'current' : '') + '">Choose scope</span><span class="step ' + (session.stage === 'additional' ? 'current' : '') + '">Additional request</span><span class="step ' + (session.stage === 'complete' ? 'current' : '') + '">Review receipts</span></div><small style="margin-bottom:15px">' + escapeHtml(modeDisclosure(session.mode)) + '</small>' + (hasPending ? '<div class="notice warning" role="status"><strong>Submission outcome needs verification</strong><p>The same request ID and intent are retained. No changed sharing choice will be resubmitted automatically.</p><div class="toolbar"><button class="button" data-participant-action="verify_pending" ' + (interruptBusy || requestBusy && !isInterrupt(pending?.body?.action) ? 'disabled' : '') + '>Verify the same submission</button><button class="button" data-participant-action="refresh">Check session state</button></div></div>' : '') + (current.alice?.stopped ? '<div class="notice">' + (stoppingPending ? 'Waiting for Stop confirmation. ' : 'Future Alice sharing is stopped. ') + 'Previously received snapshots remain in the receipt history.</div>' : '') + (waiting || session.paused ? '<div class="notice warning" role="status"><strong>' + (session.paused ? 'Collaboration paused' : 'Waiting') + '</strong><p>' + escapeHtml(waiting?.message || 'The researcher paused this round. Your current step and received information are preserved.') + '</p>' + (approvalPending || waiting?.reason === 'admin' || waiting?.reason === 'configuration_changed' ? '<div class="toolbar"><button class="button" data-participant-action="admin_review">Open researcher review window</button><span class="muted">Closing it leaves the request pending.</span></div>' : '') + '</div>' : '') + (outcome ? '<section class="panel">' + outcome + '<div class="toolbar">' + (!session.ended ? '<button class="button quiet" data-participant-action="end" ' + (interruptBusy ? 'disabled' : '') + '>End this demo</button>' : '') + '</div></section>' : '') + '<div class="split-layout"><div class="stack">' + (!session.ended && !session.paused && !waiting && ['initial', 'additional'].includes(session.stage) ? choicesHtml(session.stage) : '') + (session.stage === 'replay' ? '<section class="panel"><h3>Saved trace · replay</h3><p class="muted">Source: ' + escapeHtml(current.replay?.source || 'Saved replay') + ' · step ' + escapeHtml(current.replay?.index ?? 0) + ' / ' + escapeHtml(current.replay?.total ?? 0) + '</p><button class="button primary section-actions" data-participant-action="replay_next" ' + (requestBusy || interruptBusy || pending || session.ended || (current.replay?.index ?? 0) >= (current.replay?.total ?? 0) ? 'disabled' : '') + '>Next replay step</button></section>' : '') + receiptsHtml() + questionsHtml() + '</div><div class="stack">' + calendarHtml() + '<section class="panel"><div class="panel-heading"><h3>Agent conversation</h3><span class="tag">Bob r' + escapeHtml(current.bob?.configRevision) + '</span></div><ol class="conversation">' + messages.slice(-8).map(message => '<li class="message" data-from="' + escapeHtml(message.from) + '"><header><strong>' + escapeHtml(message.from) + '</strong><span>' + escapeHtml(message.kind || '') + '</span></header><p>' + escapeHtml(message.text) + '</p></li>').join('') + '</ol>' + (!messages.length ? '<p class="empty">No messages yet.</p>' : '') + '</section></div></div>';
}

async function startSession() {
  if (requestBusy || interruptBusy) return;
  requestBusy = true; renderParticipant();
  try {
    const previous = current ? { previousSessionId: current.session.id, previousToken: participantToken } : {};
    const result = await api('/api/sessions', { method: 'POST', auth: false, body: { mode: local.mode, researchConsent: local.mode !== 'replay' && local.consent, ...previous } });
    rememberPending(null); rememberSession(result.token, result.state); planningNewRound = false; clearPreview(); local.initial = null; local.additional = null; local.prediction = null; local.revocation = null; local.predictionSubmitted = false; local.revocationSubmitted = false;
    if (!selectedSessionId || selectedSessionId === previous.previousSessionId) selectedSessionId = current.session.id; notify('');
  } catch (error) { notify(error.message, 'error'); }
  finally { requestBusy = false; renderParticipant(); }
}
async function refreshCurrent({ quiet = false } = {}) {
  if (!current || !participantToken) return;
  const sessionId = current.session.id, token = participantToken;
  try {
    const next = await api('/api/sessions/' + encodeURIComponent(sessionId), { token });
    if (current?.session.id !== sessionId || participantToken !== token) return;
    if (JSON.stringify(next) !== JSON.stringify(current)) applyState(next);
  } catch (error) {
    if (current?.session.id !== sessionId || participantToken !== token) return;
    if ([401, 404, 410].includes(error.status)) { current = null; participantToken = null; local.consent = false; planningNewRound = false; rememberPending(null); writeStorage(sessionKey, null); clearPreview(); notify('This in-memory session is no longer available. A server restart or round reset ends the old round; start a new demo.', 'warning'); renderParticipant(); }
    else if (!quiet) notify(error.message, 'warning');
  }
}
async function previewChoice(stage) {
  if (!current || !local[stage] || requestBusy || interruptBusy || pending) return;
  const sequence = ++requestSequence, sessionId = current.session.id, choice = local[stage];
  requestBusy = true; renderParticipant();
  try { const preview = await api('/api/sessions/' + encodeURIComponent(sessionId) + '/preview', { method: 'POST', body: { stage, choice } }); if (sequence !== requestSequence || current?.session.id !== sessionId || current.session.ended || current.alice.stopped || interruptBusy) return; local.preview = preview; local.previewStage = stage; local.previewChoice = choice; notify(''); }
  catch (error) { if (sequence === requestSequence && current?.session.id === sessionId && !interruptBusy) notify(error.message, 'error'); }
  finally { if (sequence === requestSequence) requestBusy = false; renderParticipant(); }
}
async function performInterrupt(actionName, { repeat = false } = {}) {
  if (!current || interruptBusy) return;
  if (pending?.body?.action === 'end' && actionName !== 'end') return;
  const previous = pending?.sessionId === current.session.id ? pending : null;
  const submission = repeat || previous?.body?.action === actionName ? previous : { sessionId: current.session.id, requestId: newRequestId(), body: { action: actionName, expectedVersion: current.session.version }, ...(previous ? { prior: previous } : {}) };
  if (!submission || submission.sessionId !== current.session.id) return;
  submission.body.requestId = submission.requestId;
  rememberPending(submission); interruptBusy = true; const sequence = ++interruptSequence; renderParticipant();
  try {
    const result = await api('/api/sessions/' + encodeURIComponent(submission.sessionId) + '/actions', { method: 'POST', body: submission.body });
    if (sequence !== interruptSequence || current?.session.id !== submission.sessionId) return;
    applyState(result.state);
    const confirmed = actionName === 'end' ? result.state?.session.ended : result.state?.alice.stopped;
    if (confirmed) {
      rememberPending(null); clearPreview(); requestSequence++; requestBusy = false;
      notify('');
    } else notify('The restriction is not yet confirmed. Verify the same submission; received information remains in the receipt history.', 'warning');
  } catch (error) {
    if (sequence !== interruptSequence || current?.session.id !== submission.sessionId) return;
    if (error.status >= 400 && error.status < 500) {
      removePendingRequest(submission.requestId); await refreshCurrent({ quiet: true });
      notify(error.status === 409 ? 'The session changed before this restriction was accepted. Review its current state and choose End or Stop again; nothing was automatically resent.' : error.message, 'warning');
    } else {
      await refreshCurrent({ quiet: true });
      notify('The restriction outcome is unknown. Verify the same submission. The original sharing request ID is retained, and previously received copies remain.', 'warning');
    }
  } finally { if (sequence === interruptSequence) interruptBusy = false; renderParticipant(); }
}
async function performAction(actionName, extra = {}, { repeat = false } = {}) {
  if (isInterrupt(actionName)) return performInterrupt(actionName, { repeat });
  if (!current || requestBusy || interruptBusy) return;
  if (pending && !repeat) { notify('Verify the unresolved submission before starting a different action.', 'warning'); return; }
  const submission = repeat ? pending : { sessionId: current.session.id, requestId: newRequestId(), body: { action: actionName, ...extra, expectedVersion: local.preview && ['share_initial', 'respond_additional'].includes(actionName) ? local.preview.sessionVersion : current.session.version } };
  if (!submission || submission.sessionId !== current.session.id) return;
  submission.body.requestId = submission.requestId;
  const sequence = ++requestSequence;
  rememberPending(submission); clearPreview(); requestBusy = true; renderParticipant();
  try {
    const result = await api('/api/sessions/' + encodeURIComponent(submission.sessionId) + '/actions', { method: 'POST', body: submission.body });
    if (sequence !== requestSequence || current?.session.id !== submission.sessionId) return;
    removePendingRequest(submission.requestId); clearPreview(); if (submission.body.action === 'answer_prediction') local.predictionSubmitted = true; if (submission.body.action === 'answer_revocation') local.revocationSubmitted = true; applyState(result.state); if (!interruptBusy && !isInterrupt(pending?.body?.action)) notify('');
  } catch (error) {
    if (sequence !== requestSequence || current?.session.id !== submission.sessionId) return;
    if (error.status >= 400 && error.status < 500) { removePendingRequest(submission.requestId); clearPreview(); await refreshCurrent({ quiet: true }); if (!interruptBusy && !isInterrupt(pending?.body?.action)) notify(error.status === 409 ? 'The request or approval changed. Nothing was automatically resubmitted. Review the current state and make a new deliberate choice.' : error.message, 'warning'); }
    else { if (!interruptBusy && !isInterrupt(pending?.body?.action)) notify(error.message + ' Use “Verify the same submission” to check the original request; its scope will not change.', 'warning'); await refreshCurrent({ quiet: true }); }
  } finally { if (sequence === requestSequence) requestBusy = false; renderParticipant(); }
}

$('participant-view').addEventListener('change', event => {
  const input = event.target;
  if (input.name === 'start-mode') { local.mode = input.value; if (local.mode === 'replay') local.consent = false; renderStart(); }
  if (input.id === 'start-consent') local.consent = input.checked;
  if (input.name === 'initial-choice' || input.name === 'additional-choice') { local[input.name.split('-')[0]] = input.value; clearPreview(); renderParticipant(); }
  if (input.name === 'prediction-answer') { local.prediction = input.value; renderParticipant(); }
  if (input.name === 'revocation-answer') { local.revocation = input.value; renderParticipant(); }
});
$('participant-view').addEventListener('click', event => {
  const button = event.target.closest('[data-participant-action]'); if (!button || button.disabled) return;
  const actionName = button.dataset.participantAction;
  if (actionName === 'start') startSession();
  else if (actionName === 'fresh') { if (requestBusy || interruptBusy || pending) return; local.mode = current?.session.mode || 'controlled'; local.consent = false; planningNewRound = true; rememberPending(null); clearPreview(); renderParticipant(); }
  else if (actionName === 'preview') previewChoice(button.dataset.stage);
  else if (actionName === 'confirm') { const stage = button.dataset.stage; if (local.preview && local.previewStage === stage) performAction(stage === 'initial' ? 'share_initial' : 'respond_additional', { choice: local[stage], previewHash: local.preview.payloadHash }); }
  else if (actionName === 'verify_pending') performAction(pending?.body?.action, {}, { repeat: true });
  else if (actionName === 'refresh') refreshCurrent();
  else if (actionName === 'admin_review') openAdminDialog({ kind: 'approval', sessionId: current.session.id });
  else if (actionName === 'end') showDialog('end-dialog', button);
  else if (actionName === 'answer_prediction') performAction(actionName, { answer: local.prediction });
  else if (actionName === 'answer_revocation') performAction(actionName, { answer: local.revocation });
  else performAction(actionName);
});
$('end-confirm').addEventListener('click', () => { closeDialog('end-dialog'); performAction('end'); });

function showDialog(id, opener = document.activeElement) {
  dialogOpener = opener; const dialog = $(id); if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector('input:not([type="hidden"]),button,select,textarea')?.focus());
}
function closeDialog(id) { const dialog = $(id); if (dialog.open) dialog.close(); if (dialogOpener?.isConnected) dialogOpener.focus(); else $('admin-open').focus(); if (id === 'admin-dialog') dialogContext = null; }
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog.id); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter(node => !node.hidden && node.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
document.addEventListener('click', event => { const button = event.target.closest('[data-close-dialog]'); if (button) closeDialog(button.dataset.closeDialog); });

function openAdminDialog(context = { kind: 'login' }) {
  dialogContext = context;
  showDialog('admin-dialog');
  if (!adminToken) renderLogin();
  else if (context.kind === 'approval') loadApprovals(context.sessionId);
  else { closeDialog('admin-dialog'); setView('console'); }
}
function renderLogin(message = '') {
  $('admin-dialog-title').textContent = 'Researcher sign in';
  $('admin-dialog-body').innerHTML = '<p class="dialog-note">The researcher controls Bob’s permissions. Alice’s data sharing still requires the participant’s own choice. The token stays in memory.</p><form id="admin-login-form"><label class="field"><span>Researcher PIN</span><input id="admin-pin" type="password" autocomplete="off" required></label>' + (message ? '<div class="notice error" role="alert">' + escapeHtml(message) + '</div>' : '') + '<div class="toolbar dialog-actions"><button class="button" type="button" data-close-dialog="admin-dialog">Cancel</button><button class="button primary" type="submit">Sign in</button></div></form>';
  requestAnimationFrame(() => $('admin-pin')?.focus());
}
$('admin-dialog-body').addEventListener('submit', async event => {
  if (event.target.id !== 'admin-login-form') return;
  event.preventDefault(); const pin = $('admin-pin').value; $('admin-pin').value = ''; const context = dialogContext;
  event.target.querySelectorAll('button,input').forEach(node => { node.disabled = true; });
  try {
    const result = await api('/api/admin/login', { method: 'POST', auth: false, body: { pin } }); adminToken = result.token;
    document.querySelectorAll('[data-admin-nav]').forEach(node => { node.hidden = false; }); $('admin-logout').hidden = false; $('admin-open').textContent = 'Researcher tools';
    selectedSessionId ||= current?.session.id;
    if (context?.kind === 'approval') await loadApprovals(context.sessionId); else closeDialog('admin-dialog');
  } catch (error) { renderLogin(error.message); }
});
async function loadApprovals(sessionId) {
  if (!adminToken || !sessionId) return;
  dialogContext = { kind: 'approval', sessionId }; $('admin-dialog-title').textContent = 'Bob authorization · researcher review'; $('admin-dialog-body').innerHTML = '<p class="loading">Loading the immutable pending request…</p>';
  try {
    const result = await api('/api/admin/sessions/' + encodeURIComponent(sessionId) + '/approvals');
    if (!dialogContext || dialogContext.sessionId !== sessionId || !$('admin-dialog').open) return;
    const approvals = result.approvals.filter(item => item.status === 'pending'); dialogContext.approvals = approvals;
    if (!approvals.length) { $('admin-dialog-body').innerHTML = '<p>No pending Bob approval. Closing this window returns to the unchanged participant step.</p><div class="toolbar dialog-actions"><button class="button" data-close-dialog="admin-dialog">Return</button></div>'; return; }
    renderApproval(approvals[0]);
  } catch (error) { $('admin-dialog-body').innerHTML = '<div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-close-dialog="admin-dialog">Return without deciding</button>'; }
}
function renderApproval(approval, message = '') {
  dialogContext.selected = approval;
  $('admin-dialog-body').innerHTML = '<span class="tag">Owner Bob · Alice consent unchanged</span><h3 style="margin-top:13px">' + escapeHtml(approval.summary) + '</h3><dl class="definition-list"><dt>Recipient</dt><dd>' + escapeHtml(approval.recipient) + '</dd><dt>Purpose</dt><dd>' + escapeHtml(approval.purpose) + '</dd><dt>Resource</dt><dd>' + escapeHtml(approval.resource) + '</dd><dt>Policy revision</dt><dd>' + escapeHtml(approval.policyRevision) + '</dd><dt>Pending request expires</dt><dd>' + escapeHtml(approval.expiresAt ? new Date(approval.expiresAt).toLocaleString() : 'No deadline supplied') + '</dd><dt>Reason</dt><dd>' + escapeHtml(approval.reason || 'Outside Bob’s current permission') + '</dd></dl><fieldset><legend>Fields · narrowing only</legend><div class="approval-fields">' + (approval.fields || []).map((field, index) => '<label class="check"><input type="checkbox" name="approval-field" value="' + escapeHtml(field) + '" checked><span>' + escapeHtml(field) + '</span></label>').join('') + '</div></fieldset><details open><summary>Exact pending values</summary><pre>' + escapeHtml(JSON.stringify(approval.values, null, 2)) + '</pre><code>' + escapeHtml(approval.payloadHash) + '</code></details><div class="form-grid" style="margin-top:14px"><label class="field"><span>Round grant · maximum uses</span><input id="approval-max-uses" type="number" min="1" step="1" value="1"></label><label class="field"><span>Round grant · expiry minutes</span><input id="approval-expiry" type="number" min="1" value="5"></label></div>' + (message ? '<div class="notice error" role="alert">' + escapeHtml(message) + '</div>' : '') + '<p class="dialog-note">One-time approval applies only to this immutable Bob request. A round grant is bounded; neither changes the reusable template or authorizes Alice’s data. Closing leaves the request pending.</p><div class="toolbar dialog-actions"><button class="button" data-approval-decision="deny">Decline Bob’s request</button><button class="button" data-approval-decision="allow_once">Allow once</button><button class="button" data-approval-decision="allow_round">Allow within this round</button></div>';
}
$('admin-dialog-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-approval-decision]'); if (!button || !dialogContext?.selected || button.disabled) return;
  const approval = dialogContext.selected;
  const fields = [...$('admin-dialog-body').querySelectorAll('input[name="approval-field"]:checked')].map(input => input.value);
  const body = { decision: button.dataset.approvalDecision, fields, expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash };
  if (body.decision === 'allow_round') { body.maxUses = Number($('approval-max-uses').value); body.expiryMinutes = Number($('approval-expiry').value); }
  $('admin-dialog-body').querySelectorAll('button,input').forEach(node => { node.disabled = true; });
  try { const result = await api('/api/admin/approvals/' + encodeURIComponent(approval.id) + '/decision', { method: 'POST', body }); applyState(result.state); closeDialog('admin-dialog'); if (activeView === 'console') loadAdminSessions(); }
  catch (error) { if (error.status === 401) { renderLogin('Researcher sign-in expired. Sign in again to review this pending request.'); } else if (error.status === 409) { await loadApprovals(approval.sessionId); notify('The pending Bob request changed. Review its new revision; no decision was automatically resent.', 'warning'); } else renderApproval(approval, error.message); }
});
$('admin-open').addEventListener('click', () => openAdminDialog());
$('admin-logout').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* Clearing local admin capability is still required. */ } clearAdmin(); });
$('app-tabs').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });

async function loadAdminSessions() {
  if (!adminToken) return;
  try {
    const result = await api('/api/admin/sessions'); adminSessions = result.sessions;
    if (!selectedSessionId || !adminSessions.some(session => session.id === selectedSessionId)) selectedSessionId = current && adminSessions.some(session => session.id === current.session.id) ? current.session.id : adminSessions[0]?.id;
    if (selectedSessionId) adminState = await api('/api/sessions/' + encodeURIComponent(selectedSessionId), { admin: true }); else adminState = null;
    renderConsole();
  } catch (error) { notify(error.message, 'error'); }
}
function renderConsole() {
  const state = adminState, session = state?.session;
  const received = state?.receipts?.aliceToBob?.filter(receipt => receipt.status === 'received') || [];
  const submitted = state?.choices?.initial !== null && state?.choices?.initial !== undefined;
  $('console-view').innerHTML = '<div class="panel-heading"><div><h2>Operator console</h2><small>Authenticated researcher · Bob control only</small></div><button class="button" data-console-action="refresh">Refresh sessions</button></div><div class="split-layout"><section class="panel"><h3>In-memory sessions</h3><div class="session-list">' + adminSessions.map(item => '<div class="session-row ' + (item.id === selectedSessionId ? 'selected' : '') + '"><div><strong class="mono">' + escapeHtml(item.id.slice(0, 12)) + ' · epoch ' + escapeHtml(item.epoch) + '</strong><small>' + escapeHtml(modeLabel(item.mode)) + ' · ' + escapeHtml(item.stage) + ' · research ' + (item.researchConsent ? 'on' : 'off') + '</small></div><button class="button" data-console-select="' + escapeHtml(item.id) + '">Inspect</button></div>').join('') + '</div>' + (!adminSessions.length ? '<p class="empty">No current sessions.</p>' : '') + '</section><section class="panel"><h3>Selected round</h3>' + (session ? '<dl class="definition-list"><dt>Session</dt><dd class="mono">' + escapeHtml(session.id) + '</dd><dt>Run mode</dt><dd>' + escapeHtml(modeLabel(session.mode)) + '</dd><dt>Bob config</dt><dd>Active r' + escapeHtml(state.bob.configRevision) + ' · template r' + escapeHtml(state.bob.templateRevision) + '</dd><dt>Research consent</dt><dd>' + (session.researchConsent ? 'On · participant agreed' : 'Off · memory only') + '</dd><dt>Agent stores</dt><dd>Alice / Bob isolated</dd></dl><div class="phase-grid"><div class="phase"><strong>Queued / submitted</strong><small>' + (submitted ? state.choices.initial === 'none' ? 'Sharing declined' : 'Confirmed action' : 'No confirmed action') + '</small></div><div class="phase"><strong>Peer receipt</strong><small>' + received.length + ' actually received</small></div><div class="phase"><strong>Business outcome</strong><small>' + escapeHtml(state.task.outcome || 'Pending') + '</small></div></div>' + (state.waiting ? '<div class="notice warning">' + escapeHtml(state.waiting.message) + '</div>' : '') + '<div class="toolbar"><button class="button" data-console-action="' + (session.paused ? 'resume' : 'pause') + '" ' + (session.ended ? 'disabled' : '') + '>' + (session.paused ? 'Recheck Bob & resume' : 'Pause at safe point') + '</button><button class="button" data-console-action="reset">Start new round</button><button class="button" data-console-action="' + (state.bob.online ? 'disconnect_bob' : 'restore_bob') + '">' + (state.bob.online ? 'Simulate Bob offline' : 'Restore Bob connection') + '</button><button class="button" data-console-action="retry" ' + (session.ended ? 'disabled' : '') + '>Verify / retry same request</button><button class="button" data-console-action="inject_request" ' + (session.ended ? 'disabled' : '') + '>Inject researcher request</button><button class="button" data-console-action="approvals">Review Bob approvals</button><button class="button" data-console-action="config">Configure Bob</button></div><small style="margin-top:14px">Reset clears both stores, revokes the old token and starts research consent off. Consented research records remain. Researcher interventions are recorded separately.</small><details><summary>Actual receipt state</summary><pre>' + escapeHtml(JSON.stringify(state.receipts, null, 2)) + '</pre></details>' : '<p class="empty">Select a current session.</p>') + '</section></div>';
}
$('console-view').addEventListener('click', async event => {
  const select = event.target.closest('[data-console-select]'); if (select) { selectedSessionId = select.dataset.consoleSelect; await loadAdminSessions(); return; }
  const button = event.target.closest('[data-console-action]'); if (!button || button.disabled) return;
  const actionName = button.dataset.consoleAction;
  if (actionName === 'refresh') { loadAdminSessions(); return; }
  if (actionName === 'config') { setView('config'); return; }
  if (actionName === 'approvals') { openAdminDialog({ kind: 'approval', sessionId: selectedSessionId }); return; }
  if (!selectedSessionId) return; button.disabled = true;
  try {
    const oldId = selectedSessionId;
    const result = await api('/api/admin/sessions/' + encodeURIComponent(oldId) + '/intervene', { method: 'POST', body: { action: actionName } });
    if (result.token && current?.session.id === oldId) { rememberSession(result.token, result.state); rememberPending(null); clearPreview(); local.initial = null; local.additional = null; local.prediction = null; local.revocation = null; local.predictionSubmitted = false; local.revocationSubmitted = false; renderParticipant(); }
    else applyState(result.state);
    selectedSessionId = result.state?.session.id || oldId; await loadAdminSessions(); notify('');
  } catch (error) { notify(error.message, 'error'); renderConsole(); }
});

function qualityLabel(value) { return typeof value === 'string' ? value : value?.status || value?.label || textValue(value); }
async function loadResearch() {
  if (!adminToken) return;
  try { research = await api('/api/admin/research'); renderResearch(); } catch (error) { notify(error.message, 'error'); }
}
function renderResearch() {
  if (!research) { $('research-view').innerHTML = '<section class="panel loading">Loading actual consented research runs…</section>'; return; }
  const all = research.runs || [], summary = research.summary || {};
  const filtered = all.filter(run => (researchFilters.mode === 'all' || run.mode === researchFilters.mode) && (researchFilters.status === 'all' || run.status === researchFilters.status) && (researchFilters.quality === 'all' || qualityLabel(run.quality) === researchFilters.quality));
  const optionList = (key, values, label) => '<label class="field"><span>' + label + '</span><select data-research-filter="' + key + '"><option value="all">All</option>' + [...new Set(values)].sort().map(value => '<option value="' + escapeHtml(value) + '" ' + (researchFilters[key] === value ? 'selected' : '') + '>' + escapeHtml(value) + '</option>').join('') + '</select></label>';
  const counts = [...new Set(filtered.map(run => run.mode))].map(mode => ({ mode, count: filtered.filter(run => run.mode === mode).length }));
  const max = Math.max(1, ...counts.map(item => item.count));
  $('research-view').innerHTML = '<div class="panel-heading"><div><h2>Research review</h2><small>Actual consented records only · calendar data is fictional</small></div><div class="toolbar"><button class="button" data-research-action="refresh">Refresh records</button><button class="button" data-research-action="csv">Export CSV</button><button class="button" data-research-action="jsonl">Export JSONL</button></div></div><section class="panel"><div class="summary-grid">' + [['Recorded runs', summary.runs], ['Task outcomes', summary.taskCompleted], ['Closed completed', summary.completed], ['Awaiting end', summary.runsPendingClose]].map(([label, value]) => '<div class="summary-item"><small>' + label + '</small><strong>' + escapeHtml(value ?? '—') + '</strong></div>').join('') + '</div><small>Server totals · stopped: ' + escapeHtml(summary.stopped ?? '—') + ' · technical: ' + escapeHtml(summary.technical ?? '—') + ' · affected by technical issues: ' + escapeHtml(summary.affectedByTechnical ?? '—') + ' · replay excluded: ' + escapeHtml(summary.replayExcluded ?? 0) + '. Unconsented rounds have no research rows.</small><div class="form-grid" style="margin-top:17px">' + optionList('mode', all.map(run => run.mode), 'Mode') + optionList('status', all.map(run => run.status), 'Status') + optionList('quality', all.map(run => qualityLabel(run.quality)), 'Quality') + '</div><h3 style="margin-top:22px">Filtered recorded runs by mode</h3><div class="chart-bars" aria-label="Counts from actual filtered records">' + counts.map(item => '<div class="chart-row"><span>' + escapeHtml(modeLabel(item.mode)) + '</span><div class="chart-track"><div class="chart-fill" style="width:' + item.count / max * 100 + '%"></div></div><span class="chart-value">' + item.count + '</span></div>').join('') + '</div>' + (!filtered.length ? '<p class="empty">No actual consented runs match these filters. No sample measurements are inserted.</p>' : '') + '<table class="research-table"><thead><tr><th>Run</th><th>Started</th><th>Mode</th><th>Config</th><th>Status / quality</th><th>Events</th></tr></thead><tbody>' + filtered.map(run => '<tr><td data-label="Run" class="mono">' + escapeHtml(run.runId) + '</td><td data-label="Started">' + escapeHtml(formatDate(run.startedAt)) + '</td><td data-label="Mode">' + escapeHtml(modeLabel(run.mode)) + '</td><td data-label="Config">r' + escapeHtml(run.configRevision) + '</td><td data-label="Status / quality">' + escapeHtml(run.status) + '<small>' + escapeHtml(qualityLabel(run.quality)) + '</small></td><td data-label="Events">' + (run.events?.length || 0) + '<details><summary>Inspect</summary><pre>' + escapeHtml(JSON.stringify(run.events, null, 2)) + '</pre></details></td></tr>').join('') + '</tbody></table></section>';
}
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString(); }
$('research-view').addEventListener('change', event => { if (event.target.dataset.researchFilter) { researchFilters[event.target.dataset.researchFilter] = event.target.value; renderResearch(); } });
$('research-view').addEventListener('click', async event => {
  const button = event.target.closest('[data-research-action]'); if (!button) return;
  const format = button.dataset.researchAction; if (format === 'refresh') { loadResearch(); return; }
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/research/export?format=' + format, { headers: { Authorization: 'Bearer ' + adminToken }, cache: 'no-store' });
    if (!response.ok) { if (response.status === 401) clearAdmin(); throw new Error('Research export failed (' + response.status + ').'); }
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = 'agent-on-request-research.' + format; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
});

configController = mountBobConfig($('config-view'), { api, getSessionId: () => selectedSessionId || current?.session.id, onApplied: result => { if (result.state) applyState(result.state); if (activeView === 'console') loadAdminSessions(); } });
modelController = mountModelConfig($('models-view'), { api, getCurrentRevision: () => current?.session.modelRevision, onApplied: async () => { try { meta = await api('/api/meta', { auth: false }); if (!current || planningNewRound) renderParticipant(); } catch (error) { notify(error.message, 'error'); } } });

window.addEventListener('pagehide', () => modelController?.clearSecret());

async function boot() {
  try {
    meta = await api('/api/meta', { auth: false });
    $('connection-status').textContent = 'Local demo'; $('connection-status').className = 'tag good';
    $('runtime-status').textContent = 'Alice: ' + (meta.runtime?.alice?.online ? 'ready' : 'offline') + ' · Bob: ' + (meta.runtime?.bob?.online ? 'ready' : 'offline');
    const stored = readStorage(sessionKey);
    if (stored?.id && stored?.token) {
      participantToken = stored.token;
      try { current = await api('/api/sessions/' + encodeURIComponent(stored.id)); selectedSessionId = current.session.id; if (pending?.sessionId !== current.session.id) rememberPending(null); }
      catch (error) { current = null; participantToken = null; writeStorage(sessionKey, null); rememberPending(null); notify('The previous in-memory round is unavailable. Start a new demo; no previous sharing choice will be reconstructed.', 'warning'); }
    } else rememberPending(null);
    renderParticipant();
  } catch (error) { $('connection-status').textContent = 'Unavailable'; $('connection-status').className = 'tag warn'; $('participant-view').innerHTML = '<section class="panel"><h2>Demo service unavailable</h2><p class="lead">' + escapeHtml(error.message) + '</p><button class="button" id="retry-boot">Reconnect</button></section>'; $('retry-boot').addEventListener('click', boot); }
}
setInterval(async () => {
  if (pollBusy || document.hidden) return; pollBusy = true;
  try { if (current) await refreshCurrent({ quiet: true }); if (adminToken && activeView === 'console') await loadAdminSessions(); }
  finally { pollBusy = false; }
}, 2500);
boot();
