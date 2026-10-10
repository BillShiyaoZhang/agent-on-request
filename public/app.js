import { mountBobConfig } from './bob-config.js';
import { mountModelConfig } from './model-config.js';
import { mountAgentStates } from './agent-state.js';
import { createInitialConditions } from './initial-conditions.js';
import { initLanguageSwitcher } from './i18n.js';
import { renderParticipantHtml, scopeIconHtml } from './participant-ui.js';
import { renderUnderstandingHtml, understandingQuestionForInput } from './understanding.js';
import { renderLoginHtml, renderApprovalHtml, renderConsoleHtml } from './operator-ui.js';
import { rememberDisclosures, restoreDisclosures, observeDisclosures } from './disclosure-state.js';
import { mountResearchReview } from './research-ui.js';
import { renderPerspectiveHtml, renderOntologyHtml, renderContributionHtml } from './ontology-ui.js';
import { renderRecoveryHtml } from './recovery-ui.js';

initLanguageSwitcher();

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const textValue = value => Array.isArray(value) ? value.map(textValue).join(', ') : value && typeof value === 'object' ? Object.entries(value).map(([key, item]) => key + ': ' + textValue(item)).join(' · ') : String(value ?? 'None');
const sessionKey = 'agent-on-request.session';
const pendingKey = 'agent-on-request.pending';
// This is a UI capability marker, not a credential. Only the server's explicit
// local open-controls mode accepts unauthenticated control requests.
const openControlsMarker = 'local-demo-open-controls-access';
let meta, current, participantToken, adminToken, adminState, selectedSessionId, activeView = 'participant', configController, modelController, conditionsController;
let perspective = 'owner', perspectiveBusy = false;
let recoveryBusy = false;
let sessionRestore = null, sessionRestoreBusy = false;
let adminSessions = [], research = null, dialogContext = null, dialogOpener = null, requestBusy = false, interruptBusy = false, requestSequence = 0, interruptSequence = 0, pollBusy = false, planningNewRound = false;
let pending = readStorage(pendingKey);
const local = { mode: 'controlled', ontologyScenario: 'distinct', durationMinutes: 30, consent: false, initial: null, additional: null, preview: null, previewStage: null, previewChoice: null, prediction: null, revocation: null, alignmentAnswer: null, moduleAnswer: null, predictionSubmitted: false, revocationSubmitted: false };
const researchFilters = { mode: 'all', status: 'all', quality: 'all' };
const approvalDrafts = new Map();
let selectedResearchRunId, researchStep = 0;
let participantFocusFrame, participantStepFocusPending = false, participantPreviewFocusPending = false, adminLoadSequence = 0, adminDialogLoadSequence = 0;

function participantFocusSnapshot(view) {
  const node = document.activeElement;
  if (!view.contains(node)) return null;
  if (node.id) return { id: node.id };
  if (node.matches('input[name]')) return { name: node.name, value: node.value };
  if (node.dataset.participantAction) return { action: node.dataset.participantAction, stage: node.dataset.stage };
  return null;
}
function restoreParticipantPosition(view, step, focus) {
  const previous = view.dataset.experienceStep;
  view.dataset.experienceStep = step;
  if (previous && previous !== step && activeView === 'participant') participantStepFocusPending = true;
  cancelAnimationFrame(participantFocusFrame);
  participantFocusFrame = requestAnimationFrame(() => {
    if (activeView !== 'participant' || document.querySelector('dialog[open]')) return;
    if (participantStepFocusPending || participantPreviewFocusPending) {
      const heading = view.querySelector(participantStepFocusPending ? '.experience-heading h2, .start-hero h1' : '.preview-box h3');
      participantStepFocusPending = false; participantPreviewFocusPending = false;
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start', behavior: 'instant' }); }
      return;
    }
    const target = focus?.id ? document.getElementById(focus.id)
      : focus?.name ? [...view.querySelectorAll('input[name]')].find(node => node.name === focus.name && node.value === focus.value)
      : focus?.action ? [...view.querySelectorAll('[data-participant-action]')].find(node => node.dataset.participantAction === focus.action && node.dataset.stage === focus.stage)
      : null;
    if (target && view.contains(target) && !target.disabled) target.focus({ preventScroll: true });
  });
}

