const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = role => '<span class="experience-avatar ' + role.toLowerCase() + '" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="7" y="10" width="18" height="16" rx="5"/><path d="M16 5v5m-5 7h1m8 0h1m-9 5h8"/></svg></span>';

function audienceProgress(current) {
  return '<ol class="experience-progress" aria-label="Demo steps">' + ['Architecture', 'Collaborate', 'Summary'].map((label, index) => {
    const step = index + 1;
    return '<li class="' + (step < current ? 'done' : step === current ? 'current' : '') + '"' + (step === current ? ' aria-current="step"' : '') + '><span aria-hidden="true">' + (step < current ? '✓' : step) + '</span><strong>' + label + '</strong></li>';
  }).join('') + '</ol>';
}

export function renderAudienceIntroHtml({ controls = '', direct = false } = {}) {
  return `<div class="audience-intro" data-audience-step="intro">
    ${audienceProgress(1)}
    <section class="start-hero audience-intro-heading">
      <p class="eyebrow">Audience demo</p>
      <h1>Can two agents agree on a time?</h1>
      <p class="lead">Alice and Bob have separate knowledge graphs. Help them arrange a fictional discussion while each owner controls what their agent shares.</p>
    </section>
    <section class="panel audience-architecture" aria-labelledby="audience-architecture-title">
      <div class="panel-heading"><div><p class="eyebrow">Reference architecture</p><h2 id="audience-architecture-title">How the agents fit together</h2></div></div>
      <ol class="audience-route" aria-label="Bidirectional reference architecture">
        <li class="audience-route-agent alice">${icon('Alice')}<strong>Agent A · Alice</strong><small>KG A</small></li>
        <li><strong>agent-comm A</strong></li>
        <li class="audience-route-platform"><strong>agent-collaboration-platform</strong><small>Fictional · unused in this demo</small></li>
        <li><strong>agent-comm B</strong></li>
        <li class="audience-route-agent bob">${icon('Bob')}<strong>Agent B · Bob</strong><small>KG B</small></li>
      </ol>
      <p class="audience-example-url"><span>Example platform URL</span><code data-platform-url>https://agent-collaboration-platform.example</code></p>
      <p class="audience-active-route"><strong>In this demo</strong><span>${direct ? 'Agent-comm A and B exchange messages directly over a local connection.' : 'The agents exchange messages through the demo runtime.'}</span></p>
    </section>
    <section class="panel audience-next" aria-labelledby="audience-next-title">
      <div><h2 id="audience-next-title">What you’ll do</h2>
        <ol><li>Act as Alice’s owner. Review how the agents interpret free time and decide which calendar information Alice can share.</li>
        <li>Watch the agents exchange information, then review the result and the collaboration trace.</li></ol>
      </div>
      ${controls}
    </section>
  </div>`;
}

export function scopeIconHtml(choice) {
  const paths = choice === 'none' || choice === 'keep' ? '<rect x="10" y="15" width="16" height="13" rx="3"/><path d="M14 15v-5a4 4 0 0 1 8 0v5m-4 6v3"/>' : choice === 'full' ? '<rect x="8" y="5" width="20" height="26" rx="4"/><path d="M13 12h10m-10 6h10m-10 6h6"/>' : choice === 'busy' ? '<rect x="5" y="8" width="26" height="24" rx="4"/><path d="M5 15h26M12 4v8M24 4v8m-12 9h5m5 0h3m-13 6h5"/>' : '<circle cx="18" cy="18" r="13"/><path d="M18 10v8l6 4"/>';
  return '<span class="scope-icon" aria-hidden="true"><svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></span>';
}

