import { mountAgentStates } from './agent-state.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const array = value => Array.isArray(value) ? value : [];
const nextRowId = (rows, prefix) => { let index = rows.length + 1; const used = new Set(rows.map(row => row.id)); while (used.has(prefix + index)) index++; return prefix + index; };
const getPath = (value, path) => path.split('.').reduce((node, key) => node?.[key], value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) node = node[key] ||= {}; node[keys.at(-1)] = next; }
const dayOptions = value => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => '<option ' + (day === value ? 'selected' : '') + '>' + day + '</option>').join('');
const fieldLabels = { day: 'Day', time: 'Time', status: 'Free / busy', title: 'Title', note: 'Note' };
const kitPresentation = {
  conference: { tone: 'blue', icon: 'calendar', description: 'Try the full scheduling scenario.', label: 'Recommended' },
  minimal: { tone: 'green', icon: 'overlap', description: 'Start with availability and a shared time.' },
  'shared-context': { tone: 'purple', icon: 'context', description: 'Explore scheduling with a shared research topic.' },
  'broad-review': { tone: 'amber', icon: 'shield', description: 'Explore owner review before each Bob reply.' },
  custom: { tone: 'slate', icon: 'custom', description: 'Start empty and add your own pieces.' }
};
function conditionIcon(kind) {
  const shapes = {
    calendar: '<rect x="5" y="7" width="22" height="21" rx="4"/><path d="M5 13h22M11 4v6M21 4v6"/><path d="m11 20 3 3 7-7"/>',
    overlap: '<rect x="3" y="7" width="17" height="18" rx="4"/><rect x="12" y="7" width="17" height="18" rx="4"/><path d="m14 16 2 2 4-4"/>',
    context: '<circle cx="7" cy="16" r="4"/><circle cx="24" cy="7" r="4"/><circle cx="24" cy="25" r="4"/><path d="m11 14 9-5m-9 9 9 5"/>',
    shield: '<path d="m16 3 11 5v9c0 6-11 12-11 12S5 23 5 17V8Z"/><path d="m11 16 3 3 7-7"/>',
    custom: '<rect x="4" y="4" width="10" height="10" rx="3"/><rect x="18" y="4" width="10" height="10" rx="3"/><rect x="4" y="18" width="10" height="10" rx="3"/><path d="M23 18v10m-5-5h10"/>',
    skills: '<path d="m18 3-12 16h9l-1 10 12-17h-9Z"/>',
    person: '<circle cx="16" cy="10" r="5"/><path d="M6 28v-4a10 10 0 0 1 20 0v4"/>'
  };
  return '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (shapes[kind] || shapes.context) + '</svg>';
}

