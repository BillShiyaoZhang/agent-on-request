import { mountAgentStates } from './agent-state.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const array = value => Array.isArray(value) ? value : [];
const starterDraft = preset => ({ presetId: preset?.id ?? 'conference', componentIds: clone(preset?.componentIds ?? { Alice: [], Bob: [] }), custom: {} });
const nextRowId = (rows, prefix) => { let index = rows.length + 1; const used = new Set(rows.map(row => row.id)); while (used.has(prefix + index)) index++; return prefix + index; };
const getPath = (value, path) => path.split('.').reduce((node, key) => node?.[key], value);
function setPath(value, path, next) { const keys = path.split('.'); let node = value; for (const key of keys.slice(0, -1)) node = node[key] ||= {}; node[keys.at(-1)] = next; }
const dayOptions = value => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => '<option ' + (day === value ? 'selected' : '') + '>' + day + '</option>').join('');
const fieldLabels = { day: 'Day', time: 'Time', status: 'Free / busy', title: 'Title', note: 'Note', id: 'Skill ID', label: 'Readable label', description: 'Description / instructions' };
const categoryPresentation = {
  data: { title: 'Data', icon: 'calendar', hint: 'What this agent can work with', tone: 'blue' },
  kg: { title: 'Knowledge graph', icon: 'context', hint: 'Facts and their connections', tone: 'purple' },
  skills: { title: 'Skills', icon: 'skills', hint: 'What this agent can do', tone: 'amber' },
  authorization: { title: 'Authorization', icon: 'shield', hint: 'Limits on what may be shared', tone: 'green' }
};
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