function messageHtml(state) {
  const approval = state.pendingApprovals?.find(item => item.status === 'pending');
  if (approval && state.waiting?.reason === 'admin') {
    const meeting = [...(state.receipts?.bobToAlice || [])].reverse().find(receipt => receipt.status === 'received' && ['day', 'time', 'status'].every(field => receipt.fields.includes(field)));
    const confirmed = approval.resource === 'meeting_brief' && meeting;
    return '<section class="panel agent-facing-message" data-agent-facing-message data-current-bob-request><div class="experience-message-heading">' + icon('Bob') + '<div><h3>' + (confirmed ? 'Shared time confirmed' : 'Bob’s sharing request') + '</h3><small>Bob’s owner reviews his agent’s outgoing information</small></div></div>'
      + (confirmed ? '<p><strong>' + escapeHtml(meeting.values.day) + ' · ' + escapeHtml(meeting.values.time) + '</strong></p><p>The optional meeting brief needs Bob’s owner approval. Your calendar choice stays unchanged.</p>' : '<p>' + escapeHtml(approval.summary) + '</p><p>Your calendar choice stays unchanged.</p>') + '</section>';
  }
  const messages = state.messages || [];
  const message = [...messages].reverse().find(item => !['receipt', 'technical', 'approval'].includes(item.kind));
  if (!message) return '';
  const role = message.from === 'Alice' ? 'Alice' : message.from === 'Bob' ? 'Bob' : 'system';
  return '<section class="panel agent-facing-message" data-agent-facing-message><div class="experience-message-heading">' + icon(role) + '<div><h3>' + (role === 'Alice' ? 'Alice · your agent' : role === 'Bob' ? 'A message for Alice' : 'Demo update') + '</h3><small>' + (role === 'Bob' ? 'Bob’s request, presented for your decision' : 'What matters at this step') + '</small></div></div><p>' + escapeHtml(message.text) + '</p></section>';
}

function deliverySummary(state) {
  if (state.session.mode === 'replay') return '';
  const sent = (state.receipts?.aliceToBob || []).filter(item => item.status === 'received').length;
  const back = (state.receipts?.bobToAlice || []).filter(item => item.status === 'received').length;
  const uncertain = [...(state.receipts?.aliceToBob || []), ...(state.receipts?.bobToAlice || [])].filter(item => item.status !== 'received').length;
  return '<div class="delivery-summary" aria-label="Confirmed sharing"><span class="delivery-point alice"><strong>Alice → Bob</strong><small>' + sent + ' confirmed snapshots</small></span><span class="delivery-link" aria-hidden="true">⇄</span><span class="delivery-point bob"><strong>Bob → Alice</strong><small>' + back + ' confirmed snapshots</small></span>' + (uncertain ? '<span class="tag warn">' + uncertain + ' unconfirmed snapshots</span>' : '<span class="tag">' + (sent || back ? 'Only confirmed receipts count' : 'Nothing shared yet') + '</span>') + '</div>';
}

function receivedValueHtml(value) {
  if (Array.isArray(value)) return value.length ? '<ul class="received-value-list">' + value.map(item => '<li>' + receivedValueHtml(item) + '</li>').join('') + '</ul>' : '<span class="muted">Empty list</span>';
  if (value !== null && typeof value === 'object') return Object.keys(value).length ? '<dl class="definition-list received-value-fields">' + Object.entries(value).map(([key, item]) => '<dt data-i18n-ignore>' + escapeHtml(key) + '</dt><dd>' + receivedValueHtml(item) + '</dd>').join('') + '</dl>' : '<span class="muted">No fields</span>';
  return '<span data-i18n-ignore>' + escapeHtml(value === null ? 'null' : value) + '</span>';
}

function receivedInformationHtml(state) {
  const labels = { topic: 'Topic', agenda: 'Agenda' };
  const received = (state.receipts?.bobToAlice || []).filter(receipt => receipt.status === 'received' && Object.keys(receipt.values || {}).some(key => !['day', 'time', 'status'].includes(key)));
  if (!received.length) return '';
  return '<section class="panel alice-received-information" data-alice-received><div class="experience-message-heading">' + icon('Alice') + '<div><h3>Information Alice received</h3><small>Confirmed information from Bob</small></div></div>' + received.map((receipt, index) => '<dl class="definition-list">' + Object.entries(receipt.values || {}).filter(([key]) => !['day', 'time', 'status'].includes(key)).map(([key, value]) => '<dt>' + escapeHtml(labels[key] || key) + '</dt><dd>' + (value !== null && typeof value === 'object' ? '<details class="received-structured" data-disclosure-id="received-info-' + escapeHtml(receipt.operationId || index) + '-' + escapeHtml(key) + '"><summary>View information details</summary>' + receivedValueHtml(value) + '</details>' : receivedValueHtml(value)) + '</dd>').join('') + '</dl>').join('') + '</section>';
}

