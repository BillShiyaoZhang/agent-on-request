const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
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
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify([draft, target, sessionId]);
  function announce(text, error = false, success = false) { message = text; messageKind = error ? 'error' : success ? 'success' : ''; const notice = query('[data-config-notice]'); if (notice) { notice.textContent = text; notice.className = 'notice ' + messageKind; notice.setAttribute('role', error ? 'alert' : 'status'); } }
  function invalidate() { reviewed = null; diff = []; draftVersion++; announce('Draft changed. Validate and review the exact diff before applying.'); updateControls(); }
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
    if (type === 'mode') input = '<select data-config-path="' + path + '"><option value="each_action" ' + (value === 'each_action' ? 'selected' : '') + '>Confirm each action</option><option value="bounded" ' + (value === 'bounded' ? 'selected' : '') + '>Bounded preauthorization</option></select>';
    else if (type === 'textarea' || type === 'times') input = '<textarea rows="2" data-config-path="' + path + '" data-config-type="' + type + '">' + escapeHtml(value) + '</textarea>';
    else input = '<input type="' + (type === 'number' ? 'number' : 'text') + '" ' + (type === 'number' ? 'step="any" ' : '') + 'data-config-path="' + path + '" data-config-type="' + type + '" value="' + escapeHtml(value) + '">';
    return '<label class="field"><span>' + label + '</span>' + input + '</label>';
  }
  function renderDiff() {
    const body = query('[data-config-diff]'); if (!body) return;
    body.innerHTML = diff.length ? diff.map(item => '<tr><td>' + escapeHtml(item.path) + '</td><td>' + escapeHtml(JSON.stringify(item.before) ?? '∅') + '</td><td>' + escapeHtml(JSON.stringify(item.after) ?? '∅') + '</td></tr>').join('') : '<tr><td colspan="3">' + (reviewed ? 'No configuration changes.' : 'Diff not reviewed.') + '</td></tr>';
  }
  function updateControls() {
    const validReview = reviewed === stamp() && !rawDirty;
    container.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = busy; });
    query('[data-config-draft-version]')?.replaceChildren(document.createTextNode('Draft edit ' + draftVersion));
    container.querySelectorAll('[data-config-path]').forEach(node => { node.disabled = busy || rawDirty; });
    container.querySelectorAll('[name="config-target"]').forEach(node => { node.disabled = busy || node.value === 'session' && !sessionId; });
    for (const name of ['validate', 'apply', 'save-profile', 'load-profile', 'load-template', 'load-active']) { const node = query('[data-config-action="' + name + '"]'); if (node) node.disabled = busy || rawDirty || name === 'apply' && !validReview || name === 'load-profile' && !profiles.length || name === 'load-active' && !authoritative?.active; }
    if (!rawDirty) { const raw = query('[data-config-json]'); if (raw) raw.value = JSON.stringify(draft, null, 2); }
    const reviewStep = query('[data-config-step="review"]');
    const applyStep = query('[data-config-step="apply"]');
    reviewStep?.classList.toggle('is-complete', validReview);
    reviewStep?.classList.toggle('is-current', !validReview);
    applyStep?.classList.toggle('is-current', validReview);
    const reviewState = query('[data-config-review-state]');
    if (reviewState) reviewState.textContent = validReview ? 'Validated · ready to review' : rawDirty ? 'JSON buffer needs parsing' : 'Validation required';
    renderDiff();
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
  function topic(key, tone, title, description, contents) {
    return '<details class="config-topic tone-' + tone + '" data-config-section="' + key + '"><summary><span class="config-topic-icon">' + icon(key) + '</span><span class="config-topic-copy"><strong>' + title + '</strong><small>' + description + '</small></span><span class="config-level">Essentials</span></summary><div class="config-topic-body">' + contents + '</div></details>';
  }
  function render() {
    if (!authoritative || !draft) return;
    rememberEditor();
    container.innerHTML = '<div class="panel-heading"><div><h2>Bob configuration</h2><small>Researcher controls Bob. Alice retains her own data-sharing decisions.</small></div><div class="toolbar"><span class="tag" data-config-draft-version>Draft edit ' + draftVersion + '</span><button class="button quiet" data-config-action="reload">Reload saved configuration</button></div></div>'
      + '<p class="config-intro">Start with three essentials. Open a card when you want to adjust its details.</p>'
      + '<div class="config-overview">'
      + topic('goal', 'violet', 'Goal & role', 'What Bob should achieve, and how he should act.', '<div class="stack">' + fields(['objective', 'persona']) + '</div>')
      + topic('calendar', 'blue', 'Time & materials', 'The calendar and brief Bob can work with.', '<div class="stack">' + fields(['data.source', 'data.availableTimes']) + '</div><details class="config-subsection" data-config-section="brief"><summary>Optional brief</summary><div class="stack">' + fields(['data.brief.topic', 'data.brief.agenda', 'response.offerBrief']) + '</div></details>')
      + topic('sharing', 'green', 'Sharing boundaries', 'Who can receive what, and when Bob asks first.', '<div class="config-detail-grid form-grid">' + fields(['permissions.recipients', 'permissions.fields', 'permissions.resources', 'permissions.window', 'permissions.confirmation']) + '</div><details class="config-subsection" data-config-section="limits"><summary>Permission limits & collaboration</summary><div class="stack">' + fields(['permissions.askAdminForNewScope', 'permissions.maxUses', 'permissions.expiryMinutes', 'collaboration.acceptInvitations', 'collaboration.allowedPeers']) + '</div></details>')
      + '</div><div class="config-workspace">'
      + '<section class="config-customize"><details class="config-group config-advanced" data-config-section="advanced"><summary><span>Fine-tune behavior</span><span class="config-level">Advanced</span></summary><p class="muted">Explore these after the essentials feel right.</p>'
      + '<details class="config-subsection" data-config-section="response"><summary>Reply style</summary><div class="stack">' + fields(['response.constraints', 'response.maxWords']) + '</div></details>'
      + '<details class="config-subsection" data-config-section="prompts"><summary>Prompts & tools</summary><div class="stack">' + fields(['prompts.system', 'prompts.followUp', 'tools.capabilities']) + '</div></details>'
      + '<details class="config-subsection" data-config-section="json"><summary>All configuration · JSON</summary><div class="notice">LLM provider, model and generation settings for both Alice and Bob are managed in Model configuration. Legacy runtime model fields are retained in JSON but do not override those settings.</div><p class="muted">Unknown keys are retained. JSON changes are a buffer until parsed; form editing pauses meanwhile. Never enter API keys here.</p><label class="field"><span>Canonical draft / JSON edit buffer</span><textarea class="mono" rows="12" spellcheck="false" data-config-json></textarea></label><div class="toolbar section-actions"><button class="button" data-config-action="parse-json">Parse into draft</button><button class="button" data-config-action="discard-json">Discard JSON buffer</button></div></details></details>'
      + '<details class="config-group config-support" data-config-section="saved"><summary><span>Saved drafts & history</span><span class="config-level">Optional</span></summary><div class="toolbar section-actions"><span class="tag">Template r' + escapeHtml(authoritative.templateRevision) + '</span><span class="tag">' + (authoritative.activeRevision == null ? 'No active session' : 'Active r' + escapeHtml(authoritative.activeRevision)) + '</span></div><div class="toolbar section-actions"><button class="button" data-config-action="load-template">Load template into draft</button><button class="button" data-config-action="load-active">Load active into draft</button></div>'
      + '<details class="config-subsection" data-config-section="profiles"><summary>Profiles</summary><small>Server-saved Bob configurations, separate from participant research records.</small><label class="field"><span>Profile name</span><input type="text" data-config-profile-name placeholder="Conference baseline"></label><div class="toolbar section-actions"><button class="button" data-config-action="save-profile">Save draft profile</button></div><label class="field"><span>Saved profile</span><select data-config-profile>' + profiles.map(profile => '<option value="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</option>').join('') + '</select></label><button class="button section-actions" data-config-action="load-profile" ' + (!profiles.length ? 'disabled' : '') + '>Load as draft</button></details>'
      + '<details class="config-subsection" data-config-section="revisions"><summary>Saved configuration revisions</summary>' + ((authoritative.versions || []).length ? (authoritative.versions || []).map(version => '<details data-config-section="revision-' + escapeHtml(version.target + '-' + version.revision) + '"><summary>r' + escapeHtml(version.revision) + ' · ' + escapeHtml(version.target) + ' · ' + escapeHtml(version.createdAt) + '</summary><code>' + escapeHtml(version.hash) + '</code><pre>' + escapeHtml(JSON.stringify(version.config, null, 2)) + '</pre></details>').join('') : '<p class="muted">No saved revisions returned by the server.</p>') + '</details></details></section>'
      + '<section class="panel config-review"><div class="panel-heading"><h3>Review & apply</h3><span class="tag" data-config-review-state>Validation required</span></div><ol class="config-flow" aria-label="Configuration steps"><li class="is-complete" data-config-step="configure"><span>1</span><strong>Configure</strong></li><li class="is-current" data-config-step="review"><span>2</span><strong>Review changes</strong></li><li data-config-step="apply"><span>3</span><strong>Apply</strong></li></ol>'
      + '<h4>Apply scope</h4><div class="choices"><label class="choice"><input type="radio" name="config-target" value="template" ' + (target === 'template' ? 'checked' : '') + '><span><strong>Template · new rounds</strong><small>Default. Current rounds keep their existing revision.</small></span></label><label class="choice"><input type="radio" name="config-target" value="session" ' + (target === 'session' ? 'checked' : '') + (!sessionId ? ' disabled' : '') + '><span><strong>Pause & apply to this round</strong><small>Temporary Bob override. The next round uses the template; already delivered content stays delivered.</small></span></label></div><small>' + (sessionId ? 'Selected session: ' + escapeHtml(sessionId) : 'No active session selected; template editing only.') + '</small>'
      + '<div class="notice ' + messageKind + '" data-config-notice role="' + (messageKind === 'error' ? 'alert' : 'status') + '" aria-live="polite">' + escapeHtml(message || 'Draft belongs to this editor; the server owns active and template revisions.') + '</div><button class="button" data-config-action="validate">Validate & preview diff</button>'
      + '<details class="config-diff-review config-subsection" data-config-section="diff"><summary>Changes to review</summary><div class="table-wrap"><table class="config-diff"><thead><tr><th>Property</th><th>Authoritative before</th><th>Draft after</th></tr></thead><tbody data-config-diff></tbody></table></div></details>'
      + '<button class="button primary section-actions" data-config-action="apply">' + (target === 'template' ? 'Save template for new rounds' : 'Pause & apply current round') + '</button></section></div>';
    container.querySelectorAll('details[data-config-section]').forEach(node => { node.open = expanded.get(node.dataset.configSection) === true; });
    if (rawDirty) query('[data-config-json]').value = rawBuffer;
    query('[data-config-profile-name]').value = profileName;
    if (profiles.some(profile => profile.name === selectedProfile)) query('[data-config-profile]').value = selectedProfile;
    updateControls();
  }
  async function load(id = getSessionId?.(), { force = false } = {}) {
    if (!force && authoritative && draft && sessionId === (id || null)) { render(); return; }
    const ownGeneration = ++generation; sessionId = id || null; target = 'template'; rawDirty = false; reviewed = null; diff = []; message = ''; busy = true;
    container.innerHTML = '<section class="panel loading">Loading Bob’s authoritative configuration…</section>';
    try {
      const value = await api('/api/admin/config' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), { admin: true });
      if (ownGeneration !== generation) return;
      authoritative = value; profiles = value.profiles || []; draft = clone(value.template); draftVersion = 1;
      busy = false; render();
    } catch (error) { if (ownGeneration !== generation) return; busy = false; container.innerHTML = '<section class="panel"><div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-config-action="reload">Reload configuration</button></section>'; }
  }
  function clear() { generation++; authoritative = null; draft = null; profiles = []; reviewed = null; rawDirty = false; container.innerHTML = '<section class="panel">Researcher sign-in is required.</section>'; }
  function commitField(node) {
    if (!draft || rawDirty || busy) return;
    const path = node.dataset.configPath, type = node.dataset.configType;
    let value = node.value;
    if (type === 'boolean') value = node.checked;
    if (type === 'number') value = node.value === '' ? null : Number(node.value);
    if (type === 'csv') value = node.value.split(',').map(item => item.trim()).filter(Boolean);
    if (type === 'times') { const prior = getPath(draft, path); value = node.value.split('\n').map(item => item.trim()).filter(Boolean).map((line, index) => { const split = line.indexOf(' '); return { ...(Array.isArray(prior) ? prior[index] : {}), day: split < 0 ? line : line.slice(0, split), time: split < 0 ? '' : line.slice(split + 1).trim() }; }); }
    setPath(draft, path, value); invalidate();
  }
  container.addEventListener('input', event => {
    if (event.target.matches('[data-config-json]')) { rawDirty = true; reviewed = null; announce('Unparsed JSON buffer. The form is locked and no active setting has changed.'); updateControls(); }
    else if (event.target.dataset.configPath && event.target.type !== 'checkbox' && event.target.tagName !== 'SELECT') commitField(event.target);
  });
  container.addEventListener('change', event => {
    if (event.target.dataset.configPath && (event.target.type === 'checkbox' || event.target.tagName === 'SELECT')) commitField(event.target);
    if (event.target.name === 'config-target') { target = event.target.value; reviewed = null; diff = []; announce(rawDirty ? 'Unparsed JSON buffer. The form is locked and no active setting has changed.' : 'Apply scope changed. Validate and review this draft for the selected scope.'); render(); }
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-config-action]'); if (!button || button.disabled) return;
    const action = button.dataset.configAction;
    if (action === 'reload') { load(undefined, { force: true }); return; }
    if (!draft) return;
    if (action === 'parse-json') { try { const value = JSON.parse(query('[data-config-json]').value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.'); draft = value; rawDirty = false; invalidate(); render(); announce('JSON parsed into the canonical draft. Unknown keys preserved; validate before applying.'); } catch (error) { announce('JSON parse error: ' + error.message, true); } return; }
    if (action === 'discard-json') { rawDirty = false; announce('Unparsed JSON edits discarded; the canonical draft was retained.'); updateControls(); return; }
    if (action === 'load-template' || action === 'load-active') { draft = clone(action === 'load-template' ? authoritative.template : authoritative.active); rawDirty = false; invalidate(); render(); return; }
    if (action === 'load-profile') { const profile = profiles.find(item => item.name === query('[data-config-profile]').value); if (profile) { draft = clone(profile.config); rawDirty = false; invalidate(); render(); announce('Profile loaded as draft only. Validate its changes before applying.'); } return; }
    if (rawDirty) { announce('Parse or discard the JSON buffer first.', true); return; }
    const ownGeneration = generation, ownStamp = stamp();
    busy = true; updateControls();
    try {
      if (action === 'validate') {
        const result = await api('/api/admin/config/validate', { method: 'POST', admin: true, body: { config: draft, ...(target === 'session' && sessionId ? { sessionId } : {}) } });
        if (ownGeneration !== generation || ownStamp !== stamp()) return;
        reviewed = result.valid ? ownStamp : null; diff = result.diff || [];
        const errors = (result.errors || []).map(error => typeof error === 'string' ? error : [error.path, error.message].filter(Boolean).join(': '));
        expanded.set('diff', true);
        const review = query('[data-config-section="diff"]'); if (review) review.open = true;
        if (!result.valid) for (const error of result.errors || []) {
          const path = (typeof error === 'string' ? error : error.path || '').replace(/^\$\./, '');
          const section = /^(persona|objective)/.test(path) ? 'goal' : /^(data\.brief|response\.offerBrief)/.test(path) ? 'brief' : /^data\./.test(path) ? 'calendar' : /^(permissions\.(maxUses|expiryMinutes|askAdminForNewScope)|collaboration\.)/.test(path) ? 'limits' : /^permissions\./.test(path) ? 'sharing' : /^response\./.test(path) ? 'response' : /^(prompts|tools)\./.test(path) ? 'prompts' : 'json';
          const node = query('[data-config-section="' + section + '"]');
          if (node) { node.open = true; expanded.set(section, true); for (let ancestor = node.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) if (ancestor.matches('details[data-config-section]')) { ancestor.open = true; expanded.set(ancestor.dataset.configSection, true); } }
        }
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
    finally { if (ownGeneration === generation) { busy = false; updateControls(); } }
  });
  clear();
  return { load, clear };
}