function readStorage(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
function writeStorage(key, value) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory operation remains available when session storage is blocked. */ } }
function rememberSession(token, state) { if (current?.session.id !== state.session.id) { requestSequence++; interruptSequence++; requestBusy = false; interruptBusy = false; } sessionRestore = null; participantToken = token; current = state; writeStorage(sessionKey, { id: state.session.id, token }); }
async function restoreParticipantSession({ quiet = false } = {}) {
  if (!sessionRestore || sessionRestoreBusy) return false;
  const target = sessionRestore;
  sessionRestoreBusy = true; renderParticipant();
  try {
    const state = await api('/api/sessions/' + encodeURIComponent(target.id), { token: target.token, admin: false });
    if (sessionRestore !== target) return false;
    perspective = 'owner'; rememberSession(target.token, state); selectedSessionId = state.session.id;
    if (!quiet) notify(''); return true;
  } catch (error) {
    if (sessionRestore !== target) return false;
    if ([401, 404, 410].includes(error.status)) { sessionRestore = null; participantToken = null; writeStorage(sessionKey, null); rememberPending(null); notify('This in-memory session is no longer available. A server restart or round reset ends the old round; start a new demo.', 'warning'); }
    else if (!quiet) notify('The round credential is retained. Check the connection and reload this round; no replacement round was created.', 'warning');
    return false;
  } finally { sessionRestoreBusy = false; renderParticipant(); }
}
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
function notify(message, kind = '') {
  const notice = $('global-notice'); notice.textContent = message; notice.className = 'notice ' + kind; notice.hidden = !message;
  if (message && !document.querySelector('dialog[open]')) { notice.tabIndex = -1; notice.focus({ preventScroll: true }); notice.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
}

class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK', details) { super(message); this.status = status; this.code = code; this.details = details; }
}
async function api(path, { method = 'GET', body, admin = path.startsWith('/api/admin/'), token, auth = true, researcher = false } = {}) {
  const bearer = token ?? (admin ? adminToken : participantToken);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && bearer) headers.Authorization = 'Bearer ' + bearer;
  if (researcher && adminToken) headers['X-Researcher-Token'] = adminToken;
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
function enableControls(token = adminToken) {
  const open = meta?.openControls === true;
  const next = open ? openControlsMarker : token === openControlsMarker ? null : token || null;
  const changed = adminToken !== next;
  adminToken = next;
  document.querySelectorAll('[data-admin-nav]').forEach(node => { node.hidden = !next; });
  $('admin-open').hidden = open;
  $('admin-open').textContent = next ? 'Researcher tools' : 'Researcher sign in';
  $('admin-logout').hidden = open || !next;
  if (next) selectedSessionId ||= current?.session.id;
  if (changed) conditionsController?.authorizationChanged();
  if (!next && activeView !== 'participant') setView('participant');
}
function clearAdmin() {
  if (meta?.openControls) { enableControls(); return; }
  adminLoadSequence++;
  approvalDrafts.clear();
  adminToken = null; adminState = null; adminSessions = []; research = null;
  perspective = 'owner';
  if (current?.perspective === 'observer' && participantToken) {
    sessionRestore = { id: current.session.id, token: participantToken }; current = null;
    renderParticipant(); restoreParticipantSession({ quiet: true });
  }
  enableControls(null);
  configController?.clear();
  modelController?.clear();
  conditionsController?.authorizationChanged();
  if (activeView !== 'participant') setView('participant');
}
function setView(view) {
  if (meta?.openControls && !adminToken) enableControls();
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
  if (current && state.session.id === current.session.id && stateCanAdvance(state, current)) {
    // Administrative mutations may return the full observer state. Only the
    // explicit perspective request may replace this participant view with it.
    if ((state.perspective || 'owner') === perspective) { current = state; renderParticipant(); }
    else refreshCurrent({ quiet: true });
  }
  if (state.session.id === selectedSessionId && stateCanAdvance(state, adminState)) { adminState = state; if (activeView === 'console') renderConsole(); }
}
function clearPreview() { local.preview = null; local.previewStage = null; local.previewChoice = null; participantPreviewFocusPending = false; }
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
  return '<section class="panel calendar-panel"><div class="panel-heading"><h3>Alice’s fictional calendar</h3><span class="tag">Synthetic data</span></div>' + tableRows(rows, 'calendar-table') + '<p class="private-label" style="margin-top:12px">Event titles and notes are fictional private information. Only your confirmed snapshot can be sent to Bob.</p></section>';
}
function renderStart() {
  const focus = participantFocusSnapshot($('participant-view'));
  rememberDisclosures($('participant-view'), $('participant-view').dataset.disclosureScope || 'start');
  $('participant-view').dataset.disclosureScope = 'start';
  $('participant-view').setAttribute('aria-busy', String(requestBusy || interruptBusy));
  const modes = meta?.modes || [];
  const selected = modes.find(mode => mode.id === local.mode);
  const ready = meta && selected?.available && meta.runtime?.alice?.online !== false && meta.runtime?.bob?.online !== false;
  const consentDetailsOpen = $('participant-view').querySelector('.consent-details')?.open;
  const modeCopy = { controlled: ['Guided experience', 'A predictable first round'], live: ['Live models', 'Try model-driven collaboration'], replay: ['Watch a replay', 'Explore a reference example'] };
  const modeShapes = { controlled: '<rect x="7" y="8" width="22" height="22" rx="6"/><path d="m13 19 4 4 7-8"/>', live: '<path d="m18 4 3.8 9.2L31 17l-9.2 3.8L18 30l-3.8-9.2L5 17l9.2-3.8Z"/><path d="M29 3v6m-3-3h6"/>', replay: '<circle cx="18" cy="18" r="13"/><path d="m15 12 9 6-9 6Z"/>' };
  $('participant-view').innerHTML = `<section class="start-hero">
    <div><p class="eyebrow">Two owners · different meanings · one task</p><h1>Can your agents understand each other?</h1><p class="lead">Help Alice and Bob arrange a discussion. Review how their concepts align, then decide what information may cross each owner’s boundary.</p><small>About 3–5 minutes · fictional calendars</small></div>
    <div class="boundary-illustration" role="img" aria-label="Alice and Bob have separate data. You control the sharing boundary.">
      <svg viewBox="0 0 360 106" aria-hidden="true"><path d="M82 49h60m76 0h60" class="boundary-path"/><circle cx="52" cy="49" r="30" class="boundary-alice"/><circle cx="308" cy="49" r="30" class="boundary-bob"/><g class="boundary-avatar"><rect x="37" y="38" width="30" height="23" rx="8"/><path d="M52 32v6m-7 10h1m12 0h1m-12 7h10"/><rect x="293" y="38" width="30" height="23" rx="8"/><path d="M308 32v6m-7 10h1m12 0h1m-12 7h10"/></g><rect x="150" y="20" width="60" height="58" rx="16" class="boundary-gate"/><g class="boundary-lock"><rect x="169" y="43" width="22" height="19" rx="4"/><path d="M174 43v-6a6 6 0 0 1 12 0v6m-6 7v5"/></g></svg>
      <div class="boundary-captions"><span><strong>Alice</strong><small>Your agent</small></span><span><strong>Your choice</strong><small>Sharing boundary</small></span><span><strong>Bob</strong><small>Peer agent</small></span></div>
    </div>
  </section><section class="panel start-ontology-story"><div class="panel-heading"><div><p class="eyebrow">Recommended conference experience</p><h3>Calendar availability and booking eligibility differ</h3></div><span class="tag">A task-scoped alignment</span></div><p>Alice describes calendar entries. Bob describes booking slots. The agents must agree on the relevant meanings before interpreting a shared snapshot.</p><div class="ontology-story-grid"><label class="choice"><input type="radio" name="ontology-scenario" value="distinct" ${local.ontologyScenario === 'distinct' ? 'checked' : ''}><span><strong>Different models · guided alignment</strong><small>Review interval, weekday and booking rules, then approve an exact snapshot.</small></span></label><label class="choice"><input type="radio" name="ontology-scenario" value="ambiguous" ${local.ontologyScenario === 'ambiguous' ? 'checked' : ''}><span><strong>Same word · ambiguous meaning</strong><small>Does “free” mean only no event, or permission to consider a meeting? Clarify before proceeding.</small></span></label></div><label class="field section-actions"><span>Discussion duration</span><select id="task-duration">${[30,45,60].map(minutes => '<option value="' + minutes + '" ' + (local.durationMinutes === minutes ? 'selected' : '') + '>' + minutes + ' minutes</option>').join('')}</select></label><div class="recommended-launch"><button class="button primary" data-participant-action="recommended" ${!ready || requestBusy ? 'disabled' : ''}>Start recommended guided demo</button><small>Uses the conference kit in guided mode. Your selected story, duration and research choice apply. No sharing is preapproved.</small></div></section><section class="panel start-preferences"><fieldset><legend><span class="setup-step">1</span>Choose your experience</legend><div class="mode-grid">${modes.map(mode => `<label class="choice mode-card ${!mode.available ? 'dimmed' : ''}" data-mode="${escapeHtml(mode.id)}"><input type="radio" name="start-mode" value="${escapeHtml(mode.id)}" ${local.mode === mode.id ? 'checked ' : ''}${!mode.available ? 'disabled ' : ''}><span class="mode-icon"><svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${modeShapes[mode.id] || modeShapes.controlled}</svg></span><span><strong>${modeCopy[mode.id]?.[0] || escapeHtml(mode.label)}</strong><small>${modeCopy[mode.id]?.[1] || escapeHtml(mode.description)}</small><span class="mode-status">${!mode.available ? 'Unavailable' : mode.id === 'controlled' ? 'Recommended to start' : escapeHtml(mode.label)}</span></span></label>`).join('')}</div></fieldset>
    ${local.mode === 'live' ? '<div class="notice live-disclosure">' + escapeHtml(modeDisclosure(local.mode)) + '</div>' : ''}
    <div class="recording-option"><span class="recording-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="8" y="6" width="17" height="22" rx="4"/><path d="M12 4h9v5h-9zM12 15h9m-9 5h6"/></svg></span><div><label class="check"><input id="start-consent" type="checkbox" ${local.consent ? 'checked ' : ''}${local.mode === 'replay' ? 'disabled ' : ''}><span><strong>Record this fictional round for research</strong><small>Optional. Records fictional data and agent states; sharing permission is separate.</small></span></label><details class="consent-details" ${consentDetailsOpen ? 'open' : ''}><summary>What gets recorded?</summary><p class="muted">Researchers can review the fictional KG, data, skills, authorization, changes and understanding answers. Model secrets and raw provider conversations are excluded. No name or account is requested. Sharing permission is a separate decision. Without consent, no research record is written. Session state remains in memory until replacement, reset or expiry.</p><small>Consent version: ${escapeHtml(meta?.consentVersion || 'Loading')}</small></details></div></div></section>`;
  const conditionsAccess = document.createElement('details'); conditionsAccess.className = 'initial-conditions-access'; conditionsAccess.dataset.disclosureId = 'start-initial-conditions';
  conditionsAccess.innerHTML = '<summary><span>Explore or customize the starting states</span><small>Optional · calendars, skills, knowledge and permission limits</small></summary><p class="muted">Experiment setup · observer preview of fictional starting states. This view is separate from Alice’s owner view during the collaboration.</p>';
  const holder = document.createElement('div'); holder.id = 'initial-conditions-builder';
  conditionsAccess.append(holder); $('participant-view').append(conditionsAccess);
  conditionsController?.attach(holder);
  const actionPanel = document.createElement('section'); actionPanel.className = 'panel start-round-panel';
  actionPanel.innerHTML = '<div class="toolbar section-actions"><button class="button primary" data-participant-action="start" ' + (!ready || requestBusy ? 'disabled' : '') + '>' + (requestBusy ? 'Starting isolated agents…' : 'Start the demo') + '</button><span class="muted">' + (!ready ? 'Waiting for an available mode and both agents.' : 'Ready · creates the exact reviewed initial states.') + '</span></div>';
  $('participant-view').append(actionPanel);
  updateStartControls();
  restoreDisclosures($('participant-view'), 'start');
  restoreParticipantPosition($('participant-view'), 'start', focus);
}
function updateStartControls() {
  const button = $('participant-view').querySelector('[data-participant-action="start"]'); if (!button) return;
  const modeReady = meta?.modes?.find(mode => mode.id === local.mode)?.available && meta.runtime?.alice?.online !== false && meta.runtime?.bob?.online !== false;
  button.disabled = !modeReady || requestBusy || !conditionsController?.ready();
  const recommended = $('participant-view').querySelector('[data-participant-action="recommended"]');
  if (recommended) recommended.disabled = requestBusy || !meta?.modes?.find(mode => mode.id === 'controlled')?.available || !conditionsController?.canSelectPreset('conference');
  const note = button.parentElement.querySelector('.muted');
  if (note) note.textContent = !modeReady ? 'Waiting for an available mode and both agents.' : conditionsController?.ready() ? 'Ready · creates the exact reviewed initial states.' : meta?.openControls ? 'Resolve and validate your initial conditions before starting.' : 'Resolve and validate your initial conditions; Bob changes need researcher sign-in.';
}
function choicesHtml(stage) {
  const initial = stage === 'initial';
  const additionalDays = current.additionalRequest?.days || ['Thu'];
  const requestWindow = additionalDays.join(', ');
  const choices = initial ? [
    ['free', 'Free times only', 'Only free time intervals on Tuesday and Wednesday.'],
    ['busy', 'Free / busy status', 'Time intervals and their free or busy status on Tuesday and Wednesday.'],
    ['full', 'Calendar titles and notes', 'All calendar information on Tuesday and Wednesday.'],
    ['none', 'Share nothing', 'Decline calendar sharing and end this collaboration.']
  ] : [
    ['keep', 'Keep the current scope', 'Send no new calendar information. Bob will respect this boundary.'],
    ['narrow', 'Free times on ' + requestWindow, 'Add only free intervals on ' + requestWindow + '.'],
    ['week', 'Full weekly calendar', 'Share event titles, notes and time intervals for the full week.']
  ];
  const profile = current.initialConditions?.agents?.Alice;
  const permission = current.agentStates?.Alice?.authorization;
  const profileSkills = profile?.skills || ['read_synthetic_calendar', 'preview_scoped_calendar', 'send_scoped_snapshot'];
  const enabledSkills = ['read_synthetic_calendar', 'preview_scoped_calendar'].every(id => profileSkills.includes(id));
  const allowedFields = profile?.authorization?.fields || ['day', 'time', 'status', 'title', 'note'];
  const allowedDays = profile?.authorization?.windows || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const requestedDays = initial ? ['Tue', 'Wed'] : additionalDays;
  const choiceEnabled = value => ['none', 'keep'].includes(value) || enabledSkills && allowedFields.length && (value === 'week' ? allowedDays.length : requestedDays.some(day => allowedDays.includes(day)));
  if (profile) {
    for (const choice of choices) {
      if (['none', 'keep'].includes(choice[0])) continue;
      if (['full', 'week'].includes(choice[0]) && !['title', 'note'].every(field => allowedFields.includes(field))) {
        choice[1] = choice[0] === 'full' ? 'Calendar information within your ceiling' : 'Weekly information within your ceiling';
        choice[2] = choice[0] === 'full' ? 'Permitted calendar fields on Tuesday and Wednesday. Preview shows the exact scope.' : 'Permitted calendar fields for the week. Preview shows the exact scope.';
      }
      if (!choiceEnabled(choice[0])) choice[2] += ' Unavailable with the current skills or authorization.';
    }
  }
  const selected = local[stage];
  const sendDisabledReason = !profileSkills.includes('send_scoped_snapshot') ? 'Alice’s initial skills allow inspection and preview, but sending is disabled.' : ['expired', 'exhausted', 'disabled'].includes(permission?.status) ? 'Alice’s authorization is ' + permission.status + '. You may inspect this preview, decline sharing, or keep the current boundary.' : '';
  const cannotConfirmSend = !['none', 'keep'].includes(selected) && Boolean(sendDisabledReason);
  const preview = local.previewStage === stage && local.previewChoice === selected ? local.preview : null;
  const stale = preview && preview.sessionVersion !== current.session.version;
  const blocked = requestBusy || interruptBusy || Boolean(pending) || current.session.paused || current.alice.stopped;
  const limits = profile ? '<details class="scope-permission-details" data-disclosure-id="scope-limits-' + stage + '"><summary>Initial permission limits</summary><dl class="definition-list"><dt>Allowed fields</dt><dd>' + escapeHtml(allowedFields.join(', ') || 'None') + '</dd><dt>Allowed days</dt><dd>' + escapeHtml(allowedDays.join(', ') || 'None') + '</dd></dl></details>' : '';
  return '<section class="panel"><fieldset ' + (blocked ? 'disabled' : '') + '><legend>' + (initial ? 'What may Alice send to Bob?' : 'Bob is requesting a wider time window') + '</legend><p class="muted" style="margin-bottom:13px">' + (initial ? 'Choose a field set for Tuesday–Wednesday. Nothing is selected by default.' : 'Review the new request independently. A wider scope is optional.') + '</p><div class="choices scope-choices">' + choices.map(([value, title, detail]) => '<label class="choice scope-choice" data-scope="' + value + '"><input type="radio" name="' + stage + '-choice" value="' + value + '" ' + (selected === value ? 'checked' : '') + (!choiceEnabled(value) ? ' disabled' : '') + '>' + scopeIconHtml(value) + '<span><strong>' + title + '</strong><small>' + detail + '</small></span></label>').join('') + '</div></fieldset>' + limits + '<div class="toolbar section-actions"><button class="button" data-participant-action="preview" data-stage="' + stage + '" ' + (!selected || blocked ? 'disabled' : '') + '>Preview exact information</button><span class="muted">Previewing does not authorize or send.</span></div>' + (preview ? '<div class="preview-box"><div class="panel-heading"><h3>Exact snapshot · recipient Bob</h3><span class="tag">Not yet sent</span></div><dl class="definition-list"><dt>Fields</dt><dd>' + escapeHtml(preview.fields?.join(', ') || 'None') + '</dd><dt>Time window</dt><dd>' + escapeHtml(textValue(preview.window)) + '</dd></dl>' + tableRows(preview.rows) + '<details><summary>Inspect exact payload and fingerprint</summary><pre>' + escapeHtml(JSON.stringify({ fields: preview.fields, window: preview.window, rows: preview.rows }, null, 2)) + '</pre><code>' + escapeHtml(preview.payloadHash) + '</code></details>' + (stale ? '<div class="notice warning">The session changed. Preview again before confirming; this snapshot will not be sent.</div>' : '') + (cannotConfirmSend ? '<div class="notice">' + escapeHtml(sendDisabledReason) + '</div>' : '') + '<div class="toolbar section-actions"><button class="button primary" data-participant-action="confirm" data-stage="' + stage + '" ' + (blocked || stale || cannotConfirmSend ? 'disabled' : '') + '>' + (initial && selected === 'none' ? 'Confirm no sharing' : !initial && selected === 'keep' ? 'Confirm current boundary' : 'Confirm and send this snapshot') + '</button></div></div>' : '') + '</section>';
}
function receiptsHtml() {
  const incoming = current.receipts?.aliceToBob || [], outgoing = current.receipts?.bobToAlice || [];
  if (!incoming.length && !outgoing.length) return '<section class="panel"><h3>Shared information receipt</h3><p class="empty">Nothing has been received yet. Choosing or previewing information does not count as delivery.</p></section>';
  return '<section class="panel"><div class="panel-heading"><h3>Approved → actually received</h3><span class="tag">Server receipts</span></div>' + incoming.map(receipt => '<article class="receipt"><div class="receipt-header"><strong>Alice → Bob</strong><span class="tag ' + (receipt.status === 'received' ? 'good' : 'warn') + '">' + escapeHtml(receipt.status) + '</span></div><dl class="definition-list"><dt>Approved fields</dt><dd>' + escapeHtml(receipt.fields?.join(', ') || 'None') + '</dd><dt>Approved window</dt><dd>' + escapeHtml(textValue(receipt.window)) + '</dd><dt>Received payload</dt><dd>' + (receipt.status === 'received' ? 'Exact snapshot below' : 'Not confirmed received') + '</dd></dl>' + (receipt.status === 'received' ? tableRows(receipt.rows) : '') + '<details><summary>Receipt identity and exact content</summary><pre>' + escapeHtml(JSON.stringify(receipt, null, 2)) + '</pre></details></article>').join('') + outgoing.map(receipt => '<article class="receipt"><div class="receipt-header"><strong>Bob → Alice</strong><span class="tag ' + (receipt.status === 'received' ? 'good' : 'warn') + '">' + escapeHtml(receipt.status) + '</span></div><p>Fields: ' + escapeHtml(receipt.fields?.join(', ') || 'None') + '</p><dl class="definition-list">' + Object.entries(receipt.values || {}).map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(textValue(value)) + '</dd>').join('') + '</dl><details><summary>Exact receipt</summary><pre>' + escapeHtml(JSON.stringify(receipt, null, 2)) + '</pre></details></article>').join('') + '</section>';
}
function questionsHtml() {
  const questions = renderUnderstandingHtml({ state: current, local, busy: requestBusy, interruptBusy, pending });
  return questions ? '<details class="understanding-access" data-disclosure-id="understanding-checks"><summary><span>Check your understanding</span><small>Optional · sharing, withdrawal, meanings and modules</small></summary>' + questions + '</details>' : '';
}