export function createInitialConditions({ api, isResearcher, isOpenControls = () => false }) {
  let container, catalog, draft = starterDraft(), resolved, reviewedStamp, generation = 0, busy = false, message = '', error = false, role = 'Alice', editor = {}, rawDirty = false, rawBuffer = '', bundles = [], bundleName = '', selectedBundleId = '';
  let savedDefault = null, savedHash = null, authorizationGeneration = 0;
  let validationIssues = [], pendingValidationFocus = false;
  let rawCompleteMode = false;
  const extensionDrafts = { Alice: {}, Bob: {} };
  const disclosureState = new Map([['composition', true]]);
  function rememberDisclosures() { container?.querySelectorAll('details[data-conditions-disclosure]').forEach(node => disclosureState.set(node.dataset.conditionsDisclosure, node.open)); }
  function restoreDisclosures() { container?.querySelectorAll('details[data-conditions-disclosure]').forEach(node => { if (disclosureState.has(node.dataset.conditionsDisclosure)) node.open = disclosureState.get(node.dataset.conditionsDisclosure); }); }
  const stamp = () => JSON.stringify(draft);
  const query = selector => container?.querySelector(selector);
  const ready = () => Boolean(resolved && reviewedStamp === stamp() && !rawDirty && !busy);
  function announce(text, failed = false) { message = text; error = failed; updateControls(); }
  function invalidate() { reviewedStamp = null; validationIssues = []; pendingValidationFocus = false; message = 'Draft changed. Validate and preview the initial state before saving.'; error = false; updateControls(); }
  function updateControls() {
    const notice = query('[data-conditions-notice]'); if (notice) { notice.textContent = message; notice.className = 'notice ' + (error ? 'error' : ''); notice.setAttribute('role', error ? 'alert' : 'status'); notice.hidden = !message; }
    const validate = query('[data-conditions-action="validate"]'); if (validate) { validate.disabled = busy || rawDirty || !catalog; validate.textContent = busy ? 'Resolving initial conditions…' : 'Validate & preview initial state'; }
    const badge = query('[data-conditions-review-status]'); if (badge) { const valid = resolved && reviewedStamp === stamp() && !rawDirty; badge.textContent = valid ? 'Validated draft' : 'Preview needs validation'; badge.className = 'tag ' + (valid ? 'good' : 'warn'); }
    container?.querySelectorAll('[data-conditions-preset],[data-conditions-component],[data-conditions-path],[data-conditions-row-path],[data-conditions-skill],[data-conditions-auth-field],[data-conditions-extension-input]').forEach(node => { node.disabled = busy || rawDirty || node.dataset.owner === 'Bob' && !isResearcher(); });
    container?.querySelectorAll('[data-conditions-json],[data-conditions-import],[data-conditions-bundle],[data-conditions-bundle-name],[data-conditions-action="parse-json"],[data-conditions-action="discard-json"],[data-conditions-action="refresh-bundles"]').forEach(node => { node.disabled = busy; });
    container?.querySelectorAll('[data-conditions-action="add-row"],[data-conditions-action="remove-row"],[data-conditions-action="clear-custom"],[data-conditions-action="load-bundle"],[data-conditions-action="add-skill"],[data-conditions-action="add-auth-field"],[data-conditions-action="edit-brief-json"]').forEach(node => { node.disabled = busy || rawDirty || node.dataset.owner === 'Bob' && !isResearcher(); });
    container?.querySelectorAll('[data-conditions-preset]').forEach(node => { const preset = catalog?.presets.find(item => item.id === node.dataset.conditionsPreset); node.checked = !draft.agents && draft.presetId === preset?.id && !Object.values(draft.custom || {}).some(profile => Object.keys(profile || {}).length) && JSON.stringify(draft.componentIds) === JSON.stringify(preset?.componentIds || { Alice: [], Bob: [] }); });
    const summaryStatus = query('[data-conditions-summary-status]'); if (summaryStatus) summaryStatus.textContent = resolved && reviewedStamp === stamp() && !rawDirty ? 'Validated initial snapshot' : 'Previous preview · draft has changed';
    const previewDescription = query('[data-conditions-preview-description]'); if (previewDescription) previewDescription.textContent = resolved && reviewedStamp === stamp() && !rawDirty ? 'This is the starting state defined by the validated draft.' : 'These are the last validated states. Validate again to see your latest edits.';
    const save = query('[data-conditions-action="save-bundle"]'); if (save) save.disabled = busy || rawDirty || !resolved || reviewedStamp !== stamp();
    const download = query('[data-conditions-action="download"]'); if (download) download.disabled = busy || rawDirty || !resolved || reviewedStamp !== stamp();
    const saveDefault = query('[data-conditions-action="save-default"]'); if (saveDefault) saveDefault.disabled = !savedDefault || !isResearcher() || !ready() || savedHash === resolved.hash;
    const resetDefault = query('[data-conditions-action="reset-default"]'); if (resetDefault) resetDefault.disabled = busy || !isResearcher() || !savedDefault?.conditions;
    const reloadDefault = query('[data-conditions-action="reload-default"]'); if (reloadDefault) reloadDefault.disabled = busy || !isResearcher();
    refreshDraftVisuals();
    applyValidationIssues();
  }
  function textField(path, label, type = 'text', owner = role) {
    const value = getPath(editor[owner], path);
    if (type === 'boolean') return '<label class="check"><input type="checkbox" data-conditions-path="' + path + '" data-owner="' + owner + '" data-value-type="boolean" ' + (value ? 'checked' : '') + '><span>' + label + '</span></label>';
    let control;
    if (type === 'confirmation') control = '<input type="text" list="conditions-confirmation-' + owner + '" data-conditions-path="' + path + '" data-owner="' + owner + '" value="' + escapeHtml(value ?? '') + '" maxlength="128"><datalist id="conditions-confirmation-' + owner + '"><option value="bounded">Bounded preauthorization</option><option value="per_action">Confirm each action</option></datalist><small>Choose a suggestion or enter your own mode. Only bounded allows preauthorization; every other mode requires review.</small>';
    else if (type === 'textarea') control = '<textarea rows="2" data-conditions-path="' + path + '" data-owner="' + owner + '">' + escapeHtml(value || '') + '</textarea>';
    else control = '<input type="' + (type === 'number' ? 'number' : 'text') + '" ' + (type === 'number' ? path === 'authorization.expiryMinutes' ? 'min="0.01" max="1440" step="0.01" ' : 'min="1" max="10000" step="1" ' : '') + 'data-conditions-path="' + path + '" data-owner="' + owner + '" data-value-type="' + type + '" value="' + escapeHtml(type === 'csv' ? array(value).join(', ') : value ?? '') + '">';
    return '<label class="field"><span>' + label + '</span>' + control + '</label>';
  }
  function rowInput(path, index, key, value, type = 'text', label = fieldLabels[key] || key) {
    const displayLabel = path === 'kg.edges' ? ({ id: 'Relation ID', source: 'Source node ID', label: 'Relationship', target: 'Target node ID' })[key] || label : path === 'kg.nodes' && key === 'id' ? 'Node ID' : label;
    const attrs = 'data-conditions-row-path="' + path + '" data-index="' + index + '" data-key="' + key + '" data-owner="' + role + '" aria-label="' + escapeHtml(role + ' ' + (index + 1) + ' ' + displayLabel) + '"';
    if (type === 'day') return '<select ' + attrs + '>' + dayOptions(value) + '</select>';
    if (type === 'status') return '<select ' + attrs + '><option ' + (value === 'Free' ? 'selected' : '') + '>Free</option><option ' + (value === 'Busy' ? 'selected' : '') + '>Busy</option></select>';
    if (type === 'textarea') return '<textarea rows="3" ' + attrs + '>' + escapeHtml(value || '') + '</textarea>';
    return '<input type="text" ' + attrs + ' value="' + escapeHtml(value || '') + '">';
  }
  function categoryMetric(category, owner = role) {
    const profile = editor[owner] || {};
    if (category === 'data') return array(owner === 'Alice' ? profile.data?.calendar : profile.data?.availableTimes).length + ' time entries';
    if (category === 'kg') return array(profile.kg?.nodes).length + ' nodes · ' + array(profile.kg?.edges).length + ' relationships';
    if (category === 'skills') return array(profile.skills).length + ' selected skills';
    return array(profile.authorization?.fields).length + ' fields · ' + (profile.authorization?.maxUses ?? 0) + ' maximum uses';
  }
  function selectedCategory(category) {
    const component = array(catalog?.components).find(item => item.category === category && array(draft.componentIds?.[role]).includes(item.id));
    const hasOverride = Object.prototype.hasOwnProperty.call(draft.custom?.[role] || {}, category);
    const completeChanged = draft.agents && (!component || JSON.stringify(draft.agents[role]?.[category]) !== JSON.stringify(component.patch?.[category]));
    return '<span class="conditions-current-choice">' + escapeHtml(completeChanged ? 'Custom definition' : component?.name || 'No component selected') + '</span>' + (hasOverride ? '<span class="conditions-override-mark">Custom override</span>' : '');
  }
  function dataMiniHtml() {
    const rows = array(role === 'Alice' ? editor[role]?.data?.calendar : editor[role]?.data?.availableTimes);
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const max = Math.max(1, ...days.map(day => rows.filter(row => row.day === day).length));
    return '<div class="conditions-week-strip" aria-label="Time entries by day">' + days.map(day => {
      const items = rows.filter(row => row.day === day), free = items.filter(row => role === 'Bob' || row.status === 'Free').length;
      return '<div class="conditions-week-day"><span class="conditions-day-bars" aria-hidden="true"><i class="conditions-day-free" style="height:' + (free / max * 100) + '%"></i><i class="conditions-day-busy" style="height:' + ((items.length - free) / max * 100) + '%"></i></span><span>' + day + '</span><strong>' + items.length + '</strong></div>';
    }).join('') + '</div><div class="conditions-visual-key"><span><i class="conditions-key-free"></i>Free</span>' + (role === 'Alice' ? '<span><i class="conditions-key-busy"></i>Busy</span>' : '') + '<small>Fictional time entries</small></div>';
  }
  function knowledgeMiniHtml() {
    const profile = editor[role] || {}, nodes = array(profile.kg?.nodes).slice(0, 6), edges = array(profile.kg?.edges);
    if (!nodes.length) return '<div class="conditions-empty-visual">' + conditionIcon('context') + '<span>No knowledge nodes yet</span></div>';
    const positions = new Map(nodes.map((node, index) => [node.id, { x: 35 + index % 3 * 100, y: 30 + Math.floor(index / 3) * 58 }]));
    const lines = edges.filter(edge => positions.has(edge.source) && positions.has(edge.target)).slice(0, 12).map(edge => {
      const from = positions.get(edge.source), to = positions.get(edge.target);
      return '<path d="M' + from.x + ' ' + from.y + 'L' + to.x + ' ' + to.y + '"/>';
    }).join('');
    return '<div class="conditions-graph-mini"><svg viewBox="0 0 270 122" role="img" aria-label="Knowledge connections preview"><g class="conditions-mini-links">' + lines + '</g>' + nodes.map(node => {
      const pos = positions.get(node.id);
      return '<g><circle cx="' + pos.x + '" cy="' + pos.y + '" r="10"/><text x="' + pos.x + '" y="' + (pos.y + 26) + '" text-anchor="middle">' + escapeHtml(String(node.label || node.id).slice(0, 12)) + '</text><title>' + escapeHtml(node.label || node.id) + '</title></g>';
    }).join('') + '</svg><small>Preview of up to 6 nodes. Edit every node and relationship below.</small></div>';
  }
  function authorizationMiniHtml() {
    const authorization = editor[role]?.authorization || {};
    return '<div class="conditions-boundary-mini"><div>' + conditionIcon('shield') + '<strong>' + array(authorization.fields).length + '</strong><small>Allowed fields</small></div><span aria-hidden="true">→</span><div><strong>' + escapeHtml(authorization.maxUses ?? 0) + '</strong><small>Maximum uses</small></div><span aria-hidden="true">→</span><div><strong>' + escapeHtml(authorization.expiryMinutes ?? 0) + '</strong><small>Expiry · minutes</small></div></div>';
  }
  function rowSummary(path, row, index) {
    if (path === 'skillDefinitions') return '<strong data-i18n-ignore>' + escapeHtml(row.label || row.id || 'Custom skill') + '</strong><small><span data-i18n-ignore>' + escapeHtml(row.id) + '</span> · ' + (isRegisteredSkill(row.id) ? 'Registered action guidance' : 'Custom planning guidance') + '</small>';
    if (path === 'kg.nodes') return '<strong>' + escapeHtml(row.label || row.id || 'New fact') + '</strong><small>' + escapeHtml(row.type || 'context') + '</small>';
    if (path === 'kg.edges') {
      const nodes = array(editor[role]?.kg?.nodes), label = id => nodes.find(node => node.id === id)?.label || id || 'Choose a node';
      return '<strong>' + escapeHtml(row.label || 'Relationship') + '</strong><small>' + escapeHtml(label(row.source)) + ' → ' + escapeHtml(label(row.target)) + '</small>';
    }
    return '<strong>' + escapeHtml(row.day || 'Day') + ' · ' + escapeHtml(row.time || 'Time') + '</strong><small class="conditions-time-status" data-status="' + escapeHtml(row.status || 'Free') + '">' + escapeHtml(row.status || 'Available') + (row.title ? ' · ' + escapeHtml(row.title) : '') + '</small>';
  }
  function refreshDraftVisuals() {
    if (!container || !catalog) return;
    container.querySelectorAll('[data-conditions-category-metric]').forEach(node => { const category = node.dataset.conditionsCategoryMetric; node.textContent = categoryMetric(category) + (validationIssues.some(issue => issue.owner === role && (issue.path === category || issue.path.startsWith(category + '.') || issue.path.startsWith(category + '[') || category === 'skills' && issue.path.startsWith('skillDefinitions'))) ? ' · Needs correction' : ''); });
    container.querySelectorAll('[data-conditions-current-category]').forEach(node => { node.innerHTML = selectedCategory(node.dataset.conditionsCurrentCategory); });
    container.querySelectorAll('[data-conditions-row-summary]').forEach(node => { const row = array(getPath(editor[role], node.dataset.path))[Number(node.dataset.index)]; if (row) node.innerHTML = rowSummary(node.dataset.path, row, Number(node.dataset.index)); });
    container.querySelectorAll('[data-conditions-mini]').forEach(node => { node.innerHTML = node.dataset.conditionsMini === 'data' ? dataMiniHtml() : node.dataset.conditionsMini === 'kg' ? knowledgeMiniHtml() : authorizationMiniHtml(); });
    const status = query('[data-conditions-draft-status]');
    if (status) { status.textContent = rawDirty ? 'Unapplied JSON · apply or discard before validation' : error ? 'Validation failed · review the message below' : resolved && reviewedStamp === stamp() ? 'Validated draft' : 'Changes need validation'; status.className = 'tag ' + (resolved && reviewedStamp === stamp() && !rawDirty && !error ? 'good' : 'warn'); }
  }
  function validationControls(issue) {
    const parentOrExact = path => path === issue.path || path.startsWith(issue.path + '.') || path.startsWith(issue.path + '[') || issue.path.startsWith(path + '[');
    return [...container.querySelectorAll('[data-conditions-path],[data-conditions-row-path],[data-conditions-skill],[data-conditions-auth-field]')].filter(node => {
      if (node.dataset.owner !== issue.owner) return false;
      const path = node.dataset.conditionsPath || (node.dataset.conditionsRowPath ? node.dataset.conditionsRowPath + '[' + node.dataset.index + '].' + node.dataset.key : node.dataset.conditionsSkill ? 'skills' : 'authorization.fields');
      return parentOrExact(path);
    });
  }
  function applyValidationIssues({ focus = false } = {}) {
    if (!container) return;
    container.querySelectorAll('[aria-invalid="true"]').forEach(node => { node.removeAttribute('aria-invalid'); if (node.getAttribute('aria-describedby') === 'conditions-validation-notice') node.removeAttribute('aria-describedby'); });
    container.querySelectorAll('[data-conditions-has-error]').forEach(node => node.removeAttribute('data-conditions-has-error'));
    if (!validationIssues.length) {
      const groups = new Map(); container.querySelectorAll('[data-conditions-error-name]').forEach(node => { const name = node.dataset.conditionsErrorName; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(node); });
      groups.forEach((nodes, name) => { const preferred = nodes.find(node => node.contains(container.ownerDocument.activeElement)) || nodes.find(node => node.open); nodes.forEach(node => { if (preferred && node !== preferred) node.open = false; node.setAttribute('name', name); delete node.dataset.conditionsErrorName; }); });
      return;
    }
    const fields = [...new Set(validationIssues.flatMap(validationControls))];
    fields.forEach(node => {
      node.setAttribute('aria-invalid', 'true'); node.setAttribute('aria-describedby', 'conditions-validation-notice');
      for (let ancestor = node.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS') { ancestor.dataset.conditionsHasError = 'true'; if (ancestor.hasAttribute('name')) { ancestor.dataset.conditionsErrorName = ancestor.getAttribute('name'); ancestor.removeAttribute('name'); } if (focus) ancestor.open = true; }
    });
    if (focus && !busy) { const target = fields.find(node => !node.disabled) || fields[0]?.closest('details')?.querySelector(':scope > summary'); if (target) { target.focus(); target.scrollIntoView({ block: 'center', behavior: 'auto' }); rememberDisclosures(); } }
  }
  function editorGroup(category, title, content) {
    const presentation = categoryPresentation[category];
    return '<details class="conditions-editor-group" data-tone="' + presentation.tone + '" data-conditions-disclosure="editor-' + role + '-' + category + '" name="conditions-editor-' + role + '"><summary><span class="conditions-category-icon">' + conditionIcon(presentation.icon) + '</span><span class="conditions-group-copy"><strong>' + title + '</strong><small data-conditions-category-metric="' + category + '">' + categoryMetric(category) + '</small></span></summary><div class="conditions-editor-body">' + content + '</div></details>';
  }
  function isRegisteredSkill(id) { return array(catalog?.skills).find(skill => skill.id === id)?.registered === true; }
  function skillNameHtml(id, label, profile) { return '<span' + (!isRegisteredSkill(id) || array(profile.skillDefinitions).some(skill => skill.id === id) ? ' data-i18n-ignore' : '') + '>' + escapeHtml(label) + '</span>'; }
  function authorizationFieldNameHtml(id) { const known = (role === 'Alice' ? ['day', 'time', 'status', 'title', 'note'] : ['day', 'time', 'status', 'topic', 'agenda']).includes(id); return '<span' + (known ? '' : ' data-i18n-ignore') + '>' + escapeHtml(known && Object.hasOwn(fieldLabels, id) ? fieldLabels[id] : id) + '</span>'; }
  function extensionInput(key, label, type = 'text', maxLength) {
    const attrs = 'data-conditions-extension-input="' + key + '" data-owner="' + role + '" ' + (maxLength ? 'maxlength="' + maxLength + '"' : '');
    const value = escapeHtml(extensionDrafts[role][key] || '');
    return '<label class="field"><span>' + label + '</span>' + (type === 'textarea' ? '<textarea rows="3" ' + attrs + '>' + value + '</textarea>' : '<input type="text" ' + attrs + ' value="' + value + '">') + '</label>';
  }
  function rowsHtml(path, columns, title, template, canAdd = true) {
    const rows = array(getPath(editor[role], path));
    const cards = rows.map((row, index) => '<details class="conditions-row-card" data-conditions-disclosure="row-' + role + '-' + path + '-' + index + '" data-conditions-row-details="' + path + '" data-index="' + index + '" name="conditions-rows-' + role + '-' + path + '"><summary><span class="conditions-row-number" aria-hidden="true">' + (index + 1) + '</span><span data-conditions-row-summary data-path="' + path + '" data-index="' + index + '">' + rowSummary(path, row, index) + '</span></summary><div class="conditions-row-fields">' + columns.map(([key, label, type]) => '<label class="field"><span>' + label + '</span>' + rowInput(path, index, key, row[key], type) + '</label>').join('') + '<div class="conditions-remove-row"><button class="button danger" data-conditions-action="remove-row" data-owner="' + role + '" data-path="' + path + '" data-index="' + index + '" aria-label="Remove ' + escapeHtml(title) + ' row ' + (index + 1) + '">' + (path === 'skillDefinitions' ? isRegisteredSkill(row.id) ? 'Remove guidance' : 'Remove custom skill' : 'Remove') + '</button></div></div></details>');
    const list = rows.length <= 10 ? cards.join('') : Array.from({ length: Math.ceil(rows.length / 10) }, (_, batch) => '<details class="conditions-entry-batch" data-conditions-disclosure="batch-' + role + '-' + path + '-' + batch + '" name="conditions-batches-' + role + '-' + path + '" ' + (batch === 0 ? 'open' : '') + '><summary>Entries ' + (batch * 10 + 1) + '–' + Math.min(rows.length, (batch + 1) * 10) + ' of ' + rows.length + '</summary><div>' + cards.slice(batch * 10, (batch + 1) * 10).join('') + '</div></details>').join('');
    return '<div class="custom-table-group"><div class="panel-heading"><h4>' + title + '</h4>' + (canAdd ? '<button class="button" data-conditions-action="add-row" data-owner="' + role + '" data-path="' + path + '" data-template="' + escapeHtml(JSON.stringify(template)) + '">Add ' + (path.startsWith('kg.') ? path.endsWith('nodes') ? 'node' : 'relation' : 'time') + '</button>' : '') + '</div><div class="condition-editor-table conditions-row-list">' + list + '</div>' + (!rows.length ? '<p class="muted">' + (canAdd ? 'No rows. Add one or select a data / knowledge component.' : 'No custom skill guidance yet.') + '</p>' : '') + '</div>';
  }
  function roleEditorHtml() {
    const profile = editor[role]; if (!profile) return '<p class="muted">Resolve a preset to populate the custom editor.</p>';
    const skillNames = new Map([...array(catalog.skills).map(skill => [skill.id, skill.name]), ...array(resolved?.agentStates?.[role]?.skills).map(skill => [skill.id, skill.label]), ...array(profile.skillDefinitions).map(skill => [skill.id, skill.label])]);
    const allowedSkills = [...new Set([...array(catalog.skills).filter(skill => array(skill.roles).includes(role)).map(skill => skill.id), ...array(profile.skills)])];
    const authFields = role === 'Alice' ? ['day', 'time', 'status', 'title', 'note'] : [...new Set(['day', 'time', 'status', 'topic', 'agenda', ...Object.keys(profile.data?.brief || {}), ...array(profile.authorization?.fields)])];
    const skills = '<p class="muted">Select the capabilities available at the start.</p><div class="component-skill-grid conditions-choice-grid">' + allowedSkills.map(id => '<label class="check"><input type="checkbox" data-conditions-skill="' + escapeHtml(id) + '" data-owner="' + role + '" ' + (array(profile.skills).includes(id) ? 'checked' : '') + '><span>' + skillNameHtml(id, skillNames.get(id) || id.replaceAll('_', ' '), profile) + '<small>' + (isRegisteredSkill(id) ? 'Registered runtime action' : 'Custom capability label') + '</small></span></label>').join('') + '</div><p class="conditions-custom-skill-note muted">Custom labels and instructions can guide planning. Executing actions still uses registered runtime tools.</p>' + rowsHtml('skillDefinitions', [['id', 'Skill ID'], ['label', 'Readable label'], ['description', 'Description / instructions', 'textarea']], 'Skill guidance', {}, false) + '<details class="conditions-extension-editor" data-conditions-disclosure="add-skill-' + role + '"><summary>Add a custom skill or guidance</summary><div class="conditions-extension-body"><p class="muted">Use a new ID for a custom capability, or an enabled skill ID to add its guidance.</p><div class="form-grid">' + extensionInput('skillId', 'Skill ID', 'text', 128) + extensionInput('skillLabel', 'Readable label', 'text', 200) + '</div>' + extensionInput('skillDescription', 'Description / instructions', 'textarea', 4000) + '<button class="button section-actions" data-conditions-action="add-skill" data-owner="' + role + '">Add skill to draft</button></div></details>';
    const authorization = '<div data-conditions-mini="authorization">' + authorizationMiniHtml() + '</div><p class="muted">Alice still confirms each exact calendar snapshot during the collaboration. These values limit what can be requested; they do not send information.</p><h4 class="conditions-section-label">Allowed fields</h4><div class="component-skill-grid conditions-choice-grid">' + authFields.map(id => '<label class="check"><input type="checkbox" data-conditions-auth-field="' + escapeHtml(id) + '" data-owner="' + role + '" ' + (array(profile.authorization?.fields).includes(id) ? 'checked' : '') + '>' + authorizationFieldNameHtml(id) + '</label>').join('') + '</div>' + (role === 'Bob' ? '<p class="muted">Clear a field to remove it from the allowed scope.</p><div class="conditions-add-field">' + extensionInput('authField', 'Custom sharing field', 'text', 128) + '<button class="button" data-conditions-action="add-auth-field" data-owner="Bob">Add field</button></div>' : '') + '<h4 class="conditions-section-label">Scope & duration</h4><div class="form-grid">' + (role === 'Alice' ? textField('authorization.windows', 'Allowed days · comma separated', 'csv') : textField('authorization.recipients', 'Recipients · comma separated', 'csv') + textField('authorization.resources', 'Resources · comma separated', 'csv') + textField('authorization.window', 'Time window') + textField('authorization.confirmation', 'Confirmation', 'confirmation')) + textField('authorization.maxUses', 'Maximum uses', 'number') + textField('authorization.expiryMinutes', 'Expiry · minutes', 'number') + '</div>' + (role === 'Bob' ? textField('authorization.askAdminForNewScope', 'Ask the researcher before a new scope', 'boolean') : '');
    const data = '<div data-conditions-mini="data">' + dataMiniHtml() + '</div>' + (role === 'Alice' ? rowsHtml('data.calendar', [['day', 'Day', 'day'], ['time', 'Time'], ['status', 'Status', 'status'], ['title', 'Title'], ['note', 'Note']], 'Fictional calendar', { day: 'Tue', time: '09:00–09:30', status: 'Free', title: '', note: '' }) : rowsHtml('data.availableTimes', [['day', 'Day', 'day'], ['time', 'Time']], 'Fictional availability', { day: 'Thu', time: '15:00–15:30' }) + '<details class="conditions-brief-editor" data-conditions-disclosure="brief-' + role + '"><summary>Brief topic, agenda & extra fields</summary><div class="form-grid">' + textField('data.brief.topic', 'Brief topic') + textField('data.brief.agenda', 'Brief agenda', 'textarea') + '</div><div class="conditions-json-entry"><p class="muted">Extra brief fields can hold text, numbers, lists or nested JSON. Edit the complete profile to add or remove them.</p><button class="button section-actions" data-conditions-action="edit-brief-json" data-owner="Bob">Edit extra brief fields in JSON</button></div></details>');
    const knowledge = '<div data-conditions-mini="kg">' + knowledgeMiniHtml() + '</div>' + rowsHtml('kg.nodes', [['id', 'Node ID'], ['label', 'Readable label'], ['type', 'Type']], 'Knowledge nodes', { id: nextRowId(array(profile.kg?.nodes), 'node-'), label: 'New fact', type: 'context' }) + rowsHtml('kg.edges', [['id', 'Relation ID'], ['source', 'Source node ID'], ['label', 'Relationship'], ['target', 'Target node ID']], 'Knowledge relationships', { id: nextRowId(array(profile.kg?.edges), 'edge-'), source: profile.kg?.nodes?.[0]?.id || '', target: profile.kg?.nodes?.[1]?.id || profile.kg?.nodes?.[0]?.id || '', label: 'related to' });
    return '<fieldset class="custom-role-fields" ' + (role === 'Bob' && !isResearcher() ? 'disabled' : '') + '><legend class="sr-only">' + role + ' custom initial profile</legend><p class="conditions-editor-intro muted">Open one section, then one entry, to edit its values.</p>' + editorGroup('skills', 'Skills', skills) + editorGroup('authorization', 'Initial authorization ceiling', authorization) + editorGroup('data', role === 'Alice' ? 'Fictional calendar' : 'Fictional availability & brief', data) + editorGroup('kg', 'Knowledge graph', knowledge) + '</fieldset>';
  }
  function componentsHtml() {
    const categories = [...new Set(array(catalog?.components).filter(component => array(component.roles).includes(role)).map(component => component.category))];
    return '<div class="conditions-category-list">' + categories.map(category => {
      const presentation = categoryPresentation[category] || { title: category, icon: 'custom', tone: 'slate', hint: '' };
      return '<details class="conditions-component-group" data-tone="' + presentation.tone + '" data-conditions-disclosure="component-' + role + '-' + category + '" name="conditions-components-' + role + '"><summary><span class="conditions-category-icon">' + conditionIcon(presentation.icon) + '</span><span class="conditions-group-copy"><strong>' + escapeHtml(presentation.title) + '</strong><span data-conditions-current-category="' + category + '">' + selectedCategory(category) + '</span></span><small class="conditions-category-count" data-conditions-category-metric="' + category + '">' + categoryMetric(category) + '</small><button type="button" class="button quiet conditions-customize-link" data-conditions-action="edit-category" data-category="' + category + '" aria-label="Customize ' + escapeHtml(presentation.title) + ' values">Customize</button></summary><fieldset class="component-category" ' + (role === 'Bob' && !isResearcher() ? 'disabled' : '') + '><legend class="sr-only">' + escapeHtml(presentation.title) + '</legend><p class="muted conditions-component-hint">' + escapeHtml(presentation.hint) + '</p><div class="component-grid">' + array(catalog.components).filter(component => component.category === category && array(component.roles).includes(role)).map(component => '<label class="component-card"><input type="radio" name="condition-component-' + role + '-' + escapeHtml(category) + '" data-conditions-component="' + escapeHtml(component.id) + '" data-owner="' + role + '" data-category="' + escapeHtml(category) + '" ' + (array(draft.componentIds[role]).includes(component.id) && (!draft.agents || JSON.stringify(draft.agents[role][category]) === JSON.stringify(component.patch[category])) ? 'checked' : '') + '><span><strong>' + escapeHtml(component.name) + '</strong><small>' + escapeHtml(component.description) + '</small></span></label>').join('') + '</div></fieldset></details>';
    }).join('') + '</div>';
  }
  function openCustomEditor(category) {
    const composition = query('.conditions-composition'), custom = query('.custom-condition-editor');
    if (composition) composition.open = true; if (custom) custom.open = true;
    const group = category ? [...container.querySelectorAll('.conditions-editor-group')].find(node => node.dataset.conditionsDisclosure === 'editor-' + role + '-' + category) : custom;
    if (group) { group.open = true; const summary = group.querySelector(':scope > summary'); summary?.focus(); summary?.scrollIntoView({ block: 'center', behavior: 'auto' }); }
    rememberDisclosures();
  }
  function commitRowValue(node) {
    const owner = node.dataset.owner, path = node.dataset.conditionsRowPath, rows = clone(array(getPath(editor[owner], path))), index = Number(node.dataset.index);
    if (busy || rawDirty || owner === 'Bob' && !isResearcher()) return;
    if (!rows[index]) return;
    if (path === 'skillDefinitions' && node.dataset.key === 'id') { const previous = rows[index].id; container.querySelectorAll('[data-conditions-skill]').forEach(input => { if (input.dataset.owner === owner && input.dataset.conditionsSkill === previous) input.dataset.conditionsSkill = node.value; }); commitPath(owner, 'skills', array(editor[owner].skills).map(id => id === previous ? node.value : id)); }
    rows[index][node.dataset.key] = node.value; commitPath(owner, path, rows);
  }
  function savedBundlesHtml() {
    return '<details class="advanced-condition-editor saved-condition-bundles condition-detail" data-conditions-disclosure="reuse"><summary><span>Save, reuse or import initial conditions</span><small>Files & reusable bundles</small></summary><p class="muted">Download the validated fictional fixture for reproducible reuse. Researcher bundles are reusable configurations stored separately from participant research records.</p><div class="toolbar section-actions"><button class="button" data-conditions-action="download">Download validated fixture</button><label class="button import-fixture-label">Import fixture or composition<input type="file" accept="application/json,.json" data-conditions-import></label></div>' + (isResearcher() ? '<div class="form-grid"><label class="field"><span>Saved researcher bundle</span><select data-conditions-bundle><option value="">Choose a bundle</option>' + bundles.map(bundle => '<option value="' + escapeHtml(bundle.id) + '" ' + (bundle.id === selectedBundleId ? 'selected' : '') + '>' + escapeHtml(bundle.name) + ' · r' + bundle.revision + '</option>').join('') + '</select></label><label class="field"><span>Bundle name</span><input data-conditions-bundle-name value="' + escapeHtml(bundleName) + '" placeholder="Availability baseline"></label></div><div class="toolbar section-actions"><button class="button" data-conditions-action="load-bundle">Load selected bundle</button><button class="button" data-conditions-action="save-bundle">' + (bundles.some(bundle => bundle.name === bundleName.trim()) ? 'Save next bundle revision' : 'Save validated bundle') + '</button><button class="button" data-conditions-action="refresh-bundles">Refresh bundles</button></div><small>Reusing an existing name creates a new revision only when the current revision still matches.</small>' : '<small>Sign in as a researcher to save shared reusable bundles on this server.</small>') + '</details>';
  }
  function defaultStatusHtml() {
    const status = !savedDefault ? 'Defaults unavailable'
      : savedDefault.conditions ? 'Custom default · revision ' + escapeHtml(savedDefault.revision) : 'Built-in default';
    return '<div class="conditions-default-status"><span class="tag ' + (savedDefault ? 'good' : 'warn') + '" data-conditions-default-status>' + status + '</span>'
      + '<div class="toolbar"><button class="button" data-conditions-action="reload-default">Reload saved default</button><button class="button" data-conditions-action="reset-default">Restore built-in default</button></div></div>';
  }
  function render() {
    if (!container) return;
    rememberDisclosures();
    if (!catalog) { container.innerHTML = '<section class="panel"><h2>Agent defaults</h2><p class="loading" role="' + (error ? 'alert' : 'status') + '">' + escapeHtml(message || 'Loading starter kits and components…') + '</p><button class="button" data-conditions-action="reload"' + (busy ? ' disabled' : '') + '>Reload catalog</button></section>'; return; }
    const definitions = rawCompleteMode ? editor : draft.agents || draft.custom;
    const customRoles = Object.keys(draft.custom || {}).filter(owner => Object.keys(draft.custom[owner] || {}).length);
    const kits = catalog.presets.map(preset => {
      const presentation = kitPresentation[preset.id] || { tone: 'blue', icon: 'calendar', description: preset.description };
      return '<label class="preset-card condition-kit-card" data-tone="' + presentation.tone + '" title="' + escapeHtml(preset.description) + '"><input type="radio" name="condition-preset" data-conditions-preset="' + escapeHtml(preset.id) + '" aria-description="' + escapeHtml(preset.description) + '" ' + (!draft.agents && draft.presetId === preset.id ? 'checked' : '') + '><span class="condition-kit-visual">' + conditionIcon(presentation.icon) + '</span><span class="condition-kit-copy"><strong>' + escapeHtml(preset.name) + '</strong><small>' + escapeHtml(presentation.description) + '</small>' + (presentation.label ? '<span class="condition-kit-badge">' + presentation.label + '</span>' : '') + '</span></label>';
    }).join('');
    const custom = '<details class="custom-condition-editor condition-detail" data-conditions-disclosure="custom"><summary><span>Customize ' + role + ' · skills, authorization, data & KG</span><small>Edit individual values</small></summary>' + (customRoles.length ? '<div class="notice">Custom overrides active for ' + escapeHtml(customRoles.join(' and ')) + '. They take precedence over components.<button class="button section-actions" data-conditions-action="clear-custom" data-owner="' + role + '">Clear ' + role + ' overrides</button></div>' : '') + roleEditorHtml() + '</details>';
    const json = '<details class="advanced-condition-editor condition-detail" data-conditions-disclosure="json"><summary><span>Complete custom definition · JSON & schema</span><small>Advanced</small></summary><p class="muted">' + (rawCompleteMode ? 'Edit the complete profiles below. Removing a brief key keeps it removed after validation.' : draft.agents ? 'This imported fixture keeps complete profiles exactly as defined. Editing a profile replaces its definition; selecting a component replaces only that category. Choose a starter kit to build a new composition.' : 'All custom profile fields are available here. Arrays replace preset arrays; objects merge. Start from any kit, then customize the values you want to change.') + (isOpenControls() ? ' Alice and Bob can both be configured directly in this demo.' : ' Bob changes require researcher sign-in.') + '</p><label class="field"><span>' + (draft.agents || rawCompleteMode ? 'Complete profiles for ' : 'Custom overrides for ') + (isResearcher() ? 'Alice and Bob' : 'Alice') + '</span><textarea class="mono" rows="10" spellcheck="false" data-conditions-json>' + escapeHtml(rawDirty ? rawBuffer : JSON.stringify(isResearcher() ? definitions : { Alice: definitions.Alice || {} }, null, 2)) + '</textarea></label><div class="toolbar section-actions"><button class="button" data-conditions-action="parse-json">Use JSON definition</button><button class="button" data-conditions-action="discard-json">Discard JSON buffer</button><a class="button" href="/api/conditions/schema" target="_blank" rel="noopener">Open configuration schema</a></div></details>';
    const composition = '<details class="conditions-composition configuration-disclosure" data-conditions-disclosure="composition"><summary><span><strong>Edit agent profiles</strong><small>Knowledge graphs, skills, data and authorization</small></span></summary><div class="disclosure-body"><div class="role-switch toolbar" aria-label="Agent to configure"><button class="button ' + (role === 'Alice' ? 'primary' : '') + '" data-conditions-role="Alice" aria-pressed="' + (role === 'Alice') + '">Agent A · Alice</button><button class="button ' + (role === 'Bob' ? 'primary' : '') + '" data-conditions-role="Bob" aria-pressed="' + (role === 'Bob') + '">Agent B · Bob</button></div><div class="conditions-composition-heading"><strong>Profile overview</strong><span data-conditions-draft-status></span></div>' + componentsHtml() + custom + json + savedBundlesHtml() + '</div></details>';
    const starterKits = '<details class="configuration-disclosure" data-conditions-disclosure="kits"><summary><span><strong>Choose a starting scenario</strong><small>Load a starter kit into the draft.</small></span></summary><div class="disclosure-body"><div class="preset-grid condition-kit-grid">' + kits + '</div></div></details>';
    container.innerHTML = '<section class="panel initial-conditions"><div class="panel-heading"><div><h2>Agent defaults</h2><small>New demos use the saved default. Active rounds keep their starting profiles.</small></div><span class="tag" data-conditions-review-status></span></div>'
      + defaultStatusHtml() + composition + starterKits
      + '<div class="notice" id="conditions-validation-notice" data-conditions-notice role="status"></div><div class="toolbar section-actions"><button class="button" data-conditions-action="validate">Validate & preview initial state</button><button class="button primary" data-conditions-action="save-default">Save as demo default</button></div><div data-conditions-summary></div><div data-conditions-preview></div></section>';
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
      return '<article class="condition-overview-card" data-agent="' + owner + '"><div class="condition-agent-heading"><span class="condition-avatar">' + conditionIcon('person') + '</span><strong>' + (owner === 'Alice' ? 'Agent A · Alice' : 'Agent B · Bob') + '</strong></div><div class="condition-metrics">' + metrics.map(([category, icon, count, label]) => '<div class="condition-metric" data-metric="' + category + '"><span class="condition-metric-icon">' + conditionIcon(icon) + '</span><strong>' + count + '</strong><small>' + label + '</small></div>').join('') + '</div><small class="condition-ceiling">' + (profile.authorization?.maxUses ?? 0) + ' maximum uses · ' + escapeHtml(array(profile.authorization?.fields).map(field => fieldLabels[field] || field).join(', ') || 'None') + '</small></article>';
    }).join('') + '</div><p class="condition-boundary-note">Alice confirms each exact calendar snapshot. These are sharing limits; no information has been authorized or sent.</p></div>';
    holder.innerHTML = '<details class="conditions-state-details configuration-disclosure" data-conditions-disclosure="states"><summary><span><strong>Explore both agent states</strong><small>Knowledge graphs, capabilities, data & authorization</small></span><span class="disclosure-level">Full preview</span></summary><div class="disclosure-body"><div data-conditions-full-states></div><details class="condition-detail conditions-definition-details" data-conditions-disclosure="identity"><summary>Snapshot identity & resolved definition</summary><code>' + escapeHtml(resolved.hash) + '</code><pre>' + escapeHtml(JSON.stringify(resolved.conditions, null, 2)) + '</pre></details></div></details>';
    mountAgentStates(query('[data-conditions-full-states]'), resolved.agentStates, { scope: 'initial-preview', heading: 'Preview both initial agent states', description: valid ? 'This is the starting state defined by the validated draft.' : 'These are the last validated states. Validate again to see your latest edits.' });
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
      resolved = value; reviewedStamp = stamp(); validationIssues = []; pendingValidationFocus = false; editor = clone(value.conditions.agents); error = false; message = 'Validated. Review the starting state of both agents below.'; rawDirty = false; rawCompleteMode = false; render();
      return value;
    } catch (reason) { if (ownGeneration === generation) { reviewedStamp = null; const errors = Array.isArray(reason.details) ? reason.details : reason.details?.errors || [];
      validationIssues = input === draft ? [...errors, ...(reason.details?.path ? [{ path: reason.details.path }] : [])].flatMap(item => { const match = /^\$\.(?:custom|agents)\.(Alice|Bob)\.(.+)$/.exec(item.path || ''); return match ? [{ owner: match[1], path: match[2] }] : []; }) : [];
      pendingValidationFocus = validationIssues.length > 0;
      const firstOwner = validationIssues[0]?.owner; if (firstOwner && role !== firstOwner) { role = firstOwner; render(); }
      announce(reason.message + (reason.details?.path ? ' · ' + reason.details.path : '') + errors.slice(0, 6).map(item => ' · ' + item.path + ': ' + item.message).join(''), true);
    } }
    finally { if (ownGeneration === generation) { busy = false; updateControls(); if (pendingValidationFocus) { applyValidationIssues({ focus: true }); pendingValidationFocus = false; } } }
  }
  function adoptDefault(value) {
    savedDefault = value;
    savedHash = null;
    draft = value?.conditions ? clone(value.conditions) : starterDraft(catalog?.presets.find(item => item.id === catalog.defaultPresetId));
    resolved = null;
    reviewedStamp = null;
    editor = {};
    rawDirty = false;
    rawBuffer = '';
    rawCompleteMode = false;
    validationIssues = [];
    pendingValidationFocus = false;
    for (const owner of Object.keys(extensionDrafts)) extensionDrafts[owner] = {};
  }
  async function load({ force = false } = {}) {
    if (!isResearcher() || busy || savedDefault && !force) return;
    const ownGeneration = ++generation;
    busy = true;
    message = '';
    error = false;
    render();
    try {
      const [catalogResult, defaultResult] = await Promise.allSettled([
        api('/api/conditions/catalog', { auth: false }),
        api('/api/admin/conditions/default')
      ]);
      if (ownGeneration !== generation) return;
      if (catalogResult.status === 'rejected') throw catalogResult.reason;
      if (defaultResult.status === 'rejected') throw defaultResult.reason;
      catalog = catalogResult.value;
      const value = defaultResult.value;
      adoptDefault(value);
      render();
      const reviewed = await resolve({ quiet: true });
      if (reviewed && savedDefault === value && value.conditions) {
        savedHash = reviewed.hash;
        updateControls();
      }
    } catch (reason) {
      if (ownGeneration !== generation) return;
      busy = false;
      message = reason.message;
      error = true;
      render();
    }
  }
  async function applyDefault(reset) {
    if (!isResearcher() || busy || !savedDefault || !reset && !ready()) return;
    const ownGeneration = ++generation;
    busy = true;
    announce(reset ? 'Restoring the built-in default…' : 'Saving the demo default…');
    try {
      const value = await api('/api/admin/conditions/default', { method: 'PUT',
        body: { expectedRevision: savedDefault.revision, initialConditions: reset ? null : clone(resolved.conditions) } });
      if (ownGeneration !== generation) return;
      if (reset) {
        adoptDefault(value);
        render();
        const reviewed = await resolve({ quiet: true });
        if (reviewed && savedDefault === value) announce('Restored the built-in default for new demos.');
      } else {
        savedDefault = value;
        savedHash = resolved.hash;
        announce('Saved the default for new demos.');
        render();
      }
    } catch (reason) {
      if (ownGeneration === generation) announce(reason.message, true);
    } finally {
      if (ownGeneration === generation) { busy = false; updateControls(); }
    }
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
    const ownAuthorization = authorizationGeneration;
    try {
      const result = await api('/api/admin/conditions');
      if (ownAuthorization !== authorizationGeneration) return;
      bundles = array(result.bundles);
      render();
    } catch (reason) {
      if (ownAuthorization === authorizationGeneration) announce(reason.message, true);
    }
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
    rawDirty = false; rawBuffer = ''; rawCompleteMode = false; invalidate(); resolve({ input: next, adopt: true });
  }
  function bind() {
    container.addEventListener('toggle', event => {
      if (event.currentTarget === container && event.target.matches('details[data-conditions-disclosure]')) disclosureState.set(event.target.dataset.conditionsDisclosure, event.target.open);
    }, true);
    container.addEventListener('input', event => {
      const node = event.target;
      if (node.dataset.conditionsExtensionInput) { extensionDrafts[node.dataset.owner][node.dataset.conditionsExtensionInput] = node.value; return; }
      if (node.matches('[data-conditions-bundle-name]')) { bundleName = node.value; const save = query('[data-conditions-action="save-bundle"]'); if (save) save.textContent = bundles.some(bundle => bundle.name === bundleName.trim()) ? 'Save next bundle revision' : 'Save validated bundle'; }
      if (node.matches('[data-conditions-json]')) { rawDirty = true; rawBuffer = node.value; invalidate(); return; }
      if (node.dataset.conditionsPath && node.type !== 'checkbox' && node.tagName !== 'SELECT') commitPath(node.dataset.owner, node.dataset.conditionsPath, node.dataset.valueType === 'number' ? Number(node.value) : node.dataset.valueType === 'csv' ? node.value.split(',').map(item => item.trim()).filter(Boolean) : node.value);
      if (node.dataset.conditionsRowPath && node.tagName !== 'SELECT') commitRowValue(node);
    });
    container.addEventListener('change', async event => {
      const node = event.target;
      if (node.matches('[data-conditions-bundle]')) { selectedBundleId = node.value; const bundle = bundles.find(item => item.id === selectedBundleId); if (bundle) { bundleName = bundle.name; query('[data-conditions-bundle-name]').value = bundleName; } return; }
      if (node.matches('[data-conditions-import]')) { try { const file = node.files?.[0]; if (!file) return; if (file.size > 4 * 1024 * 1024) throw new Error('Fixture files must be at most 4 MiB; their compact JSON request must fit within 256 KiB.'); adoptInput(JSON.parse(await file.text())); } catch (reason) { announce('Import error: ' + reason.message, true); } return; }
      if (node.dataset.conditionsPreset) { const preset = catalog.presets.find(item => item.id === node.dataset.conditionsPreset); draft = starterDraft(preset); rawDirty = false; rawCompleteMode = false; resolved = null; editor = {}; invalidate(); render(); resolve(); return; }
      if (node.dataset.conditionsComponent) { const owner = node.dataset.owner; if (owner === 'Bob' && !isResearcher()) return; const component = catalog.components.find(item => item.id === node.dataset.conditionsComponent); draft.componentIds[owner] = array(draft.componentIds[owner]).filter(id => catalog.components.find(component => component.id === id)?.category !== node.dataset.category); draft.componentIds[owner].push(node.dataset.conditionsComponent); if (draft.agents) draft.agents[owner][component.category] = clone(component.patch[component.category]);
        if (component.category === 'skills') { const skills = draft.agents ? component.patch.skills : draft.custom?.[owner]?.skills || component.patch.skills; if (draft.agents && component.patch.skillDefinitions) draft.agents[owner].skillDefinitions = clone(component.patch.skillDefinitions); else if (draft.agents?.[owner]?.skillDefinitions) draft.agents[owner].skillDefinitions = draft.agents[owner].skillDefinitions.filter(item => skills.includes(item.id)); if (draft.custom?.[owner]?.skillDefinitions) draft.custom[owner].skillDefinitions = draft.custom[owner].skillDefinitions.filter(item => skills.includes(item.id)); }
        invalidate(); resolve(); return; }
      if (node.dataset.conditionsPath && (node.type === 'checkbox' || node.tagName === 'SELECT')) commitPath(node.dataset.owner, node.dataset.conditionsPath, node.dataset.valueType === 'boolean' ? node.checked : node.value);
      if (node.dataset.conditionsRowPath && node.tagName === 'SELECT') commitRowValue(node);
      if (node.dataset.conditionsSkill) { const skills = [...container.querySelectorAll('[data-conditions-skill]:checked')].filter(input => input.dataset.owner === node.dataset.owner).map(input => input.dataset.conditionsSkill); commitPath(node.dataset.owner, 'skills', skills); if (editor[node.dataset.owner]?.skillDefinitions) { commitPath(node.dataset.owner, 'skillDefinitions', array(editor[node.dataset.owner].skillDefinitions).filter(item => skills.includes(item.id))); render(); } }
      if (node.dataset.conditionsAuthField) commitPath(node.dataset.owner, 'authorization.fields', [...container.querySelectorAll('[data-conditions-auth-field]:checked')].filter(input => input.dataset.owner === node.dataset.owner).map(input => input.dataset.conditionsAuthField));
    });
    container.addEventListener('click', async event => {
      const roleButton = event.target.closest('[data-conditions-role]');
      if (roleButton) {
        role = roleButton.dataset.conditionsRole;
        render();
        query('[data-conditions-role="' + role + '"]')?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest('[data-conditions-action]'); if (!button || button.disabled) return;
      const action = button.dataset.conditionsAction;
      if (action === 'edit-category') { event.preventDefault(); openCustomEditor(button.dataset.category); return; }
      if (action === 'reload' || action === 'reload-default') { load({ force: true }); return; }
      if (action === 'save-default' || action === 'reset-default') { applyDefault(action === 'reset-default'); return; }
      if (action === 'validate') { resolve(); return; }
      if (action === 'refresh-bundles') { refreshBundles(); return; }
      if (action === 'load-bundle') { const bundle = bundles.find(item => item.id === selectedBundleId); if (!bundle) { announce('Choose a saved researcher bundle first.', true); return; } adoptInput(bundle.conditions); return; }
      if (action === 'download') { if (!resolved || reviewedStamp !== stamp() || rawDirty) return; const url = URL.createObjectURL(new Blob([JSON.stringify(resolved.conditions, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'agent-initial-conditions.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
      if (action === 'save-bundle') {
        if (!isResearcher() || !resolved || reviewedStamp !== stamp() || rawDirty || busy) return;
        const existing = bundles.find(bundle => bundle.name === bundleName.trim()), ownAuthorization = authorizationGeneration; busy = true; updateControls();
        try { const result = await api('/api/admin/conditions', { method: 'POST', body: { name: bundleName.trim(), input: clone(resolved.conditions), ...(existing ? { expectedRevision: existing.revision } : {}) } }); if (ownAuthorization !== authorizationGeneration) return; bundles = array(result.bundles); selectedBundleId = result.bundle?.id || ''; announce('Saved researcher bundle ' + result.bundle?.name + ' · revision ' + result.bundle?.revision + '.'); render(); }
        catch (reason) { if (ownAuthorization === authorizationGeneration) announce(reason.message, true); }
        finally { if (ownAuthorization === authorizationGeneration) { busy = false; updateControls(); } } return;
      }
      if (action === 'discard-json') { rawDirty = false; rawBuffer = ''; rawCompleteMode = false; invalidate(); render(); return; }
      if (action === 'parse-json') {
        try { const value = JSON.parse(query('[data-conditions-json]').value); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['Alice', 'Bob'].includes(key))) throw new Error('Use an object containing Alice and / or Bob profile definitions.'); if (Object.prototype.hasOwnProperty.call(value, 'Bob') && !isResearcher()) throw new Error('Bob customization requires researcher sign-in.'); const next = rawCompleteMode ? { ...clone(resolved.conditions), presetId: draft.presetId, componentIds: clone(draft.componentIds), agents: { ...clone(editor), ...value } } : clone(draft); if (!rawCompleteMode) { if (next.agents) next.agents = { ...next.agents, ...value }; else next.custom = isResearcher() ? value : { ...next.custom, Alice: value.Alice || {} }; } rawDirty = false; rawBuffer = ''; rawCompleteMode = false; invalidate(); resolve({ input: next, adopt: true }); } catch (reason) { announce('Definition error: ' + reason.message, true); } return;
      }
      const owner = button.dataset.owner; if (owner === 'Bob' && !isResearcher() || busy || rawDirty) return;
      if (action === 'edit-brief-json') {
        if (!resolved) return; rawCompleteMode = true; rawBuffer = JSON.stringify(isResearcher() ? editor : { Alice: editor.Alice }, null, 2); rawDirty = true; invalidate(); render();
        const textarea = query('[data-conditions-json]'); for (let node = textarea?.parentElement; node && node !== container; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
        textarea?.focus(); const location = rawBuffer.lastIndexOf('"brief":'); if (location >= 0) textarea?.setSelectionRange(location, location + 7); textarea?.scrollIntoView({ block: 'center', behavior: 'auto' }); rememberDisclosures(); return;
      }
      if (action === 'add-skill') {
        const buffer = extensionDrafts[owner], id = (buffer.skillId || '').trim(), label = (buffer.skillLabel || id).trim();
        if (!id || !label) { announce('Enter a skill ID and readable label.', true); return; }
        if (array(editor[owner].skillDefinitions).some(item => item.id === id)) { announce('This skill already has guidance. Edit its existing entry.', true); return; }
        const definitions = [...array(editor[owner].skillDefinitions), { id, label, description: buffer.skillDescription || '' }];
        commitPath(owner, 'skills', [...new Set([...array(editor[owner].skills), id])]); commitPath(owner, 'skillDefinitions', definitions); buffer.skillId = ''; buffer.skillLabel = ''; buffer.skillDescription = ''; render(); openCustomEditor('skills');
        const added = [...container.querySelectorAll('[data-conditions-row-details="skillDefinitions"]')].find(node => Number(node.dataset.index) === definitions.length - 1); for (let node = added; node && node !== container; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true; added?.querySelector('input')?.focus(); rememberDisclosures(); return;
      }
      if (action === 'add-auth-field') { const id = (extensionDrafts[owner].authField || '').trim(); if (!id) { announce('Enter a custom sharing field.', true); return; } commitPath(owner, 'authorization.fields', [...new Set([...array(editor[owner].authorization?.fields), id])]); extensionDrafts[owner].authField = ''; render(); openCustomEditor('authorization'); return; }
      if (action === 'clear-custom') { delete draft.custom[owner]; invalidate(); resolve(); return; }
      if (action === 'add-row' || action === 'remove-row') {
        const path = button.dataset.path, rows = clone(array(getPath(editor[owner], path)));
        if (action === 'add-row') { rows.push(JSON.parse(button.dataset.template)); rememberDisclosures(); container.querySelectorAll('[data-conditions-row-details]').forEach(node => { if (node.dataset.conditionsRowDetails === path) disclosureState.set(node.dataset.conditionsDisclosure, false); }); disclosureState.set('row-' + owner + '-' + path + '-' + (rows.length - 1), true); }
        else { const [removed] = rows.splice(Number(button.dataset.index), 1); if (path === 'kg.nodes') commitPath(owner, 'kg.edges', array(editor[owner].kg?.edges).filter(edge => edge.source !== removed.id && edge.target !== removed.id)); if (path === 'skillDefinitions' && !isRegisteredSkill(removed.id)) commitPath(owner, 'skills', array(editor[owner].skills).filter(id => id !== removed.id)); }
        commitPath(owner, path, rows); const open = query('.custom-condition-editor')?.open; render(); if (open) query('.custom-condition-editor').open = true;
        if (action === 'add-row') {
          const added = [...container.querySelectorAll('[data-conditions-row-details]')].find(node => node.dataset.conditionsRowDetails === path && Number(node.dataset.index) === rows.length - 1);
          for (let node = added; node && node !== container; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
          rememberDisclosures();
        }
      }
    });
  }
  return {
    load,
    attach(next) { if (container !== next) { rememberDisclosures(); container = next; bind(); } render(); },
    authorizationChanged() {
      authorizationGeneration++;
      if (!isResearcher()) {
        generation++;
        adoptDefault(null);
        catalog = null;
        busy = false;
        message = '';
        error = false;
        bundles = [];
        bundleName = '';
        selectedBundleId = '';
        role = 'Alice';
        container?.replaceChildren();
        disclosureState.clear();
        disclosureState.set('composition', true);
      }
      render();
      if (isResearcher()) refreshBundles();
    }
  };
}
