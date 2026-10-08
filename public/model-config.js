const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const getPath = (value, path) => path.split('.').reduce((part, key) => part && typeof part === 'object' ? part[key] : undefined, value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object') node[key] = {}; node = node[key]; } node[keys.at(-1)] = next; }

export function mountModelConfig(container, { api, onApplied, getCurrentRevision }) {
  let saved = null, draft = null, reviewed = null, diff = [], busy = false, generation = 0, notice = '', noticeError = false, clearKey = false, keyNotice = '', keyNoticeError = false;
  const tests = { Alice: null, Bob: null };
  const expanded = new Map();
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify(draft);
  const icons = {
    connection: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M10 8h12v8H10zM16 16v6M6 24h20M6 22v5m20-5v5m-10-5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="11" r="1" fill="currentColor"/></svg>',
    agent: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="7" y="9" width="18" height="17" rx="5" stroke="currentColor" stroke-width="2"/><path d="M16 5v4M3 16h4m18 0h4M12 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/><circle cx="20" cy="15" r="1.5" fill="currentColor"/></svg>',
    tune: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="7" r="3" fill="var(--surface)" stroke="currentColor" stroke-width="1.7"/><circle cx="16" cy="17" r="3" fill="var(--surface)" stroke="currentColor" stroke-width="1.7"/></svg>'
  };
  function rememberExpanded() { container.querySelectorAll('[data-model-disclosure]').forEach(node => expanded.set(node.dataset.modelDisclosure, node.open)); }
  function openDisclosure(id) { expanded.set(id, true); const node = query('[data-model-disclosure="' + id + '"]'); if (node) node.open = true; }
  function disclosure(id, title, content, { nested = false, icon = false } = {}) {
    return '<details class="config-disclosure' + (nested ? ' config-disclosure-nested' : '') + '" data-model-disclosure="' + id + '" ' + (expanded.get(id) ? 'open' : '') + '><summary>' + (icon ? '<span class="config-summary-icon">' + icons.tune + '</span>' : '') + '<span>' + title + '</span></summary><div class="config-disclosure-body">' + content + '</div></details>';
  }
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
    return '<div class="model-key-row"><label class="field"><span>' + (saved.keyConfigured ? 'Replace API key · optional' : preset ? 'Token Plan API key · required to connect' : 'API key · optional for local compatible servers') + '</span><input data-model-key type="password" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="model-key-intent" placeholder="' + (saved.keyConfigured ? 'Leave empty to keep the saved key' : 'Enter a provider key') + '"></label><button class="button primary" data-model-action="save-key">Save API key</button></div><small id="model-key-intent" data-model-key-intent></small><div class="notice ' + (keyNoticeError ? 'error' : '') + '" data-model-key-notice role="' + (keyNoticeError ? 'alert' : 'status') + '" ' + (keyNotice ? '' : 'hidden') + '>' + escapeHtml(keyNotice) + '</div>';
  }
  function field(path, label, { number = false, min, max, step = 'any', disabled = false } = {}) {
    return '<label class="field"><span>' + label + '</span><input data-model-path="' + path + '" type="' + (number ? 'number' : 'text') + '" value="' + escapeHtml(getPath(draft, path)) + '" ' + (number ? 'data-model-number step="' + step + '" ' + (min != null ? 'min="' + min + '" ' : '') + (max != null ? 'max="' + max + '" ' : '') : '') + (disabled ? 'readonly ' : '') + '></label>';
  }
  function testHtml(role) {
    const value = tests[role];
    if (!value) return '<p class="muted model-test-status">' + (saved?.config.provider === 'minimax_cn_token_plan' && !saved.keyConfigured ? 'Save a Token Plan key to run a connectivity test.' : 'No test has run. This uses saved configuration, not the draft.') + '</p>';
    if (value.error) return '<div class="notice error" role="alert">' + escapeHtml(value.error) + '</div>';
    return '<div class="notice success"><div class="toolbar"><strong>Connection successful · fictional test data</strong><span class="tag good">' + escapeHtml(value.latencyMs) + ' ms</span></div><small data-i18n-ignore>' + escapeHtml(value.model) + '</small>' + disclosure(role + '-test-response', 'Response', '<p data-i18n-ignore>' + escapeHtml(value.response) + '</p>', { nested: true }) + '</div>';
  }
  function roleCard(role) {
    const path = 'agents.' + role + '.';
    const parameters = '<small>Optional tuning. Keep the saved values to get started.</small><div class="form-grid">' + field(path + 'temperature', 'Temperature', { number: true, min: 0, max: 2 }) + field(path + 'maxTokens', 'Maximum output tokens', { number: true, min: 128, max: 32768, step: 1 }) + '<label class="field"><span>Thinking mode · MiniMax</span><select data-model-path="' + path + 'thinking"><option value="disabled" ' + (getPath(draft, path + 'thinking') === 'disabled' ? 'selected' : '') + '>Disabled</option><option value="adaptive" ' + (getPath(draft, path + 'thinking') === 'adaptive' ? 'selected' : '') + '>Adaptive</option></select></label></div>' + disclosure(role + '-reliability', 'Timeout & retries', '<div class="form-grid">' + field(path + 'timeoutSeconds', 'Timeout · seconds', { number: true, min: 1, max: 300 }) + field(path + 'retryLimit', 'Retry limit', { number: true, min: 0, max: 3, step: 1 }) + '</div>', { nested: true });
    return '<section class="panel model-agent-card ' + role.toLowerCase() + '"><div class="panel-heading"><div class="config-section-title"><span class="model-agent-avatar">' + icons.agent + '</span><div><h3>' + role + ' · model settings</h3><small>Independent model choice</small></div></div><span class="tag">Separate agent</span></div>' + field(path + 'model', 'Model identifier') + '<button class="button section-actions" data-model-action="test" data-model-role="' + role + '">Test saved ' + role + ' configuration</button><div data-model-test="' + role + '">' + testHtml(role) + '</div>' + disclosure(role + '-parameters', 'Generation settings', parameters, { icon: true }) + '</section>';
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
    const draftState = query('[data-model-draft-state]'); if (draftState) { const unchanged = JSON.stringify(saved.config) === stamp() && !clearKey; draftState.textContent = unchanged ? 'Saved configuration' : 'Unsaved draft'; draftState.className = 'tag ' + (unchanged ? '' : 'warn'); }
    const count = query('[data-model-diff-count]'); if (count) { count.textContent = String(diff.length); count.hidden = reviewed == null; }
    if (saved?.config.provider === 'minimax_cn_token_plan' && !saved.keyConfigured) container.querySelectorAll('[data-model-action="test"]').forEach(node => { node.disabled = true; });
    renderDiff();
  }
  function render() {
    if (!saved || !draft) return;
    rememberExpanded();
    clearSecret();
    const activeRevision = getCurrentRevision?.();
    const preset = draft.provider === 'minimax_cn_token_plan';
    const keySecurity = '<small>The saved key is shared by Alice and Bob. A blank field keeps it. The key is write-only and never returned. This field clears when you leave the panel, reload or submit. No key is placed in browser storage.</small>' + (saved.keyConfigured ? '<label class="check"><input data-model-clear-key type="checkbox" ' + (clearKey ? 'checked' : '') + '><span>Clear the saved shared key when applying<small>Explicit removal for new rounds. The current round retains its own model configuration.</small></span></label>' : '');
    const connectionDetails = field('baseUrl', 'API base URL', { disabled: preset }) + '<small>' + (preset ? 'The MiniMax China preset fixes the regional endpoint and requires a Token Plan key beginning sk-cp-. Usage-based keys are a separate product.' : 'Advanced configuration for a compatible provider or local test server. The server validates this endpoint.') + '</small>' + disclosure('key-security', 'Key storage & removal', keySecurity, { nested: true }) + disclosure('test-explanation', 'About connectivity tests', '<small>Connectivity tests send a tiny fictional prompt using the saved revision. They are actual provider requests and may use plan quota. They do not include calendar rows, research answers or agent conversation. Test output is shown as plain text.</small>', { nested: true });
    const reviewTable = '<div class="table-wrap"><table class="config-diff"><thead><tr><th>Property</th><th>Saved before</th><th>Draft after</th></tr></thead><tbody data-model-diff></tbody></table></div><small>Saved settings take effect when the next round starts. Current rounds retain their model revision and do not change midway. Controlled and replay modes do not invoke this provider.</small>';
    container.innerHTML = '<div class="config-hierarchy"><div class="panel-heading"><div><h2>Model configuration</h2><small>Connect once, choose a model for each agent, then explore the details.</small></div><div class="toolbar"><span class="tag" data-model-draft-state></span><span class="tag">Saved r' + escapeHtml(saved.revision) + '</span><button class="button quiet" data-model-action="reload">Reload saved configuration</button></div></div>'
      + '<section class="panel model-connection-card"><div class="panel-heading"><div class="config-section-title"><span class="config-overview-icon">' + icons.connection + '</span><div><h3>Shared connection</h3><small>One provider for both agents</small></div></div><span class="tag model-key-status ' + (saved.keyConfigured ? 'good' : 'warn') + '">' + (saved.keyConfigured ? 'Key configured on server' : 'No key configured') + '</span></div><div class="config-flow" aria-label="Alice and Bob share this provider"><span class="config-flow-node connection">Shared provider</span><span class="config-flow-link" aria-hidden="true">→</span><span class="config-flow-node alice">Alice</span><span class="config-flow-node bob">Bob</span></div><label class="field"><span>Provider preset</span><select data-model-provider><option value="minimax_cn_token_plan" ' + (preset ? 'selected' : '') + '>MiniMax China · Token Plan</option><option value="openai_compatible" ' + (!preset ? 'selected' : '') + '>Advanced · OpenAI compatible</option></select></label>' + keyControls(preset) + '<small>Keys are write-only. Connectivity tests may use provider quota.</small>' + disclosure('connection-details', 'Connection details', connectionDetails) + '</section>'
      + '<div class="model-role-grid">' + roleCard('Alice') + roleCard('Bob') + '</div>'
      + '<section class="panel config-save-bar"><div class="panel-heading"><div><h3>Review & apply to new rounds</h3><small>Changes take effect from the next round.</small></div><span class="tag">' + (activeRevision == null ? 'No current round' : 'Current round r' + escapeHtml(activeRevision)) + '</span></div><div class="notice ' + (noticeError ? 'error' : '') + '" data-model-notice role="' + (noticeError ? 'alert' : 'status') + '">' + escapeHtml(notice || 'Edit the draft, validate, review the diff, then save for new rounds.') + '</div><div class="toolbar"><button class="button" data-model-action="validate">Validate & preview diff</button><button class="button primary" data-model-action="apply">Save for new rounds</button></div>' + disclosure('review-diff', 'Review changes <span class="tag" data-model-diff-count hidden></span>', reviewTable) + '</section></div>';
    updateControls();
  }
  async function load({ force = false } = {}) {
    if (!force && saved && draft) { render(); return; }
    rememberExpanded();
    const ownGeneration = ++generation; clearSecret(); busy = true; reviewed = null; diff = []; notice = ''; noticeError = false; clearKey = false; keyNotice = ''; keyNoticeError = false;
    container.innerHTML = '<section class="panel loading">Loading redacted model configuration…</section>';
    try {
      const value = await api('/api/admin/models', { admin: true });
      if (ownGeneration !== generation) return;
      saved = value; draft = clone(value.config); tests.Alice = null; tests.Bob = null; busy = false; render();
    } catch (error) { if (ownGeneration !== generation) return; busy = false; container.innerHTML = '<section class="panel"><div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-model-action="reload">Reload model configuration</button></section>'; }
  }
  function clear() { rememberExpanded(); generation++; clearSecret(); saved = null; draft = null; reviewed = null; clearKey = false; keyNotice = ''; keyNoticeError = false; tests.Alice = null; tests.Bob = null; busy = false; container.innerHTML = '<section class="panel">Researcher sign-in is required.</section>'; }
  container.addEventListener('toggle', event => { if (event.target.matches('[data-model-disclosure]')) expanded.set(event.target.dataset.modelDisclosure, event.target.open); }, true);
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
    reviewed = null; diff = []; announce('Provider draft changed. Review the new endpoint and save explicitly.'); render(); openDisclosure('connection-details');
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-model-action]'); if (!button || button.disabled) return;
    const action = button.dataset.modelAction;
    if (action === 'reload') { load({ force: true }); return; }
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
        openDisclosure('review-diff');
        if (!value.valid) for (const error of errors) {
          for (const agent of ['Alice', 'Bob']) if (error.includes('agents.' + agent + '.')) { openDisclosure(agent + '-parameters'); if (/timeoutSeconds|retryLimit/.test(error)) openDisclosure(agent + '-reliability'); }
          if (/baseUrl|provider/.test(error)) openDisclosure('connection-details');
        }
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