function renderParticipant() {
  const view = $('participant-view');
  const focus = participantFocusSnapshot(view);
  rememberDisclosures(view, view.dataset.disclosureScope || 'start');
  if (sessionRestore) { view.innerHTML = '<section class="panel" role="status"><h2>Checking the saved round</h2><p>The round credential is retained while its owner view is loaded. No information is shown until the server confirms this view.</p><button class="button primary section-actions" data-participant-action="restore_session" ' + (sessionRestoreBusy ? 'disabled' : '') + '>' + (sessionRestoreBusy ? 'Checking the round…' : 'Reload the saved round') + '</button></section>'; return; }
  if (!current || planningNewRound) { renderStart(); return; }
  const session = current.session;
  view.setAttribute('aria-busy', String(requestBusy || interruptBusy));
  view.dataset.disclosureScope = 'participant:' + session.id;
  if (current.answers?.received_scope) { local.prediction = current.answers.received_scope; local.predictionSubmitted = true; }
  if (current.answers?.withdrawal) { local.revocation = current.answers.withdrawal; local.revocationSubmitted = true; }
  $('runtime-status').textContent = 'Alice: ' + (current.runtime?.alice?.online ? 'ready' : 'offline') + ' · Bob: ' + (current.runtime?.bob?.online ? 'ready' : 'offline');
  const hasPending = pending?.sessionId === session.id;
  const endingPending = hasPending && pending.body.action === 'end';
  const stoppingPending = hasPending && pending.body.action === 'stop_sharing';
  $('end-confirm').disabled = interruptBusy;
  let outcome = '';
  if (endingPending) outcome = '<h2>Waiting for End confirmation</h2><p class="lead">The restriction request is still being confirmed. The receipt history preserves what had actually arrived.</p>';
  else if (session.ended) outcome = '<h2>This demo has ended</h2><p class="lead">No further information will be sent. The receipts show what had already been delivered.</p>';
  else if (session.mode === 'replay' && current.task?.outcome) outcome = '<h2>Replay complete</h2><p class="lead">This saved trace illustrates a collaboration. It did not send a new payload or arrange a live meeting.</p>';
  else if (current.task?.outcome === 'arranged') outcome = '<h2>Discussion arranged</h2><p class="lead">' + escapeHtml(current.task.meeting?.day || '') + ' · ' + escapeHtml(current.task.meeting?.time || '') + '. Review what each agent actually received.</p>';
  else if (current.task?.outcome === 'alignment_rejected') outcome = '<h2>Meaning left unresolved</h2><p class="lead">The proposed interpretation was declined. The agents did not use it to exchange or interpret calendar data.</p>';
  else if (current.task?.outcome === 'boundary_kept') {
    const reasons = {
      scope_kept: 'You kept the current scope. No meeting was arranged from the information available.',
      no_common_time: 'The available information has no common slot long enough for this task.',
      bob_permission_denied: 'Bob’s owner did not authorize the reply needed to complete this task.',
      confirmation_incomplete: 'The required confirmation was not completed. No meeting is recorded as arranged.',
      alignment_rejected: 'The concept interpretation remains unresolved. Calendar data cannot be used as booking permission.'
    };
    outcome = '<h2>Your boundary was kept</h2><p class="lead">' + escapeHtml(reasons[current.task.reason] || 'No meeting was arranged from the information available. Review the recorded reason and receipts below.') + '</p>';
  }
  else if (current.task?.outcome === 'declined') outcome = '<h2>Calendar sharing declined</h2><p class="lead">Your decision completed this collaboration. No calendar information was authorized.</p>';
  else if (current.task?.outcome === 'ended') outcome = '<h2>This demo has ended</h2><p class="lead">No further information will be sent. The receipts show what had already been delivered.</p>';
  const waiting = current.waiting;
  const approvalPending = current.pendingApprovals?.some(item => item.status === 'pending');
  const heading = session.stage === 'alignment' ? 'Confirm how the two assistants understand free time' : session.stage === 'initial' ? 'Choose Alice’s sharing boundary' : session.stage === 'additional' ? 'Review Bob’s additional request' : session.stage === 'replay' ? 'Labelled replay' : 'Your collaboration';
  const controls = (endingPending ? '<span class="tag warn">End needs confirmation</span>' : !session.ended ? '<button class="button quiet" data-participant-action="end" ' + (interruptBusy ? 'disabled' : '') + '>End this demo</button>' + (!current.alice.stopped && session.mode !== 'replay' ? '<button class="button" data-participant-action="stop_sharing" ' + (interruptBusy ? 'disabled' : '') + '>Stop future sharing</button>' : '') : '<button class="button" data-participant-action="fresh" ' + (requestBusy || interruptBusy || pending ? 'disabled' : '') + '>New demo</button>');
  const warnings = (hasPending && (isInterrupt(pending?.body?.action) ? interruptBusy : requestBusy) ? '<div class="notice" role="status" data-processing-choice><strong>Processing your choice</strong><p>Your original choice is being confirmed. You can stop future sharing or end this round.</p><button class="button" data-participant-action="refresh">Check session state</button></div>' : hasPending ? '<div class="notice warning" role="status"><strong>Submission outcome needs verification</strong><p>The same request ID and intent are retained. No changed sharing choice will be resubmitted automatically.</p><div class="toolbar"><button class="button" data-participant-action="verify_pending">Verify the same submission</button><button class="button" data-participant-action="refresh">Check session state</button></div></div>' : '')
    + (current.alice?.stopped ? '<div class="notice">' + (stoppingPending ? 'Waiting for Stop confirmation. ' : 'Future Alice sharing is stopped. ') + 'Previously received snapshots remain in the receipt history.</div>' : '')
    + (session.paused ? renderRecoveryHtml(current, { busy: requestBusy || interruptBusy || recoveryBusy || hasPending }) : waiting ? '<div class="notice warning" role="status"><strong>Waiting</strong><p>' + escapeHtml(waiting.message) + '</p>' + (approvalPending || waiting.reason === 'admin' ? '<div class="toolbar"><button class="button" data-participant-action="admin_review">Open Bob owner review window</button><span class="muted">Closing it leaves the request pending.</span></div>' : '') + '</div>' : '');
  const replay = session.stage === 'replay' ? '<section class="panel"><h3>Saved trace · replay</h3><p class="muted">Source: ' + escapeHtml(current.replay?.source || 'Saved replay') + ' · step ' + escapeHtml(current.replay?.index ?? 0) + ' / ' + escapeHtml(current.replay?.total ?? 0) + '</p><button class="button primary section-actions" data-participant-action="replay_next" ' + (requestBusy || interruptBusy || pending || session.ended || (current.replay?.index ?? 0) >= (current.replay?.total ?? 0) ? 'disabled' : '') + '>Next replay step</button></section>' : '';
  const ontologyCard = renderOntologyHtml(current, { busy: requestBusy || interruptBusy || Boolean(pending) || session.paused || Boolean(waiting) });
  const ontology = session.stage === 'alignment' || !ontologyCard ? ontologyCard : '<details class="ontology-aligned-access" data-disclosure-id="ontology-accepted-summary"><summary><span>' + (current.ontology?.status === 'accepted' ? 'Meaning aligned for this task' : 'Alignment decision & evidence') + '</span><small>Definitions, mappings and confirmed agent dialogue</small></summary>' + ontologyCard + '</details>';
  view.innerHTML = renderParticipantHtml({ state: current, heading, mode: modeLabel(session.mode), warnings, controls, outcome, choices: !session.ended && !session.paused && !waiting && ['initial', 'additional'].includes(session.stage) ? choicesHtml(session.stage) : '', questions: questionsHtml(), receipts: receiptsHtml(), calendar: calendarHtml(), replay, modeDisclosure: modeDisclosure(session.mode), perspective: renderPerspectiveHtml(current, { busy: perspectiveBusy || requestBusy || interruptBusy }), ontology, contribution: renderContributionHtml(current) });
  mountAgentStates($('live-alice-state'), { Alice: current.agentStates?.Alice }, { scope: 'participant-live:' + session.id });
  mountAgentStates($('live-bob-state'), { Bob: current.agentStates?.Bob }, { scope: 'participant-live:' + session.id });
  restoreDisclosures(view, view.dataset.disclosureScope);
  restoreParticipantPosition(view, [session.id, session.stage, current.ontology?.status, session.paused, session.ended, current.alice?.stopped, current.task?.outcome].join(':'), focus);
}

