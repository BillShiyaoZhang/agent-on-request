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
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify([draft, target, sessionId]);
  function announce(text, error = false) { message = text; messageKind = error ? 'error' : ''; const notice = query('[data-config-notice]'); if (notice) { notice.textContent = text; notice.className = 'notice ' + messageKind; notice.setAttribute('role', error ? 'alert' : 'status'); } }
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
    query('[data-config-draft-version]')?.replaceChildren(document.createTextNode('Draft edit ' + draftVersion));
    container.querySelectorAll('[data-config-path]').forEach(node => { node.disabled = busy || rawDirty; });
    for (const name of ['validate', 'apply', 'save-profile', 'load-profile', 'load-template', 'load-active']) { const node = query('[data-config-action="' + name + '"]'); if (node) node.disabled = busy || rawDirty || name === 'apply' && !validReview || name === 'load-profile' && !profiles.length || name === 'load-active' && !authoritative?.active; }
    if (!rawDirty) { const raw = query('[data-config-json]'); if (raw) raw.value = JSON.stringify(draft, null, 2); }
    renderDiff();
  }
  function render() {
    if (!authoritative || !draft) return;
    container.innerHTML = '<div class="panel-heading"><div><h2>Bob configuration</h2><small>Researcher controls Bob. Alice retains her own data-sharing decisions.</small></div><div class="toolbar"><span class="tag">Template r' + escapeHtml(authoritative.templateRevision) + '</span><span class="tag">' + (authoritative.activeRevision == null ? 'No active session' : 'Active r' + escapeHtml(authoritative.activeRevision)) + '</span><span class="tag" data-config-draft-version>Draft edit ' + draftVersion + '</span></div></div><div class="split-layout"><section class="panel"><h3>Task & synthetic calendar</h3><div class="stack" style="margin-top:13px">' + fieldSpecs.slice(0, 2).map(args => field(...args)).join('') + '<div class="form-grid">' + fieldSpecs.slice(2, 4).map(args => field(...args)).join('') + '</div></div><div class="config-group"><h3>Bob’s outbound permissions</h3><div class="form-grid" style="margin-top:13px">' + fieldSpecs.slice(4, 9).map(args => field(...args)).join('') + '</div>' + field(...fieldSpecs[9]) + '</div><details class="config-group"><summary>Prompts, brief & tools</summary><div class="stack" style="margin-top:13px">' + fieldSpecs.slice(10).map(args => field(...args)).join('') + '</div></details><details class="config-group"><summary>All configuration · JSON</summary><div class="notice">LLM provider, model and generation settings for both Alice and Bob are managed in Model configuration. Legacy runtime model fields are retained in JSON but do not override those settings.</div><p class="muted" style="margin:9px 0">Unknown keys are retained. JSON changes are a buffer until parsed; form editing pauses meanwhile. Never enter API keys here.</p><label class="field"><span>Canonical draft / JSON edit buffer</span><textarea class="mono" rows="12" spellcheck="false" data-config-json></textarea></label><div class="toolbar section-actions"><button class="button" data-config-action="parse-json">Parse into draft</button><button class="button" data-config-action="discard-json">Discard JSON buffer</button></div></details></section><section class="panel"><h3>Apply scope</h3><div class="choices" style="margin-top:12px"><label class="choice"><input type="radio" name="config-target" value="template" ' + (target === 'template' ? 'checked' : '') + '><span><strong>Template · new rounds</strong><small>Default. Current rounds keep their existing revision.</small></span></label><label class="choice"><input type="radio" name="config-target" value="session" ' + (target === 'session' ? 'checked' : '') + (!sessionId ? ' disabled' : '') + '><span><strong>Pause & apply to this round</strong><small>Temporary Bob override. The next round uses the template; already delivered content stays delivered.</small></span></label></div><small style="margin-top:9px">' + (sessionId ? 'Selected session: ' + escapeHtml(sessionId) : 'No active session selected; template editing only.') + '</small><div class="toolbar section-actions"><button class="button" data-config-action="load-template">Load template into draft</button><button class="button" data-config-action="load-active">Load active into draft</button></div><div class="notice ' + messageKind + '" data-config-notice role="status">' + escapeHtml(message || 'Draft belongs to this editor; the server owns active and template revisions.') + '</div><button class="button" data-config-action="validate">Validate & preview diff</button><div class="table-wrap"><table class="config-diff"><thead><tr><th>Property</th><th>Authoritative before</th><th>Draft after</th></tr></thead><tbody data-config-diff></tbody></table></div><button class="button primary section-actions" data-config-action="apply">' + (target === 'template' ? 'Save template for new rounds' : 'Pause & apply current round') + '</button><div class="config-group"><h3>Profiles</h3><small>Server-saved Bob configurations, separate from participant research records.</small><label class="field" style="margin-top:12px"><span>Profile name</span><input type="text" data-config-profile-name placeholder="Conference baseline"></label><div class="toolbar section-actions"><button class="button" data-config-action="save-profile">Save draft profile</button></div><label class="field" style="margin-top:12px"><span>Saved profile</span><select data-config-profile>' + profiles.map(profile => '<option value="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</option>').join('') + '</select></label><button class="button section-actions" data-config-action="load-profile" ' + (!profiles.length ? 'disabled' : '') + '>Load as draft</button></div><details class="config-group"><summary>Saved configuration revisions</summary>' + ((authoritative.versions || []).length ? (authoritative.versions || []).map(version => '<details><summary>r' + escapeHtml(version.revision) + ' · ' + escapeHtml(version.target) + ' · ' + escapeHtml(version.createdAt) + '</summary><code>' + escapeHtml(version.hash) + '</code><pre>' + escapeHtml(JSON.stringify(version.config, null, 2)) + '</pre></details>').join('') : '<p class="muted">No saved revisions returned by the server.</p>') + '</details></section></div>';
    updateControls();
  }
  async function load(id = getSessionId?.()) {
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
    if (event.target.name === 'config-target') { target = event.target.value; reviewed = null; diff = []; render(); }
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-config-action]'); if (!button || button.disabled) return;
    const action = button.dataset.configAction;
    if (action === 'reload') { load(); return; }
    if (!draft) return;
    if (action === 'parse-json') { try { const value = JSON.parse(query('[data-config-json]').value); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.'); draft = value; rawDirty = false; invalidate(); render(); announce('JSON parsed into the canonical draft. Unknown keys preserved; validate before applying.'); } catch (error) { announce('JSON parse error: ' + error.message, true); } return; }
    if (action === 'discard-json') { rawDirty = false; announce('Unparsed JSON edits discarded; the canonical draft was retained.'); updateControls(); return; }
    if (action === 'load-template' || action === 'load-active') { draft = clone(action === 'load-template' ? authoritative.template : authoritative.active); rawDirty = false; invalidate(); render(); return; }
    if (action === 'load-profile') { const profile = profiles.find(item => item.name === query('[data-config-profile]').value); if (profile) { draft = clone(profile.config); rawDirty = false; invalidate(); render(); announce('Profile loaded as draft only. Validate its changes before applying.'); } return; }
    if (rawDirty) { announce('Parse or discard the JSON buffer first.', true); return; }
    busy = true; updateControls();
    try {
      if (action === 'validate') {
        const result = await api('/api/admin/config/validate', { method: 'POST', admin: true, body: { config: draft, ...(target === 'session' && sessionId ? { sessionId } : {}) } });
        reviewed = result.valid ? stamp() : null; diff = result.diff || [];
        const errors = (result.errors || []).map(error => typeof error === 'string' ? error : [error.path, error.message].filter(Boolean).join(': '));
        announce(result.valid ? 'Server validation passed. Review ' + diff.length + ' changed properties before applying.' : errors.join(' ') || 'Configuration validation failed.', !result.valid);
      } else if (action === 'apply') {
        if (reviewed !== stamp()) throw new Error('Validate this exact draft and target first.');
        const result = await api('/api/admin/config/apply', { method: 'POST', admin: true, body: { config: draft, target, ...(sessionId ? { sessionId } : {}), expectedRevision: target === 'template' ? authoritative.templateRevision : authoritative.activeRevision } });
        authoritative = { ...authoritative, ...result }; reviewed = null; diff = [];
        onApplied?.(result);
        announce(target === 'template' ? 'Template saved for new rounds. Existing rounds keep their active configuration.' : 'Bob’s temporary override is active and the round is paused. Recheck Bob before resuming; Alice grants and already received content are unchanged.');
        render();
      } else if (action === 'save-profile') {
        const name = query('[data-config-profile-name]').value.trim(); if (!name) throw new Error('Enter a profile name.');
        await api('/api/admin/profiles', { method: 'POST', admin: true, body: { name, config: draft } });
        const result = await api('/api/admin/profiles', { admin: true }); profiles = result.profiles; render(); announce('Profile saved on the server. No participant record or template was changed.');
      }
    } catch (error) { reviewed = null; announce(error.status === 409 ? 'The authoritative revision changed. Reload and review the new diff; nothing was automatically reapplied.' : error.message, true); }
    finally { busy = false; updateControls(); }
  });
  clear();
  return { load, clear };
}
