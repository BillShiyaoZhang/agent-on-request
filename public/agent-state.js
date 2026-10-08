const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const array = value => Array.isArray(value) ? value : [];
const readable = value => Array.isArray(value) ? value.join(', ') : value && typeof value === 'object' ? Object.entries(value).map(([key, item]) => key + ': ' + readable(item)).join(' · ') : String(value ?? '—');
const controls = new Map();
const categoryStates = new Map();
function categoryIcon(category) {
  const shapes = {
    knowledge: '<circle cx="7" cy="16" r="4"/><circle cx="24" cy="7" r="4"/><circle cx="24" cy="25" r="4"/><path d="m11 14 9-5m-9 9 9 5"/>',
    skills: '<path d="m18 3-12 16h9l-1 10 12-17h-9Z"/>',
    data: '<rect x="6" y="5" width="20" height="22" rx="4"/><path d="M6 12h20M12 3v6m8-6v6m-8 9h8m-8 5h5"/>',
    authorization: '<path d="m16 3 11 5v9c0 6-11 12-11 12S5 23 5 17V8Z"/><path d="M12 16v-3a4 4 0 0 1 8 0v3m-9 0h10v7H11z"/>'
  };
  return '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shapes[category] + '</svg>';
}
function categoryHtml(scope, role, category, title, value, label, contents) {
  const key = scope + ':' + role + ':' + category;
  return '<details class="state-category ' + category + '" data-state-category="' + category + '" data-state-disclosure-key="' + escapeHtml(key) + '" data-disclosure-id="agent-category-' + escapeHtml(key) + '" ' + (categoryStates.get(key) ? 'open' : '') + '><summary><span class="state-category-icon">' + categoryIcon(category) + '</span><span class="state-category-title"><strong>' + title + '</strong><small>' + label + '</small></span><span class="state-category-count">' + escapeHtml(value) + '</span></summary><div class="state-category-body">' + contents + '</div></details>';
}
const originLabel = origin => origin === 'received' ? 'Received from peer' : 'Own knowledge';
const statusLabel = value => ({ active: 'Active', pending: 'Awaiting approval', expired: 'Expired', exhausted: 'Uses exhausted', disabled: 'Disabled', stopped: 'Sharing stopped', denied: 'Declined', bounded: 'Within bounded policy', per_action: 'Confirm each action', each_action: 'Confirm each action' })[value] || value;
function detailsHtml(details) {
  return array(details).length ? '<dl class="definition-list">' + details.map(detail => '<dt>' + escapeHtml(detail.label) + '</dt><dd>' + escapeHtml(readable(detail.value)) + '</dd>').join('') + '</dl>' : '';
}
function provenanceHtml(value) {
  if (!value) return '';
  return '<div class="knowledge-provenance"><strong>Receipt provenance</strong><small>' + escapeHtml(value.sender || value.from || 'Peer') + (value.receivedAt ? ' · ' + new Date(value.receivedAt).toLocaleString() : '') + '</small>' + (value.fields?.length ? '<small>Confirmed fields: ' + escapeHtml(readable(value.fields)) + '</small>' : '') + (value.operationId ? '<code>Operation ' + escapeHtml(value.operationId) + '</code>' : '') + '</div>';
}
function skillHtml(skills) {
  return '<section class="agent-section"><h4>Skills & capabilities</h4><ul class="capability-list">' + array(skills).map(skill => '<li><span class="status-dot ' + (skill.enabled !== false ? 'enabled' : '') + '" aria-hidden="true"></span><div' + (skill.customized ? ' data-i18n-ignore' : '') + '><strong>' + escapeHtml(skill.label || skill.id) + '</strong><small>' + escapeHtml(skill.description || '') + '</small></div><span class="tag ' + (skill.enabled !== false ? 'good' : '') + '">' + (skill.enabled !== false ? 'Enabled' : 'Disabled') + '</span></li>').join('') + (!skills?.length ? '<li class="muted">No skills configured.</li>' : '') + '</ul></section>';
}
function dataHtml(data) {
  return '<section class="agent-section"><h4>Data inventory</h4><div class="state-card-list">' + array(data).map(item => '<details class="state-card"><summary><span><strong>' + escapeHtml(item.label || item.id) + '</strong><small>' + escapeHtml(item.summary || item.kind || '') + '</small></span><span class="tag">' + escapeHtml(item.count ?? array(item.items).length) + ' items</span></summary><p class="muted">' + escapeHtml(originLabel(item.origin)) + (item.fields?.length ? ' · ' + escapeHtml(readable(item.fields)) : '') + '</p>' + array(item.items).map(row => '<article class="inventory-item"><strong>' + escapeHtml(row.label || row.id || item.label) + '</strong>' + detailsHtml(row.details) + '</article>').join('') + provenanceHtml(item.provenance) + '</details>').join('') + (!data?.length ? '<p class="muted">No data configured.</p>' : '') + '</div></section>';
}
function authorizationHtml(authorization = {}) {
  return '<section class="agent-section"><div class="panel-heading"><h4>Authorization</h4><span class="tag ' + (['stopped', 'expired', 'denied', 'disabled', 'exhausted'].includes(authorization.status) ? 'warn' : '') + '">' + escapeHtml(statusLabel(authorization.status) || 'No grant') + '</span></div><p class="muted">' + escapeHtml(authorization.summary || 'No authorization information supplied.') + '</p><div class="state-card-list">' + array(authorization.cards).map(card => '<details class="state-card" open><summary><span><strong>' + escapeHtml(card.label || card.id) + '</strong><small>' + escapeHtml(statusLabel(card.status) || '') + '</small></span></summary>' + (card.description ? '<p class="muted">' + escapeHtml(card.description) + '</p>' : '') + '<dl class="definition-list">' + [['Recipient', card.recipient || card.recipients], ['Resource', card.resource || card.resources], ['Fields', card.fields], ['Time window', card.windows || card.window], ['Confirmation', statusLabel(card.confirmation)], ['Maximum uses', card.maxUses], ['Used / reserved', card.reserved ? (card.uses ?? 0) + ' used · ' + card.reserved + ' reserved' : card.uses], ['Remaining uses', card.remaining ?? (card.maxUses == null ? null : Math.max(0, card.maxUses - (card.uses || 0)))], ['Expires', card.expiresAt ? new Date(card.expiresAt).toLocaleString() : card.expiryMinutes == null ? null : card.expiryMinutes + ' minutes']].filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => '<dt>' + label + '</dt><dd>' + escapeHtml(readable(value) || 'None') + '</dd>').join('') + '</dl></details>').join('') + '</div>' + (authorization.receivedSnapshotsRetained ? '<small class="retention-note">Stopping future sharing preserves snapshots already received.</small>' : '') + '</section>';
}