async function startSession() {
  if (requestBusy || interruptBusy) return;
  requestBusy = true; renderParticipant();
  try {
    const initialConditions = await conditionsController.submission();
    const previous = current ? { previousSessionId: current.session.id, previousToken: participantToken } : {};
    const result = await api('/api/sessions', { method: 'POST', auth: false, researcher: true, body: { mode: local.mode, ontologyScenario: local.ontologyScenario, alignmentReview: true, task: { type: 'schedule', durationMinutes: local.durationMinutes }, researchConsent: local.mode !== 'replay' && local.consent, ...initialConditions, ...previous } });
    perspective = 'owner';
    rememberPending(null); rememberSession(result.token, result.state); planningNewRound = false; clearPreview(); local.initial = null; local.additional = null; local.prediction = null; local.revocation = null; local.alignmentAnswer = null; local.moduleAnswer = null; local.predictionSubmitted = false; local.revocationSubmitted = false;
    if (!selectedSessionId || selectedSessionId === previous.previousSessionId) selectedSessionId = current.session.id; notify('');
  } catch (error) { notify(error.message, 'error'); }
  finally { requestBusy = false; renderParticipant(); }
}
async function refreshCurrent({ quiet = false } = {}) {
  if (sessionRestore) return restoreParticipantSession({ quiet });
  if (!current || !participantToken) return;
  const sessionId = current.session.id, token = participantToken;
  const observer = perspective === 'observer' && Boolean(adminToken);
  const requestedPerspective = observer ? 'observer' : 'owner';
  try {
    const next = await api('/api/sessions/' + encodeURIComponent(sessionId) + (observer ? '?perspective=observer' : ''), { token: observer ? adminToken : token, admin: observer });
    if (current?.session.id !== sessionId || participantToken !== token) return;
    if (perspective !== requestedPerspective || observer && !adminToken) return false;
    if (JSON.stringify(next) !== JSON.stringify(current)) applyState(next);
    return true;
  } catch (error) {
    if (current?.session.id !== sessionId || participantToken !== token) return;
    if (observer && [401, 403].includes(error.status)) { perspective = 'owner'; await refreshCurrent({ quiet: true }); if (!quiet) notify('Observer access is unavailable. You remain in Alice owner view.', 'warning'); return false; }
    if ([401, 404, 410].includes(error.status)) { current = null; participantToken = null; local.consent = false; planningNewRound = false; rememberPending(null); writeStorage(sessionKey, null); clearPreview(); notify('This in-memory session is no longer available. A server restart or round reset ends the old round; start a new demo.', 'warning'); renderParticipant(); }
    else if (!quiet) notify(error.message, 'warning');
    return false;
  }
}
async function previewChoice(stage) {
  if (!current || !local[stage] || requestBusy || interruptBusy || pending) return;
  const sequence = ++requestSequence, sessionId = current.session.id, choice = local[stage];
  requestBusy = true; renderParticipant();
  try { const preview = await api('/api/sessions/' + encodeURIComponent(sessionId) + '/preview', { method: 'POST', body: { stage, choice } }); if (sequence !== requestSequence || current?.session.id !== sessionId || current.session.ended || current.alice.stopped || interruptBusy) return; local.preview = preview; local.previewStage = stage; local.previewChoice = choice; participantPreviewFocusPending = true; notify(''); }
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
  if (input.name === 'ontology-scenario') local.ontologyScenario = input.value;
  if (input.id === 'task-duration') local.durationMinutes = Number(input.value);
  if (input.id === 'start-consent') local.consent = input.checked;
  if (input.name === 'initial-choice' || input.name === 'additional-choice') { local[input.name.split('-')[0]] = input.value; clearPreview(); renderParticipant(); }
  const question = understandingQuestionForInput(input.name);
  if (question && current?.task?.outcome && !current.session.ended && current.session.mode !== 'replay' && !local[question.localKey] && !current.answers?.[question.id] && !requestBusy && !interruptBusy && !pending) {
    local[question.localKey] = input.value;
    performAction(question.action, { answer: input.value });
  }
});
$('participant-view').addEventListener('click', event => {
  const button = event.target.closest('[data-participant-action]'); if (!button || button.disabled) return;
  const actionName = button.dataset.participantAction;
  if (actionName === 'start') startSession();
  else if (actionName === 'restore_session') restoreParticipantSession();
  else if (actionName === 'recommended') startRecommended();
  else if (actionName === 'perspective') switchPerspective(button.dataset.perspective);
  else if (actionName.startsWith('alignment_')) performAction('alignment_decision', { decision: actionName.slice('alignment_'.length), expectedAlignmentVersion: current.ontology?.revision, ...(button.dataset.bookable !== undefined ? { calendarFreeMeansBookable: button.dataset.bookable === 'true' } : {}) });
  else if (actionName === 'fresh') { if (requestBusy || interruptBusy || pending) return; local.mode = current?.session.mode || 'controlled'; local.consent = false; planningNewRound = true; rememberPending(null); clearPreview(); renderParticipant(); }
  else if (actionName === 'preview') previewChoice(button.dataset.stage);
  else if (actionName === 'confirm') { const stage = button.dataset.stage; if (local.preview && local.previewStage === stage) performAction(stage === 'initial' ? 'share_initial' : 'respond_additional', { choice: local[stage], previewHash: local.preview.payloadHash }); }
  else if (actionName === 'verify_pending') performAction(pending?.body?.action, {}, { repeat: true });
  else if (actionName === 'refresh') refreshCurrent();
  else if (actionName === 'admin_review') openAdminDialog({ kind: 'approval', sessionId: current.session.id });
  else if (actionName === 'recover') openAdminDialog({ kind: 'recovery', sessionId: current.session.id });
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
function rememberApprovalDraft() {
  const approval = dialogContext?.selected, body = $('admin-dialog-body');
  if (!approval || !body.querySelector('input[name="approval-field"]')) return;
  approvalDrafts.set(approval.id, { selectedFields: [...body.querySelectorAll('input[name="approval-field"]:checked')].map(node => node.value), maxUses: $('approval-max-uses')?.value, expiryMinutes: $('approval-expiry')?.value });
}
async function switchPerspective(next) {
  if (!current || perspectiveBusy || requestBusy || interruptBusy) return;
  if (next === 'observer' && !adminToken) { openAdminDialog({ kind: 'perspective', perspective: next }); return; }
  perspectiveBusy = true;
  const previous = perspective;
  perspective = next;
  renderParticipant();
  try { if (!await refreshCurrent()) perspective = previous === 'observer' && !adminToken ? 'owner' : previous; }
  catch { perspective = previous; }
  finally { perspectiveBusy = false; renderParticipant(); }
}
async function startRecommended() {
  if (requestBusy || interruptBusy || pending) return;
  local.mode = 'controlled';
  try { await conditionsController.selectPreset('conference'); await startSession(); }
  catch (error) { notify(error.message, 'error'); }
}
function closeDialog(id) { if (id === 'admin-dialog') rememberApprovalDraft(); const dialog = $(id); if (dialog.open) dialog.close(); if (dialogOpener?.isConnected) dialogOpener.focus(); else ($('admin-open').hidden ? document.querySelector('[data-view="' + activeView + '"]') : $('admin-open'))?.focus(); if (id === 'admin-dialog') dialogContext = null; }
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
  if (meta?.openControls) enableControls();
  dialogContext = context;
  showDialog('admin-dialog');
  if (!adminToken) renderLogin();
  else if (context.kind === 'approval') loadApprovals(context.sessionId);
  else if (context.kind === 'recovery') loadRecovery(context.sessionId);
  else { closeDialog('admin-dialog'); setView('console'); }
}
function renderLogin(message = '') {
  $('admin-dialog-title').textContent = 'Researcher sign in';
  const body = $('admin-dialog-body');
  rememberDisclosures(body, body.dataset.disclosureScope || 'login');
  body.dataset.disclosureScope = 'login';
  body.innerHTML = renderLoginHtml(message);
  restoreDisclosures(body, 'login');
  requestAnimationFrame(() => $('admin-pin')?.focus());
}
$('admin-dialog-body').addEventListener('submit', async event => {
  if (event.target.id !== 'admin-login-form') return;
  event.preventDefault(); const pin = $('admin-pin').value; $('admin-pin').value = ''; const context = dialogContext;
  event.target.querySelectorAll('button,input').forEach(node => { node.disabled = true; });
  try {
    const result = await api('/api/admin/login', { method: 'POST', auth: false, body: { pin } }); enableControls(result.token);
    if (context?.kind === 'approval') await loadApprovals(context.sessionId);
    else if (context?.kind === 'recovery') await loadRecovery(context.sessionId);
    else if (context?.kind === 'perspective') { closeDialog('admin-dialog'); await switchPerspective(context.perspective); }
    else closeDialog('admin-dialog');
  } catch (error) { renderLogin(error.message); }
});
async function loadApprovals(sessionId) {
  if (!adminToken || !sessionId) return;
  const sequence = ++adminDialogLoadSequence;
  rememberApprovalDraft();
  dialogContext = { kind: 'approval', sessionId }; $('admin-dialog-title').textContent = meta?.openControls ? 'Review Bob’s sharing request' : 'Bob authorization · researcher review'; $('admin-dialog-body').innerHTML = '<p class="loading">Loading the immutable pending request…</p>';
  try {
    const result = await api('/api/admin/sessions/' + encodeURIComponent(sessionId) + '/approvals');
    if (sequence !== adminDialogLoadSequence || dialogContext?.kind !== 'approval' || dialogContext.sessionId !== sessionId || !$('admin-dialog').open) return;
    const approvals = result.approvals.filter(item => item.status === 'pending'); dialogContext.approvals = approvals;
    if (!approvals.length) { $('admin-dialog-body').innerHTML = '<p>No pending Bob approval. Closing this window returns to the unchanged participant step.</p><div class="toolbar dialog-actions"><button class="button" data-close-dialog="admin-dialog">Return</button></div>'; return; }
    renderApproval(approvals[0]);
  } catch (error) { if (sequence === adminDialogLoadSequence && dialogContext?.kind === 'approval' && dialogContext.sessionId === sessionId && $('admin-dialog').open) $('admin-dialog-body').innerHTML = '<div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-close-dialog="admin-dialog">Return without deciding</button>'; }
}
async function loadRecovery(sessionId, message = '') {
  if (!adminToken || !sessionId) return;
  const sequence = ++adminDialogLoadSequence;
  dialogContext = { kind: 'recovery', sessionId };
  $('admin-dialog-title').textContent = 'Recover the paused step';
  $('admin-dialog-body').innerHTML = '<p class="loading">Checking the current step and confirmed receipts…</p>';
  try {
    const isCurrent = current?.session.id === sessionId;
    const state = await api('/api/sessions/' + encodeURIComponent(sessionId) + (isCurrent ? '' : '?perspective=observer'), { token: isCurrent ? participantToken : adminToken, admin: !isCurrent });
    if (sequence !== adminDialogLoadSequence || dialogContext?.kind !== 'recovery' || dialogContext.sessionId !== sessionId || !$('admin-dialog').open) return;
    dialogContext.state = state;
    $('admin-dialog-body').innerHTML = state.session.paused && !state.session.ended ? renderRecoveryHtml(state, { controls: true, busy: recoveryBusy, message }) : '<p>No paused operation remains. Review the current round before taking another action.</p><button class="button section-actions" data-close-dialog="admin-dialog">Return</button>';
  } catch (error) {
    if (sequence !== adminDialogLoadSequence || dialogContext?.kind !== 'recovery' || dialogContext.sessionId !== sessionId || !$('admin-dialog').open) return;
    $('admin-dialog-body').innerHTML = '<p class="notice warning">' + escapeHtml(error.message) + '</p><div class="toolbar"><button class="button" data-recovery-action="refresh">Check the current step</button><button class="button" data-close-dialog="admin-dialog">Return without retrying</button></div>';
  }
}
function renderApproval(approval, message = '') {
  dialogContext.selected = approval;
  const body = $('admin-dialog-body');
  const scope = 'approval:' + approval.id;
  const same = body.dataset.disclosureScope === scope && Boolean(body.querySelector('input[name="approval-field"]'));
  const selections = same ? { selectedFields: [...body.querySelectorAll('input[name="approval-field"]:checked')].map(node => node.value), maxUses: $('approval-max-uses')?.value, expiryMinutes: $('approval-expiry')?.value } : approvalDrafts.get(approval.id) || {};
  rememberDisclosures(body, body.dataset.disclosureScope || scope);
  body.dataset.disclosureScope = scope;
  body.innerHTML = renderApprovalHtml(approval, message, selections);
  restoreDisclosures(body, scope);
}
$('admin-dialog-body').addEventListener('click', async event => {
  const recoveryButton = event.target.closest('[data-recovery-action]');
  if (recoveryButton && !recoveryButton.disabled && dialogContext?.kind === 'recovery' && !recoveryBusy) {
    const context = dialogContext, sessionId = context.sessionId, recoveryAction = recoveryButton.dataset.recoveryAction;
    if (recoveryAction === 'refresh') { await loadRecovery(sessionId); return; }
    if (recoveryAction === 'configure') { selectedSessionId = sessionId; closeDialog('admin-dialog'); setView('config'); return; }
    if (!['retry', 'restore_bob'].includes(recoveryAction)) return;
    recoveryBusy = true;
    $('admin-dialog-body').innerHTML = renderRecoveryHtml(context.state, { controls: true, busy: true }); renderParticipant();
    let recoveryMessage = '';
    try {
      const result = await api('/api/admin/sessions/' + encodeURIComponent(sessionId) + '/intervene', { method: 'POST', body: { action: recoveryAction } });
      applyState(result.state);
      if (current?.session.id === sessionId) await refreshCurrent({ quiet: true });
    } catch (error) {
      if (error.status === 401 && !meta?.openControls) { recoveryBusy = false; if (dialogContext?.kind === 'recovery' && dialogContext.sessionId === sessionId) renderLogin('Researcher sign-in expired. Sign in again to recover this paused step.'); return; }
      recoveryMessage = error.status ? error.message : 'The recovery outcome needs verification. Check the current step before choosing another retry. No changed sharing decision was sent.';
    } finally { recoveryBusy = false; renderParticipant(); }
    if (dialogContext?.kind === 'recovery' && dialogContext.sessionId === sessionId && $('admin-dialog').open) await loadRecovery(sessionId, recoveryMessage);
    return;
  }
  const button = event.target.closest('[data-approval-decision]'); if (!button || !dialogContext?.selected || button.disabled) return;
  const context = dialogContext, approval = context.selected;
  const fields = [...$('admin-dialog-body').querySelectorAll('input[name="approval-field"]:checked')].map(input => input.value);
  const body = { decision: button.dataset.approvalDecision, fields, expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash };
  if (body.decision !== 'deny' && !fields.length) { renderApproval(approval, 'Select at least one field to allow a reply, or decline the request.'); return; }
  if (body.decision === 'allow_round') { body.maxUses = Number($('approval-max-uses').value); body.expiryMinutes = Number($('approval-expiry').value); }
  $('admin-dialog-body').querySelectorAll('button,input').forEach(node => { node.disabled = true; });
  try { const result = await api('/api/admin/approvals/' + encodeURIComponent(approval.id) + '/decision', { method: 'POST', body }); applyState(result.state); if (dialogContext === context) closeDialog('admin-dialog'); approvalDrafts.delete(approval.id); if (activeView === 'console') loadAdminSessions(); }
  catch (error) { if (dialogContext !== context || !$('admin-dialog').open) return; if (error.status === 401 && !meta?.openControls) { renderLogin('Researcher sign-in expired. Sign in again to review this pending request.'); } else if (error.status === 409 || !error.status) { await loadApprovals(approval.sessionId); notify(error.status === 409 ? 'The pending Bob request changed. Review its new revision; no decision was automatically resent.' : 'The approval outcome needs verification. The current pending request was checked; no approval was automatically resent.', 'warning'); } else renderApproval(approval, error.message); }
});
$('admin-dialog-body').addEventListener('change', event => {
  if (event.target.name !== 'approval-field') return;
  const body = $('admin-dialog-body'), empty = !body.querySelector('input[name="approval-field"]:checked');
  body.querySelectorAll('[data-approval-decision="allow_once"],[data-approval-decision="allow_round"]').forEach(button => { button.disabled = empty; });
  const hint = body.querySelector('[data-empty-approval]'); if (hint) hint.hidden = !empty;
  rememberApprovalDraft();
});
$('admin-open').addEventListener('click', () => openAdminDialog());
$('admin-logout').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* Clearing local admin capability is still required. */ } clearAdmin(); });
$('app-tabs').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });

