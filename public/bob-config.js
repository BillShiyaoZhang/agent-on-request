const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
import { renderChangeSummary } from './config-change-summary.js';

const clone = value => JSON.parse(JSON.stringify(value));
const getPath = (value, path) => path.split('.').reduce((part, key) => part && typeof part === 'object' ? part[key] : undefined, value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {}; node = node[key]; } node[keys.at(-1)] = next; }
const fieldSpecs = [
  ['persona', 'Persona', 'textarea'], ['objective', 'Objective', 'text'], ['data.source', 'Synthetic data source', 'text'], ['data.availableTimes', 'Available times · one day and time per line', 'times'],
  ['permissions.recipients', 'Recipients', 'csv'], ['permissions.fields', 'Allowed fields', 'csv'], ['permissions.resources', 'Resources', 'csv'], ['permissions.window', 'Time window', 'text'],
  ['permissions.confirmation', 'Confirmation mode', 'mode'], ['permissions.askAdminForNewScope', 'Ask the administrator about an unexpected Bob scope', 'boolean'],
  ['prompts.system', 'System prompt', 'textarea'], ['prompts.followUp', 'Follow-up prompt', 'textarea'], ['data.brief.topic', 'Synthetic brief topic', 'text'], ['data.brief.agenda', 'Synthetic brief agenda', 'textarea'],
  ['collaboration.acceptInvitations', 'Bob accepts invitations within his permission', 'boolean'], ['collaboration.allowedPeers', 'Allowed peers', 'csv'], ['tools.capabilities', 'Tools / capabilities', 'csv'],
  ['response.constraints', 'Response constraints', 'textarea'], ['response.offerBrief', 'Offer an optional brief', 'boolean'], ['response.maxWords', 'Maximum response words', 'number'],
  ['permissions.maxUses', 'Maximum permission uses', 'number'], ['permissions.expiryMinutes', 'Permission expiry · minutes', 'number']
];

