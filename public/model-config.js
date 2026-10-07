const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const getPath = (value, path) => path.split('.').reduce((part, key) => part && typeof part === 'object' ? part[key] : undefined, value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object') node[key] = {}; node = node[key]; } node[keys.at(-1)] = next; }

export function mountModelConfig(container, { api, onApplied, getCurrentRevision }) {
  let saved = null, draft = null, reviewed = null, diff = [], busy = false, generation = 0, notice = '', noticeError = false, clearKey = false, keyNotice = '', keyNoticeError = false;
  const tests = { Alice: null, Bob: null };
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify(draft);
  function clearSecret() { const key = query('[data-model-key]'); if (key) key.value = ''; }
  function announce(message, error = false) {
    notice = message; noticeError = error;
    const node = query('[data-model-notice]'); if (node) { node.textContent = message; node.className = 'notice ' + (error ? 'error' : ''); node.setAttribute('role', error ? 'alert' : 'status'); }
  }
  function announceKey(message, error = false) {
    keyNotice = message; keyNoticeError = error;
    const node = query('[data-model-key-notice]');
    if (node) { node.textContent = message; node.hidden = !message; node.className = 'notice ' + (error ? 'error' : ''); node.setAttribute('role', error ? 'alert' : 'status'); }
  }
  function keyControls(preset) {
    return '<div class="form-grid" style="margin-top:16px"><div><label class="field"><span>' + (saved.keyConfigured ? 'Replace API key · optional' : preset ? 'Token Plan API key · required to connect' : 'API key · optional for local compatible servers') + '</span><input data-model-key type="password" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="model-key-intent" placeholder="' + (saved.keyConfigured ? 'Leave empty to keep the saved key' : 'Enter a provider key') + '"></label><button class="button primary" style="margin-top:10px" data-model-action="save-key">Save API key</button><div class="notice ' + (keyNoticeError ? 'error' : '') + '" data-model-key-notice role="' + (keyNoticeError ? 'alert' : 'status') + '" ' + (keyNotice ? '' : 'hidden') + '>' + escapeHtml(keyNotice) + '</div></div><div><span class="tag ' + (saved.keyConfigured ? 'good' : 'warn') + '">' + (saved.keyConfigured ? 'Key configured on server' : 'No key configured') + '</span><small style="margin-top:8px">The saved key is shared by Alice and Bob. A blank field keeps it. The key is write-only and never returned. This field clears when you leave the panel, reload or submit. No key is placed in browser storage.</small></div></div>' + (saved.keyConfigured ? '<label class="check"><input data-model-clear-key type="checkbox" ' + (clearKey ? 'checked' : '') + '><span>Clear the saved shared key when applying<small>Explicit removal for new rounds. The current round retains its own model configuration.</small></span></label>' : '') + '<small id="model-key-intent" data-model-key-intent style="margin-top:8px"></small>';
  }
  function field(path, label, { number = false, min, max, step = 'any', disabled = false } = {}) {
    return '<label class="field"><span>' + label + '</span><input data-model-path="' + path + '" type="' + (number ? 'number' : 'text') + '" value="' + escapeHtml(getPath(draft, path)) + '" ' + (number ? 'data-model-number step="' + step + '" ' + (min != null ? 'min="' + min + '" ' : '') + (max != null ? 'max="' + max + '" ' : '') : '') + (disabled ? 'readonly ' : '') + '></label>';
  }
  function testHtml(role) {
    const value = tests[role];
    if (!value) return '<p class="muted" style="margin-top:10px">' + (saved?.config.provider === 'minimax_cn_token_plan' && !saved.keyConfigured ? 'Save a Token Plan key to run a connectivity test.' : 'No test has run. This uses saved configuration, not the draft.') + '</p>';
    if (value.error) return '<div class="notice error" role="alert">' + escapeHtml(value.error) + '</div>';
    return '<div class="notice success"><strong>Synthetic connectivity test</strong><dl class="definition-list"><dt>Role</dt><dd>' + role + '</dd><dt>Model</dt><dd>' + escapeHtml(value.model) + '</dd><dt>Latency</dt><dd>' + escapeHtml(value.latencyMs) + ' ms</dd><dt>Response</dt><dd>' + escapeHtml(value.response) + '</dd></dl></div>';
  }
  function roleCard(role) {
    const path = 'agents.' + role + '.';
    return '<section class="panel"><div class="panel-heading"><h3>' + role + ' · model settings</h3><span class="tag">Separate agent</span></div><div class="stack">' + field(path + 'model', 'Model identifier') + '<div class="form-grid">' + field(path + 'temperature', 'Temperature', { number: true, min: 0, max: 2 }) + field(path + 'maxTokens', 'Maximum output tokens', { number: true, min: 128, max: 32768, step: 1 }) + field(path + 'timeoutSeconds', 'Timeout · seconds', { number: true, min: 1, max: 300 }) + field(path + 'retryLimit', 'Retry limit', { number: true, min: 0, max: 3, step: 1 }) + '<label class="field"><span>Thinking mode · MiniMax</span><select data-model-path="' + path + 'thinking"><option value="disabled" ' + (getPath(draft, path + 'thinking') === 'disabled' ? 'selected' : '') + '>Disabled</option><option value="adaptive" ' + (getPath(draft, path + 'thinking') === 'adaptive' ? 'selected' : '') + '>Adaptive</option></select></label></div></div><button class="button section-actions" data-model-action="test" data-model-role="' + role + '">Test saved ' + role + ' configuration</button><div data-model-test="' + role + '">' + testHtml(role) + '</div></section>';
  }
  function renderDiff() {
    const node = query('[data-model-diff]'); if (!node) return;
    node.innerHTML = diff.length ? diff.map(item => '<tr><td>' + escapeHtml(item.path) + '</td><td>' + escapeHtml(JSON.stringify(item.before) ?? '∅') + '</td><td>' + escapeHtml(JSON.stringify(item.after) ?? '∅') + '</td></tr>').join('') : '<tr><td colspan="3">' + (reviewed ? 'No public configuration changes. A supplied key is still replaced on save.' : 'Validate the exact draft to review changes.') + '</td></tr>';
  }
  function updateControls() {
    container.querySelectorAll('input,select,button').forEach(node => { node.disabled = busy; });
    const key = query('[data-model-key]'); if (key) key.disabled = busy || clearKey;
    const identityChanged = saved && (draft.provider !== saved.config.provider || draft.baseUrl !== saved.config.baseUrl);
    const needsKeyDecision = identityChanged && saved.keyConfigured && !clearKey && !key?.value.trim();
    const apply = query('[data-model-action="apply"]'); if (apply) apply.disabled = busy || reviewed !== stamp() || needsKeyDecision;
    const saveKey = query('[data-model-action="save-key"]'); if (saveKey) saveKey.disabled = busy || clearKey || identityChanged || !key?.value.trim();
    const intent = query('[data-model-key-intent]'); if (intent) intent.textContent = clearKey ? 'On apply: clear the saved shared key for new rounds.' : identityChanged ? 'Provider or API URL changed. Validate the draft and use Save for new rounds below to save the connection and key together.' : key?.value.trim() ? 'Save API key updates the shared key for the saved provider. Other draft settings are saved separately below.' : 'Enter a key, then select Save API key. No draft validation is needed to save just the key.';
    if (saved?.config.provider === 'minimax_cn_token_plan' && !saved.keyConfigured) container.querySelectorAll('[data-model-action="test"]').forEach(node => { node.disabled = true; });
    renderDiff();
  }
  function render() {
    if (!saved || !draft) return;
    clearSecret();
    const activeRevision = getCurrentRevision?.();
    const preset = draft.provider === 'minimax_cn_token_plan';
    container.innerHTML = '<div class="panel-heading"><div><h2>Model configuration</h2><small>One shared provider; separate model settings for Alice and Bob.</small></div><div class="toolbar"><span class="tag">Saved r' + escapeHtml(saved.revision) + '</span><span class="tag">' + (activeRevision == null ? 'No current round' : 'Current round r' + escapeHtml(activeRevision)) + '</span><button class="button" data-model-action="reload">Reload saved configuration</button></div></div><section class="panel"><h3>Shared provider & server-held key</h3><div class="form-grid" style="margin-top:14px"><label class="field"><span>Provider preset</span><select data-model-provider><option value="minimax_cn_token_plan" ' + (preset ? 'selected' : '') + '>MiniMax China · Token Plan</option><option value="openai_compatible" ' + (!preset ? 'selected' : '') + '>Advanced · OpenAI compatible</option></select></label>' + field('baseUrl', 'API base URL', { disabled: preset }) + '</div><small style="margin-top:8px">' + (preset ? 'The MiniMax China preset fixes the regional endpoint and requires a Token Plan key beginning sk-cp-. Usage-based keys are a separate product.' : 'Advanced configuration for a compatible provider or local test server. The server validates this endpoint.') + '</small>' + keyControls(preset) + '</section><div class="model-role-grid" style="margin-top:18px">' + roleCard('Alice') + roleCard('Bob') + '</div><section class="panel" style="margin-top:18px"><h3>Review & apply to new rounds</h3><p class="muted" style="margin-top:8px">Saved settings take effect when the next round starts. Current rounds retain their model revision and do not change midway. Controlled and replay modes do not invoke this provider.</p><div class="notice ' + (noticeError ? 'error' : '') + '" data-model-notice role="status">' + escapeHtml(notice || 'Edit the draft, validate, review the diff, then save for new rounds.') + '</div><div class="toolbar"><button class="button" data-model-action="validate">Validate & preview diff</button><button class="button primary" data-model-action="apply">Save for new rounds</button></div><div class="table-wrap" style="margin-top:14px"><table class="config-diff"><thead><tr><th>Property</th><th>Saved before</th><th>Draft after</th></tr></thead><tbody data-model-diff></tbody></table></div><small style="margin-top:14px">Connectivity tests send a tiny fictional prompt using the saved revision. They are actual provider requests and may use plan quota. They do not include calendar rows, research answers or agent conversation. Test output is shown as plain text.</small></section>';
    updateControls();
  }
  async function load() {
    const ownGeneration = ++generation; clearSecret(); busy = true; reviewed = null; diff = []; notice = ''; noticeError = false; clearKey = false; keyNotice = ''; keyNoticeError = false;
    container.innerHTML = '<section class="panel loading">Loading redacted model configuration…</section>';
    try {
      const value = await api('/api/admin/models', { admin: true });
      if (ownGeneration !== generation) return;
      saved = value; draft = clone(value.config); tests.Alice = null; tests.Bob = null; busy = false; render();
    } catch (error) { if (ownGeneration !== generation) return; busy = false; container.innerHTML = '<section class="panel"><div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-model-action="reload">Reload model configuration</button></section>'; }
  }
  function clear() { generation++; clearSecret(); saved = null; draft = null; reviewed = null; clearKey = false; keyNotice = ''; keyNoticeError = false; tests.Alice = null; tests.Bob = null; busy = false; container.innerHTML = '<section class="panel">Researcher sign-in is required.</section>'; }
  container.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('[data-model-key]')) return;
    event.preventDefault(); query('[data-model-action="save-key"]')?.click();
  });
  container.addEventListener('input', event => {
    const node = event.target; if (node.matches('[data-model-key]')) { announceKey(''); updateControls(); return; } if (!draft || !node.dataset.modelPath || busy) return;
    setPath(draft, node.dataset.modelPath, node.hasAttribute('data-model-number') ? node.value === '' ? null : Number(node.value) : node.value);
    reviewed = null; diff = []; announce('Draft changed. Validate and review it before saving.'); updateControls();
  });
  container.addEventListener('change', event => {
    if (event.target.matches('[data-model-clear-key]')) { clearKey = event.target.checked; if (clearKey) clearSecret(); updateControls(); return; }
    if (draft && event.target.dataset.modelPath && event.target.tagName === 'SELECT' && !busy) { setPath(draft, event.target.dataset.modelPath, event.target.value); reviewed = null; diff = []; announce('Draft changed. Validate and review it before saving.'); updateControls(); return; }
    if (!draft || !event.target.matches('[data-model-provider]') || busy) return;
    draft.provider = event.target.value;
    if (draft.provider === 'minimax_cn_token_plan') draft.baseUrl = 'https://api.minimax.cn/v1';
    reviewed = null; diff = []; announce('Provider draft changed. Review the new endpoint and save explicitly.'); render();
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-model-action]'); if (!button || button.disabled) return;
    const action = button.dataset.modelAction;
    if (action === 'reload') { load(); return; }
    if (!saved || !draft) return;
    const ownGeneration = generation;
    const role = button.dataset.modelRole;
    const apiKey = action === 'apply' || action === 'save-key' ? query('[data-model-key]')?.value.trim() : undefined;
    if (action === 'apply' || action === 'save-key') clearSecret();
    if (action === 'save-key') announceKey('Saving API key…');
    busy = true; updateControls();
    try {
      if (action === 'validate') {
        const value = await api('/api/admin/models/validate', { method: 'POST', admin: true, body: { config: draft } });
        if (ownGeneration !== generation) return;
        reviewed = value.valid ? stamp() : null; diff = value.diff || [];
        const errors = (value.errors || []).map(error => typeof error === 'string' ? error : [error.path, error.message].filter(Boolean).join(': '));
        announce(value.valid ? 'Server validation passed. Review ' + diff.length + ' changed properties before saving.' : errors.join(' ') || 'Validation failed.', !value.valid);
      } else if (action === 'save-key') {
        if (!apiKey || clearKey || draft.provider !== saved.config.provider || draft.baseUrl !== saved.config.baseUrl) throw new Error('Save the provider draft and its key together using Save for new rounds below.');
        const value = await api('/api/admin/models/apply', { method: 'POST', admin: true, body: { config: saved.config, apiKey, expectedRevision: saved.revision } });
        if (ownGeneration !== generation) return;
        saved = value; reviewed = null; diff = []; tests.Alice = null; tests.Bob = null;
        announceKey('API key saved for Alice and Bob. New rounds use it; the current round keeps its existing configuration.');
        announce('Shared API key saved. Other draft settings are unchanged; validate and save them separately.');
        render(); onApplied?.(value);
      } else if (action === 'apply') {
        if (reviewed !== stamp()) throw new Error('Validate this exact draft first.');
        const value = await api('/api/admin/models/apply', { method: 'POST', admin: true, body: { config: draft, ...(apiKey ? { apiKey } : {}), ...(clearKey ? { clearKey: true } : {}), expectedRevision: saved.revision } });
        if (ownGeneration !== generation) return;
        saved = value; draft = clone(value.config); reviewed = null; diff = []; clearKey = false; tests.Alice = null; tests.Bob = null;
        announceKey(apiKey ? 'API key and model settings saved for Alice and Bob.' : '');
        announce('Model settings saved for new rounds. The current round keeps its existing model revision.'); render(); onApplied?.(value);
      } else if (action === 'test') {
        const value = await api('/api/admin/models/test', { method: 'POST', admin: true, body: { role } });
        if (ownGeneration !== generation) return;
        tests[role] = value; const output = query('[data-model-test="' + role + '"]'); if (output) output.innerHTML = testHtml(role);
        announce(role + ' connectivity test completed using saved configuration.');
      }
    } catch (error) {
      if (ownGeneration !== generation) return;
      if (action === 'test') { tests[role] = { error: error.message }; const output = query('[data-model-test="' + role + '"]'); if (output) output.innerHTML = testHtml(role); }
      if (action === 'apply' || action === 'save-key') reviewed = null;
      const message = error.status === 409 ? 'The saved model revision changed. Reload and review; no settings were automatically retried.' : error.message;
      if (action === 'save-key' || (action === 'apply' && apiKey)) announceKey(message, true);
      announce(message, true);
    } finally { if (ownGeneration === generation) { busy = false; updateControls(); } }
  });
  clear();
  return { load, clear, clearSecret };
}
