const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
import { renderChangeSummary } from './config-change-summary.js';

const clone = value => JSON.parse(JSON.stringify(value));
const getPath = (value, path) => path.split('.').reduce((part, key) => part && typeof part === 'object' ? part[key] : undefined, value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object') node[key] = {}; node = node[key]; } node[keys.at(-1)] = next; }

export function mountModelConfig(container, { api, onApplied, getCurrentRevision }) {
  let saved = null, draft = null, reviewed = null, diff = [], busy = false, generation = 0, notice = '', noticeError = false, clearKey = false, keyNotice = '', keyNoticeError = false;
  let compatibleEndpoint = null, importBuffer = '', transferNotice = '', transferError = false, importReadSequence = 0;
  const tests = { Alice: null, Bob: null };
  const expanded = new Map();
  const query = selector => container.querySelector(selector);
  const stamp = () => JSON.stringify(draft);
  const icons = {
    connection: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M10 8h12v8H10zM16 16v6M6 24h20M6 22v5m20-5v5m-10-5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="11" r="1" fill="currentColor"/></svg>',
    agent: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="7" y="9" width="18" height="17" rx="5" stroke="currentColor" stroke-width="2"/><path d="M16 5v4M3 16h4m18 0h4M12 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/><circle cx="20" cy="15" r="1.5" fill="currentColor"/></svg>',
    tune: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="7" r="3" fill="var(--surface)" stroke="currentColor" stroke-width="1.7"/><circle cx="16" cy="17" r="3" fill="var(--surface)" stroke="currentColor" stroke-width="1.7"/></svg>',
    style: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    length: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    reliability: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 5v6h-6M12 7v5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function rememberExpanded() { container.querySelectorAll('[data-model-disclosure]').forEach(node => expanded.set(node.dataset.modelDisclosure, node.open)); }
  function openDisclosure(id) { expanded.set(id, true); const node = query('[data-model-disclosure="' + id + '"]'); if (node) node.open = true; }
  function disclosure(id, title, content, { nested = false, icon = false, group = '' } = {}) {
    return '<details class="config-disclosure' + (nested ? ' config-disclosure-nested' : '') + '" data-model-disclosure="' + id + '" ' + (group ? 'name="model-' + group + '-tuning" data-model-tuning-group="' + group + '" ' : '') + (expanded.get(id) ? 'open' : '') + '><summary>' + (icon ? '<span class="config-summary-icon">' + icons.tune + '</span>' : '') + '<span>' + title + '</span></summary><div class="config-disclosure-body">' + content + '</div></details>';
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
  function field(path, label, { number = false, min, max, step = 'any', disabled = false, describedBy = '', placeholder = '' } = {}) {
    return '<label class="field"><span>' + label + '</span><input data-model-path="' + path + '" type="' + (number ? 'number' : 'text') + '" value="' + escapeHtml(getPath(draft, path)) + '" ' + (number ? 'data-model-number step="' + step + '" ' + (min != null ? 'min="' + min + '" ' : '') + (max != null ? 'max="' + max + '" ' : '') : '') + (describedBy ? 'aria-describedby="' + describedBy + '" ' : '') + (placeholder ? 'placeholder="' + escapeHtml(placeholder) + '" ' : '') + (disabled ? 'readonly ' : '') + '></label>';
  }
  function selectProvider(provider) {
    if (!draft || !['minimax_cn_token_plan', 'openai_compatible'].includes(provider)) return;
    if (draft.provider !== provider) {
      if (draft.provider === 'openai_compatible') compatibleEndpoint = draft.baseUrl;
      draft.provider = provider;
      draft.baseUrl = provider === 'minimax_cn_token_plan' ? 'https://api.minimax.cn/v1' : compatibleEndpoint ?? '';
      reviewed = null; diff = [];
      announce('Provider draft changed. Review the new endpoint and save explicitly.');
      render();
    }
    if (provider === 'openai_compatible') query('[data-model-path="baseUrl"]')?.focus();
    else openDisclosure('connection-details');
  }
  function announceTransfer(message, error = false) {
    transferNotice = message; transferError = error;
    const node = query('[data-model-transfer-notice]');
    if (node) { node.textContent = message; node.hidden = !message; node.className = 'notice ' + (error ? 'error' : ''); node.setAttribute('role', error ? 'alert' : 'status'); }
  }
  function publicConfig(value) {
    const exactObject = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
    const agentKeys = ['model', 'temperature', 'maxTokens', 'timeoutSeconds', 'retryLimit', 'thinking'];
    if (!exactObject(value, ['provider', 'baseUrl', 'agents']) || !['minimax_cn_token_plan', 'openai_compatible'].includes(value.provider) || !exactObject(value.agents, ['Alice', 'Bob'])) throw new Error('Use the complete public configuration format: provider, baseUrl and both agents. API keys and extra properties are not accepted.');
    let endpoint;
    try { endpoint = new URL(value.baseUrl); } catch { throw new Error('Enter a valid API URL before importing or exporting configuration.'); }
    if (typeof value.baseUrl !== 'string' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Configuration files cannot contain URL credentials, query parameters or fragments.');
    if (value.provider === 'minimax_cn_token_plan' && value.baseUrl.replace(/\/+$/, '') !== 'https://api.minimax.cn/v1') throw new Error('MiniMax Token Plan requires https://api.minimax.cn/v1. To use another endpoint, select a custom compatible connection.');
    for (const role of ['Alice', 'Bob']) {
      const agent = value.agents[role];
      if (!exactObject(agent, agentKeys) || typeof agent.model !== 'string' || !['disabled', 'adaptive'].includes(agent.thinking) || !agentKeys.slice(1, -1).every(key => typeof agent[key] === 'number' && Number.isFinite(agent[key]))) throw new Error('Each agent needs a model, temperature, maxTokens, timeoutSeconds, retryLimit and thinking. API keys and extra properties are not accepted.');
    }
    // Always reconstruct the public schema. The write-only key is never a source.
    return { provider: value.provider, baseUrl: value.baseUrl, agents: Object.fromEntries(['Alice', 'Bob'].map(role => [role, Object.fromEntries(agentKeys.map(key => [key, value.agents[role][key]]))])) };
  }
  function importConfiguration() {
    importReadSequence++;
    try {
      if (importBuffer.length > 65536) throw new Error('Configuration JSON must be at most 64 KiB.');
      let parsed;
      try { parsed = JSON.parse(importBuffer); } catch { throw new Error('Paste valid model configuration JSON. API keys belong in the separate key field.'); }
      const next = publicConfig(parsed);
      if (draft.provider === 'openai_compatible') compatibleEndpoint = draft.baseUrl;
      draft = next;
      if (draft.provider === 'openai_compatible') compatibleEndpoint = draft.baseUrl;
      reviewed = null; diff = []; clearKey = false; importBuffer = '';
      announce('Configuration imported as a draft. Validate and review it before saving for new rounds.');
      announceTransfer('Imported as an unsaved draft. Validate, review, then save for new rounds.');
      render();
    } catch (error) {
      // Reject credential-bearing input without echoing its keys or values.
      importBuffer = ''; const input = query('[data-model-import-json]'); if (input) input.value = '';
      announceTransfer(error.message, true);
    }
  }
  function exportConfiguration() {
    try {
      const config = publicConfig(draft);
      const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'model-configuration.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      announceTransfer('Draft exported without API keys. Import the file to reuse these settings.');
    } catch (error) { openDisclosure('reuse-configuration'); announceTransfer(error.message, true); }
  }
  const validNumber = (value, min, max, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
  function tuningState(role) {
    const values = draft.agents[role];
    const temperatureValid = validNumber(values.temperature, 0, 2);
    const tokensValid = validNumber(values.maxTokens, 128, 32768, true);
    const reliabilityValid = validNumber(values.timeoutSeconds, 1, 300) && validNumber(values.retryLimit, 0, 3, true);
    return {
      values, temperatureValid, tokensValid, reliabilityValid,
      style: temperatureValid ? values.temperature <= 0.4 ? 'More consistent' : values.temperature <= 1 ? 'Balanced variation' : 'More varied' : 'Needs review',
      length: tokensValid ? values.maxTokens <= 2048 ? 'Shorter ceiling' : values.maxTokens <= 8192 ? 'Medium ceiling' : 'Higher ceiling' : 'Needs review',
      temperaturePosition: temperatureValid ? values.temperature / 2 * 100 : 0,
      // The picture is a qualitative scale, never a prediction of response length.
      outputLines: tokensValid ? values.maxTokens <= 2048 ? 3 : values.maxTokens <= 8192 ? 5 : 7 : 0
    };
  }
  function metric(role, group, icon, title, meaning, value) {
    return '<button type="button" class="model-tuning-metric" data-model-action="tune" data-model-role="' + role + '" data-model-tuning-target="' + group + '" aria-label="' + role + ': adjust ' + title.toLowerCase() + '"><span class="model-metric-icon">' + icons[icon] + '</span><span class="model-metric-copy"><small>' + title + '</small><strong>' + meaning + '</strong><span class="model-metric-value">' + escapeHtml(value) + '</span></span><span class="model-metric-arrow" aria-hidden="true">↗</span></button>';
  }
  function overviewHtml(role) {
    const state = tuningState(role), values = state.values;
    return metric(role, 'style', 'style', 'Generation style', state.style, state.temperatureValid ? 'Temperature ' + values.temperature : 'Check the number')
      + metric(role, 'length', 'length', 'Output length', state.length, state.tokensValid ? values.maxTokens + ' tokens max' : 'Check the number')
      + metric(role, 'reliability', 'reliability', 'Timeout & retries', state.reliabilityValid ? values.retryLimit === 0 ? 'One attempt' : 'Retry on failure' : 'Needs review', state.reliabilityValid ? values.timeoutSeconds + ' s / ' + values.retryLimit + ' retries' : 'Check the numbers');
  }
  function stylePreview(role) {
    const state = tuningState(role);
    return '<div class="model-preview-title"><strong>' + state.style + '</strong><span class="model-preview-number" data-i18n-ignore>' + (state.temperatureValid ? escapeHtml(state.values.temperature) : '—') + '</span></div><div class="model-style-track" aria-hidden="true"><span class="model-style-marker" style="left:' + state.temperaturePosition + '%"></span></div><div class="model-scale-labels"><span>More consistent</span><span>More varied</span></div>';
  }
  function lengthPreview(role) {
    const state = tuningState(role);
    return '<div class="model-preview-title"><strong>' + state.length + '</strong><span class="model-preview-number">' + (state.tokensValid ? escapeHtml(state.values.maxTokens) + ' tokens max' : '—') + '</span></div><div class="model-output-picture" aria-hidden="true">' + Array.from({ length: 7 }, (_, index) => '<span class="' + (index < state.outputLines ? 'is-filled' : '') + '"></span>').join('') + '</div><div class="model-scale-labels"><span>128 tokens</span><span>32,768 tokens</span></div>';
  }
  function reliabilityPreview(role) {
    const state = tuningState(role), values = state.values;
    if (!state.reliabilityValid) return '<strong>Needs review</strong><small>Check timeout and retry values.</small>';
    return '<div class="model-preview-title"><strong>' + (values.retryLimit ? 'Retry on failure' : 'One attempt') + '</strong><span class="model-preview-number">' + values.timeoutSeconds + ' s per attempt</span></div><div class="model-attempts" aria-hidden="true">' + Array.from({ length: 4 }, (_, index) => '<span class="model-attempt' + (index <= values.retryLimit ? ' is-enabled' : '') + '"><span>' + (index === 0 ? icons.connection : icons.reliability) + '</span><small>' + (index === 0 ? 'Request' : 'Retry ' + index) + '</small></span>').join('') + '</div><small>' + (values.retryLimit === 0 ? 'A failed request is not retried.' : 'Retries run only after a failed attempt.') + '</small>';
  }
  function updatePreviews() {
    if (!draft) return;
    for (const role of ['Alice', 'Bob']) {
      const overview = query('[data-model-overview="' + role + '"]');
      if (overview) overview.innerHTML = overviewHtml(role);
      for (const [group, html] of [['style', stylePreview(role)], ['length', lengthPreview(role)], ['reliability', reliabilityPreview(role)]]) {
        const preview = query('[data-model-preview="' + role + '-' + group + '"]');
        if (preview) preview.innerHTML = html;
      }
    }
  }
  function testHtml(role) {
    const value = tests[role];
    if (!value) return '<p class="muted model-test-status">' + (saved?.config.provider === 'minimax_cn_token_plan' && !saved.keyConfigured ? 'Save a Token Plan key to run a connectivity test.' : 'Uses saved settings. No test has run.') + '</p>';
    if (value.error) return '<div class="notice error" role="alert">' + escapeHtml(value.error) + '</div>';
    return '<div class="notice success"><div class="toolbar"><strong>Connection successful · fictional test data</strong><span class="tag good">' + escapeHtml(value.latencyMs) + ' ms</span></div><small data-i18n-ignore>' + escapeHtml(value.model) + '</small>' + disclosure(role + '-test-response', 'Response', '<p data-i18n-ignore>' + escapeHtml(value.response) + '</p>', { nested: true }) + '</div>';
  }
  function roleCard(role) {
    const path = 'agents.' + role + '.';
    const thinkingGuide = draft.provider === 'minimax_cn_token_plan' ? 'Adaptive lets a supported MiniMax model decide when to think.' : 'Thinking mode is sent only to MiniMax. This value is retained for switching back.';
    const style = '<div class="model-parameter-preview" data-model-preview="' + role + '-style">' + stylePreview(role) + '</div>' + field(path + 'temperature', 'Temperature', { number: true, min: 0, max: 2, describedBy: role + '-temperature-guide' }) + '<small id="' + role + '-temperature-guide" class="model-parameter-guide">Lower values favor repeatable wording; higher values allow more variation. The model still determines the response.</small>' + '<label class="field model-thinking-field"><span>Thinking mode · MiniMax</span><select data-model-path="' + path + 'thinking" aria-describedby="' + role + '-thinking-guide"><option value="disabled" ' + (getPath(draft, path + 'thinking') === 'disabled' ? 'selected' : '') + '>Disabled</option><option value="adaptive" ' + (getPath(draft, path + 'thinking') === 'adaptive' ? 'selected' : '') + '>Adaptive</option></select></label><small id="' + role + '-thinking-guide" class="model-parameter-guide">' + thinkingGuide + '</small>';
    const length = '<div class="model-parameter-preview" data-model-preview="' + role + '-length">' + lengthPreview(role) + '</div>' + field(path + 'maxTokens', 'Maximum output tokens', { number: true, min: 128, max: 32768, step: 1, describedBy: role + '-tokens-guide' }) + '<small id="' + role + '-tokens-guide" class="model-parameter-guide">An output ceiling, not a target. The bars illustrate the limit; they do not predict the actual reply length.</small>';
    const reliability = '<div class="model-parameter-preview" data-model-preview="' + role + '-reliability">' + reliabilityPreview(role) + '</div><div class="form-grid">' + field(path + 'timeoutSeconds', 'Timeout · seconds', { number: true, min: 1, max: 300, describedBy: role + '-reliability-guide' }) + field(path + 'retryLimit', 'Retry limit', { number: true, min: 0, max: 3, step: 1, describedBy: role + '-reliability-guide' }) + '</div><small id="' + role + '-reliability-guide" class="model-parameter-guide">Timeout caps each attempt. Retries allow another attempt after failure and may increase waiting time.</small>';
    const groupTitle = (icon, title, guide) => '<span class="model-group-heading"><span class="model-group-icon">' + icons[icon] + '</span><span><strong>' + title + '</strong><small>' + guide + '</small></span></span>';
    const parameters = '<small>Choose one area to adjust. The overview follows your draft.</small>'
      + disclosure(role + '-style', groupTitle('style', 'Style & reasoning', 'Variation and model thinking'), style, { nested: true, group: role })
      + disclosure(role + '-length', groupTitle('length', 'Output length', 'Set a maximum reply size'), length, { nested: true, group: role })
      + disclosure(role + '-reliability', groupTitle('reliability', 'Timeout & retries', 'Waiting time and recovery'), reliability, { nested: true, group: role });
    return '<section class="panel model-agent-card ' + role.toLowerCase() + '"><div class="panel-heading"><div class="config-section-title"><span class="model-agent-avatar">' + icons.agent + '</span><div><h3>' + role + ' · model settings</h3><small>Independent model choice</small></div></div><span class="tag">Separate agent</span></div>' + field(path + 'model', 'Model identifier', { describedBy: role + '-model-guide', placeholder: 'Enter any supported model identifier' }) + '<small id="' + role + '-model-guide" class="model-parameter-guide">Choose any model supported by your provider. Presets keep model names and tuning editable.</small><div class="model-overview-heading"><small>Draft tuning overview</small><small>Select a card to adjust</small></div><div class="model-tuning-overview" data-model-overview="' + role + '">' + overviewHtml(role) + '</div>' + disclosure(role + '-parameters', 'Generation settings', parameters, { icon: true }) + '<div class="model-connection-test"><button class="button" data-model-action="test" data-model-role="' + role + '">Test saved ' + role + ' configuration</button><div data-model-test="' + role + '">' + testHtml(role) + '</div></div></section>';
  }
  function renderDiff() {
    renderChangeSummary(query('[data-model-change-summary]'), diff, reviewed === stamp());
    const node = query('[data-model-diff]'); if (!node) return;
    node.innerHTML = diff.length ? diff.map(item => '<tr><td>' + escapeHtml(item.path) + '</td><td>' + escapeHtml(JSON.stringify(item.before) ?? '∅') + '</td><td>' + escapeHtml(JSON.stringify(item.after) ?? '∅') + '</td></tr>').join('') : '<tr><td colspan="3">' + (reviewed ? 'No public configuration changes. A supplied key is still replaced on save.' : 'Validate the exact draft to review changes.') + '</td></tr>';
  }
  function updateControls() {
    container.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = busy; });
    const key = query('[data-model-key]'); if (key) key.disabled = busy || clearKey;
    const identityChanged = saved && (draft.provider !== saved.config.provider || draft.baseUrl !== saved.config.baseUrl);
    const needsKeyDecision = identityChanged && saved.keyConfigured && !clearKey && !key?.value.trim();
    const apply = query('[data-model-action="apply"]'); if (apply) apply.disabled = busy || reviewed !== stamp() || needsKeyDecision;
    const saveKey = query('[data-model-action="save-key"]'); if (saveKey) saveKey.disabled = busy || clearKey || identityChanged || !key?.value.trim();
    const intent = query('[data-model-key-intent]'); if (intent) intent.textContent = clearKey ? 'On apply: clear the saved shared key for new rounds.' : identityChanged ? 'Connection changed. Validate and save it with the key below.' : key?.value.trim() ? 'Save API key applies only the key to the saved connection.' : 'Enter a key to save it for both agents.';
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
    const customEndpoint = !preset ? '<div class="model-custom-endpoint"><span class="tag">Custom API connection</span>' + field('baseUrl', 'Your API base URL', { describedBy: 'model-endpoint-guide', placeholder: 'https://provider.example/v1' }) + '<small id="model-endpoint-guide" class="model-parameter-guide">Use an OpenAI compatible API over HTTPS, or HTTP on localhost. Enter the base URL without credentials or query parameters.</small></div>' : '';
    const connectionDetails = (preset ? field('baseUrl', 'API base URL', { disabled: true }) + '<small>The MiniMax China preset fixes the regional endpoint and requires a Token Plan key beginning sk-cp-. Usage-based keys are a separate product.</small>' : '') + disclosure('protocol-constraints', 'Supported protocol & parameter limits', '<small>Custom connections use the OpenAI compatible chat completions protocol. MiniMax Token Plan uses its fixed China endpoint. Arbitrary provider protocols are not supported.</small><small class="model-parameter-guide">Temperature: 0–2. Output: 128–32,768 tokens. Timeout: 1–300 seconds. Retries: 0–3. Model identifiers: up to 128 characters.</small>', { nested: true }) + disclosure('key-security', 'Key storage & removal', keySecurity, { nested: true }) + disclosure('test-explanation', 'About connectivity tests', '<small>Connectivity tests send a tiny fictional prompt using the saved revision. They are actual provider requests and may use plan quota. They do not include calendar rows, research answers or agent conversation. Test output is shown as plain text.</small>', { nested: true });
    const reuse = '<section class="panel model-reuse-card"><div class="panel-heading"><div><h3>Reuse your custom configuration</h3><small>Export public settings or import a configuration as a draft.</small></div><div class="toolbar"><button class="button" data-model-action="open-import">Import JSON</button><button class="button" data-model-action="export">Export draft JSON</button></div></div>' + disclosure('reuse-configuration', 'Import public configuration', '<small id="model-import-guide">Use the complete configuration JSON: provider, baseUrl, Alice and Bob. Never include API keys. Importing requires validation and review before saving.</small><label class="field model-import-file"><span>Choose a configuration JSON file</span><input type="file" accept=".json,application/json" data-model-import-file aria-describedby="model-import-guide"></label><label class="field"><span>Or paste configuration JSON</span><textarea class="mono" rows="8" spellcheck="false" autocomplete="off" data-model-import-json aria-describedby="model-import-guide">' + escapeHtml(importBuffer) + '</textarea></label><button class="button section-actions" data-model-action="import">Use JSON as draft</button>', { icon: true }) + '<div data-model-transfer-notice class="notice ' + (transferError ? 'error' : '') + '" role="' + (transferError ? 'alert' : 'status') + '" ' + (transferNotice ? '' : 'hidden') + '>' + escapeHtml(transferNotice) + '</div></section>';
    const reviewTable = '<div data-model-change-summary hidden></div>' + disclosure('technical-diff', 'Exact properties & raw values', '<div class="table-wrap"><table class="config-diff"><thead><tr><th>Property</th><th>Saved before</th><th>Draft after</th></tr></thead><tbody data-model-diff></tbody></table></div>', { nested: true }) + '<small>Saved settings take effect when the next round starts. Current rounds retain their model revision and do not change midway. Controlled and replay modes do not invoke this provider.</small>';
    container.innerHTML = '<div class="config-hierarchy"><div class="panel-heading"><div><h2>Model configuration</h2><small>Start with a preset or connect a custom API. Model names and tuning stay editable.</small></div><div class="toolbar"><span class="tag" data-model-draft-state></span><span class="tag">Saved r' + escapeHtml(saved.revision) + '</span><button class="button quiet" data-model-action="reload">Reload saved configuration</button></div></div>'
      + '<section class="panel model-connection-card"><div class="panel-heading"><div class="config-section-title"><span class="config-overview-icon">' + icons.connection + '</span><div><h3>Shared connection</h3><small>One provider for both agents</small></div></div><span class="tag model-key-status ' + (saved.keyConfigured ? 'good' : 'warn') + '">' + (saved.keyConfigured ? 'Key configured on server' : 'No key configured') + '</span></div><div class="config-flow" aria-label="Alice and Bob share this provider"><span class="config-flow-node connection">Shared provider</span><span class="config-flow-link" aria-hidden="true">→</span><span class="config-flow-node alice">Alice</span><span class="config-flow-node bob">Bob</span></div><div class="model-provider-choice"><label class="field"><span>Connection type</span><select data-model-provider><option value="minimax_cn_token_plan" ' + (preset ? 'selected' : '') + '>Preset · MiniMax China Token Plan</option><option value="openai_compatible" ' + (!preset ? 'selected' : '') + '>Custom · OpenAI compatible API</option></select></label>' + (preset ? '<button class="button" data-model-action="custom-provider"><span class="model-inline-icon">' + icons.tune + '</span><span>Use a custom provider</span></button>' : '') + '</div>' + customEndpoint + keyControls(preset) + '<small>Keys are write-only. Connectivity tests may use provider quota.</small>' + disclosure('connection-details', 'Connection details', connectionDetails) + '</section>'
      + '<div class="model-role-grid">' + roleCard('Alice') + roleCard('Bob') + '</div>'
      + reuse
      + '<section class="panel config-save-bar"><div class="panel-heading"><div><h3>Review & apply to new rounds</h3><small>Changes take effect from the next round.</small></div><span class="tag">' + (activeRevision == null ? 'No current round' : 'Current round r' + escapeHtml(activeRevision)) + '</span></div><div class="notice ' + (noticeError ? 'error' : '') + '" data-model-notice role="' + (noticeError ? 'alert' : 'status') + '">' + escapeHtml(notice || 'Edit the draft, validate, review the diff, then save for new rounds.') + '</div><div class="toolbar"><button class="button" data-model-action="validate">Validate & preview diff</button><button class="button primary" data-model-action="apply">Save for new rounds</button></div>' + disclosure('review-diff', 'Review changes <span class="tag" data-model-diff-count hidden></span>', reviewTable) + '</section></div>';
    updateControls();
  }
  async function load({ force = false } = {}) {
    if (!force && saved && draft) { render(); return; }
    importReadSequence++;
    rememberExpanded();
    const ownGeneration = ++generation; clearSecret(); busy = true; reviewed = null; diff = []; notice = ''; noticeError = false; clearKey = false; keyNotice = ''; keyNoticeError = false; importBuffer = ''; transferNotice = ''; transferError = false;
    container.innerHTML = '<section class="panel loading">Loading redacted model configuration…</section>';
    try {
      const value = await api('/api/admin/models', { admin: true });
      if (ownGeneration !== generation) return;
      saved = value; draft = clone(value.config); compatibleEndpoint = draft.provider === 'openai_compatible' ? draft.baseUrl : null; tests.Alice = null; tests.Bob = null; busy = false; render();
    } catch (error) { if (ownGeneration !== generation) return; busy = false; container.innerHTML = '<section class="panel"><div class="notice error" role="alert">' + escapeHtml(error.message) + '</div><button class="button" data-model-action="reload">Reload model configuration</button></section>'; }
  }
  function clear() { rememberExpanded(); generation++; importReadSequence++; clearSecret(); saved = null; draft = null; reviewed = null; clearKey = false; keyNotice = ''; keyNoticeError = false; compatibleEndpoint = null; importBuffer = ''; transferNotice = ''; transferError = false; tests.Alice = null; tests.Bob = null; busy = false; container.innerHTML = '<section class="panel">Researcher sign-in is required.</section>'; }
  container.addEventListener('toggle', event => { if (event.target.matches('[data-model-disclosure]')) expanded.set(event.target.dataset.modelDisclosure, event.target.open); }, true);
  container.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('[data-model-key]')) return;
    event.preventDefault(); query('[data-model-action="save-key"]')?.click();
  });
  container.addEventListener('input', event => {
    const node = event.target;
    if (node.matches('[data-model-import-json]') && !busy) { importReadSequence++; importBuffer = node.value; announceTransfer(''); return; }
    if (node.matches('[data-model-key]')) { announceKey(''); updateControls(); return; } if (!draft || !node.dataset.modelPath || busy) return;
    setPath(draft, node.dataset.modelPath, node.hasAttribute('data-model-number') ? node.value === '' ? null : Number(node.value) : node.value);
    if (node.dataset.modelPath === 'baseUrl' && draft.provider === 'openai_compatible') compatibleEndpoint = node.value;
    node.removeAttribute('aria-invalid');
    reviewed = null; diff = []; announce('Draft changed. Validate and review it before saving.'); updatePreviews(); updateControls();
  });
  container.addEventListener('change', async event => {
    if (event.target.matches('[data-model-import-file]') && !busy) {
      const ownReadSequence = ++importReadSequence;
      const file = event.target.files?.[0]; if (!file) return;
      event.target.value = '';
      const ownGeneration = generation;
      try {
        if (file.size > 65536) throw new Error('Configuration JSON must be at most 64 KiB.');
        announceTransfer('Reading configuration file… You can keep editing the JSON below.');
        const text = await file.text(); if (ownGeneration !== generation || ownReadSequence !== importReadSequence) return;
        importBuffer = text; const input = query('[data-model-import-json]'); if (input) input.value = text;
        announceTransfer('File loaded. Select Use JSON as draft to review these settings.');
      } catch (error) { if (ownGeneration === generation && ownReadSequence === importReadSequence) announceTransfer(error.message, true); }
      return;
    }
    if (event.target.matches('[data-model-clear-key]')) { clearKey = event.target.checked; if (clearKey) clearSecret(); updateControls(); return; }
    if (draft && event.target.dataset.modelPath && event.target.tagName === 'SELECT' && !busy) { setPath(draft, event.target.dataset.modelPath, event.target.value); reviewed = null; diff = []; announce('Draft changed. Validate and review it before saving.'); updatePreviews(); updateControls(); return; }
    if (!draft || !event.target.matches('[data-model-provider]') || busy) return;
    selectProvider(event.target.value);
  });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-model-action]'); if (!button || button.disabled) return;
    const action = button.dataset.modelAction;
    if (action === 'reload') { load({ force: true }); return; }
    if (!saved || !draft) return;
    if (action === 'custom-provider') { selectProvider('openai_compatible'); return; }
    if (action === 'open-import') { openDisclosure('reuse-configuration'); query('[data-model-import-json]')?.focus(); return; }
    if (action === 'import') { importConfiguration(); return; }
    if (action === 'export') { exportConfiguration(); return; }
    if (action === 'tune') {
      const role = button.dataset.modelRole, group = button.dataset.modelTuningTarget;
      openDisclosure(role + '-parameters'); openDisclosure(role + '-' + group);
      const firstInput = query('[data-model-disclosure="' + role + '-' + group + '"] input');
      firstInput?.focus();
      return;
    }
    const ownGeneration = generation;
    let firstInvalidField = null;
    const role = button.dataset.modelRole;
    const apiKey = action === 'apply' || action === 'save-key' ? query('[data-model-key]')?.value.trim() : undefined;
    if (action === 'apply' || action === 'save-key') clearSecret();
    if (action === 'save-key') announceKey('Saving API key…');
    busy = true; updateControls();
    try {
      if (action === 'validate') {
        container.querySelectorAll('[data-model-path][aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
        const value = await api('/api/admin/models/validate', { method: 'POST', admin: true, body: { config: draft } });
        if (ownGeneration !== generation) return;
        reviewed = value.valid ? stamp() : null; diff = value.diff || [];
        const errors = (value.errors || []).map(error => typeof error === 'string' ? error : [error.path, error.message].filter(Boolean).join(': '));
        openDisclosure('review-diff');
        if (!value.valid) for (const error of value.errors || []) {
          const field = [...container.querySelectorAll('[data-model-path]')].find(node => typeof error === 'string' ? error.includes(node.dataset.modelPath) : error.path?.replace(/^\$\.?/, '') === node.dataset.modelPath);
          if (field) {
            field.setAttribute('aria-invalid', 'true');
            if (!firstInvalidField) {
              firstInvalidField = field;
              for (let parent = field.parentElement; parent && parent !== container; parent = parent.parentElement) if (parent.matches('details[data-model-disclosure]')) openDisclosure(parent.dataset.modelDisclosure);
            }
          }
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
    } finally { if (ownGeneration === generation) { busy = false; updateControls(); firstInvalidField?.focus(); } }
  });
  clear();
  return { load, clear, clearSecret };
}