export function mountBobConfig(container, { api, onApplied, getSessionId }) {
  let authoritative = null, draft = null, sessionId = null, target = 'template', rawDirty = false, reviewed = null, diff = [], busy = false, generation = 0;
  let message = '', messageKind = '', profiles = [], draftVersion = 1;
  const expanded = new Map();
  let rawBuffer = '', profileName = '', selectedProfile = '';
  const customBuffers = new Map();
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify([draft, target, sessionId]);
  function announce(text, error = false, success = false) { message = text; messageKind = error ? 'error' : success ? 'success' : ''; const notice = query('[data-config-notice]'); if (notice) { notice.textContent = text; notice.className = 'notice ' + messageKind; notice.setAttribute('role', error ? 'alert' : 'status'); } }
  function invalidate() { reviewed = null; diff = []; draftVersion++; clearFieldErrors(); announce('Draft changed. Validate and review the exact diff before applying.'); updateControls(); }
  function format(path, type) {
    const value = getPath(draft, path);
    if (type === 'times') return Array.isArray(value) ? value.map(row => row.day + ' ' + row.time).join('\n') : '';
    if (type === 'csv') return Array.isArray(value) ? value.join(', ') : '';
    return value ?? '';
  }
  function field(path, label, type) {
    if (type === 'boolean') return '<label class="check"><input type="checkbox" data-config-path="' + path + '" data-config-type="boolean" ' + (getPath(draft, path) === true ? 'checked' : '') + '><span>' + label + '</span></label>';
    const value = format(path, type);
    let input;
    if (type === 'mode') input = '<input type="text" list="bob-confirmation-modes" data-config-path="' + path + '" value="' + escapeHtml(value) + '"><datalist id="bob-confirmation-modes"><option value="each_action">Confirm each action</option><option value="bounded">Bounded preauthorization</option></datalist><small class="bob-input-hint">Choose a suggested mode or type your own. Only bounded allows sends within a fixed permission; other modes ask the owner first.</small>';
    else if (type === 'textarea' || type === 'times') input = '<textarea rows="2" data-config-path="' + path + '" data-config-type="' + type + '">' + escapeHtml(value) + '</textarea>';
    else input = '<input type="' + (type === 'number' ? 'number' : 'text') + '" ' + (type === 'number' ? 'step="any" ' : '') + 'data-config-path="' + path + '" data-config-type="' + type + '" value="' + escapeHtml(value) + '">';
    return '<label class="field"><span>' + label + '</span>' + input + '</label>';
  }
  function renderDiff() {
    renderChangeSummary(query('[data-config-change-summary]'), diff, reviewed === stamp() && !rawDirty && !customBuffers.size);
    const body = query('[data-config-diff]'); if (!body) return;
    body.innerHTML = diff.length ? diff.map(item => '<tr><td>' + escapeHtml(item.path) + '</td><td>' + escapeHtml(JSON.stringify(item.before) ?? '∅') + '</td><td>' + escapeHtml(JSON.stringify(item.after) ?? '∅') + '</td></tr>').join('') : '<tr><td colspan="3">' + (reviewed ? 'No configuration changes.' : 'Diff not reviewed.') + '</td></tr>';
  }
  function updateControls() {
    const pendingCustom = customBuffers.size > 0;
    const validReview = reviewed === stamp() && !rawDirty && !pendingCustom;
    container.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = busy; });
    query('[data-config-draft-version]')?.replaceChildren(document.createTextNode('Draft edit ' + draftVersion));
    container.querySelectorAll('[data-config-path]').forEach(node => { node.disabled = busy || rawDirty || pendingCustom; });
    container.querySelectorAll('[data-config-custom-json]').forEach(node => { node.disabled = busy || rawDirty; });
    container.querySelectorAll('[data-config-custom-json]').forEach(node => { const path = node.dataset.configCustomJson; if (!customBuffers.has(path)) node.value = JSON.stringify(getPath(draft, path) ?? (path === 'tools.skillDefinitions' ? [] : {}), null, 2); });
    container.querySelectorAll('[data-config-action="parse-custom"],[data-config-action="discard-custom"]').forEach(node => { node.disabled = busy || rawDirty; });
    container.querySelectorAll('[data-config-json],[data-config-action="parse-json"],[data-config-action="discard-json"],[data-config-import]').forEach(node => { node.disabled = busy || pendingCustom; });
    const importFile = query('[data-config-import]'); if (importFile) importFile.disabled = busy || rawDirty || pendingCustom;
    const download = query('[data-config-action="download"]'); if (download) download.disabled = busy || !validReview;
    container.querySelectorAll('[name="config-target"]').forEach(node => { node.disabled = busy || node.value === 'session' && !sessionId; });
    for (const name of ['validate', 'apply', 'save-profile', 'load-profile', 'load-template', 'load-active']) { const node = query('[data-config-action="' + name + '"]'); if (node) node.disabled = busy || rawDirty || pendingCustom || name === 'apply' && !validReview || name === 'load-profile' && !profiles.length || name === 'load-active' && !authoritative?.active; }
    if (!rawDirty) { const raw = query('[data-config-json]'); if (raw) raw.value = JSON.stringify(draft, null, 2); }
    const reviewStep = query('[data-config-step="review"]');
    const applyStep = query('[data-config-step="apply"]');
    reviewStep?.classList.toggle('is-complete', validReview);
    reviewStep?.classList.toggle('is-current', !validReview);
    applyStep?.classList.toggle('is-current', validReview);
    const reviewState = query('[data-config-review-state]');
    if (reviewState) reviewState.textContent = validReview ? 'Validated · ready to review' : rawDirty || pendingCustom ? 'JSON buffer needs parsing' : 'Validation required';
    renderDiff();
    updatePreviews();
  }
  function clearFieldErrors() {
    container.querySelectorAll('[data-config-path][aria-invalid],[data-config-custom-json][aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
  }
  function revealError(error) {
    const path = (typeof error === 'string' ? error.split(':')[0] : error.path || '').replace(/^\$\./, '');
    const fieldNode = [...container.querySelectorAll('[data-config-path],[data-config-custom-json]')].find(node => { const fieldPath = node.dataset.configPath || node.dataset.configCustomJson; return path === fieldPath || path.startsWith(fieldPath + '.') || path.startsWith(fieldPath + '['); });
    const node = fieldNode || query('[data-config-json]');
    fieldNode?.setAttribute('aria-invalid', 'true');
    for (let ancestor = node?.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) if (ancestor.matches('details[data-config-section]')) { ancestor.open = true; expanded.set(ancestor.dataset.configSection, true); }
    return fieldNode;
  }
  function rememberEditor() {
    container.querySelectorAll('details[data-config-section]').forEach(node => expanded.set(node.dataset.configSection, node.open));
    if (rawDirty && query('[data-config-json]')) rawBuffer = query('[data-config-json]').value;
    if (query('[data-config-profile-name]')) profileName = query('[data-config-profile-name]').value;
    if (query('[data-config-profile]')) selectedProfile = query('[data-config-profile]').value;
  }
  function icon(kind) {
    const shapes = {
      goal: '<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="3" fill="currentColor"/><path d="m24 24 17-17m-7 0h7v7"/>',
      calendar: '<rect x="7" y="10" width="34" height="32" rx="6"/><path d="M7 20h34M16 6v8M32 6v8m-18 14h4m7 0h4m-15 7h4m7 0h4"/>',
      sharing: '<path d="M24 5 8 12v12c0 9 9 15 16 19 7-4 16-10 16-19V12Z"/><path d="m17 24 5 5 10-11"/>'
    };
    return '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shapes[kind] + '</svg>';
  }
  const fields = paths => paths.map(path => field(...fieldSpecs.find(spec => spec[0] === path))).join('');
  // Update only these read-only previews as the draft changes. Inputs and their
  // selection/focus stay mounted, including during language switching.
  const previewText = (value, empty = 'Not set') => typeof value === 'string' && value.trim() ? '<span data-i18n-ignore>' + escapeHtml(value) + '</span>' : '<span class="bob-preview-empty">' + empty + '</span>';
  const arrayValue = path => Array.isArray(getPath(draft, path)) ? getPath(draft, path) : [];
  function chips(values, empty, { friendly = false, limit = 4 } = {}) {
    const names = { day: 'Day', time: 'Time', status: 'Free / busy', availability: 'Availability', brief: 'Brief' };
    const shown = values.slice(0, limit).map(value => '<span class="bob-preview-chip"' + (friendly && Object.hasOwn(names, value) ? '' : ' data-i18n-ignore') + '>' + escapeHtml(friendly && Object.hasOwn(names, value) ? names[value] : value) + '</span>').join('');
    return '<span class="bob-preview-chips">' + (shown || '<span class="bob-preview-empty">' + empty + '</span>') + (values.length > limit ? '<span class="bob-preview-more">+' + (values.length - limit) + '</span>' : '') + '</span>';
  }
  function calendarPreview() {
    const rows = arrayValue('data.availableTimes');
    const intervals = rows.slice(0, 3).map(row => {
      const time = typeof row?.time === 'string' ? row.time : '';
      const match = /^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})$/.exec(time);
      const start = match ? Number(match[1]) * 60 + Number(match[2]) : -1;
      const end = match ? Number(match[3]) * 60 + Number(match[4]) : -1;
      const valid = match && Number(match[1]) < 24 && Number(match[3]) < 24 && Number(match[2]) < 60 && Number(match[4]) < 60 && end > start;
      return '<span class="bob-calendar-row"><span class="bob-calendar-day">' + previewText(row?.day, 'Day not set') + '</span><span class="bob-calendar-slot"><span class="bob-calendar-time">' + previewText(time, 'Time not set') + '</span><span class="bob-calendar-track" aria-hidden="true">' + (valid ? '<span class="bob-calendar-interval" style="left:' + (start / 14.4).toFixed(2) + '%;width:' + ((end - start) / 14.4).toFixed(2) + '%"></span>' : '<span class="bob-calendar-unparsed"></span>') + '</span></span></span>';
    }).join('');
    return '<span class="bob-preview-kicker"><span>Available intervals</span><strong>' + rows.length + '</strong></span>'
      + (intervals ? '<span class="bob-calendar">' + intervals + '<span class="bob-calendar-scale" aria-hidden="true"><span>00:00</span><span>12:00</span><span>24:00</span></span></span>' : '<span class="bob-preview-empty">Add a day and time to see the calendar.</span>')
      + (rows.length > 3 ? '<span class="bob-preview-footnote">+' + (rows.length - 3) + ' more intervals in editor</span>' : '')
      + '<span class="bob-preview-footnote"><span class="bob-mini-dot"></span><span>' + (getPath(draft, 'response.offerBrief') === true ? 'Optional brief enabled' : 'Optional brief off') + '</span></span>';
  }
  function sharingPreview() {
    const mode = getPath(draft, 'permissions.confirmation');
    const hasScope = ['permissions.recipients', 'permissions.fields', 'permissions.resources'].every(path => arrayValue(path).length > 0);
    return '<span class="bob-sharing-route"><span class="bob-sharing-owner">Bob</span><span class="bob-sharing-arrow" aria-hidden="true">→</span>' + chips(arrayValue('permissions.recipients'), 'No recipients', { limit: 3 }) + '</span>'
      + '<span class="bob-preview-label">Allowed to send</span>' + chips(arrayValue('permissions.fields'), 'No fields', { friendly: true })
      + '<span class="bob-preview-label">Resources</span>' + chips(arrayValue('permissions.resources'), 'No resources', { friendly: true, limit: 2 })
      + '<span class="bob-preview-footnote"><span class="bob-mini-shield">' + icon('sharing') + '</span><span>' + (!hasScope ? 'No shareable scope' : mode === 'bounded' ? 'Within a fixed permission' : 'Confirm every send') + '</span></span>'
      + '<span class="bob-preview-footnote"><span>Sharing window</span><strong>' + previewText(getPath(draft, 'permissions.window')) + '</strong></span>';
  }
  function goalPreview() {
    return '<span class="bob-preview-label">Objective</span><span class="bob-goal-text">' + previewText(getPath(draft, 'objective'), 'Add Bob’s objective') + '</span>'
      + '<span class="bob-preview-label">Persona</span><span class="bob-persona-text">' + previewText(getPath(draft, 'persona'), 'Add Bob’s role') + '</span>';
  }
  function updatePreviews() {
    if (!draft) return;
    for (const [key, markup] of [['goal', goalPreview()], ['calendar', calendarPreview()], ['sharing', sharingPreview()]]) {
      const preview = query('[data-config-preview="' + key + '"]');
      if (preview) preview.innerHTML = markup;
    }
    const state = query('[data-config-preview-state]');
    if (state) state.textContent = rawDirty || customBuffers.size ? 'Preview shows the last parsed draft' : 'Live draft preview';
  }
  function subgroup(key, title, contents, hint = '') {
    return '<details class="config-subsection bob-field-group" data-config-section="' + key + '"><summary>' + title + '</summary>' + (hint ? '<p class="bob-group-hint">' + hint + '</p>' : '') + '<div class="stack">' + contents + '</div></details>';
  }
  function customJson(path, label, hint, fallback = {}) {
    const buffer = customBuffers.has(path) ? customBuffers.get(path) : JSON.stringify(getPath(draft, path) ?? fallback, null, 2);
    return '<p class="bob-group-hint">' + hint + '</p><label class="field"><span>' + label + '</span><textarea class="mono" rows="6" spellcheck="false" data-config-custom-json="' + path + '">' + escapeHtml(buffer) + '</textarea></label><div class="toolbar section-actions"><button class="button" data-config-action="parse-custom" data-config-custom-path="' + path + '">Use custom content</button><button class="button quiet" data-config-action="discard-custom" data-config-custom-path="' + path + '">Discard custom buffer</button></div>';
  }
  function topic(key, tone, title, description, contents) {
    return '<details class="config-topic bob-visual-topic tone-' + tone + '" data-config-section="' + key + '"><summary><span class="config-topic-icon">' + icon(key) + '</span><span class="config-topic-copy"><strong>' + title + '</strong></span><span class="bob-topic-edit">Edit</span><span class="bob-draft-preview" data-config-preview="' + key + '"></span></summary><div class="config-topic-body"><p class="bob-topic-guide">' + description + '</p>' + contents + '</div></details>';
  }
  function render() {
    if (!authoritative || !draft) return;
    rememberEditor();
    container.innerHTML = '<div class="panel-heading"><div><h2>Bob configuration</h2><small>Researcher controls Bob. Alice retains her own data-sharing decisions.</small></div><div class="toolbar"><span class="tag" data-config-draft-version>Draft edit ' + draftVersion + '</span><button class="button quiet" data-config-action="reload">Reload saved configuration</button></div></div>'
      + '<div class="bob-editor-guide"><span>Start with three essentials. Open a card when you want to adjust its details.</span><span class="bob-draft-state" data-config-preview-state>Live draft preview</span></div>'
      + '<div class="config-overview">'
      + topic('goal', 'violet', 'Goal & role', 'What Bob should achieve, and how he should act.', '<div class="stack">' + fields(['objective']) + '</div>' + subgroup('persona', 'Role & tone', fields(['persona']), 'Describe the character behind Bob’s replies.'))
      + topic('calendar', 'blue', 'Time & materials', 'The calendar and brief Bob can work with.', '<div class="stack">' + fields(['data.availableTimes']) + '<small class="bob-input-hint">Example: Thu 15:00–15:30. The preview uses a 24-hour timeline.</small></div>' + subgroup('source', 'Data source', fields(['data.source'])) + subgroup('brief', 'Optional brief', fields(['response.offerBrief', 'data.brief.topic', 'data.brief.agenda']) + subgroup('custom-brief', 'Custom brief fields', customJson('data.brief', 'Complete fictional brief', 'Add your own fields and JSON values. Keep only the fields you want Bob to hold.')), 'Choose whether Bob can offer a brief, then add its content.'))
      + topic('sharing', 'green', 'Sharing boundaries', 'Who can receive what, and when Bob asks first.', '<div class="stack">' + fields(['permissions.recipients', 'permissions.fields']) + '<small class="bob-input-hint">Separate multiple values with commas.</small></div>' + subgroup('scope', 'Resources & sharing window', fields(['permissions.resources', 'permissions.window'])) + subgroup('approval', 'Confirmation & limits', fields(['permissions.confirmation', 'permissions.maxUses', 'permissions.expiryMinutes', 'permissions.askAdminForNewScope']), 'Bounded sends still obey the recipients, fields, window and limits above.') + subgroup('limits', 'Collaboration', fields(['collaboration.acceptInvitations', 'collaboration.allowedPeers']), 'Invitation acceptance stays inside Bob’s permission.'))
      + '</div><div class="config-workspace">'
      + '<section class="config-customize"><details class="config-group config-advanced" data-config-section="advanced"><summary><span>Fine-tune behavior</span><span class="config-level">Advanced</span></summary><p class="muted">Explore these after the essentials feel right.</p>'
      + '<details class="config-subsection" data-config-section="response"><summary>Reply style</summary><div class="stack">' + fields(['response.constraints', 'response.maxWords']) + '</div></details>'
      + '<details class="config-subsection" data-config-section="prompts"><summary>Prompts & tools</summary><div class="stack">' + fields(['prompts.system', 'prompts.followUp', 'tools.capabilities']) + '</div></details>'
      + '<details class="config-subsection" data-config-section="custom-skills"><summary>Custom capability descriptions</summary>' + customJson('tools.skillDefinitions', 'Capability definitions', 'Define id, label and description for your capability IDs. Instructions guide planning; executable actions still come from the runtime registry.', []) + '</details>'
      + '<details class="config-subsection" data-config-section="extensions"><summary>Custom configuration fields</summary>' + customJson('extensions', 'Extension fields', 'Keep your own research metadata and nested JSON values here.') + '</details>'
      + '<details class="config-subsection" data-config-section="json"><summary>All configuration · JSON</summary><div class="notice">LLM provider, model and generation settings for both Alice and Bob are managed in Model configuration. Legacy runtime model fields are retained in JSON but do not override those settings.</div><p class="muted">Unknown keys are retained. JSON changes are a buffer until parsed; form editing pauses meanwhile. Never enter API keys here.</p><label class="field"><span>Canonical draft / JSON edit buffer</span><textarea class="mono" rows="12" spellcheck="false" data-config-json></textarea></label><div class="toolbar section-actions"><button class="button" data-config-action="parse-json">Parse into draft</button><button class="button" data-config-action="discard-json">Discard JSON buffer</button></div></details></details>'
      + '<details class="config-group config-support" data-config-section="saved"><summary><span>Saved drafts & history</span><span class="config-level">Optional</span></summary><div class="toolbar section-actions"><span class="tag">Template r' + escapeHtml(authoritative.templateRevision) + '</span><span class="tag">' + (authoritative.activeRevision == null ? 'No active session' : 'Active r' + escapeHtml(authoritative.activeRevision)) + '</span></div><div class="toolbar section-actions"><button class="button" data-config-action="load-template">Load template into draft</button><button class="button" data-config-action="load-active">Load active into draft</button><button class="button" data-config-action="download">Download validated configuration</button><label class="button import-fixture-label">Import Bob configuration<input type="file" accept="application/json,.json" data-config-import></label></div>'
      + '<details class="config-subsection" data-config-section="profiles"><summary>Profiles</summary><small>Server-saved Bob configurations, separate from participant research records.</small><label class="field"><span>Profile name</span><input type="text" data-config-profile-name placeholder="Conference baseline"></label><div class="toolbar section-actions"><button class="button" data-config-action="save-profile">Save draft profile</button></div><label class="field"><span>Saved profile</span><select data-config-profile>' + profiles.map(profile => '<option value="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</option>').join('') + '</select></label><button class="button section-actions" data-config-action="load-profile" ' + (!profiles.length ? 'disabled' : '') + '>Load as draft</button></details>'
      + '<details class="config-subsection" data-config-section="revisions"><summary>Saved configuration revisions</summary>' + ((authoritative.versions || []).length ? (authoritative.versions || []).map(version => '<details data-config-section="revision-' + escapeHtml(version.target + '-' + version.revision) + '"><summary>r' + escapeHtml(version.revision) + ' · ' + escapeHtml(version.target) + ' · ' + escapeHtml(version.createdAt) + '</summary><code>' + escapeHtml(version.hash) + '</code><pre>' + escapeHtml(JSON.stringify(version.config, null, 2)) + '</pre></details>').join('') : '<p class="muted">No saved revisions returned by the server.</p>') + '</details></details></section>'
      + '<section class="panel config-review"><div class="panel-heading"><h3>Review & apply</h3><span class="tag" data-config-review-state>Validation required</span></div><ol class="config-flow" aria-label="Configuration steps"><li class="is-complete" data-config-step="configure"><span>1</span><strong>Configure</strong></li><li class="is-current" data-config-step="review"><span>2</span><strong>Review changes</strong></li><li data-config-step="apply"><span>3</span><strong>Apply</strong></li></ol>'
      + '<h4>Apply scope</h4><div class="choices bob-apply-choices"><label class="choice"><input type="radio" name="config-target" value="template" ' + (target === 'template' ? 'checked' : '') + '><span><strong>Template · new rounds</strong><small>Next rounds</small></span></label><label class="choice"><input type="radio" name="config-target" value="session" ' + (target === 'session' ? 'checked' : '') + (!sessionId ? ' disabled' : '') + '><span><strong>Pause & apply to this round</strong><small>Current round</small></span></label></div>'
      + '<details class="config-subsection bob-scope-explainer" data-config-section="target"><summary>How application affects rounds</summary><p class="muted">' + (target === 'template' ? 'Default. Current rounds keep their existing revision.' : 'Temporary Bob override. The next round uses the template; already delivered content stays delivered.') + '</p><small>' + (sessionId ? 'Selected session: <span data-i18n-ignore>' + escapeHtml(sessionId) + '</span>' : 'No active session selected; template editing only.') + '</small></details>'
      + '<div class="notice ' + messageKind + '" data-config-notice role="' + (messageKind === 'error' ? 'alert' : 'status') + '" aria-live="polite">' + escapeHtml(message || 'Draft belongs to this editor; the server owns active and template revisions.') + '</div><button class="button" data-config-action="validate">Validate & preview diff</button>'
      + '<details class="config-diff-review config-subsection" data-config-section="diff"><summary>Changes to review</summary><div data-config-change-summary hidden></div><details class="config-technical-diff" data-config-section="technical-diff"><summary>Exact properties & raw values</summary><div class="table-wrap"><table class="config-diff"><thead><tr><th>Property</th><th>Authoritative before</th><th>Draft after</th></tr></thead><tbody data-config-diff></tbody></table></div></details></details>'
      + '<button class="button primary section-actions" data-config-action="apply">' + (target === 'template' ? 'Save template for new rounds' : 'Pause & apply current round') + '</button></section></div>';
    container.querySelectorAll('details[data-config-section]').forEach(node => { node.open = expanded.get(node.dataset.configSection) === true; });
    if (rawDirty) query('[data-config-json]').value = rawBuffer;
    query('[data-config-profile-name]').value = profileName;
    if (profiles.some(profile => profile.name === selectedProfile)) query('[data-config-profile]').value = selectedProfile;
    updateControls();
  }
  async function load(id = getSessionId?.(), { force = false } = {}) {
    if (!force && authoritative && draft && sessionId === (id || null)) { render(); return; }
    const ownGeneration = ++generation; sessionId = id || null; target = 'template'; rawDirty = false; customBuffers.clear(); reviewed = null; diff = []; message = ''; busy = true;
    container.innerHTML = '<section class="panel loading">Loading Bob’s authoritative configuration…</section>';
    try {
      const value = await api('/api/admin/config' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), { admin: true });
      if (ownGeneration !== generation) return;
      authoritative = value; profiles = value.profiles || []; draft = clone(value.template); draftVersion = 1;
      busy = false; render();
    } catch (error) { if (ownGeneration !== generation) return; busy = false; container.innerHTML = '<section class="panel"><div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-config-action="reload">Reload configuration</button></section>'; }
  }
  function clear() { generation++; authoritative = null; draft = null; profiles = []; reviewed = null; rawDirty = false; customBuffers.clear(); container.innerHTML = '<section class="panel">Researcher sign-in is required.</section>'; }
  function commitField(node) {
    if (!draft || rawDirty || customBuffers.size || busy) return;
    const path = node.dataset.configPath, type = node.dataset.configType;
    let value = node.value;
    if (type === 'boolean') value = node.checked;
    if (type === 'number') value = node.value === '' ? null : Number(node.value);
    if (type === 'csv') value = node.value.split(',').map(item => item.trim()).filter(Boolean);
    if (type === 'times') { const prior = getPath(draft, path); value = node.value.split('\n').map(item => item.trim()).filter(Boolean).map((line, index) => { const split = line.indexOf(' '); return { ...(Array.isArray(prior) ? prior[index] : {}), day: split < 0 ? line : line.slice(0, split), time: split < 0 ? '' : line.slice(split + 1).trim() }; }); }
    setPath(draft, path, value); invalidate();
  }
  container.addEventListener('input', event => {
    if (event.target.matches('[data-config-custom-json]') && !busy && !rawDirty) { customBuffers.set(event.target.dataset.configCustomJson, event.target.value); reviewed = null; diff = []; announce('Custom content is a buffer. Use or discard it before validation.'); updateControls(); }
    else if (event.target.matches('[data-config-json]')) { rawDirty = true; reviewed = null; announce('Unparsed JSON buffer. The form is locked and no active setting has changed.'); updateControls(); }
    else if (event.target.dataset.configPath && event.target.type !== 'checkbox' && event.target.tagName !== 'SELECT') commitField(event.target);
  });
  container.addEventListener('change', async event => {
    if (event.target.matches('[data-config-import]')) {
      const input = event.target, file = input.files?.[0]; if (!file || busy || rawDirty || customBuffers.size) return;
      const importGeneration = generation; busy = true; updateControls();
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('Configuration files must be at most 4 MiB.');
        const parsed = JSON.parse(await file.text()); if (importGeneration !== generation) return;
        const value = parsed && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'config') ? parsed.config : parsed;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.');
        draft = value; reviewed = null; diff = []; draftVersion++; busy = false; render(); announce('Configuration imported as a draft. Validate and review before applying.');
      } catch (error) { if (importGeneration === generation) announce('Import error: ' + error.message, true); }
      finally { input.value = ''; if (importGeneration === generation) { busy = false; updateControls(); } }
      return;
    }
    if (event.target.dataset.configPath && (event.target.type === 'checkbox' || event.target.tagName === 'SELECT')) commitField(event.target);
    if (event.target.name === 'config-target') { target = event.target.value; reviewed = null; diff = []; announce(rawDirty ? 'Unparsed JSON buffer. The form is locked and no active setting has changed.' : 'Apply scope changed. Validate and review this draft for the selected scope.'); render(); }
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-config-action]'); if (!button || button.disabled) return;
    const action = button.dataset.configAction;
    if (action === 'reload') { load(undefined, { force: true }); return; }
    if (!draft) return;
    if (action === 'parse-custom' || action === 'discard-custom') {
      const path = button.dataset.configCustomPath;
      const node = [...container.querySelectorAll('[data-config-custom-json]')].find(node => node.dataset.configCustomJson === path);
      if (!node || rawDirty || busy) return;
      if (action === 'parse-custom') {
        try {
          const value = JSON.parse(node.value), expectsArray = path === 'tools.skillDefinitions';
          if (expectsArray ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(expectsArray ? 'Use a JSON array of capability definitions.' : 'Use a JSON object for custom fields.');
          setPath(draft, path, value); customBuffers.delete(path); invalidate(); render(); announce('Custom content added to the draft. Validate before applying.');
        } catch (error) { node.setAttribute('aria-invalid', 'true'); announce('JSON parse error: ' + error.message, true); node.focus(); }
      } else { customBuffers.delete(path); node.removeAttribute('aria-invalid'); render(); announce('Custom buffer discarded; the draft was retained.'); }
      return;
    }
    if (action === 'download') {
      if (reviewed !== stamp() || rawDirty || customBuffers.size || busy) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })), link = document.createElement('a');
      link.href = url; link.download = 'bob-configuration.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (action === 'parse-json') { try { const value = JSON.parse(query('[data-config-json]').value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.'); draft = value; rawDirty = false; invalidate(); render(); announce('JSON parsed into the canonical draft. Unknown keys preserved; validate before applying.'); } catch (error) { announce('JSON parse error: ' + error.message, true); } return; }
    if (action === 'discard-json') { rawDirty = false; announce('Unparsed JSON edits discarded; the canonical draft was retained.'); updateControls(); return; }
    if (action === 'load-template' || action === 'load-active') { draft = clone(action === 'load-template' ? authoritative.template : authoritative.active); rawDirty = false; invalidate(); render(); return; }
    if (action === 'load-profile') { const profile = profiles.find(item => item.name === query('[data-config-profile]').value); if (profile) { draft = clone(profile.config); rawDirty = false; invalidate(); render(); announce('Profile loaded as draft only. Validate its changes before applying.'); } return; }
    if (rawDirty || customBuffers.size) { announce('Parse or discard the JSON buffer first.', true); return; }
    const ownGeneration = generation, ownStamp = stamp();
    let firstInvalidField = null;
    busy = true; updateControls();
    try {
      if (action === 'validate') {
        const result = await api('/api/admin/config/validate', { method: 'POST', admin: true, body: { config: draft, ...(target === 'session' && sessionId ? { sessionId } : {}) } });
        if (ownGeneration !== generation || ownStamp !== stamp()) return;
        reviewed = result.valid ? ownStamp : null; diff = result.diff || [];
        const errors = (result.errors || []).map(error => typeof error === 'string' ? error : [error.path, error.message].filter(Boolean).join(': '));
        expanded.set('diff', true);
        const review = query('[data-config-section="diff"]'); if (review) review.open = true;
        clearFieldErrors();
        if (!result.valid) for (const error of result.errors || []) { const node = revealError(error); if (!firstInvalidField && node) firstInvalidField = node; }
        announce(result.valid ? 'Server validation passed. Review ' + diff.length + ' changed properties before applying.' : errors.join(' ') || 'Configuration validation failed.', !result.valid, result.valid);
      } else if (action === 'apply') {
        if (reviewed !== stamp()) throw new Error('Validate this exact draft and target first.');
        const result = await api('/api/admin/config/apply', { method: 'POST', admin: true, body: { config: draft, target, ...(sessionId ? { sessionId } : {}), expectedRevision: target === 'template' ? authoritative.templateRevision : authoritative.activeRevision } });
        if (ownGeneration !== generation) return;
        authoritative = { ...authoritative, ...result }; reviewed = null; diff = [];
        onApplied?.(result);
        announce(target === 'template' ? 'Template saved for new rounds. Existing rounds keep their active configuration.' : 'Bob’s temporary override is active and the round is paused. Recheck Bob before resuming; Alice grants and already received content are unchanged.');
        render();
      } else if (action === 'save-profile') {
        const name = query('[data-config-profile-name]').value.trim(); if (!name) throw new Error('Enter a profile name.');
        await api('/api/admin/profiles', { method: 'POST', admin: true, body: { name, config: draft } });
        if (ownGeneration !== generation) return;
        const result = await api('/api/admin/profiles', { admin: true });
        if (ownGeneration !== generation) return;
        profiles = result.profiles; render(); announce('Profile saved on the server. No participant record or template was changed.');
      }
    } catch (error) { if (ownGeneration !== generation) return; reviewed = null; announce(error.status === 409 ? 'The authoritative revision changed. Reload and review the new diff; nothing was automatically reapplied.' : error.message, true); }
    finally { if (ownGeneration === generation) { busy = false; updateControls(); firstInvalidField?.focus(); } }
  });
  clear();
  return { load, clear };
}