async function loadAdminSessions() {
  if (!adminToken) return;
  const sequence = ++adminLoadSequence, token = adminToken;
  try {
    const result = await api('/api/admin/sessions');
    if (sequence !== adminLoadSequence || token !== adminToken) return;
    adminSessions = result.sessions;
    if (!selectedSessionId || !adminSessions.some(session => session.id === selectedSessionId)) selectedSessionId = current && adminSessions.some(session => session.id === current.session.id) ? current.session.id : adminSessions[0]?.id;
    const id = selectedSessionId;
    if (adminState?.session.id !== id) { adminState = null; if (activeView === 'console') renderConsole(); }
    const state = id ? await api('/api/sessions/' + encodeURIComponent(id) + '?perspective=observer', { admin: true }) : null;
    if (sequence !== adminLoadSequence || token !== adminToken || id !== selectedSessionId) return;
    adminState = state;
    renderConsole();
  } catch (error) { if (sequence === adminLoadSequence && token === adminToken) notify(error.message, 'error'); }
}
function renderConsole() {
  const view = $('console-view');
  rememberDisclosures(view, view.dataset.disclosureScope || 'console');
  view.dataset.disclosureScope = 'console:' + (adminState?.session.id || 'empty');
  view.innerHTML = renderConsoleHtml({ state: adminState, sessions: adminSessions, selectedSessionId, modeLabel, loading: Boolean(selectedSessionId && !adminState), openControls: meta?.openControls === true });
  restoreDisclosures(view, view.dataset.disclosureScope);
}