function inspectionHtml(state, contents) {
  const agent = state.agentStates?.Alice;
  const received = (agent?.kg?.nodes || []).filter(node => node.origin === 'received').length;
  const calendar = contents ? '<details class="experience-calendar" data-disclosure-id="participant-calendar"><summary>Your calendar at a glance</summary><div class="disclosure-body">' + contents + '</div></details>' : '';
  return '<details class="experience-inspection alice configuration-disclosure" data-disclosure-id="participant-Alice"><summary><span class="experience-inspection-title">' + icon('Alice') + '<span><strong>Inside Alice · optional</strong><small>Your agent’s calendar, knowledge and permissions</small></span></span><span class="tag">' + (agent ? received + ' received facts' : 'Snapshot unavailable') + '</span></summary><div class="disclosure-body"><div id="live-alice-state"></div>' + calendar + '</div></details>';
}

function historyHtml(messages) {
  return '<ol class="conversation">' + messages.map(message => '<li class="message" data-from="' + escapeHtml(message.from) + '"><header><strong>' + escapeHtml(message.from === 'system' ? 'Demo update' : message.from) + '</strong></header><p>' + escapeHtml(message.text) + '</p></li>').join('') + '</ol>';
}

function observationHtml(state, messages) {
  const adminPending = state.waiting?.reason === 'admin';
  const updates = state.session.paused ? [] : messages.filter(message => message.kind !== 'approval' && !(adminPending && message.kind === 'request')).slice(-2);
  const alignment = state.ontology?.status;
  return '<aside class="panel audience-observation" aria-labelledby="audience-observation-title" data-audience-observation>'
    + '<p class="eyebrow">Agent A ↔ Agent B</p><h3 id="audience-observation-title">Follow the collaboration</h3>'
    + (alignment ? '<p class="audience-alignment">' + (alignment === 'accepted' ? 'The agents agreed on the meaning of free time for this task.' : alignment === 'rejected' ? 'The proposed meaning was declined.' : 'The agents are aligning the meaning of free time.') + '</p>' : '')
    + deliverySummary(state)
    + '<div class="audience-latest"><h4>Recent updates</h4>' + (updates.length ? historyHtml(updates) : '<p class="muted">' + (state.session.paused ? 'The collaboration is paused.' : 'Updates will appear as the agents work.') + '</p>') + '</div></aside>';
}

export function renderParticipantHtml({ state, heading, mode, summary = state.session.ended || Boolean(state.task?.outcome), warnings = '', controls = '', outcome = '', choices = '', questions = '', receipts = '', calendar = '', replay = '', modeDisclosure = '', ontology = '', contribution = '' }) {
  const session = state.session;
  const messages = (state.messages || []).filter(message => message.kind !== 'technical');
  const trace = '<details class="experience-evidence configuration-disclosure" data-disclosure-id="participant-evidence" data-audience-trace><summary><span><strong>View collaboration trace</strong><small>Agent updates, alignment decisions and sharing receipts</small></span></summary><div class="disclosure-body">' + (summary ? contribution + ontology : '') + '<section class="conversation-history"><h4>Agent updates</h4>' + (messages.length ? historyHtml(messages) : '<p class="muted">No updates recorded for this round.</p>') + '</section>' + receipts + '<details data-disclosure-id="participant-round-details"><summary>Round details</summary><p class="muted">' + escapeHtml(modeDisclosure) + '</p><span class="tag">Research ' + (session.researchConsent ? 'on' : 'off') + '</span><span class="tag mono">Epoch ' + escapeHtml(session.epoch) + '</span></details></div></details>';
  const received = receivedInformationHtml(state);
  const result = (outcome ? '<section class="panel experience-outcome" data-outcome>' + outcome + '</section>' : '') + received;
  const action = (session.stage === 'alignment' || session.paused || session.stage === 'replay' ? '' : messageHtml(state)) + ontology + choices + replay + received;
  return '<div data-audience-step="' + (summary ? 'summary' : 'collaboration') + '">' + audienceProgress(summary ? 3 : 2)
    + '<div class="panel-heading experience-heading"><div><p class="eyebrow">' + escapeHtml(mode) + ' · fictional scenario</p><h2>' + (summary ? 'Collaboration summary' : heading) + '</h2></div><div class="toolbar">' + controls + '</div></div>' + warnings
    + (summary ? '<div class="participant-main-flow">' + result + trace + questions + '</div>' : '<div class="audience-workspace"><div class="participant-main-flow">' + action + '</div>' + observationHtml(state, messages) + '</div>')
    + '<div class="participant-inspection-stack">' + inspectionHtml(state, calendar) + (summary ? '' : trace) + '</div></div>';
}
