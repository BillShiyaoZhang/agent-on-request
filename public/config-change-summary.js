const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = {
  persona: 'Persona', objective: 'Objective', 'data.source': 'Synthetic data source',
  'data.availableTimes': 'Available times', 'data.brief.topic': 'Brief topic', 'data.brief.agenda': 'Brief agenda',
  'permissions.recipients': 'Recipients', 'permissions.fields': 'Allowed fields', 'permissions.resources': 'Resources',
  'permissions.window': 'Time window', 'permissions.confirmation': 'Confirmation mode',
  'permissions.askAdminForNewScope': 'Ask before a new scope', 'permissions.maxUses': 'Maximum permission uses',
  'permissions.expiryMinutes': 'Permission expiry · minutes', 'collaboration.acceptInvitations': 'Accept invitations',
  'collaboration.allowedPeers': 'Allowed peers', 'tools.capabilities': 'Tools / capabilities',
  'prompts.system': 'System prompt', 'prompts.followUp': 'Follow-up prompt',
  'response.constraints': 'Response constraints', 'response.offerBrief': 'Offer an optional brief',
  'response.maxWords': 'Maximum response words', provider: 'Provider preset', baseUrl: 'API base URL',
  model: 'Model identifier', temperature: 'Temperature', maxTokens: 'Maximum output tokens',
  thinking: 'Thinking mode · MiniMax', timeoutSeconds: 'Timeout · seconds', retryLimit: 'Retry limit'
};
function identify(path) {
  const clean = path.replace(/^\$\.?/, '');
  const role = /^agents\.(Alice|Bob)\.(\w+)$/.exec(clean);
  if (role) return { group: role[1], label: Object.hasOwn(labels, role[2]) ? labels[role[2]] : role[2] };
  const group = /^(permissions|collaboration)\./.test(clean) ? 'Sharing boundaries'
    : /^data\./.test(clean) ? 'Time & materials'
    : /^(persona|objective)$/.test(clean) ? 'Goal & role'
    : /^(prompts|response|tools)\./.test(clean) ? 'Fine-tune behavior'
    : /^(provider|baseUrl)$/.test(clean) ? 'Shared connection' : 'Other settings';
  return { group, label: Object.hasOwn(labels, clean) ? labels[clean] : undefined, path: clean };
}
function valueHtml(value) {
  if (value == null) return '<span class="change-empty">Not set</span>';
  if (typeof value === 'boolean') return '<span class="change-boolean">' + (value ? 'Enabled' : 'Disabled') + '</span>';
  if (Array.isArray(value) && value.length === 0) return '<span class="change-empty">None selected</span>';
  if (Array.isArray(value) && value.every(item => item == null || typeof item !== 'object')) {
    return '<div class="change-chips">' + value.map(item => '<span data-i18n-ignore>' + escapeHtml(item) + '</span>').join('') + '</div>';
  }
  if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && typeof item.day === 'string' && typeof item.time === 'string')) {
    return '<div class="change-times">' + value.slice(0, 3).map(row => '<div><span class="change-time-day" data-i18n-ignore>' + escapeHtml(row.day) + '</span><strong data-i18n-ignore>' + escapeHtml(row.time) + '</strong></div>').join('') + (value.length > 3 ? '<small>+' + (value.length - 3) + ' more entries</small>' : '') + '</div>';
  }
  const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  if (text.length > 160 || typeof value === 'object') {
    const excerpt = typeof value === 'object' ? '<span>' + (Array.isArray(value) ? value.length + ' entries' : Object.keys(value).length + ' properties') + '</span>' : '<span class="change-value-excerpt" data-i18n-ignore>' + escapeHtml(text.slice(0, 160)) + '…</span>';
    return '<details class="change-full-value"><summary>' + excerpt + '<small>Read full value</small></summary><pre data-i18n-ignore>' + escapeHtml(text) + '</pre></details>';
  }
  return '<span data-i18n-ignore>' + escapeHtml(text) + '</span>';
}
export function renderChangeSummary(root, differences, reviewed) {
  if (!root) return;
  const state = JSON.stringify([differences, reviewed]);
  if (root.dataset.changeStamp === state) return;
  root.dataset.changeStamp = state;
  if (!reviewed) { root.innerHTML = ''; root.hidden = true; return; }
  root.hidden = false;
  if (!differences.length) { root.innerHTML = '<p class="change-no-edits"><span aria-hidden="true">✓</span><span>No setting changes</span></p>'; return; }
  const groups = new Map();
  for (const difference of differences) {
    const info = identify(difference.path);
    if (!groups.has(info.group)) groups.set(info.group, []);
    groups.get(info.group).push({ ...difference, ...info });
  }
  root.innerHTML = '<div class="change-summary-heading"><strong>What will change</strong><span class="tag"><b data-change-total>' + differences.length + '</b>&nbsp;<span>settings changed</span></span></div><div class="change-groups">' + [...groups].map(([group, items], index) =>
    '<details class="change-group" ' + (index === 0 ? 'open' : '') + '><summary><strong>' + escapeHtml(group) + '</strong><span class="tag">' + items.length + '</span></summary><div class="change-group-body">' + items.map(item =>
      '<article class="change-item"><h4>' + (item.label ? '<span>' + escapeHtml(item.label) + '</span>' : '<code data-i18n-ignore>' + escapeHtml(item.path) + '</code>') + '</h4><div class="change-pair"><div class="change-before"><small>Before</small>' + valueHtml(item.before) + '</div><span class="change-direction" aria-hidden="true">→</span><div class="change-after"><small>After</small>' + valueHtml(item.after) + '</div></div></article>'
    ).join('') + '</div></details>'
  ).join('') + '</div>';
}