$('console-view').addEventListener('click', async event => {
  const select = event.target.closest('[data-console-select]'); if (select) { selectedSessionId = select.dataset.consoleSelect; adminState = null; renderConsole(); await loadAdminSessions(); return; }
  const button = event.target.closest('[data-console-action]'); if (!button || button.disabled) return;
  const actionName = button.dataset.consoleAction;
  if (actionName === 'refresh') { loadAdminSessions(); return; }
  if (actionName === 'config') { setView('config'); return; }
  if (actionName === 'approvals') { openAdminDialog({ kind: 'approval', sessionId: selectedSessionId }); return; }
  if (actionName === 'retry' || actionName === 'resume' && adminState?.session.paused) { openAdminDialog({ kind: 'recovery', sessionId: selectedSessionId }); return; }
  if (!selectedSessionId || adminState?.session.id !== selectedSessionId) return; button.disabled = true;
  try {
    const oldId = selectedSessionId;
    const result = await api('/api/admin/sessions/' + encodeURIComponent(oldId) + '/intervene', { method: 'POST', body: { action: actionName } });
    if (result.token && current?.session.id === oldId) {
      const target = { id: result.state.session.id, token: result.token };
      // Preserve the replacement credential before any follow-up read can fail.
      perspective = 'owner'; participantToken = result.token; writeStorage(sessionKey, target); sessionRestore = target; current = null;
      requestSequence++; interruptSequence++; requestBusy = false; interruptBusy = false;
      rememberPending(null); clearPreview(); local.initial = null; local.additional = null; local.prediction = null; local.revocation = null; local.alignmentAnswer = null; local.moduleAnswer = null; local.predictionSubmitted = false; local.revocationSubmitted = false; renderParticipant();
      if (result.state?.perspective === 'owner') rememberSession(result.token, result.state);
      else await restoreParticipantSession();
      renderParticipant();
    }
    else applyState(result.state);
    selectedSessionId = result.state?.session.id || oldId; await loadAdminSessions(); notify('');
  } catch (error) { notify(error.message, 'error'); renderConsole(); }
});