function graphHtml(state, view, scope) {
  const allNodes = array(state.kg?.nodes), allEdges = array(state.kg?.edges);
  const query = view.query.trim().toLocaleLowerCase();
  const filtered = allNodes.filter(node => (view.origin === 'all' || (node.origin || 'own') === view.origin) && (!query || [node.label, node.type, node.id, ...array(node.details).map(detail => readable(detail.value))].join(' ').toLocaleLowerCase().includes(query)));
  const ownFiltered = filtered.filter(node => node.origin !== 'received'), receivedFiltered = filtered.filter(node => node.origin === 'received');
  const representatives = receivedFiltered.length ? [...ownFiltered.slice(0, 14), ...receivedFiltered.slice(0, 14)] : ownFiltered.slice(0, 28);
  const representedIds = new Set(representatives.map(node => node.id));
  const visible = [...representatives, ...filtered.filter(node => !representedIds.has(node.id))].slice(0, 28), visibleIds = new Set(visible.map(node => node.id));
  const edges = allEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).slice(0, 100);
  const own = visible.filter(node => node.origin !== 'received'), received = visible.filter(node => node.origin === 'received');
  const positions = new Map();
  // Stable owner / receipt columns make the trust boundary visible without a physics simulation.
  [own, received].forEach((group, column) => group.forEach((node, index) => {
    const columns = group.length > 7 ? 2 : 1, rows = Math.ceil(group.length / columns);
    positions.set(node.id, { x: column * 290 + (columns === 1 ? 155 : 88 + (index % columns) * 137), y: 70 + Math.floor(index / columns) * Math.min(46, 290 / Math.max(1, rows - 1)) });
  }));
  const marker = scope.replace(/[^a-z0-9_-]/gi, '') + '-arrow';
  const svg = '<svg class="knowledge-svg" viewBox="0 0 600 410" role="group" aria-label="' + escapeHtml(state.label || state.id) + ' knowledge graph. Select a node to read its details."><defs><marker id="' + marker + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs><rect x="12" y="12" width="280" height="384" rx="12" class="graph-region own"/><rect x="307" y="12" width="280" height="384" rx="12" class="graph-region received"/><text x="27" y="37" class="graph-region-label">Own knowledge</text><text x="322" y="37" class="graph-region-label">Received from peer</text>' + edges.map(edge => {
    const a = positions.get(edge.source), b = positions.get(edge.target), selected = edge.source === view.selected || edge.target === view.selected;
    return '<g class="knowledge-edge ' + (selected ? 'selected' : '') + '" data-edge-source="' + escapeHtml(edge.source) + '" data-edge-target="' + escapeHtml(edge.target) + '"><title>' + escapeHtml(edge.label || edge.relation || 'Related') + '</title><line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" marker-end="url(#' + marker + ')"/></g>';
  }).join('') + visible.map(node => {
    const pos = positions.get(node.id), label = node.label || node.id;
    return '<g class="knowledge-node ' + (node.origin === 'received' ? 'received' : 'own') + (node.id === view.selected ? ' selected' : '') + '" tabindex="0" role="button" aria-label="' + escapeHtml(label + '. ' + originLabel(node.origin) + '. ' + (node.type || 'Knowledge')) + '" aria-pressed="' + (node.id === view.selected) + '" data-knowledge-node="' + escapeHtml(node.id) + '" transform="translate(' + pos.x + ' ' + pos.y + ')"><title>' + escapeHtml(label) + '</title><rect x="-61" y="-15" width="122" height="32" rx="7"/><text text-anchor="middle" y="5">' + escapeHtml(label.length > 18 ? label.slice(0, 17) + '…' : label) + '</text></g>';
  }).join('') + (!visible.length ? '<text x="300" y="210" text-anchor="middle" class="graph-region-label">No matching knowledge</text>' : '') + '</svg>';
  const page = Math.min(view.page || 0, Math.max(0, Math.ceil(filtered.length / 30) - 1)); view.page = page;
  return '<div class="graph-area"><div class="knowledge-viewport">' + svg + '</div><small class="graph-pan-hint">Scroll the graph sideways, or open the knowledge list below for full labels.</small><small>' + filtered.length + ' matching nodes · ' + allEdges.length + ' total relations' + (filtered.length > 28 ? ' · graph shows up to 28 nodes across both origins; browse every node in the list below.' : '') + '</small><div data-knowledge-detail>' + nodeDetailsHtml(state, view.selected) + '</div><details class="knowledge-list"><summary>Knowledge list & relationships · accessible alternative</summary><ul>' + filtered.slice(page * 30, page * 30 + 30).map(node => '<li><button class="button quiet" data-knowledge-node="' + escapeHtml(node.id) + '">' + escapeHtml(node.label || node.id) + '</button><small>' + escapeHtml(node.type || 'Knowledge') + ' · ' + originLabel(node.origin) + '</small></li>').join('') + '</ul>' + (filtered.length > 30 ? '<div class="toolbar"><button class="button" data-knowledge-page="-1" ' + (!page ? 'disabled' : '') + '>Previous nodes</button><small>Page ' + (page + 1) + ' of ' + Math.ceil(filtered.length / 30) + '</small><button class="button" data-knowledge-page="1" ' + ((page + 1) * 30 >= filtered.length ? 'disabled' : '') + '>Next nodes</button></div>' : '') + '</details></div>';
}
function nodeDetailsHtml(state, id) {
  const node = array(state.kg?.nodes).find(item => item.id === id);
  if (!node) return '<div class="node-detail muted">Select a graph node or list item to inspect its facts and provenance.</div>';
  const connected = array(state.kg?.edges).filter(edge => edge.source === id || edge.target === id);
  const nodes = new Map(array(state.kg?.nodes).map(item => [item.id, item]));
  return '<article class="node-detail"><div class="panel-heading"><h4>' + escapeHtml(node.label || node.id) + '</h4><span class="tag">' + escapeHtml(node.type || 'Knowledge') + '</span></div><small>' + originLabel(node.origin) + '</small>' + detailsHtml(node.details) + provenanceHtml(node.provenance) + (connected.length ? '<ul class="relation-list">' + connected.slice(0, 50).map(edge => '<li>' + escapeHtml(nodes.get(edge.source)?.label || edge.source) + ' <span>→ ' + escapeHtml(edge.label || edge.relation || 'related to') + ' →</span> ' + escapeHtml(nodes.get(edge.target)?.label || edge.target) + '</li>').join('') + (connected.length > 50 ? '<li class="muted">Showing the first 50 relationships.</li>' : '') + '</ul>' : '<small>No relationships for this node.</small>') + '</article>';
}

