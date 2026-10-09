import { mountAgentStates } from './agent-state.js';
import { renderAnswerComparisonHtml, UNDERSTANDING_QUESTIONS } from './understanding.js';
import { renderOntologyHtml } from './ontology-ui.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const array = value => Array.isArray(value) ? value : [];
const contexts = new WeakMap();
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString(); };
const pretty = value => value === undefined ? '<p class="muted">Not recorded</p>' : '<pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
export const researchQualityLabel = value => Array.isArray(value) ? value.length ? value.map(item => String(item).replaceAll('_', ' ')).join(', ') : 'No quality flags' : typeof value === 'string' ? value : value?.status || value?.label || JSON.stringify(value ?? {});
const eventData = event => event?.data && typeof event.data === 'object' ? event.data : event || {};
const runOutcome = run => array(run.trace).at(-1)?.snapshot?.task?.outcome || eventData(array(run.events).findLast(event => (event.kind || event.type) === 'stage' && eventData(event).stage === 'complete')).status || 'Not recorded';
const received = (snapshot, direction) => array(snapshot?.receipts?.[direction]).filter(receipt => receipt.status === 'received');
const eventTitles = { initialized: 'Round initialized', ontology_negotiated: 'Task ontology negotiated', ontology_decision: 'Ontology interpretation decided', choice: 'Sharing decision', request: 'Sharing requested', delivery: 'Confirmed delivery', prediction: 'Understanding answer recorded', understanding: 'Understanding answer recorded', admin_intervention: 'Researcher intervention', technical: 'Technical issue recorded', config_changed: 'Configuration updated', stage: 'Round progress', closed: 'Round closed', checkpoint: 'State recorded' };
const eventTitle = kind => eventTitles[kind] || String(kind || 'Recorded event').replaceAll('_', ' ');
function icon(kind) {
  const paths = {
    runs: '<rect x="5" y="7" width="22" height="22" rx="4"/><path d="M11 3v8m10-8v8M5 15h22m-16 5h3m5 0h2m-10 5h3"/>',
    outcome: '<circle cx="16" cy="16" r="12"/><path d="m10 16 4 4 8-9"/>',
    closed: '<path d="M8 27h16V5H8zm4-9 3 3 6-7"/>',
    waiting: '<circle cx="16" cy="16" r="12"/><path d="M16 8v9l6 3"/>',
    event: '<path d="M5 16h7l3-8 4 16 3-8h5"/>',
    person: '<circle cx="16" cy="10" r="5"/><path d="M6 28v-4a10 10 0 0 1 20 0v4"/>',
    knowledge: '<circle cx="7" cy="16" r="4"/><circle cx="24" cy="7" r="4"/><circle cx="24" cy="25" r="4"/><path d="m11 14 9-5m-9 9 9 5"/>',
    data: '<rect x="5" y="5" width="22" height="23" rx="4"/><path d="M5 13h22m-14 0v15m7-15v15"/>',
    skills: '<path d="m18 3-12 16h9l-1 10 12-17h-9Z"/>',
    authorization: '<path d="m16 3 11 5v9c0 6-11 12-11 12S5 23 5 17V8Z"/><path d="m11 16 3 3 7-7"/>'
  };
  return '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[kind] || paths.event) + '</svg>';
}
function disclosure(id, title, hint, content, classes = '') {
  return '<details class="research-disclosure ' + classes + '" data-disclosure-id="' + escapeHtml(id) + '"><summary><span><strong>' + title + '</strong>' + (hint ? '<small>' + hint + '</small>' : '') + '</span></summary><div class="research-disclosure-body">' + content + '</div></details>';
}
function remember(context) {
  context.container.querySelectorAll('details[data-disclosure-id]').forEach(node => context.disclosures.set(node.dataset.disclosureId, node.open));
}
function restore(context) {
  context.container.querySelectorAll('details[data-disclosure-id]').forEach(node => { if (context.disclosures.has(node.dataset.disclosureId)) node.open = context.disclosures.get(node.dataset.disclosureId); });
}
function focusedControl(container) {
  const active = container.ownerDocument.activeElement;
  if (!container.contains(active)) return null;
  for (const attribute of ['data-research-filter', 'data-research-run', 'data-research-action', 'data-research-clear-filters']) {
    if (active.hasAttribute(attribute)) return { attribute, value: active.getAttribute(attribute) };
  }
  return null;
}
function restoreFocus(container, focus) {
  if (!focus) return;
  const control = [...container.querySelectorAll('[' + focus.attribute + ']')].find(node => node.getAttribute(focus.attribute) === focus.value);
  control?.focus({ preventScroll: true });
}
function qualityWarning(run) {
  const quality = researchQualityLabel(run.quality);
  if (quality === 'No quality flags') return '';
  const failed = array(run.quality).includes('trace_integrity_failed') || run.quality?.trace_integrity_failed === true || /trace[_ ]integrity[_ ]failed/.test(quality);
  return '<div class="notice warning research-quality-warning" role="status"><strong>' + (failed ? 'Trace integrity failed · retained history may be incomplete' : 'Recorded quality flags') + '</strong><small>' + escapeHtml(quality) + '</small></div>';
}
function recordCard(run, selected, modeLabel) {
  const flagged = researchQualityLabel(run.quality) !== 'No quality flags';
  return '<button class="research-run-card ' + (selected ? 'selected' : '') + '" data-research-run="' + escapeHtml(run.runId) + '" aria-pressed="' + selected + '"><span class="research-run-heading"><strong>' + escapeHtml(modeLabel(run.mode)) + '</strong><span class="tag ' + (flagged ? 'warn' : '') + '">' + escapeHtml(run.status) + '</span></span><span class="research-run-date">' + escapeHtml(dateLabel(run.startedAt)) + '</span><span class="research-run-outcome">' + escapeHtml(runOutcome(run)) + '</span><small>' + array(run.events).length + ' events · ' + array(run.trace).length + ' snapshots</small><small class="mono" title="' + escapeHtml(run.runId) + '">' + escapeHtml(String(run.runId).slice(0, 12)) + '</small>' + (flagged ? '<small class="research-run-flag">' + escapeHtml(researchQualityLabel(run.quality)) + '</small>' : '') + '</button>';
}
function eventHtml(event, includeHeading = true) {
  const data = eventData(event), kind = event?.kind || event?.type;
  const scopeWindow = data.window ?? data.timeWindow ?? data.time_window;
  const question = UNDERSTANDING_QUESTIONS.find(question => question.id === data.questionId);
  const keys = ({ choice: ['choice', 'fields', 'window'], request: ['recipient', 'fields', 'window'], delivery: ['recipient', 'fields', 'window'], prediction: ['questionId', 'answer'], understanding: ['questionId', 'answer'], admin_intervention: ['action', 'actor'], technical: ['code', 'reason'], stage: ['stage', 'status'], config_changed: [] })[kind] || ['choice', 'recipient', 'fields', 'window', 'action', 'code', 'status'];
  const labels = { choice: 'Choice', fields: 'Fields', window: 'Time window', recipient: 'Recipient', questionId: 'Question', answer: 'Original answer', action: 'Action', actor: 'Actor', code: 'Code', reason: 'Reason', stage: 'Stage', status: 'Status' };
  const values = keys.filter(key => key === 'window' ? scopeWindow != null : Object.hasOwn(data, key) && data[key] != null).map(key => {
    let value = key === 'window' ? scopeWindow : data[key];
    if (key === 'questionId' && question) value = question.shortTitle;
    if (key === 'answer' && question) value = question.options.find(option => option.value === value)?.label || value;
    return [labels[key], Array.isArray(value) ? value.join(', ') || 'None' : value];
  });
  return (includeHeading ? '<strong>' + escapeHtml(eventTitle(kind)) + '</strong>' : '') + (values.length ? '<small>' + values.map(([label, value]) => '<span>' + label + '</span>: ' + escapeHtml(value)).join(' · ') + '</small>' : '');
}
function stateChanges(before = {}, after = {}) {
  return ['Alice', 'Bob'].map(role => {
    const previous = before[role] || {}, current = after[role] || {};
    const previousNodes = new Map(array(previous.kg?.nodes).map(node => [node.id, node])), currentNodes = new Map(array(current.kg?.nodes).map(node => [node.id, node]));
    const added = [...currentNodes.values()].filter(node => !previousNodes.has(node.id)), removed = [...previousNodes.values()].filter(node => !currentNodes.has(node.id));
    const updated = [...currentNodes.values()].filter(node => previousNodes.has(node.id) && JSON.stringify(node) !== JSON.stringify(previousNodes.get(node.id)));
    const categories = [['knowledge', 'Knowledge', added.length || removed.length || updated.length || JSON.stringify(previous.kg?.edges) !== JSON.stringify(current.kg?.edges)], ['skills', 'Skills', JSON.stringify(previous.skills) !== JSON.stringify(current.skills)], ['data', 'Data', JSON.stringify(previous.data) !== JSON.stringify(current.data)], ['authorization', 'Sharing', JSON.stringify(previous.authorization) !== JSON.stringify(current.authorization)]];
    return { role, added, removed, updated, categories, previous, current };
  });
}
function changeHtml(previous, snapshot, id) {
  if (!previous) return '<p class="muted">Initial snapshot · the starting conditions for this recorded run.</p>';
  const changes = stateChanges(previous.agentStates, snapshot.agentStates);
  const names = values => values.map(node => node.label || node.id).join(', ');
  const rows = [];
  for (const change of changes) {
    for (const [label, nodes] of [['Added facts', change.added], ['Removed facts', change.removed], ['Updated facts', change.updated]]) if (nodes.length) rows.push([change.role, label, names(nodes)]);
    for (const [category, label, changed] of change.categories) if (changed && category !== 'knowledge') rows.push([change.role, label, category === 'skills' ? array(change.current.skills).filter(skill => skill.enabled !== false).map(skill => skill.label || skill.id).join(', ') || 'No enabled skills' : category === 'authorization' ? change.current.authorization?.summary || change.current.authorization?.status || 'Not recorded' : array(change.current.data).map(item => (item.label || item.id) + ' · ' + (item.count ?? array(item.items).length) + ' items').join('; ')]);
    if (JSON.stringify(change.previous.kg?.edges) !== JSON.stringify(change.current.kg?.edges)) rows.push([change.role, 'Relationships changed', array(change.current.kg?.edges).length + ' current relations']);
  }
  const cards = '<div class="research-change-grid">' + changes.map(change => '<article class="research-change-card" data-research-agent="' + change.role + '"><strong>' + change.role + '</strong><div class="research-fact-delta"><span class="added">+' + change.added.length + '</span><span class="removed">−' + change.removed.length + '</span><span class="updated">~' + change.updated.length + '</span><small>Added / removed / updated facts</small></div><div class="research-change-categories">' + change.categories.map(([category, label, changed]) => '<span class="' + (changed ? 'changed' : '') + '" data-category="' + category + '">' + icon(category) + '<small>' + label + '</small><span class="sr-only">' + (changed ? 'Changed' : 'Unchanged') + '</span></span>').join('') + '</div></article>').join('') + '</div>';
  const detail = rows.length ? '<div class="table-wrap"><table><thead><tr><th scope="col">Agent</th><th scope="col">Change</th><th scope="col">Details</th></tr></thead><tbody>' + rows.map(([role, label, value]) => '<tr><td>' + role + '</td><td>' + label + '</td><td>' + escapeHtml(value) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No knowledge, data, skills or authorization changes at this step. The event remains part of the recorded timeline.</p>';
  return cards + disclosure(id + '-changes', 'Inspect the recorded changes', 'Exact changed facts and state categories', detail);
}
function deliveryHtml(snapshot, id) {
  const alice = received(snapshot, 'aliceToBob'), bob = received(snapshot, 'bobToAlice');
  const flow = '<div class="research-delivery-flow" role="img" aria-label="' + alice.length + ' confirmed deliveries to Bob and ' + bob.length + ' confirmed deliveries to Alice"><span class="research-flow-agent alice">' + icon('person') + '<strong>Alice</strong></span><div class="research-flow-counts"><span class="alice-to-bob">' + alice.length + ' to Bob <span aria-hidden="true">→</span></span><span class="bob-to-alice"><span aria-hidden="true">←</span> ' + bob.length + ' to Alice</span></div><span class="research-flow-agent bob">' + icon('person') + '<strong>Bob</strong></span></div>';
  const receipts = [...alice.map(receipt => ({ direction: 'Alice → Bob', receipt })), ...bob.map(receipt => ({ direction: 'Bob → Alice', receipt }))];
  const content = receipts.length ? receipts.map(({ direction, receipt }, index) => disclosure(id + '-receipt-' + index, escapeHtml(direction), escapeHtml(array(receipt.fields).join(', ') || 'None'), '<dl class="definition-list"><dt>Received at</dt><dd>' + escapeHtml(dateLabel(receipt.receivedAt)) + '</dd><dt>Operation</dt><dd class="mono">' + escapeHtml(receipt.operationId) + '</dd></dl>' + pretty(receipt))).join('') : '<p class="muted">No confirmed deliveries at this step.</p>';
  return '<section class="research-delivery-summary"><h4>Confirmed deliveries at this step</h4>' + flow + disclosure(id + '-deliveries', 'Inspect delivered information', 'Exact fields, values and receipts', content) + '</section>';
}
function renderReplay(context, run) {
  const holder = context.container.querySelector('#research-agent-replay'), trace = array(run.trace), id = 'research-' + run.runId;
  if (!holder) return;
  if (!trace.length) { holder.innerHTML = '<section class="panel"><h3>Step-by-step review</h3><p class="empty">This older run has no stored agent snapshots. Its original events remain available below.</p></section>'; return; }
  context.step = Math.max(0, Math.min(Number(context.step) || 0, trace.length - 1));
  holder.innerHTML = '<section class="panel research-replay"><div class="panel-heading"><div><h3>Step-by-step review</h3><small>' + trace.length + ' stored snapshots</small></div><span class="tag">Read-only historical state</span></div><div class="replay-controls"><button class="button" data-trace-move="-1">Previous</button><label class="field trace-slider"><span data-trace-position></span><input type="range" min="0" max="' + (trace.length - 1) + '" value="' + context.step + '" step="1" aria-label="Recorded snapshot step" data-trace-slider></label><button class="button" data-trace-move="1">Next</button><button class="button" data-trace-latest>Latest</button></div><div data-trace-event></div><div data-trace-diff></div><div data-trace-ontology></div><div data-trace-states></div><div data-trace-evidence></div></section>';
  context.renderStep = ({ rememberState = true } = {}) => {
    if (rememberState) remember(context);
    const step = trace[context.step], previous = trace[context.step - 1]?.snapshot, snapshot = step.snapshot || {};
    const events = array(run.events).filter(event => step.eventSeq != null && (event.seq === step.eventSeq || event.eventSeq === step.eventSeq));
    holder.querySelector('[data-trace-position]').textContent = 'Step ' + (context.step + 1) + ' of ' + trace.length + ' · sequence ' + (step.seq ?? context.step);
    holder.querySelector('[data-trace-slider]').value = context.step;
    holder.querySelector('[data-trace-move="-1"]').disabled = context.step === 0;
    holder.querySelector('[data-trace-move="1"]').disabled = context.step === trace.length - 1;
    holder.querySelector('[data-trace-latest]').disabled = context.step === trace.length - 1;
    holder.querySelector('[data-trace-event]').innerHTML = '<article class="research-current-event"><span class="research-event-icon">' + icon('event') + '</span><div><div class="panel-heading"><strong>' + escapeHtml(eventTitle(step.kind)) + '</strong><small>' + escapeHtml(dateLabel(step.at)) + '</small></div>' + (events.length ? '<ul class="timeline-event-list">' + events.map(event => '<li>' + eventHtml(event, eventTitle(event.kind || event.type) !== eventTitle(step.kind)) + '</li>').join('') + '<small>Original event details remain available in the evidence below.</small>' : '<small>Agent snapshot at this point in the recorded run.</small>') + '</div></article><div class="research-step-result"><div><small>Task result at this step</small><strong>' + escapeHtml(snapshot.task?.outcome || 'Pending') + '</strong>' + (snapshot.task?.meeting ? '<small>' + escapeHtml([snapshot.task.meeting.day, snapshot.task.meeting.time].filter(Boolean).join(' · ')) + '</small>' : '') + '</div><div><small>Recorded stage</small><strong>' + escapeHtml(snapshot.stage || 'Not recorded') + '</strong></div></div>' + deliveryHtml(snapshot, id);
    holder.querySelector('[data-trace-diff]').innerHTML = '<div class="trace-diff"><h4>Changes since the previous snapshot</h4>' + changeHtml(previous, snapshot, id) + '</div>';
    const historicalSession = { mode: run.mode, ended: true, stage: snapshot.stage };
    holder.querySelector('[data-trace-ontology]').innerHTML = (snapshot.ontology ? disclosure(id + '-ontology', 'Recorded task ontology', 'Accepted rules, owner interpretation and verified dialogue at this step', renderOntologyHtml({ ...snapshot, session: historicalSession })) : '') + (snapshot.briefOntology ? disclosure(id + '-brief-ontology', 'Recorded context ontology', 'Separate task module after Bob’s owner decision', renderOntologyHtml({ ...snapshot, ontology: snapshot.briefOntology, session: historicalSession })) : '');
    holder.querySelector('[data-trace-states]').innerHTML = ['Alice', 'Bob'].map(role => disclosure(id + '-' + role, role === 'Alice' ? 'Inside Alice at this step' : 'Inside Bob at this step', role === 'Alice' ? 'Your agent’s knowledge, capabilities and sharing state' : 'Peer agent’s knowledge, capabilities and sharing state', '<div data-research-state-holder="' + role + '"></div>', 'research-agent-detail')).join('');
    for (const role of ['Alice', 'Bob']) mountAgentStates(holder.querySelector('[data-research-state-holder="' + role + '"]'), snapshot.agentStates?.[role] ? { [role]: snapshot.agentStates[role] } : null, { scope: id + ':' + role, heading: role + ' at this step', description: 'Exact historical state from this stored snapshot.' });
    holder.querySelector('[data-trace-evidence]').innerHTML = disclosure(id + '-snapshot', 'Current snapshot & event evidence', 'Recorded values, identifiers and hash chain', pretty({ step, events }));
    restore(context);
  };
  context.renderStep({ rememberState: false });
}
function render(context) {
  const focus = focusedControl(context.container);
  remember(context);
  const { research, modeLabel = value => value } = context.options;
  if (!research) { context.container.innerHTML = '<section class="panel loading">Loading actual consented research runs…</section>'; return; }
  // Sort a copy: the just-completed round is easy to find without changing
  // stored/exported history or an explicitly selected round and replay step.
  const all = array(research.runs).slice().reverse().sort((left, right) => (Date.parse(right.startedAt) || 0) - (Date.parse(left.startedAt) || 0)), summary = research.summary || {}, filters = context.filters;
  const filtered = all.filter(run => (filters.mode === 'all' || run.mode === filters.mode) && (filters.status === 'all' || run.status === filters.status) && (filters.quality === 'all' || researchQualityLabel(run.quality) === filters.quality));
  const selectedRunId = filtered.some(run => run.runId === context.selectedRunId) ? context.selectedRunId : filtered[0]?.runId;
  if (context.selectedRunId !== selectedRunId) context.step = 0;
  context.selectedRunId = selectedRunId;
  context.filteredRunIds = filtered.map(run => run.runId);
  const selected = filtered.find(run => run.runId === selectedRunId);
  const counts = [...new Set(filtered.map(run => run.mode))].map(mode => ({ mode, count: filtered.filter(run => run.mode === mode).length })), max = Math.max(1, ...counts.map(item => item.count));
  const optionList = (key, values, label) => '<label class="field"><span>' + label + '</span><select data-research-filter="' + key + '"><option value="all">All</option>' + [...new Set(values)].sort().map(value => '<option value="' + escapeHtml(value) + '" ' + (filters[key] === value ? 'selected' : '') + '>' + escapeHtml(key === 'mode' ? modeLabel(value) : value) + '</option>').join('') + '</select></label>';
  const totals = [['runs', 'Recorded runs', summary.runs ?? all.length], ['outcome', 'Task outcomes', summary.taskCompleted], ['closed', 'Closed completed', summary.completed], ['waiting', 'Awaiting end', summary.runsPendingClose]];
  const controls = '<div class="form-grid">' + optionList('mode', all.map(run => run.mode), 'Mode') + optionList('status', all.map(run => run.status), 'Status') + optionList('quality', all.map(run => researchQualityLabel(run.quality)), 'Quality') + '</div><div class="toolbar section-actions"><button class="button" data-research-action="csv">Export CSV</button><button class="button" data-research-action="jsonl">Export JSONL</button></div><small>Exports contain actual consented records and original recorded values.</small>';
  const records = filtered.length ? '<div class="research-run-list">' + filtered.slice(0, 4).map(run => recordCard(run, run.runId === selectedRunId, modeLabel)).join('') + '</div>' + (filtered.length > 4 ? disclosure('research-more-runs', 'More recorded rounds', String(filtered.length - 4), '<div class="research-run-list">' + filtered.slice(4).map(run => recordCard(run, run.runId === selectedRunId, modeLabel)).join('') + '</div>') : '') : all.length ? '<p class="empty">No actual consented runs match these filters. No sample measurements are inserted.</p><button class="button" data-research-clear-filters>Clear filters</button>' : '<p class="empty">No research records yet. Start a round with research recording enabled, then refresh here. Rounds without consent and replay are not recorded.</p>';
  context.container.innerHTML = '<div class="research-review"><div class="panel-heading"><div><h2>Research review</h2><small>Actual consented records only · calendar data is fictional</small></div><button class="button" data-research-action="refresh">Refresh records</button></div><section class="panel research-overview"><div class="research-summary-grid">' + totals.map(([kind, label, value]) => '<article class="research-summary-card" data-summary-kind="' + kind + '"><span>' + icon(kind) + '</span><div><strong>' + escapeHtml(value ?? '—') + '</strong><small>' + label + '</small></div></article>').join('') + '</div>' + (summary.affectedByTechnical ? '<p class="notice warning">' + summary.affectedByTechnical + ' runs affected by technical issues</p>' : '') + '<div class="research-mode-chart" aria-label="Counts from actual filtered records">' + counts.map(item => '<div class="research-mode-row"><span>' + escapeHtml(modeLabel(item.mode)) + '</span><div class="research-mode-track"><span data-mode="' + escapeHtml(item.mode) + '" style="width:' + item.count / max * 100 + '%"></span></div><strong>' + item.count + '</strong></div>').join('') + '</div>' + disclosure('research-filters', 'Filter or export records', 'Mode, status, quality & original data', controls) + '</section><section class="panel research-record-picker"><div class="panel-heading"><h3>Choose a recorded round</h3><span class="tag">' + filtered.length + ' matching records</span></div>' + records + '</section>' + (selected ? '<section class="panel research-selected"><div class="panel-heading"><div><p class="eyebrow">Selected recorded round</p><h3>' + escapeHtml(modeLabel(selected.mode)) + '</h3><small>' + escapeHtml(dateLabel(selected.startedAt)) + '</small></div><span class="research-outcome-tag">' + escapeHtml(runOutcome(selected)) + '</span></div>' + qualityWarning(selected) + renderAnswerComparisonHtml(array(selected.events)) + '</section><div id="research-agent-replay"></div><section class="research-record-evidence">' + selectedEvidence(selected) + '</section>' : '') + '</div>';
  context.renderStep = null;
  if (selected) renderReplay(context, selected);
  restore(context);
  restoreFocus(context.container, focus);
}
function selectedEvidence(run) {
  const id = 'research-' + run.runId, metadata = { ...run };
  delete metadata.trace; delete metadata.events; delete metadata.initialConditions;
  return disclosure(id + '-technical', 'Record quality & configuration', 'Quality flags, revisions and recorded metadata', '<dl class="definition-list"><dt>Run</dt><dd class="mono">' + escapeHtml(run.runId) + '</dd><dt>Quality</dt><dd>' + escapeHtml(researchQualityLabel(run.quality)) + '</dd><dt>Config</dt><dd>r' + escapeHtml(run.configRevision ?? '—') + '</dd></dl>' + pretty(metadata)) + disclosure(id + '-events', 'All original recorded events', array(run.events).length + ' events', pretty(array(run.events))) + disclosure(id + '-initial', 'Recorded initial conditions', 'Complete original fictional fixture', pretty(run.initialConditions));
}
export function mountResearchReview(container, options = {}) {
  if (!container) return { selectedRunId: undefined, step: 0, filteredRunIds: [] };
  let context = contexts.get(container);
  if (!context) {
    context = { container, disclosures: new Map(), options: {}, filters: {}, step: 0 };
    contexts.set(container, context);
    container.addEventListener('toggle', event => { if (event.target.matches('details[data-disclosure-id]')) context.disclosures.set(event.target.dataset.disclosureId, event.target.open); }, true);
    container.addEventListener('change', event => {
      const key = event.target.dataset.researchFilter;
      if (!key) return;
      const next = { ...context.filters, [key]: event.target.value };
      if (context.options.onFiltersChange) context.options.onFiltersChange(next);
      else { context.filters = next; render(context); }
    });
    container.addEventListener('input', event => {
      if (!event.target.matches('[data-trace-slider]')) return;
      context.step = Number(event.target.value); context.renderStep?.(); context.options.onStepChange?.(context.step);
    });
    container.addEventListener('click', event => {
      const clear = event.target.closest('[data-research-clear-filters]');
      if (clear) { const next = { mode: 'all', status: 'all', quality: 'all' }; if (context.options.onFiltersChange) context.options.onFiltersChange(next); else { context.filters = next; render(context); } container.querySelector('[data-research-run]')?.focus({ preventScroll: true }); return; }
      const run = event.target.closest('[data-research-run]');
      if (run) { if (context.options.onRunSelect) context.options.onRunSelect(run.dataset.researchRun); else { context.selectedRunId = run.dataset.researchRun; context.step = 0; render(context); } return; }
      const action = event.target.closest('[data-research-action]');
      if (action && !action.disabled) { context.options.onAction?.(action.dataset.researchAction, action); return; }
      const move = event.target.closest('[data-trace-move]'), latest = event.target.closest('[data-trace-latest]');
      if ((!move || move.disabled) && (!latest || latest.disabled)) return;
      const selected = array(context.options.research?.runs).find(run => run.runId === context.selectedRunId);
      context.step = latest ? array(selected?.trace).length - 1 : context.step + Number(move.dataset.traceMove);
      context.renderStep?.(); context.options.onStepChange?.(context.step);
    });
  }
  context.options = options;
  context.filters = { mode: 'all', status: 'all', quality: 'all', ...options.filters };
  context.selectedRunId = options.selectedRunId ?? context.selectedRunId;
  context.step = options.step ?? context.step;
  render(context);
  return { selectedRunId: context.selectedRunId, step: context.step, filteredRunIds: context.filteredRunIds || [] };
}