async function loadResearch() {
  if (!adminToken) return;
  try { research = await api('/api/admin/research'); renderResearch(); } catch (error) { notify(error.message, 'error'); }
}
function renderResearch() {
  const result = mountResearchReview($('research-view'), {
    research, filters: researchFilters, selectedRunId: selectedResearchRunId, step: researchStep, modeLabel,
    onFiltersChange: filters => { Object.assign(researchFilters, filters); renderResearch(); },
    onRunSelect: id => { selectedResearchRunId = id; researchStep = 0; renderResearch(); },
    onStepChange: step => { researchStep = step; },
    onAction: researchAction
  });
  selectedResearchRunId = result.selectedRunId; researchStep = result.step;
}
async function researchAction(format, button) {
  if (format === 'refresh') { loadResearch(); return; }
  if (!['csv', 'jsonl'].includes(format)) return;
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/research/export?format=' + format, { headers: { Authorization: 'Bearer ' + adminToken }, cache: 'no-store' });
    if (!response.ok) { if (response.status === 401) clearAdmin(); throw new Error('Research export failed (' + response.status + ').'); }
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = 'agent-on-request-research.' + format; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
}

configController = mountBobConfig($('config-view'), { api, getSessionId: () => selectedSessionId || current?.session.id, onApplied: result => { if (result.state) applyState(result.state); if (activeView === 'console') loadAdminSessions(); } });
modelController = mountModelConfig($('models-view'), { api, getCurrentRevision: () => current?.session.modelRevision, onApplied: async () => { try { meta = await api('/api/meta', { auth: false }); enableControls(); if (!current || planningNewRound) renderParticipant(); } catch (error) { notify(error.message, 'error'); } } });
conditionsController = createInitialConditions({ api, isResearcher: () => Boolean(adminToken), isOpenControls: () => meta?.openControls === true, onChange: updateStartControls, onSignIn: () => openAdminDialog() });