export function createInitialConditions({ api, isResearcher, isOpenControls = () => false, onChange, onSignIn }) {
  let container, catalog, schema, draft = { presetId: 'conference', componentIds: { Alice: [], Bob: [] }, custom: {} }, resolved, reviewedStamp, generation = 0, busy = false, message = '', error = false, role = 'Alice', editor = {}, rawDirty = false, rawBuffer = '', bundles = [], bundleName = '', selectedBundleId = '';
  const disclosureState = new Map();
  function rememberDisclosures() { container?.querySelectorAll('details[data-conditions-disclosure]').forEach(node => disclosureState.set(node.dataset.conditionsDisclosure, node.open)); }
  function restoreDisclosures() { container?.querySelectorAll('details[data-conditions-disclosure]').forEach(node => { node.open = disclosureState.get(node.dataset.conditionsDisclosure) || false; }); }
  const stamp = () => JSON.stringify(draft);
  const query = selector => container?.querySelector(selector);
  const ready = () => Boolean(resolved && reviewedStamp === stamp() && !rawDirty && !busy && (!resolved.requiresResearcher || isResearcher()));
  function announce(text, failed = false) { message = text; error = failed; updateControls(); }
  function invalidate() { reviewedStamp = null; message = 'Draft changed. Validate & preview the resulting initial state before starting.'; error = false; updateControls(); }
  function updateControls() {
    const notice = query('[data-conditions-notice]'); if (notice) { notice.textContent = message; notice.className = 'notice ' + (error ? 'error' : ''); notice.setAttribute('role', error ? 'alert' : 'status'); notice.hidden = !message; }
    const validate = query('[data-conditions-action="validate"]'); if (validate) { validate.disabled = busy || rawDirty || !catalog; validate.textContent = busy ? 'Resolving initial conditions…' : 'Validate & preview initial state'; }
    const badge = query('[data-conditions-review-status]'); if (badge) { const valid = resolved && reviewedStamp === stamp() && !rawDirty; badge.textContent = valid ? 'Validated draft' : 'Preview needs validation'; badge.className = 'tag ' + (valid ? 'good' : 'warn'); }
    container?.querySelectorAll('[data-conditions-preset],[data-conditions-component],[data-conditions-path],[data-conditions-row-path],[data-conditions-skill],[data-conditions-auth-field]').forEach(node => { node.disabled = busy || rawDirty || node.dataset.owner === 'Bob' && !isResearcher(); });
    container?.querySelectorAll('[data-conditions-json],[data-conditions-import],[data-conditions-bundle],[data-conditions-bundle-name],[data-conditions-action="parse-json"],[data-conditions-action="discard-json"],[data-conditions-action="refresh-bundles"]').forEach(node => { node.disabled = busy; });
    container?.querySelectorAll('[data-conditions-action="add-row"],[data-conditions-action="remove-row"],[data-conditions-action="clear-custom"],[data-conditions-action="load-bundle"]').forEach(node => { node.disabled = busy || rawDirty || node.dataset.owner === 'Bob' && !isResearcher(); });
    container?.querySelectorAll('[data-conditions-preset]').forEach(node => { const preset = catalog?.presets.find(item => item.id === node.dataset.conditionsPreset); node.checked = !draft.agents && draft.presetId === preset?.id && !Object.values(draft.custom || {}).some(profile => Object.keys(profile || {}).length) && JSON.stringify(draft.componentIds) === JSON.stringify(preset?.componentIds || { Alice: [], Bob: [] }); });
    const summaryStatus = query('[data-conditions-summary-status]'); if (summaryStatus) summaryStatus.textContent = resolved && reviewedStamp === stamp() && !rawDirty ? 'Validated initial snapshot' : 'Previous preview · draft has changed';
    const previewDescription = query('[data-conditions-preview-description]'); if (previewDescription) previewDescription.textContent = resolved && reviewedStamp === stamp() && !rawDirty ? 'This is the exact validated draft that will create the next round.' : 'These are the last validated states. Validate again to see your latest edits.';
    const restriction = query('[data-conditions-researcher-needed]'); if (restriction) restriction.hidden = !resolved?.requiresResearcher || isResearcher();
    const save = query('[data-conditions-action="save-bundle"]'); if (save) save.disabled = busy || rawDirty || !resolved || reviewedStamp !== stamp();
    const download = query('[data-conditions-action="download"]'); if (download) download.disabled = busy || rawDirty || !resolved || reviewedStamp !== stamp();
    onChange?.();
  }
  function textField(path, label, type = 'text', owner = role) {
    const value = getPath(editor[owner], path);
    if (type === 'boolean') return '<label class="check"><input type="checkbox" data-conditions-path="' + path + '" data-owner="' + owner + '" data-value-type="boolean" ' + (value ? 'checked' : '') + '><span>' + label + '</span></label>';
    let control;
    if (type === 'confirmation') control = '<select data-conditions-path="' + path + '" data-owner="' + owner + '"><option value="bounded" ' + (value === 'bounded' ? 'selected' : '') + '>Bounded preauthorization</option><option value="per_action" ' + (value === 'per_action' ? 'selected' : '') + '>Confirm each action</option></select>';
    else if (type === 'textarea') control = '<textarea rows="2" data-conditions-path="' + path + '" data-owner="' + owner + '">' + escapeHtml(value || '') + '</textarea>';
    else control = '<input type="' + (type === 'number' ? 'number' : 'text') + '" ' + (type === 'number' ? path === 'authorization.expiryMinutes' ? 'min="0.01" max="1440" step="0.01" ' : 'min="1" max="10000" step="1" ' : '') + 'data-conditions-path="' + path + '" data-owner="' + owner + '" data-value-type="' + type + '" value="' + escapeHtml(type === 'csv' ? array(value).join(', ') : value ?? '') + '">';
    return '<label class="field"><span>' + label + '</span>' + control + '</label>';
  }
  function rowInput(path, index, key, value, type = 'text') {
    const attrs = 'data-conditions-row-path="' + path + '" data-index="' + index + '" data-key="' + key + '" data-owner="' + role + '" aria-label="' + escapeHtml(role + ' ' + (index + 1) + ' ' + (fieldLabels[key] || key)) + '"';
    if (type === 'day') return '<select ' + attrs + '>' + dayOptions(value) + '</select>';
    if (type === 'status') return '<select ' + attrs + '><option ' + (value === 'Free' ? 'selected' : '') + '>Free</option><option ' + (value === 'Busy' ? 'selected' : '') + '>Busy</option></select>';
    return '<input type="text" ' + attrs + ' value="' + escapeHtml(value || '') + '">';
  }
  function rowsHtml(path, columns, title, template) {
    const rows = array(getPath(editor[role], path));
    return '<div class="custom-table-group"><div class="panel-heading"><h4>' + title + '</h4><button class="button" data-conditions-action="add-row" data-owner="' + role + '" data-path="' + path + '" data-template="' + escapeHtml(JSON.stringify(template)) + '">Add ' + (path.startsWith('kg.') ? path.endsWith('nodes') ? 'node' : 'relation' : 'time') + '</button></div><div class="table-wrap"><table class="condition-editor-table"><thead><tr>' + columns.map(([key, label]) => '<th scope="col">' + label + '</th>').join('') + '<th scope="col">Remove</th></tr></thead><tbody>' + rows.map((row, index) => '<tr>' + columns.map(([key, , type]) => '<td>' + rowInput(path, index, key, row[key], type) + '</td>').join('') + '<td><button class="button danger" data-conditions-action="remove-row" data-owner="' + role + '" data-path="' + path + '" data-index="' + index + '" aria-label="Remove ' + escapeHtml(title) + ' row ' + (index + 1) + '">×</button></td></tr>').join('') + '</tbody></table></div>' + (!rows.length ? '<p class="muted">No rows. Add one or select a data / knowledge component.</p>' : '') + '</div>';
  }
  function roleEditorHtml() {
    const profile = editor[role]; if (!profile) return '<p class="muted">Resolve a preset to populate the custom editor.</p>';
    const skillNames = new Map(array(resolved?.agentStates?.[role]?.skills).map(skill => [skill.id, skill.label]));
    const allowedSkills = schema?.properties?.agents?.properties?.[role]?.properties?.skills?.items?.enum || schema?.skills?.[role] || [...new Set([...array(profile.skills), ...array(catalog.components).filter(component => array(component.roles).includes(role)).flatMap(component => array(component.patch?.skills))])];
    const authFields = role === 'Alice' ? ['day', 'time', 'status', 'title', 'note'] : ['day', 'time', 'status', 'topic', 'agenda'];
    return '<fieldset class="custom-role-fields" ' + (role === 'Bob' && !isResearcher() ? 'disabled' : '') + '><legend class="sr-only">' + role + ' custom initial profile</legend><div class="custom-table-group"><h4>Skills</h4><div class="component-skill-grid">' + allowedSkills.map(id => '<label class="check"><input type="checkbox" data-conditions-skill="' + escapeHtml(id) + '" data-owner="' + role + '" ' + (array(profile.skills).includes(id) ? 'checked' : '') + '><span>' + escapeHtml(skillNames.get(id) || id.replaceAll('_', ' ')) + '</span></label>').join('') + '</div></div><div class="custom-table-group"><h4>Initial authorization ceiling</h4><p class="muted">Alice still confirms each exact calendar snapshot during the collaboration. These values limit what can be requested; they do not send information.</p><div class="component-skill-grid">' + authFields.map(id => '<label class="check"><input type="checkbox" data-conditions-auth-field="' + id + '" data-owner="' + role + '" ' + (array(profile.authorization?.fields).includes(id) ? 'checked' : '') + '><span>' + (fieldLabels[id] || id) + '</span></label>').join('') + '</div><div class="form-grid">' + (role === 'Alice' ? textField('authorization.windows', 'Allowed days · comma separated', 'csv') : textField('authorization.recipients', 'Recipients · comma separated', 'csv') + textField('authorization.resources', 'Resources · comma separated', 'csv') + textField('authorization.window', 'Time window') + textField('authorization.confirmation', 'Confirmation', 'confirmation')) + textField('authorization.maxUses', 'Maximum uses', 'number') + textField('authorization.expiryMinutes', 'Expiry · minutes', 'number') + '</div>' + (role === 'Bob' ? textField('authorization.askAdminForNewScope', 'Ask the researcher before a new scope', 'boolean') : '') + '</div>' + (role === 'Alice' ? rowsHtml('data.calendar', [['day', 'Day', 'day'], ['time', 'Time'], ['status', 'Status', 'status'], ['title', 'Title'], ['note', 'Note']], 'Fictional calendar', { day: 'Tue', time: '09:00–09:30', status: 'Free', title: '', note: '' }) : rowsHtml('data.availableTimes', [['day', 'Day', 'day'], ['time', 'Time']], 'Fictional availability', { day: 'Thu', time: '15:00–15:30' }) + '<div class="form-grid">' + textField('data.brief.topic', 'Brief topic') + textField('data.brief.agenda', 'Brief agenda', 'textarea') + '</div>') + rowsHtml('kg.nodes', [['id', 'Node ID'], ['label', 'Readable label'], ['type', 'Type']], 'Knowledge nodes', { id: nextRowId(array(profile.kg?.nodes), 'node-'), label: 'New fact', type: 'context' }) + rowsHtml('kg.edges', [['id', 'Relation ID'], ['source', 'Source node ID'], ['label', 'Relationship'], ['target', 'Target node ID']], 'Knowledge relationships', { id: nextRowId(array(profile.kg?.edges), 'edge-'), source: profile.kg?.nodes?.[0]?.id || '', target: profile.kg?.nodes?.[1]?.id || profile.kg?.nodes?.[0]?.id || '', label: 'related to' }) + '</fieldset>';
  }
  function componentsHtml() {
    const categories = [...new Set(array(catalog?.components).filter(component => array(component.roles).includes(role)).map(component => component.category))];
    return categories.map(category => '<fieldset class="component-category" ' + (role === 'Bob' && !isResearcher() ? 'disabled' : '') + '><legend>' + escapeHtml(({ kg: 'Knowledge graph', data: 'Data', skills: 'Skills', authorization: 'Authorization' })[category] || category) + '</legend><div class="component-grid">' + array(catalog.components).filter(component => component.category === category && array(component.roles).includes(role)).map(component => '<label class="component-card"><input type="radio" name="condition-component-' + role + '-' + escapeHtml(category) + '" data-conditions-component="' + escapeHtml(component.id) + '" data-owner="' + role + '" data-category="' + escapeHtml(category) + '" ' + (array(draft.componentIds[role]).includes(component.id) && (!draft.agents || JSON.stringify(draft.agents[role][category]) === JSON.stringify(component.patch[category])) ? 'checked' : '') + '><span><strong>' + escapeHtml(component.name) + '</strong><small>' + escapeHtml(component.description) + '</small></span></label>').join('') + '</div></fieldset>').join('');
  }
  function savedBundlesHtml() {
    return '<details class="advanced-condition-editor saved-condition-bundles condition-detail" data-conditions-disclosure="reuse"><summary><span>Save, reuse or import initial conditions</span><small>Files & reusable bundles</small></summary><p class="muted">Download the validated fictional fixture for reproducible reuse. Researcher bundles are reusable configurations stored separately from participant research records.</p><div class="toolbar section-actions"><button class="button" data-conditions-action="download">Download validated fixture</button><label class="button import-fixture-label">Import fixture or composition<input type="file" accept="application/json,.json" data-conditions-import></label></div>' + (isResearcher() ? '<div class="form-grid"><label class="field"><span>Saved researcher bundle</span><select data-conditions-bundle><option value="">Choose a bundle</option>' + bundles.map(bundle => '<option value="' + escapeHtml(bundle.id) + '" ' + (bundle.id === selectedBundleId ? 'selected' : '') + '>' + escapeHtml(bundle.name) + ' · r' + bundle.revision + '</option>').join('') + '</select></label><label class="field"><span>Bundle name</span><input data-conditions-bundle-name value="' + escapeHtml(bundleName) + '" placeholder="Availability baseline"></label></div><div class="toolbar section-actions"><button class="button" data-conditions-action="load-bundle">Load selected bundle</button><button class="button" data-conditions-action="save-bundle">' + (bundles.some(bundle => bundle.name === bundleName.trim()) ? 'Save next bundle revision' : 'Save validated bundle') + '</button><button class="button" data-conditions-action="refresh-bundles">Refresh bundles</button></div><small>Reusing an existing name creates a new revision only when the current revision still matches.</small>' : '<small>Sign in as a researcher to save shared reusable bundles on this server.</small>') + '</details>';
  }
  function render() {
    if (!container) return;
    rememberDisclosures();
    if (!catalog) { container.innerHTML = '<section class="panel"><h3>Initial conditions</h3><p class="loading">' + escapeHtml(message || 'Loading starter kits and components…') + '</p><button class="button" data-conditions-action="reload">Reload catalog</button></section>'; return; }
    const definitions = draft.agents || draft.custom;
    const customRoles = Object.keys(draft.custom || {}).filter(owner => Object.keys(draft.custom[owner] || {}).length);
    const kits = catalog.presets.map(preset => {
      const presentation = kitPresentation[preset.id] || { tone: 'blue', icon: 'calendar', description: preset.description };
      return '<label class="preset-card condition-kit-card" data-tone="' + presentation.tone + '" title="' + escapeHtml(preset.description) + '"><input type="radio" name="condition-preset" data-conditions-preset="' + escapeHtml(preset.id) + '" aria-description="' + escapeHtml(preset.description) + '" ' + (!draft.agents && draft.presetId === preset.id ? 'checked' : '') + '><span class="condition-kit-visual">' + conditionIcon(presentation.icon) + '</span><span class="condition-kit-copy"><strong>' + escapeHtml(preset.name) + '</strong><small>' + escapeHtml(presentation.description) + '</small>' + (presentation.label ? '<span class="condition-kit-badge">' + presentation.label + '</span>' : '') + '</span></label>';
    }).join('');
    const custom = '<details class="custom-condition-editor condition-detail" data-conditions-disclosure="custom"><summary><span>Customize ' + role + ' · skills, authorization, data & KG</span><small>Edit individual values</small></summary>' + (customRoles.length ? '<div class="notice">Custom overrides active for ' + escapeHtml(customRoles.join(' and ')) + '. They take precedence over components.<button class="button section-actions" data-conditions-action="clear-custom" data-owner="' + role + '">Clear ' + role + ' overrides</button></div>' : '') + roleEditorHtml() + '</details>';
    const json = '<details class="advanced-condition-editor condition-detail" data-conditions-disclosure="json"><summary><span>Complete custom definition · JSON & schema</span><small>Advanced</small></summary><p class="muted">' + (draft.agents ? 'This imported fixture keeps complete profiles exactly as defined. Editing a profile replaces its definition; selecting a component replaces only that category. Choose a starter kit to build a new composition.' : 'All custom profile fields are available here. Arrays replace preset arrays; objects merge. Use the empty starter kit for a complete definition.') + (isOpenControls() ? ' Alice and Bob can both be configured directly in this demo.' : ' Bob changes require researcher sign-in.') + '</p><label class="field"><span>' + (draft.agents ? 'Complete profiles for ' : 'Custom overrides for ') + (isResearcher() ? 'Alice and Bob' : 'Alice') + '</span><textarea class="mono" rows="10" spellcheck="false" data-conditions-json>' + escapeHtml(rawDirty ? rawBuffer : JSON.stringify(isResearcher() ? definitions : { Alice: definitions.Alice || {} }, null, 2)) + '</textarea></label><div class="toolbar section-actions"><button class="button" data-conditions-action="parse-json">Use JSON definition</button><button class="button" data-conditions-action="discard-json">Discard JSON buffer</button><a class="button" href="/api/conditions/schema" target="_blank" rel="noopener">Open configuration schema</a></div></details>';
    const composition = '<details class="conditions-composition configuration-disclosure" data-conditions-disclosure="composition"><summary><span><strong>Fine-tune the starter kit</strong><small>Components, agent profiles & reusable files</small></span><span class="disclosure-level">Optional details</span></summary><div class="disclosure-body"><p class="muted">Keep the starter kit as it is, or adjust one part at a time.</p><div class="role-switch toolbar" aria-label="Agent to configure"><button class="button ' + (role === 'Alice' ? 'primary' : '') + '" data-conditions-role="Alice" aria-pressed="' + (role === 'Alice') + '">Alice · your agent</button><button class="button ' + (role === 'Bob' ? 'primary' : '') + '" data-conditions-role="Bob" aria-pressed="' + (role === 'Bob') + '">' + (isOpenControls() ? 'Bob · peer agent' : 'Bob · researcher control') + '</button></div>' + (role === 'Bob' && !isResearcher() ? '<div class="notice">Bob’s initial profile is visible for review. Sign in as a researcher to change his components or custom profile. <button class="button" data-conditions-action="sign-in">Researcher sign in</button></div>' : '') + componentsHtml() + custom + json + savedBundlesHtml() + '</div></details>';
    container.innerHTML = '<section class="panel initial-conditions"><div class="panel-heading"><div><p class="eyebrow">Before this round</p><h3>Choose a starting scenario</h3><small>A starter kit is enough to begin. Details are optional.</small></div><span class="tag" data-conditions-review-status></span></div><div class="preset-grid condition-kit-grid">' + kits + '</div>' + composition + '<div class="notice" data-conditions-notice role="status"></div><div class="notice warning" data-conditions-researcher-needed hidden>The selected initial conditions also change Bob. A researcher must sign in before this round can start. <button class="button" data-conditions-action="sign-in">Researcher sign in</button></div><div class="toolbar section-actions"><button class="button" data-conditions-action="validate">Validate & preview initial state</button><small>Previewing is read-only. Starting creates isolated stores from this validated draft.</small></div><div data-conditions-summary></div><div data-conditions-preview></div></section>';
    restoreDisclosures();
    updateControls(); renderPreview();
  }
  function renderPreview() {
    const holder = query('[data-conditions-preview]'), summary = query('[data-conditions-summary]'); if (!holder || !summary || !resolved) return;
    rememberDisclosures();
    const valid = reviewedStamp === stamp() && !rawDirty;
    summary.innerHTML = '<div class="initial-summary"><div class="panel-heading"><strong data-conditions-summary-status>' + (valid ? 'Validated initial snapshot' : 'Previous preview · draft has changed') + '</strong><small>Two agents, separate starting states</small></div><div class="condition-overview-grid">' + ['Alice', 'Bob'].map(owner => {
      const profile = resolved.conditions?.agents?.[owner] || {};
      const metrics = [
        ['knowledge', 'context', array(profile.kg?.nodes).length, 'Knowledge nodes'],
        ['data', 'calendar', array(owner === 'Alice' ? profile.data?.calendar : profile.data?.availableTimes).length, 'Calendar rows'],
        ['skills', 'skills', array(profile.skills).length, 'Skills'],
        ['authorization', 'shield', array(profile.authorization?.fields).length, 'Allowed fields']
      ];
      return '<article class="condition-overview-card" data-agent="' + owner + '"><div class="condition-agent-heading"><span class="condition-avatar">' + conditionIcon('person') + '</span><div><strong>' + owner + '</strong><small>' + (owner === 'Alice' ? 'Your agent' : isOpenControls() ? 'Peer agent' : 'Researcher-controlled agent') + '</small></div></div><div class="condition-metrics">' + metrics.map(([category, icon, count, label]) => '<div class="condition-metric" data-metric="' + category + '"><span class="condition-metric-icon">' + conditionIcon(icon) + '</span><strong>' + count + '</strong><small>' + label + '</small></div>').join('') + '</div><small class="condition-ceiling">' + (profile.authorization?.maxUses ?? 0) + ' maximum uses · ' + escapeHtml(array(profile.authorization?.fields).map(field => fieldLabels[field] || field).join(', ') || 'None') + '</small></article>';
    }).join('') + '</div><p class="condition-boundary-note">Alice confirms each exact calendar snapshot. These are sharing limits; no information has been authorized or sent.</p></div>';
    holder.innerHTML = '<details class="conditions-state-details configuration-disclosure" data-conditions-disclosure="states"><summary><span><strong>Explore both agent states</strong><small>Knowledge graphs, capabilities, data & authorization</small></span><span class="disclosure-level">Full preview</span></summary><div class="disclosure-body"><div data-conditions-full-states></div><details class="condition-detail conditions-definition-details" data-conditions-disclosure="identity"><summary>Snapshot identity & resolved definition</summary><code>' + escapeHtml(resolved.hash) + '</code><pre>' + escapeHtml(JSON.stringify(resolved.conditions, null, 2)) + '</pre></details></div></details>';
    mountAgentStates(query('[data-conditions-full-states]'), resolved.agentStates, { scope: 'initial-preview', heading: 'Preview both initial agent states', description: valid ? 'This is the exact validated draft that will create the next round.' : 'These are the last validated states. Validate again to see your latest edits.' });
    query('[data-conditions-full-states] .agent-observatory > .panel-heading > div > small')?.setAttribute('data-conditions-preview-description', '');
    restoreDisclosures();
  }
  async function resolve({ quiet = false, input = draft, adopt = false } = {}) {
    if (!catalog || rawDirty) return;
    const ownGeneration = ++generation, ownStamp = stamp(); busy = true; if (!quiet) message = 'Validating the complete initial conditions…'; updateControls();
    try {
      const value = await api('/api/conditions/resolve', { method: 'POST', auth: false, body: clone(input) });
      if (ownGeneration !== generation || ownStamp !== stamp()) return;
      if (adopt) draft = clone(Object.prototype.hasOwnProperty.call(input, 'agents') ? value.conditions : input);
      resolved = value; reviewedStamp = stamp(); editor = clone(value.conditions.agents); error = false; message = 'Validated. Review both states below; nothing has been authorized or sent.'; rawDirty = false; render();
    } catch (reason) { if (ownGeneration === generation) { reviewedStamp = null; const errors = Array.isArray(reason.details) ? reason.details : reason.details?.errors || []; announce(reason.message + (reason.details?.path ? ' · ' + reason.details.path : '') + errors.slice(0, 6).map(item => ' · ' + item.path + ': ' + item.message).join(''), true); } }
    finally { if (ownGeneration === generation) { busy = false; updateControls(); } }
  }
  async function load() {
    busy = true; message = ''; render(); onChange?.();
    try {
      const result = await Promise.allSettled([api('/api/conditions/catalog', { auth: false }), api('/api/conditions/schema', { auth: false })]);
      if (result[0].status === 'rejected') throw result[0].reason;
      catalog = result[0].value; schema = result[1].status === 'fulfilled' ? result[1].value : null;
      const preset = catalog.presets.find(item => item.id === draft.presetId) || catalog.presets[0]; if (!preset) throw new Error('No initial-condition starter kits are available.');
      if (!draft.agents) { draft.presetId = preset.id; draft.componentIds = clone(preset.componentIds || { Alice: [], Bob: [] }); }
      render(); await resolve({ quiet: true });
    } catch (reason) { busy = false; message = reason.message; error = true; render(); onChange?.(); }
  }
  function commitPath(owner, path, value) {
    if (!editor[owner] || owner === 'Bob' && !isResearcher() || busy || rawDirty) return;
    setPath(editor[owner], path, value);
    if (draft.agents) setPath(draft.agents[owner], path, clone(value));
    else { draft.custom[owner] ||= {}; setPath(draft.custom[owner], path, clone(value)); }
    invalidate();
  }
  async function refreshBundles() {
    if (!isResearcher()) return;
    try { const result = await api('/api/admin/conditions'); if (!isResearcher()) return; bundles = array(result.bundles); render(); }
    catch (reason) { announce(reason.message, true); }
  }
  function adoptInput(value) {
    const input = value?.conditions || value;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Use a fixture or initial-condition composition object.');
    const preset = catalog.presets.find(item => item.id === (input.presetId || 'conference'));
    // Complete fixtures are replacement definitions. Turning them into patches
    // would merge removed brief fields back in from the current owner template.
    const next = clone(input);
    if (!Object.prototype.hasOwnProperty.call(next, 'agents')) {
      if (!Object.prototype.hasOwnProperty.call(next, 'presetId')) next.presetId = 'conference';
      if (!Object.prototype.hasOwnProperty.call(next, 'componentIds')) next.componentIds = clone(preset?.componentIds || { Alice: [], Bob: [] });
      if (!Object.prototype.hasOwnProperty.call(next, 'custom')) next.custom = {};
    }
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 262144) throw new Error('The compact fixture request must fit within 256 KiB. Reduce its data or knowledge size.');
    // Validate before adopting, so malformed complete definitions cannot leave
    // the structured editor in an unusable partially populated state.
    rawDirty = false; rawBuffer = ''; invalidate(); resolve({ input: next, adopt: true });
  }
  function bind() {
    container.addEventListener('toggle', event => {
      if (event.currentTarget === container && event.target.matches('details[data-conditions-disclosure]')) disclosureState.set(event.target.dataset.conditionsDisclosure, event.target.open);
    }, true);
    container.addEventListener('input', event => {
      const node = event.target;
      if (node.matches('[data-conditions-bundle-name]')) { bundleName = node.value; const save = query('[data-conditions-action="save-bundle"]'); if (save) save.textContent = bundles.some(bundle => bundle.name === bundleName.trim()) ? 'Save next bundle revision' : 'Save validated bundle'; }
      if (node.matches('[data-conditions-json]')) { rawDirty = true; rawBuffer = node.value; invalidate(); return; }
      if (node.dataset.conditionsPath && node.type !== 'checkbox' && node.tagName !== 'SELECT') commitPath(node.dataset.owner, node.dataset.conditionsPath, node.dataset.valueType === 'number' ? Number(node.value) : node.dataset.valueType === 'csv' ? node.value.split(',').map(item => item.trim()).filter(Boolean) : node.value);
      if (node.dataset.conditionsRowPath && node.tagName !== 'SELECT') { const rows = clone(getPath(editor[node.dataset.owner], node.dataset.conditionsRowPath)); rows[Number(node.dataset.index)][node.dataset.key] = node.value; commitPath(node.dataset.owner, node.dataset.conditionsRowPath, rows); }
    });
    container.addEventListener('change', async event => {
      const node = event.target;
      if (node.matches('[data-conditions-bundle]')) { selectedBundleId = node.value; const bundle = bundles.find(item => item.id === selectedBundleId); if (bundle) { bundleName = bundle.name; query('[data-conditions-bundle-name]').value = bundleName; } return; }
      if (node.matches('[data-conditions-import]')) { try { const file = node.files?.[0]; if (!file) return; if (file.size > 4 * 1024 * 1024) throw new Error('Fixture files must be at most 4 MiB; their compact JSON request must fit within 256 KiB.'); adoptInput(JSON.parse(await file.text())); } catch (reason) { announce('Import error: ' + reason.message, true); } return; }
      if (node.dataset.conditionsPreset) { const preset = catalog.presets.find(item => item.id === node.dataset.conditionsPreset); draft = { presetId: preset.id, componentIds: clone(preset.componentIds || { Alice: [], Bob: [] }), custom: {} }; rawDirty = false; resolved = null; editor = {}; invalidate(); render(); resolve(); return; }
      if (node.dataset.conditionsComponent) { const owner = node.dataset.owner; if (owner === 'Bob' && !isResearcher()) return; const component = catalog.components.find(item => item.id === node.dataset.conditionsComponent); draft.componentIds[owner] = array(draft.componentIds[owner]).filter(id => catalog.components.find(component => component.id === id)?.category !== node.dataset.category); draft.componentIds[owner].push(node.dataset.conditionsComponent); if (draft.agents) draft.agents[owner][component.category] = clone(component.patch[component.category]); invalidate(); resolve(); return; }
      if (node.dataset.conditionsPath && (node.type === 'checkbox' || node.tagName === 'SELECT')) commitPath(node.dataset.owner, node.dataset.conditionsPath, node.dataset.valueType === 'boolean' ? node.checked : node.value);
      if (node.dataset.conditionsRowPath && node.tagName === 'SELECT') { const rows = clone(getPath(editor[node.dataset.owner], node.dataset.conditionsRowPath)); rows[Number(node.dataset.index)][node.dataset.key] = node.value; commitPath(node.dataset.owner, node.dataset.conditionsRowPath, rows); }
      if (node.dataset.conditionsSkill) commitPath(node.dataset.owner, 'skills', [...container.querySelectorAll('[data-conditions-skill]:checked')].filter(input => input.dataset.owner === node.dataset.owner).map(input => input.dataset.conditionsSkill));
      if (node.dataset.conditionsAuthField) commitPath(node.dataset.owner, 'authorization.fields', [...container.querySelectorAll('[data-conditions-auth-field]:checked')].filter(input => input.dataset.owner === node.dataset.owner).map(input => input.dataset.conditionsAuthField));
    });
    container.addEventListener('click', async event => {
      const roleButton = event.target.closest('[data-conditions-role]'); if (roleButton) { role = roleButton.dataset.conditionsRole; render(); return; }
      const button = event.target.closest('[data-conditions-action]'); if (!button || button.disabled) return;
      const action = button.dataset.conditionsAction;
      if (action === 'reload') { load(); return; }
      if (action === 'sign-in') { onSignIn?.(); return; }
      if (action === 'validate') { resolve(); return; }
      if (action === 'refresh-bundles') { refreshBundles(); return; }
      if (action === 'load-bundle') { const bundle = bundles.find(item => item.id === selectedBundleId); if (!bundle) { announce('Choose a saved researcher bundle first.', true); return; } adoptInput(bundle.conditions); return; }
      if (action === 'download') { if (!resolved || reviewedStamp !== stamp() || rawDirty) return; const url = URL.createObjectURL(new Blob([JSON.stringify(resolved.conditions, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'agent-initial-conditions.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
      if (action === 'save-bundle') {
        if (!isResearcher() || !resolved || reviewedStamp !== stamp() || rawDirty || busy) return;
        const existing = bundles.find(bundle => bundle.name === bundleName.trim()); busy = true; updateControls();
        try { const result = await api('/api/admin/conditions', { method: 'POST', body: { name: bundleName.trim(), input: clone(resolved.conditions), ...(existing ? { expectedRevision: existing.revision } : {}) } }); if (!isResearcher()) return; bundles = array(result.bundles); selectedBundleId = result.bundle?.id || ''; announce('Saved researcher bundle ' + result.bundle?.name + ' · revision ' + result.bundle?.revision + '.'); render(); }
        catch (reason) { announce(reason.message, true); }
        finally { busy = false; updateControls(); } return;
      }
      if (action === 'discard-json') { rawDirty = false; rawBuffer = ''; invalidate(); render(); return; }
      if (action === 'parse-json') {
        try { const value = JSON.parse(query('[data-conditions-json]').value); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['Alice', 'Bob'].includes(key))) throw new Error('Use an object containing Alice and / or Bob profile definitions.'); if (Object.prototype.hasOwnProperty.call(value, 'Bob') && !isResearcher()) throw new Error('Bob customization requires researcher sign-in.'); const next = clone(draft); if (next.agents) next.agents = { ...next.agents, ...value }; else next.custom = isResearcher() ? value : { ...next.custom, Alice: value.Alice || {} }; rawDirty = false; rawBuffer = ''; invalidate(); resolve({ input: next, adopt: true }); } catch (reason) { announce('Definition error: ' + reason.message, true); } return;
      }
      const owner = button.dataset.owner; if (owner === 'Bob' && !isResearcher() || busy || rawDirty) return;
      if (action === 'clear-custom') { delete draft.custom[owner]; invalidate(); resolve(); return; }
      if (action === 'add-row' || action === 'remove-row') {
        const path = button.dataset.path, rows = clone(array(getPath(editor[owner], path)));
        if (action === 'add-row') rows.push(JSON.parse(button.dataset.template));
        else { const [removed] = rows.splice(Number(button.dataset.index), 1); if (path === 'kg.nodes') commitPath(owner, 'kg.edges', array(editor[owner].kg?.edges).filter(edge => edge.source !== removed.id && edge.target !== removed.id)); }
        commitPath(owner, path, rows); const open = query('.custom-condition-editor')?.open; render(); if (open) query('.custom-condition-editor').open = true;
      }
    });
  }
  return {
    load,
    attach(next) { if (container !== next) { rememberDisclosures(); container = next; bind(); } render(); },
    ready,
    async submission() { if (!resolved || reviewedStamp !== stamp() || rawDirty || busy) throw new Error('Validate and review your initial conditions before starting.'); if (resolved.requiresResearcher && !isResearcher()) throw new Error('Researcher sign-in is required for the selected Bob initial conditions.'); return { initialConditions: clone(draft), expectedConditionsHash: resolved.hash }; },
    authorizationChanged() { if (!isResearcher()) { bundles = []; bundleName = ''; selectedBundleId = ''; } render(); if (isResearcher()) refreshBundles(); },
    async refresh() { await resolve({ quiet: true }); }
  };
}