export function mountAgentStates(container, states, { scope = 'live', heading = 'Inside Alice & Bob', description = 'Separate knowledge, capabilities, data and authorization. Received knowledge is linked to its delivery receipt.' } = {}) {
  if (!container) return;
  container.querySelectorAll('[data-state-disclosure-key]').forEach(node => categoryStates.set(node.dataset.stateDisclosureKey, node.open));
  if (!states || !states.Alice && !states.Bob) { container.innerHTML = '<section class="panel"><h3>' + escapeHtml(heading) + '</h3><p class="empty">Agent snapshots are unavailable for this record.</p></section>'; return; }
  container.innerHTML = '<section class="panel agent-observatory"><div class="panel-heading"><div><h3>' + escapeHtml(heading) + '</h3><small>' + escapeHtml(description) + '</small></div><span class="tag">Owner / received provenance</span></div><div class="agent-state-grid">' + ['Alice', 'Bob'].map(role => {
    const state = states[role]; if (!state) return '';
    const key = scope + ':' + role, view = controls.get(key) || { origin: 'all', query: '', selected: null, page: 0 }; controls.set(key, view);
    const nodes = array(state.kg?.nodes);
    const knowledge = '<section class="agent-section"><h4>Knowledge graph</h4><div class="graph-controls"><label class="field"><span>Filter provenance</span><select data-knowledge-origin><option value="all" ' + (view.origin === 'all' ? 'selected' : '') + '>All knowledge</option><option value="own" ' + (view.origin === 'own' ? 'selected' : '') + '>Own only</option><option value="received" ' + (view.origin === 'received' ? 'selected' : '') + '>Received only</option></select></label><label class="field"><span>Find a fact</span><input type="search" data-knowledge-query value="' + escapeHtml(view.query) + '" placeholder="Label, type, or detail"></label></div><small class="sr-only" data-knowledge-page-status role="status" aria-live="polite" aria-atomic="true"></small><div data-knowledge-graph>' + graphHtml(state, view, key) + '</div></section>';
    const skills = array(state.skills), data = array(state.data), authorization = state.authorization || {};
    return '<article class="agent-state" data-state-role="' + role + '"><div class="agent-state-heading"><div><p class="eyebrow">' + (role === 'Alice' ? 'Your agent' : 'Peer agent') + '</p><h3>' + role + '</h3></div><div class="toolbar"><span class="tag">' + nodes.filter(node => node.origin !== 'received').length + ' own</span><span class="tag received-tag">' + nodes.filter(node => node.origin === 'received').length + ' received</span></div></div><div class="state-categories">'
      + categoryHtml(scope, role, 'knowledge', 'Knowledge graph', nodes.length, 'Knowledge nodes', knowledge)
      + categoryHtml(scope, role, 'skills', 'Skills & capabilities', skills.filter(skill => skill.enabled !== false).length + '/' + skills.length, 'Enabled skills / all skills', skillHtml(state.skills))
      + categoryHtml(scope, role, 'data', 'Data inventory', data.length, 'Data sources', dataHtml(state.data))
      + categoryHtml(scope, role, 'authorization', 'Authorization', statusLabel(authorization.status) || 'No grant', 'Current authorization status', authorizationHtml(authorization))
      + '</div></article>';
  }).join('') + '</div></section>';
  container.querySelectorAll('[data-state-role]').forEach(article => {
    const role = article.dataset.stateRole, state = states[role], view = controls.get(scope + ':' + role), graph = article.querySelector('[data-knowledge-graph]');
    article.querySelectorAll('[data-state-disclosure-key]').forEach(node => node.addEventListener('toggle', () => {
      // A queued toggle from a replaced view must not overwrite its successor.
      if (node.isConnected && container.contains(node)) categoryStates.set(node.dataset.stateDisclosureKey, node.open);
    }));
    const pageStatus = article.querySelector('[data-knowledge-page-status]');
    const announcePage = () => { pageStatus.textContent = graph.querySelector('.knowledge-list > .toolbar small')?.textContent || ''; };
    announcePage();
    const redraw = () => {
      const listOpen = graph.querySelector('.knowledge-list')?.open;
      const focusedPage = graph.contains(document.activeElement) ? document.activeElement?.dataset.knowledgePage : undefined;
      graph.innerHTML = graphHtml(state, view, scope + ':' + role);
      if (listOpen) graph.querySelector('.knowledge-list').open = true;
      announcePage();
      if (focusedPage) {
        const nextFocus = graph.querySelector('[data-knowledge-page="' + focusedPage + '"]:not(:disabled)') || graph.querySelector('[data-knowledge-page]:not(:disabled)') || graph.querySelector('.knowledge-list > summary');
        nextFocus?.focus({ preventScroll: true });
      }
    };
    const selectNode = id => { view.selected = id; graph.querySelector('[data-knowledge-detail]').innerHTML = nodeDetailsHtml(state, id); graph.querySelectorAll('.knowledge-node').forEach(node => { const selected = node.dataset.knowledgeNode === id; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); }); graph.querySelectorAll('.knowledge-edge').forEach(node => node.classList.toggle('selected', node.dataset.edgeSource === id || node.dataset.edgeTarget === id)); };
    article.addEventListener('change', event => { if (event.target.matches('[data-knowledge-origin]')) { view.origin = event.target.value; view.page = 0; redraw(); } });
    article.addEventListener('input', event => { if (event.target.matches('[data-knowledge-query]')) { view.query = event.target.value; view.page = 0; redraw(); } });
    article.addEventListener('click', event => { const node = event.target.closest('[data-knowledge-node]'); if (node) selectNode(node.dataset.knowledgeNode); const button = event.target.closest('[data-knowledge-page]'); if (button && !button.disabled) { view.page += Number(button.dataset.knowledgePage); redraw(); } });
    article.addEventListener('keydown', event => { const node = event.target.closest('.knowledge-node'); if (node && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectNode(node.dataset.knowledgeNode); } });
  });
}