window.addEventListener('pagehide', () => modelController?.clearSecret());

async function boot() {
  try {
    meta = await api('/api/meta', { auth: false });
    enableControls();
    $('connection-status').textContent = 'Local demo'; $('connection-status').className = 'tag good';
    $('runtime-status').textContent = 'Alice: ' + (meta.runtime?.alice?.online ? 'ready' : 'offline') + ' · Bob: ' + (meta.runtime?.bob?.online ? 'ready' : 'offline');
    const stored = readStorage(sessionKey);
    if (stored?.id && stored?.token) {
      participantToken = stored.token;
      sessionRestore = { id: stored.id, token: stored.token }; current = null;
      await restoreParticipantSession();
      if (current && pending?.sessionId !== current.session.id) rememberPending(null);
    } else rememberPending(null);
    renderParticipant();
    await conditionsController.load();
  } catch (error) { $('connection-status').textContent = 'Unavailable'; $('connection-status').className = 'tag warn'; $('participant-view').innerHTML = '<section class="panel"><h2>Demo service unavailable</h2><p class="lead">' + escapeHtml(error.message) + '</p><button class="button" id="retry-boot">Reconnect</button></section>'; $('retry-boot').addEventListener('click', boot); }
}
setInterval(async () => {
  if (pollBusy || document.hidden) return; pollBusy = true;
  try { if (current) await refreshCurrent({ quiet: true }); if (adminToken && activeView === 'console') await loadAdminSessions(); }
  finally { pollBusy = false; }
}, 2500);
for (const id of ['participant-view', 'console-view', 'admin-dialog-body']) {
  const view = $(id); observeDisclosures(view, () => view.dataset.disclosureScope || id);
}
boot();
