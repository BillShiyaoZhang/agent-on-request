import { conversationTimeline, describeActivity, describeAgentState, workspaceInventory } from './research-conversation.js';

const root = document.getElementById('research-root');
const notice = document.getElementById('research-notice');
const params = new URLSearchParams(location.search);
const readStorage = (storage, key) => { try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; } };
const store = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch { /* The current tab still works without browser storage. */ } };
const ui = { lang: readStorage(localStorage, 'research-language') ?? (navigator.language.startsWith('zh') ? 'zh' : 'en'),
  tab: 'collaboration', mode: 'controlled', busy: false, state: null, catalog: null, meta: null, query: '', queryResult: null, goal: '',
  command: '', commandType: 'auto', conversationTaskId: null,
  policyEffect: 'allow', policyResource: 'availability', selections: new Map(), openDetails: new Set(),
  workspaceId: params.get('workspace'), owner: params.get('owner') === 'Bob' ? 'Bob' : 'Alice', token: null, pin: '', access: false };
const T = (zh, en) => ui.lang === 'zh' ? zh : en;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = value => esc(JSON.stringify(value, null, 2) ?? '');
const contentVersion = value => { let hash = 2166136261; for (const char of JSON.stringify(value) ?? '') hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(36); };
const suffix = value => String(value ?? '').split(':').at(-1);
const statusLabel = value => ({ running: T('协作进行中', 'Working'), needs_owner: T('等待主人决定', 'Owner decision needed'),
  completed: T('已完成', 'Completed'), paused: T('已暂停', 'Paused'), partial: T('部分完成', 'Partially complete'),
  pending: T('待决定', 'Pending'), approved: T('已批准', 'Approved'), denied: T('已拒绝', 'Denied'),
  active: T('有效', 'Active'), revoked: T('已撤销', 'Revoked'), exhausted: T('次数已用尽', 'Exhausted'),
  expired: T('已过期', 'Expired'), succeeded: T('执行成功', 'Succeeded'), confirmed: T('已确认', 'Confirmed'),
  received: T('已收到', 'Received'), prepared: T('已准备', 'Prepared'), dispatching: T('正在执行', 'Executing'),
  uncertain: T('结果待核实', 'Awaiting verification'), failed: T('执行失败', 'Failed'), waiting_peer: T('等待对方', 'Waiting for peer'),
  complete: T('已提交进度', 'Progress saved'), working: T('工作中', 'Working') }[value] ?? value);
const taskTitle = type => ({ schedule: T('约一次学术讨论', 'Find a discussion time'), select_presentation: T('选择共同参加的报告', 'Choose a shared presentation'),
  prepare_discussion: T('共同筹备专题讨论', 'Prepare a joint discussion'), research_work: T('我的研究任务', 'My research task') }[type] ?? type);
const actionTitle = action => action === 'reservation.submit' ? T('提交场地预约', 'Submit a venue reservation') : T('向对方分享资料', 'Share information with the peer');
const purposeTitle = value => value === 'academic_coordination' ? T('学术交流与协作', 'Academic coordination') : value;
const resourceTitle = value => ({ availability: T('约见所需忙闲', 'Scoped availability'), 'report-interests': T('报告兴趣', 'Presentation interests'), public: T('主人确认公开的资料', 'Owner-confirmed public materials') }[value] ?? value);
const timeText = value => value ? new Date(value).toLocaleString(ui.lang === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', hour12: false }) : T('直到撤销', 'Until revoked');
const base = () => `/api/research/workspaces/${encodeURIComponent(ui.workspaceId)}`;
const credentialKey = () => `research-owner:${ui.workspaceId}:${ui.owner}`;
const currentTask = () => ui.state?.tasks?.at(-1);

async function api(route, data, token = ui.token) {
  const response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', headers: {
    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message ?? `HTTP ${response.status}`); error.code = result.error?.code; throw error; }
  return result;
}
function notify(message, error = false) { notice.hidden = !message; notice.className = `notice${error ? ' error' : ''}`; notice.textContent = message ?? ''; }
function remember() {
  const record = { workspaceId: ui.workspaceId, owner: ui.owner, token: ui.token };
  store(sessionStorage, credentialKey(), record);
  if (ui.owner === 'Alice') store(localStorage, 'research-alice-resume', record);
}
function details(id, title, body, open = false) {
  return `<details data-detail="${esc(id)}" ${ui.openDetails.has(id) || open ? 'open' : ''}><summary>${title}</summary>${body}</details>`;
}
function captureDetails() { root.querySelectorAll('details[data-detail]').forEach(element => { if (element.open) ui.openDetails.add(element.dataset.detail); else ui.openDetails.delete(element.dataset.detail); }); }
function render(force = false) {
  document.documentElement.lang = ui.lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('research-language').textContent = ui.lang === 'zh' ? 'English' : '中文';
  document.getElementById('page-subtitle').textContent = T('跨领域研究协作', 'Cross-domain research collaboration');
  document.getElementById('console-link').textContent = T('控制台', 'Operator console');
  document.getElementById('research-footer').textContent = T('全部人物、研究资料、日程与预约服务均为虚构数据。', 'All people, research materials, calendars and reservation services are fictional.');
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  if (!force && focused?.matches('select,input[type="checkbox"]')) return;
  const focus = focused?.id ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd }
    : focused?.matches('summary') && focused.parentElement.dataset.detail ? { detail: focused.parentElement.dataset.detail } : null;
  const scroll = new Map([...root.querySelectorAll('[data-chat-scroll]')].map(element => [element.dataset.chatScroll,
    { element, lang: element.dataset.renderLang, top: element.scrollTop, atEnd: element.scrollHeight - element.clientHeight - element.scrollTop < 64 }]));
  captureDetails();
  if (ui.access) { root.innerHTML = accessView(); return; }
  if (!ui.state) { root.innerHTML = welcomeView(); return; }
  root.innerHTML = workspaceView();
  root.querySelectorAll('[data-chat-scroll]').forEach(element => {
    const previous = scroll.get(element.dataset.chatScroll);
    if (previous?.lang === ui.lang) {
      const existing = new Map([...previous.element.children].filter(entry => entry.dataset.activity).map(entry => [entry.dataset.activity, entry]));
      const next = [...element.children].map(entry => {
        const saved = existing.get(entry.dataset.activity);
        return saved && saved.dataset.version === entry.dataset.version ? saved : entry;
      });
      next.forEach((entry, index) => { if (previous.element.children[index] !== entry) previous.element.insertBefore(entry, previous.element.children[index] ?? null); });
      while (previous.element.children.length > next.length) previous.element.lastElementChild.remove();
      element.replaceWith(previous.element);
      element = previous.element;
    }
    element.scrollTop = !previous || previous.atEnd ? element.scrollHeight : previous.top;
  });
  if (focus) {
    const element = focus.detail ? root.querySelector(`details[data-detail="${CSS.escape(focus.detail)}"] > summary`) : document.getElementById(focus.id);
    if (element && !element.disabled) {
      element.focus({ preventScroll: true });
      if (typeof focus.start === 'number' && element.setSelectionRange) element.setSelectionRange(focus.start, focus.end);
    }
  }
}
function welcomeView() {
  return `<section class="panel research-hero"><div><p class="eyebrow">SEMANTICS × HUMAN–COMPUTER INTERACTION</p>
    <h1>${T('各自理解世界，一起完成研究协作。', 'Independent knowledge. Shared research work.')}</h1>
    <p>${T('认识 Alice 的知识图谱研究助理和 Bob 的人机交互研究助理，体验从约时间到语义对齐，再到主人参与的协作。', 'Meet Alice’s semantic research assistant and Bob’s HCI assistant. Coordinate time, align meaning, and delegate work with owner decisions.')}</p></div>
    <button class="button primary" data-action="create" ${ui.busy ? 'disabled' : ''}>${T('开始一位新观众的体验', 'Start a new visitor experience')}</button></section>
    <div class="research-personas">${persona('Alice', false)}${persona('Bob', false)}</div>
    <section class="panel"><h2>${T('三个逐步深入的场景', 'Three connected scenarios')}</h2><div class="research-flow"><div>01 · ${T('找到共同时间', 'Coordinate time')}</div><div>02 · ${T('理解彼此的概念', 'Align meaning')}</div><div>03 · ${T('决定披露什么', 'Choose what to disclose')}</div><div>04 · ${T('批准操作，查看结果', 'Approve actions, inspect results')}</div></div></section>`;
}
function persona(role, active = true) {
  const own = role === ui.owner;
  const profile = ui.state?.owner === role ? ui.state.profile : null;
  const definition = profile ?? ui.catalog?.profiles?.[role];
  const knowledge = role === 'Alice';
  return `<article class="panel research-persona ${own ? '' : 'peer'}"><div class="persona-label"><h2>${role}</h2><span class="tag ${active && own ? 'good' : ''}">${active ? own ? T('你代表的主人', 'Your owner perspective') : T('合作伙伴', 'Collaborator') : T('个人研究助理', 'Personal research assistant')}</span></div>
    <strong>${knowledge ? T('知识图谱与语义技术研究者', 'Knowledge graphs & semantic technologies') : T('人机交互研究者', 'Human–computer interaction')}</strong>
    <p>${knowledge ? T('研究问题 → 语义模型 → 映射与实验 → 有证据的结论', 'Research questions → semantic models → mappings & experiments → supported claims') : T('使用情境 → 交互方案 → 用户研究 → 观察与设计启示', 'Use contexts → interaction designs → user studies → observations & implications')}</p>
    <small>${definition?.ontology?.version ? `${T('应用本体版本', 'Application ontology')} ${esc(definition.ontology.version)} · ${definition.skills?.length ?? definition.skillCount ?? 0} skills` : ''}</small>
    ${active && own ? `<div class="toolbar"><button class="button quiet" data-tab="knowledge">${T('检索我的知识', 'Search my knowledge')}</button><button class="button quiet" data-tab="ontology">${T('查看本体与技能', 'Inspect ontology & skills')}</button></div>` : ''}</article>`;
}
function workspaceView() {
  const task = currentTask(); const policies = ui.state.authorizations?.policies ?? [];
  const received = (ui.state.messages ?? []).filter(message => message.to === ui.owner);
  return `<section class="panel research-hero research-workspace-hero"><div><p class="eyebrow">RESEARCH COLLABORATION</p><h1>${T('两位研究者，各有知识与决定权。', 'Two researchers, independent knowledge and authority.')}</h1>
      <p>${T('助理自主查找、协商和准备；具体披露与正式预约由主人决定。结果来自实际回执。', 'Assistants research, negotiate and prepare autonomously. Owners decide sensitive disclosures and bookings. Receipts establish the outcome.')}</p>
      <div class="research-stats"><div class="research-stat"><strong>${ui.state.profile?.ontology?.modules?.length ?? 0}</strong><span>${T('本体模块', 'ontology modules')}</span></div><div class="research-stat"><strong>${ui.state.profile?.skills?.length ?? 0}</strong><span>skills</span></div><div class="research-stat"><strong>${received.length}</strong><span>${T('实际收到的信息', 'confirmed receptions')}</span></div><div class="research-stat"><strong>${policies.filter(p => p.status === 'active').length}</strong><span>${T('长期规则', 'standing rules')}</span></div></div></div>
    <label class="field research-mode"><span>${T('体验方式', 'Execution mode')}</span><select id="research-mode" ${ui.busy ? 'disabled' : ''}><option value="controlled" ${ui.mode === 'controlled' ? 'selected' : ''}>${T('Guided · 可重复的离线流程', 'Guided · reproducible offline workflow')}</option><option value="native" ${ui.mode === 'native' ? 'selected' : ''} ${ui.catalog?.nativeAvailable ? '' : 'disabled'}>${T('Hermes · 原生技能与多轮工具', 'Hermes · native skills & multi-tool runs')}</option></select><small>${ui.catalog?.nativeAvailable ? T('双方使用各自独立的运行环境。', 'Each agent uses its own runtime.') : T('原生 Hermes 尚未配置，Guided 可直接体验。', 'Native Hermes is not configured; Guided is available.')}</small></label></section>
    ${ui.tab === 'collaboration' ? '' : `<div class="research-personas">${persona(ui.owner)}${persona(ui.owner === 'Alice' ? 'Bob' : 'Alice')}</div>`}
    <div class="research-workspace-line"><small>${T('当前身份空间', 'Identity workspace')} <span class="mono">${esc(ui.workspaceId)}</span></small><div class="toolbar">${ui.owner === 'Alice' ? `<a class="button" href="/research.html?workspace=${encodeURIComponent(ui.workspaceId)}&owner=Bob" target="_blank" rel="noopener">${T('打开 Bob 主人窗口', 'Open Bob’s owner window')}</a><button class="button quiet" data-action="create" ${ui.busy ? 'disabled' : ''}>${T('下一位观众 · 新建身份', 'Next visitor · new identity')}</button>` : `<span class="tag">${T('Bob 的独立授权窗口', 'Bob’s independent owner window')}</span>`}</div></div>
    <nav class="app-tabs research-tabs" aria-label="${T('研究协作视图', 'Research views')}">${[['collaboration', T('协作任务', 'Collaboration')], ['workspace', T('我的工作区', 'My workspace')], ['knowledge', T('知识与证据', 'Knowledge & evidence')], ['ontology', T('本体与技能', 'Ontology & skills')], ['authorization', T('授权记忆', 'Authorization memory')]].map(([id, label]) => `<button class="tab" data-tab="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
    <section class="research-content">${ui.tab === 'workspace' ? workspaceInspectionView() : ui.tab === 'knowledge' ? knowledgeView() : ui.tab === 'ontology' ? ontologyView() : ui.tab === 'authorization' ? authorizationView() : collaborationView(task)}</section>`;
}
function collaborationView(task) {
  const active = ui.state.tasks.some(item => ['running', 'needs_owner'].includes(item.status));
  const selected = ui.state.tasks.find(item => item.id === ui.conversationTaskId) ?? task;
  const copy = { schedule: T('读取各自日程，分享有限忙闲，找到共同空闲的 30 分钟。', 'Read each calendar, exchange scoped availability and find 30 shared minutes.'),
    select_presentation: T('保留不同研究需求，区分等价、相关与同词异义，选择共同报告。', 'Preserve different interests; distinguish equivalent, related and different meanings to select a shared talk.'),
    prepare_discussion: T('准备议程和材料；决定分享哪些内容，再独立批准最终场地预约。', 'Prepare an agenda and materials, choose what to disclose, then separately approve the final venue booking.') };
  return `<div class="research-task-grid research-launchers">${['schedule', 'select_presentation', 'prepare_discussion'].map((type, index) => `<article class="panel research-task-card ${task?.type === type ? 'active' : ''}"><span class="task-number">0${index + 1}</span><h3>${taskTitle(type)}</h3><p>${copy[type]}</p><button class="button ${index === 0 ? 'primary' : ''}" data-action="start" data-type="${type}" ${ui.busy || active || ui.owner !== 'Alice' ? 'disabled' : ''}>${T('开始 · 发给 Alice', 'Start · send to Alice')}</button></article>`).join('')}</div>
    ${ui.owner === 'Bob' ? `<p class="notice">${T('共同任务由 Alice 发起。这个窗口查看 Bob 的知识、收件和待决定事项。', 'Alice initiates shared tasks. This window shows Bob’s own knowledge, incoming information and owner decisions.')}</p>` : ''}
    <div class="research-conversation-heading"><div><h2>${T('观察两个 agent 的协作', 'Watch both agents collaborate')}</h2><p>${T('阅读协作消息，关注各自进展；需要你授权时会醒目标出。', 'Follow the conversation and each agent’s progress. Requests for your authorization are highlighted.')}</p></div>
      ${ui.state.tasks.length ? `<label class="field"><span>${T('查看任务', 'Conversation')}</span><select id="conversation-task">${ui.state.tasks.slice().reverse().map(item => `<option value="${esc(item.id)}" ${item.id === selected?.id ? 'selected' : ''}>${taskTitle(item.type)} · ${esc(statusLabel(item.status))}</option>`).join('')}</select></label>` : ''}</div>
    ${selected ? `<div class="research-conversation-status"><span class="tag ${selected.status === 'needs_owner' ? 'warn' : selected.status === 'completed' ? 'good' : ''}">${esc(statusLabel(selected.status))}</span><strong>${taskTitle(selected.type)}</strong><span>${selected.mode === 'native' ? T('Hermes 原生运行', 'Native Hermes run') : T('Guided：实际执行的固定流程', 'Guided: executed deterministic workflow')}</span>${selected.status === 'paused' || selected.status === 'partial' ? `<button class="button" data-action="resume" data-id="${esc(selected.id)}" ${ui.busy ? 'disabled' : ''}>${T('核验并恢复', 'Verify & resume')}</button>` : ''}</div>` : ''}
    <div class="research-conversations">${agentConversation('Alice', selected, active)}${agentConversation('Bob', selected, active)}</div>
    ${selected ? details(`conversation-result-${selected.id}`, T('任务结果、语义对齐与执行依据', 'Task result, semantic mappings & execution evidence'), taskView(selected)) : ''}
    ${details('message-receipts', T('查看已交付资料与回执', 'Inspect delivered information and receipts'), communicationView())}`;
}
function presetCommand(type) {
  return ({ schedule: T('请和 Bob 约一次 30 分钟的学术讨论。', 'Please arrange a 30-minute academic discussion with Bob.'),
    select_presentation: T('请和 Bob 选择一场共同参加的报告。', 'Please choose a presentation to attend together with Bob.'),
    prepare_discussion: T('请和 Bob 筹备学术讨论。先准备一份未公开研究材料的分享方案交给我审阅，再根据实际获准交换的内容安排议程，最后把场地预约表单交给我决定是否提交。', 'Please prepare a discussion with Bob. First bring me a proposal for sharing unpublished research material, then prepare the agenda from the information actually approved and exchanged. Bring me the final venue form to decide whether to submit it.') })[type];
}
function endpointTitle(value) {
  if (value === 'Alice' || value === 'Bob') return `${value} agent`;
  if (/^(owner:)?Alice(:owner)?$/.test(value ?? '') || /^(owner:)?Bob(:owner)?$/.test(value ?? '')) return `${String(value).replace('owner:', '').replace(':owner', '')} ${T('的主人', 'owner')}`;
  return ({ owner: T('主人', 'Owner'), user: T('主人', 'Owner'), service: T('执行服务', 'Execution service'),
    'local-tools': T('本地工具', 'Local tools'), 'conference-reservations': T('场地预约服务', 'Venue service'), controller: T('协作控制器', 'Collaboration controller'), system: T('系统', 'System') })[value] ?? value ?? '';
}
function activityTitle(entry) {
  if (entry.kind === 'message' && entry.name === 'peer_request' && entry.direction === 'incoming') return T('收到合作方的信息请求', 'Information request received from peer');
  const names = { knowledge_search: T('检索本地研究知识', 'Search own research knowledge'), knowledge_record: T('保存研究知识', 'Save research knowledge'),
    ontology_describe: T('读取本体定义', 'Read ontology definitions'), peer_describe: T('读取合作方定义', 'Read peer definitions'),
    artifact_prepare: T('准备工作草稿', 'Prepare a draft'), artifact_revise: T('修订工作草稿', 'Revise a draft'),
    peer_request: T('向合作方请求信息', 'Request information from peer'), peer_send: T('发送获准信息', 'Send authorized information'),
    alignment_propose: T('提出语义对应', 'Propose semantic mappings'), alignment_accept: T('审阅语义对应', 'Review semantic mappings'),
    authorization_check: T('检查当前许可', 'Check current permission'), authorization_list: T('取回授权记忆', 'Retrieve authorization memory'),
    authorization_request: T('请求主人决定', 'Request an owner decision'), authorization_propose_policy: T('提议长期规则', 'Propose a standing rule'),
    resource_search: T('查询场地', 'Search venues'), reservation_submit: T('提交已批准预约', 'Submit approved booking'), receipt_inspect: T('核验实际回执', 'Inspect actual receipts'),
    task_checkpoint: T('保存任务进度', 'Save a checkpoint'), task_status: T('读取当前任务', 'Read task state'),
    assistant_response: T('Agent 给主人的回复', 'Agent reply to owner'), verified_result: T('向主人汇报核验结果', 'Report verified result to owner'),
    owner_decision: T('收到主人的具体决定', 'Owner decision received'), owner_policy_decision: T('收到主人的规则决定', 'Owner policy decision received'),
    native_run: T('原生 Agent 运行', 'Native agent run'), task_resume: T('取回任务并继续', 'Retrieve and resume task'),
    research_skills_list: T('查询可用技能', 'List available skills'), research_skill_view: T('读取技能方法', 'Read skill instructions') };
  return names[entry.name] ?? ({ command: T('收到主人的指令', 'Owner instruction received'), tool: T('执行工具', 'Tool action'),
    message: T('协作消息', 'Collaboration message'), approval: T('主人授权', 'Owner authorization'), checkpoint: T('任务进度', 'Task checkpoint'),
    result: T('向主人汇报核验结果', 'Report verified result to owner'), response: T('Agent 给主人的回复', 'Agent reply to owner'), run: T('Agent 运行状态', 'Agent run status') })[entry.kind] ?? entry.name ?? entry.kind;
}
const activityTime = value => value ? new Date(value).toLocaleTimeString(ui.lang === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const workStatus = value => ({ running: T('进行中', 'Working'), completed: T('已完成', 'Complete'), failed: T('含错误记录', 'Contains an error'), waiting_peer: T('等待合作方', 'Waiting for peer'), needs_owner: T('等待授权', 'Awaiting approval'), paused: T('已暂停', 'Paused'), recorded: T('已记录', 'Recorded') })[value] ?? statusLabel(value);
function elapsedText(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const seconds = Math.round(milliseconds / 1000);
  if (!seconds) return T('不到 1 秒', '< 1 sec');
  return seconds < 60 ? T(`${seconds} 秒`, `${seconds} sec`) : T(`${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`, `${Math.floor(seconds / 60)} min ${seconds % 60} sec`);
}
function toolCallView(records) {
  const first = records.find(entry => entry.status === 'started') ?? records[0];
  const last = records.at(-1), completed = records.findLast(entry => entry.status !== 'started');
  const running = !completed && last.status === 'started';
  const status = running ? T('进行中', 'Running') : last.status === 'failed' ? T('失败', 'Failed') : T('已完成', 'Complete');
  const readable = activityTitle(first), privateOutput = records.some(entry => entry.redacted || entry.detailsOmitted);
  const input = records.find(entry => !entry.redacted && !entry.detailsOmitted && entry.details?.arguments !== undefined)?.details.arguments;
  const output = records.findLast(entry => entry.status !== 'started' && !entry.redacted && !entry.detailsOmitted)?.details;
  const duration = first.status === 'started' && completed && first.at && completed.at ? Date.parse(completed.at) - Date.parse(first.at) : null;
  return `<div class="research-tool-call ${running ? 'is-running' : last.status === 'failed' ? 'is-failed' : ''}">${details(`tool-${first.role}-${first.callId ?? first.id}`, `<span class="research-tool-title">${esc(readable)}</span><span class="research-tool-state">${esc(status)}</span>`,
    `<div class="research-tool-body"><div class="research-tool-identity"><code>${esc(first.name ?? T('工具', 'tool'))}</code><time datetime="${esc(first.at)}">${esc(activityTime(first.at))}</time>${duration !== null ? `<span>${esc(elapsedText(duration))}</span>` : ''}</div>
    ${input !== undefined ? details(`tool-input-${first.id}`, T('调用参数 · JSON', 'Input · JSON'), `<pre>${pretty(input)}</pre>`) : ''}
    ${output !== undefined ? details(`tool-output-${first.id}`, last.status === 'failed' ? T('实际错误 · JSON', 'Actual error · JSON') : T('实际输出 · JSON', 'Output · JSON'), `<pre>${pretty(output.result ?? output)}</pre>`) : ''}
    ${privateOutput ? `<p class="research-chat-private">${T('本地调用内容仅该 agent 的主人可见。', 'Local call contents are visible only to this agent’s owner.')}</p>` : ''}
    ${input === undefined && output === undefined && !privateOutput ? `<p class="research-chat-private">${running ? T('工具尚未返回输出。', 'The tool has not returned an output yet.') : T('这条记录未包含调用参数或输出。', 'This record does not contain input or output data.')}</p>` : ''}</div>`)}</div>`;
}
function stepRecords(entries) {
  const tools = new Map();
  entries.filter(entry => entry.kind === 'tool').forEach(entry => { const key = entry.callId ?? entry.id; if (!tools.has(key)) tools.set(key, []); tools.get(key).push(entry); });
  const seen = new Set();
  return entries.map(entry => {
    if (entry.kind === 'tool') { const key = entry.callId ?? entry.id; if (seen.has(key)) return ''; seen.add(key); return toolCallView(tools.get(key)); }
    const narrative = describeActivity(entry, { lang: ui.lang, task: ui.state.tasks.find(task => task.id === entry.taskId), conference: ui.state.conference });
    return `<div class="research-step-record kind-${esc(entry.kind)}"><div class="research-step-record-heading"><span>${esc(narrative.title)}</span><time datetime="${esc(entry.at)}">${esc(activityTime(entry.at))}</time></div>${narrative.body ? `<p>${esc(narrative.body)}</p>` : ''}${entry.redacted || entry.detailsOmitted ? `<small>${T('本地记录的内容仅该 agent 的主人可见。', 'Local record contents are visible only to this agent’s owner.')}</small>` : ''}</div>`;
  }).join('');
}
function workStepView(step) {
  const duration = elapsedText(step.durationMs);
  const icon = ({ running: '◌', failed: '!', completed: '✓', needs_owner: '!', waiting_peer: '↔', paused: 'Ⅱ', recorded: '·' })[step.status] ?? '·';
  const title = `<span class="research-work-icon" aria-hidden="true">${icon}</span><span class="research-work-heading"><strong>${esc(step.title)}</strong><span class="research-work-meta"><span class="research-work-status">${esc(workStatus(step.status))}</span><span>${step.toolCallCount} ${T('次工具调用', 'tool calls')}</span>${duration ? `<span>${esc(duration)}</span>` : ''}</span></span><span class="research-work-chevron" aria-hidden="true">›</span>`;
  return `<div class="research-work-step status-${esc(step.status)}" data-activity="${esc(step.id)}" data-version="${contentVersion([ui.lang, step])}">${details(`work-${step.id}`, title,
    `<div class="research-work-body">${step.summary ? `<p class="research-work-summary"><span>${T('进度摘要', 'Progress summary')}</span>${esc(step.summary)}</p>` : ''}<div class="research-work-records">${stepRecords(step.entries)}</div></div>`)}</div>`;
}
function activityView(entry, direction = entry.direction ?? 'local') {
  const narrative = describeActivity(entry, { lang: ui.lang, task: ui.state.tasks.find(task => task.id === entry.taskId), conference: ui.state.conference });
  const route = entry.from && entry.to ? `${endpointTitle(entry.from)} → ${endpointTitle(entry.to)}` : endpointTitle(entry.to ?? entry.from);
  const audience = direction === 'outgoing' ? `${T('发给', 'To')} ${endpointTitle(entry.to ?? `owner:${entry.role}`)}`
    : direction === 'incoming' ? `${T('来自', 'From')} ${endpointTitle(entry.from ?? `owner:${entry.role}`)}` : T('进展更新', 'Progress update');
  const awaiting = entry.kind === 'approval' && entry.status === 'pending';
  const decisionId = awaiting && entry.role === ui.owner ? entry.requestId ?? entry.details?.id : null;
  return `<article class="research-chat-entry research-audience-message ${esc(direction)} kind-${esc(entry.kind)}" data-activity="${esc(entry.id)}" data-version="${contentVersion([ui.lang, entry, direction, narrative])}">
    <div class="research-chat-meta"><span class="research-recipient ${awaiting ? 'requires-approval' : ''}">${esc(audience)}</span><time datetime="${esc(entry.at)}">${esc(activityTime(entry.at))}</time></div>
    <strong class="research-chat-title">${esc(narrative.title)}</strong>
    ${narrative.body ? `<p class="research-chat-text">${esc(narrative.body)}</p>` : ''}
    ${entry.kind === 'response' ? `<small class="research-chat-private">${T('Agent 的说明；操作是否完成以回执核验为准。', 'Agent explanation; receipts establish whether an action completed.')}</small>` : ''}
    ${decisionId ? `<a class="research-inline-decision" href="#approval-${esc(decisionId)}">${T('查看内容并决定', 'Review and decide')} ↓</a>` : ''}
    ${entry.details || entry.name ? details(`activity-${entry.id}`, T('查看记录', 'View record'), `<p class="research-chat-route">${esc(route)}</p><pre>${pretty({ name: entry.name, status: entry.status, ...(!entry.redacted && entry.text ? { originalText: entry.text } : {}), ...(entry.redacted || entry.detailsOmitted || entry.details === undefined ? {} : { details: entry.details }) })}</pre>`) : ''}
  </article>`;
}
function commandComposer(active) {
  if (ui.owner !== 'Alice') return `<div class="research-chat-composer-note">${T('共同任务由 Alice 的主人发起。你可以在这里观察双方的协作。', 'Alice’s owner initiates shared tasks. You can observe both agents here.')}</div>`;
  return `<form id="research-command" class="research-chat-composer"><label class="field"><span>${T('向 Alice agent 发送指令', 'Send an instruction to Alice agent')}</span><textarea id="research-command-input" rows="2" maxlength="4000" placeholder="${T('例如：请和 Bob 找到共同空闲时间，约一次学术讨论。', 'For example: find shared availability with Bob for an academic discussion.')}" ${ui.busy || active ? 'disabled' : ''} required>${esc(ui.command)}</textarea></label><div class="research-composer-actions"><label class="field"><span class="sr-only">${T('任务类型', 'Task type')}</span><select id="research-command-type" ${ui.busy || active ? 'disabled' : ''}><option value="auto" ${ui.commandType === 'auto' ? 'selected' : ''}>${T('自动识别场景', 'Recognize scenario')}</option>${['schedule', 'select_presentation', 'prepare_discussion'].map(type => `<option value="${type}" ${ui.commandType === type ? 'selected' : ''}>${taskTitle(type)}</option>`).join('')}${ui.catalog?.nativeAvailable ? `<option value="research_work" ${ui.commandType === 'research_work' ? 'selected' : ''}>${T('个人研究任务 · Hermes', 'Private research · Hermes')}</option>` : ''}</select></label><button class="button primary" ${ui.busy || active ? 'disabled' : ''}>${T('发送指令', 'Send instruction')} <span aria-hidden="true">↑</span></button></div><small>${active ? T('当前任务进行中；主人决定或恢复按钮会继续原任务。', 'A task is active. Owner decisions or Resume continue that task.') : T('上方开始按钮会发送同样可见的指令；也可自行输入。', 'The Start buttons send a visible instruction here. You can also write your own.')}</small></form>`;
}
function agentConversation(role, task, active) {
  const entries = (ui.state.activity ?? []).filter(entry => entry.role === role && (!task || entry.taskId === task.id)).slice().sort((a, b) => a.sequence - b.sequence);
  const own = ui.owner === role;
  const timeline = conversationTimeline(entries, { role, task, lang: ui.lang, conference: ui.state.conference });
  const progress = describeAgentState({ role, task, entries: (ui.state.activity ?? []).filter(entry => entry.taskId === task?.id), owner: ui.owner, requests: ui.state.authorizations?.requests ?? [], policyCandidates: ui.state.policyCandidates ?? [], lang: ui.lang });
  const decisionId = own && progress.requestIds.length ? `approval-${progress.requestIds[0]}` : null;
  return `<section class="panel research-chat-panel ${role === 'Bob' ? 'bob' : 'alice'}" aria-labelledby="agent-${role}-heading"><header class="research-chat-header"><div class="research-agent-avatar" aria-hidden="true">${role === 'Alice' ? 'A' : 'B'}</div><div><h3 id="agent-${role}-heading">${role} <span>agent ${role === 'Alice' ? 'A' : 'B'}</span></h3><small>${role === 'Alice' ? T('知识图谱与语义技术', 'Knowledge graphs & semantics') : T('人机交互', 'Human–computer interaction')}</small></div><span class="tag ${own ? 'good' : ''}">${own ? T('你的助理', 'Your agent') : T('合作 agent', 'Peer agent')}</span></header>
    <div class="research-agent-now tone-${esc(progress.tone)}" role="status" aria-live="polite" aria-atomic="true"><div class="research-agent-now-label"><span class="research-state-dot" aria-hidden="true"></span><strong>${esc(progress.label)}</strong>${progress.tone === 'approval' ? `<span class="research-human-badge">${T('需要人类授权', 'Human authorization')}</span>` : ''}</div><p>${esc(progress.body)}</p>${decisionId ? `<a class="button research-decision-jump" href="#${esc(decisionId)}">${T('查看内容并决定', 'Review and decide')} ↓</a>` : ''}</div>
    <div class="research-chat-log" data-chat-scroll="${role}:${esc(task?.id ?? 'empty')}" data-render-lang="${ui.lang}" role="log" aria-label="${role} ${T('协作对话', 'conversation')}" aria-live="polite" aria-relevant="additions" tabindex="0">${timeline.length ? timeline.map(item => item.kind === 'step' ? workStepView(item) : activityView(item.entry, item.direction)).join('') : `<div class="research-chat-empty"><span aria-hidden="true">${role === 'Alice' ? 'A' : 'B'}</span><p>${task ? T('正在开展本地工作；实际进度和协作消息会按顺序显示在这里。', 'Working locally. Actual progress and collaboration messages will appear here in order.') : role === 'Alice' ? T('点击开始，或在下方输入指令。主人的命令会首先出现在这里。', 'Choose Start or write an instruction below. The owner’s command appears here first.') : T('Alice 发起协作后，这里展示 Bob 收到的消息和回复。', 'When Alice starts collaborating, Bob’s received messages and replies appear here.')}</p></div>`}</div>
    ${own ? `<div class="research-chat-decisions">${approvalViews(task?.id)}${policyCandidateViews(task?.id)}</div>` : ''}
    ${role === 'Alice' ? commandComposer(active) : `<div class="research-chat-composer-note">${T('这里只展示实际收到的内容；本地私有资料由各自主人的窗口查看。', 'Only actually received content appears here. Each owner can inspect their local private materials in their own window.')}</div>`}
  </section>`;
}
function approvalViews(taskId) {
  const pending = (ui.state.authorizations?.requests ?? []).filter(request => request.status === 'pending' && (!taskId || request.intent.taskId === taskId));
  if (!pending.length) return '';
  return pending.map(request => {
    const key = `${request.id}:${request.revision}`;
    if (!ui.selections.has(key)) ui.selections.set(key, new Set(request.intent.fields));
    const selected = ui.selections.get(key); const booking = request.intent.action === 'reservation.submit';
    return `<section class="panel research-approval" aria-labelledby="approval-${esc(request.id)}"><div class="research-status-line"><h2 id="approval-${esc(request.id)}" tabindex="-1">${T('这一步由你决定', 'Your decision is needed')}</h2><span class="tag warn">${esc(actionTitle(request.intent.action))}</span></div>
      <div class="approval-context"><span class="tag">${T('接收方', 'Recipient')}: ${esc(request.intent.recipient === 'conference-reservations' ? T('会议场地预约服务', 'Conference reservation service') : request.intent.recipient)}</span><span class="tag">${T('用途', 'Purpose')}: ${esc(purposeTitle(request.intent.purpose))}</span><span class="tag">${T('许可', 'Permission')}: ${T('仅这次操作', 'this operation only')}</span></div>
      <p>${booking ? T('下面是将提交的完整预约表单。批准资料分享不会同时批准这次预约。', 'This is the complete reservation form. A material-sharing grant does not approve this booking.') : T('选择允许发送的具体字段。未勾选内容会保留在本地；只分享摘要也可以继续协作。', 'Choose the exact fields to send. Unselected content stays local; the collaboration can continue with a summary.')}</p>
      ${request.intent.fields.map(field => `<label class="approval-value"><input type="checkbox" data-request="${esc(request.id)}" data-selection="${esc(key)}" data-field="${esc(field)}" ${selected.has(field) ? 'checked' : ''} ${booking ? 'disabled' : ''}><span><strong>${esc(reviewFieldLabel(field))}</strong><span class="research-review-value">${esc(reviewValue(request.intent.values[field]))}</span></span></label>`).join('')}
      <div class="toolbar"><button class="button primary" data-action="allow" data-id="${esc(request.id)}" ${ui.busy || !selected.size ? 'disabled' : ''}>${booking ? T('批准并继续预约', 'Approve and continue booking') : T('只批准选中内容', 'Approve selected fields')}</button><button class="button" data-action="deny" data-id="${esc(request.id)}" ${ui.busy ? 'disabled' : ''}>${T('拒绝这次请求', 'Decline this request')}</button></div>
      ${details(`approval-proof-${request.id}`, T('查看确切请求与技术细节', 'Inspect exact request & technical details'), `<dl class="definition-list"><dt>${T('资源', 'Resource')}</dt><dd class="mono">${esc(request.intent.resourceId)} @ ${esc(request.intent.resourceVersion)}</dd><dt>${T('请求版本', 'Request revision')}</dt><dd>${request.revision}</dd><dt>Hash</dt><dd class="mono">${esc(request.payloadHash)}</dd></dl><pre>${pretty(request.intent)}</pre>`)}
    </section>`;
  }).join('');
}
function reviewFieldLabel(field) {
  return ({ summary: T('摘要', 'Summary'), method: T('方法', 'Method'), results: T('研究结果', 'Research results'), note: T('内部备注', 'Internal notes'),
    title: T('主题', 'Title'), day: T('日期', 'Day'), time: T('时间', 'Time'), attendees: T('人数', 'Participants'), agenda: T('议程', 'Agenda'), venueId: T('场地', 'Venue'),
    slots: T('空闲时段', 'Available times'), reportIds: T('报告', 'Presentations'), interests: T('研究兴趣', 'Research interests') })[field] ?? field;
}
function reviewValue(value) {
  if (Array.isArray(value)) return value.map(reviewValue).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${reviewFieldLabel(key)}：${reviewValue(item)}`).join('\n');
  const text = String(value ?? '');
  const days = { Mon: T('周一', 'Monday'), Tue: T('周二', 'Tuesday'), Wed: T('周三', 'Wednesday'), Thu: T('周四', 'Thursday'), Fri: T('周五', 'Friday'), Sat: T('周六', 'Saturday'), Sun: T('周日', 'Sunday') };
  const venue = ui.state?.conference?.venues?.find(item => item.id === text);
  return days[text] ?? venue?.label ?? venue?.name ?? text;
}
function taskView(task) {
  const messages = ui.state.messages.filter(message => message.taskId === task.id);
  const phases = task.type === 'research_work' ? [T('读取本地研究知识', 'Read own research knowledge'), T('调用领域技能', 'Use domain skills'), T('保存成果或请求决定', 'Save results or request a decision'), T('核验并汇报', 'Verify & report')] : [T('读取本地知识', 'Read own knowledge'), T('协商与信息交换', 'Negotiate & exchange'), T('主人决定关键动作', 'Owner decisions'), T('核验并汇报', 'Verify & report')];
  const step = task.status === 'completed' || task.status === 'partial' ? 4 : task.status === 'needs_owner' ? 2 : messages.length ? 1 : 0;
  return `<section class="panel"><div class="research-status-line"><h2>${taskTitle(task.type)}</h2><span class="tag ${task.status === 'completed' ? 'good' : task.status === 'needs_owner' ? 'warn' : ''}">${esc(statusLabel(task.status))}</span></div>
    ${task.ownerGoal ? `<p class="lead">${esc(task.ownerGoal)}</p>` : ''}
    <div class="research-flow">${phases.map((phase, index) => `<div class="${step > index ? 'done' : step === index ? 'current' : ''}">${index + 1}. ${phase}</div>`).join('')}</div>
    ${task.error ? `<p class="notice error">${esc(task.error)}</p>` : ''}${resultView(task)}
    ${task.status === 'paused' || task.status === 'partial' ? `<div class="research-actions"><button class="button primary" data-action="resume" data-id="${esc(task.id)}" ${ui.busy ? 'disabled' : ''}>${T('核验状态并恢复', 'Verify state and resume')}</button></div>` : ''}
    ${task.mappings?.length ? `<h3 style="margin-top:16px">${T('本任务接受的对应关系', 'Accepted task mappings')}</h3><div class="research-data-list">${task.mappings.map(mapping => `<article class="research-record"><div class="toolbar"><strong>${esc(mapping.source ?? mapping.id)} → ${esc(mapping.target ?? '')}</strong><span class="tag">${esc(mapping.relation)}</span></div><p>${esc(mapping.reason ?? mapping.condition ?? mapping.definition ?? '')}</p>${details(`mapping-${mapping.id}`, T('对应依据与适用范围', 'Mapping evidence and scope'), `<pre>${pretty(mapping)}</pre>`)}</article>`).join('')}</div>` : ''}
    ${task.proposals?.some(proposal => proposal.status === 'rejected') ? `<section class="notice"><strong>${T('实际发生的对应审阅', 'Recorded correspondence reviews')}</strong>${task.proposals.filter(proposal => proposal.status === 'rejected').map(proposal => `<p>${esc(proposal.reviewedBy ?? T('对方', 'The peer'))} ${T('已拒绝这组对应提议。', 'declined this proposed set of correspondences.')}</p>${details(`rejected-proposal-${proposal.id}`, T('查看提议及双方交换的定义', 'Inspect the proposal and exchanged definitions'), `<div class="research-data-list">${(proposal.mappings ?? []).map(mapping => `<article class="research-record"><strong>${esc(mapping.source)} → ${esc(mapping.target)}</strong><p>${esc(mapping.sourceDefinition ?? '')}</p><p>${esc(mapping.targetDefinition ?? '')}</p><small>${esc(mapping.relation)} · ${esc(mapping.condition ?? '')}</small></article>`).join('')}</div><pre>${pretty(proposal)}</pre>`)}`).join('')}</section>` : ''}
    ${details(`task-${task.id}`, T('查看本体工作子集与协作进度', 'Inspect working ontology and progress'), `<div class="research-evidence">${Object.entries(task.ontology ?? {}).map(([role, ontology]) => `<article class="research-record"><strong>${esc(role)}</strong>${ontology ? `<p>${(ontology.modules ?? []).map(module => `<span class="tag">${esc(module.name ?? module.id)}</span>`).join(' ')}</p><small class="mono">${esc(ontology.hash)}</small>` : `<p>${T('尚未收到该方的定义。', 'Definitions from this agent have not been received yet.')}</p>`}</article>`).join('')}</div><pre>${pretty({ checkpoints: task.checkpoints, result: task.result, mode: task.mode })}</pre>`)}
  </section>`;
}
function resultView(task) {
  const result = task.result; if (!result) return '';
  let title = T('任务结果已核验', 'Verified task result'); let content = '';
  if (result.outcome === 'common_time_found') content = `<strong>${esc(result.meeting.day)} · ${esc(result.meeting.time)}</strong><p>${T('双方实际收到的忙闲信息支持这个共同时间。', 'Both confirmed availability receipts support this shared interval.')}</p>`;
  else if (result.outcome === 'presentation_selected') content = `<strong>${esc(result.report?.id)} · ${esc(result.report?.title)}</strong><p>${esc(result.report?.day)} · ${esc(result.report?.time)} · ${T('双方需求不同，这场报告分别满足各自需求。', 'The presentation independently meets the two researchers’ different interests.')}</p>`;
  else if (result.outcome === 'discussion_prepared') content = `<strong>${T('专题讨论已准备，场地已确认', 'Discussion prepared; venue confirmed')}</strong><p>${esc(result.reservation?.reservationId)} · ${esc(result.reservation?.venueId)} · ${esc(result.reservation?.day)} ${esc(result.reservation?.time)}</p>`;
  else if (result.outcome === 'prepared_not_submitted') { title = T('已保留准备成果，预约未提交', 'Preparation saved; booking not submitted'); content = `<p>${T('你拒绝了最终操作，议程草稿仍然保留。', 'The final operation was declined. The agenda draft is retained.')}</p>`; }
  else if (result.outcome === 'research_work_saved') { title = T('研究成果已保存', 'Research work saved'); content = `<p>${result.artifacts?.length ?? 0} ${T('份有来源的工作产物', 'sourced artifacts')} · ${result.facts?.length ?? 0} ${T('条研究知识记录', 'research knowledge records')}</p>`; }
  else if (result.outcome === 'policy_remembered') { title = T('长期规则已由主人确认并记住', 'Standing rule confirmed and remembered'); content = `<p>${T('后续任务将检索这条有效规则，并在执行前检查适用范围。', 'Subsequent tasks can retrieve the rule and verify its scope before acting.')}</p>`; }
  else if (result.outcome === 'policy_not_adopted') { title = T('没有采用这条提议规则', 'Proposed rule was not adopted'); content = `<p>${T('原有规则保持不变。agent 的提议没有变成执行许可。', 'Existing rules remain unchanged. The agent’s proposal did not become permission.')}</p>`; }
  else content = `<p>${esc({ no_common_time: T('已交换的信息中没有共同空闲时间。', 'No shared time was found in the exchanged information.'), sharing_declined: T('本次分享被拒绝，任务据此停止。', 'The information request was declined.'), no_shared_presentation: T('没有符合双方需求的共同报告。', 'No presentation meets both researchers’ interests.') }[result.outcome] ?? result.outcome)}</p>`;
  return `<div class="research-result"><h3>${title}</h3>${content}<small>${T('依据', 'Evidence')}: ${result.receipts?.length ?? 0} ${T('条接收回执', 'reception receipts')}${result.reservation ? ` · ${T('预约状态', 'booking status')}: ${esc(statusLabel(result.reservation.status))}` : ''}</small></div>`;
}
function communicationView() {
  const received = ui.state.messages.filter(message => message.to === ui.owner).slice().reverse();
  const sent = ui.state.messages.filter(message => message.from === ui.owner).slice().reverse();
  const message = entry => `<article class="research-record"><div class="toolbar"><strong>${esc(entry.from)} → ${esc(entry.to)}</strong><span class="tag good">${esc(statusLabel(entry.receipt.status))}</span></div><small class="mono">${esc(entry.resourceId)} @ ${esc(entry.sourceVersion)}</small><pre>${pretty(entry.payload)}</pre>${details(`receipt-${entry.id}`, T('实际回执与签名', 'Actual receipt and signature'), `<pre>${pretty(entry.receipt)}</pre>`)}</article>`;
  return `<div class="research-evidence"><section class="panel"><h2>${T('我实际收到的信息', 'Information I actually received')}</h2><div class="research-data-list">${received.length ? received.map(message).join('') : `<p class="research-empty">${T('还没有收到对方的信息。待审批草稿不会出现在这里。', 'No peer information received yet. Pending drafts do not appear here.')}</p>`}</div></section><section class="panel"><h2>${T('我的已发送内容', 'My confirmed sends')}</h2><div class="research-data-list">${sent.length ? sent.map(message).join('') : `<p class="research-empty">${T('还没有已确认的发送。', 'No confirmed sends yet.')}</p>`}</div></section></div>`;
}
function researchGoalView() {
  const active = ui.state.tasks.some(task => ['running', 'needs_owner'].includes(task.status));
  const latest = ui.state.tasks.findLast(task => task.type === 'research_work');
  return `<section class="panel"><div class="research-status-line"><h2>${T('向我的助理委托研究工作', 'Delegate research work to my assistant')}</h2><span class="tag">${T('原生 skills 与工具', 'Native skills & tools')}</span></div><p class="lead">${T('用自然语言提出研究目标，或告诉助理希望以后怎样共享信息。助理会检索自己的知识、保存有来源的成果；长期规则须经你确认才生效。', 'Describe a research goal, or how you would like information shared in future. Your assistant retrieves its own knowledge and saves sourced work. Proposed standing rules take effect only after your confirmation.')}</p>
    <form id="research-goal"><label class="field"><span>${T('研究目标或长期偏好', 'Research goal or standing preference')}</span><textarea id="research-goal-input" maxlength="4000" rows="3" placeholder="${ui.owner === 'Alice' ? T('找出支持这条研究结论的实验和本体版本，整理成简报。', 'Trace the experiments and ontology versions supporting this claim and prepare a brief.') : T('查找支持这个交互设计的用户观察，整理研究发现与局限。', 'Find the user observations supporting this interaction design and summarize findings and limitations.')}" ${ui.catalog?.nativeAvailable ? '' : 'disabled'} required>${esc(ui.goal)}</textarea></label><div class="toolbar" style="margin-top:12px"><button class="button primary" ${ui.busy || active || !ui.catalog?.nativeAvailable ? 'disabled' : ''}>${T('交给我的助理', 'Delegate to my assistant')}</button></div></form>
    ${!ui.catalog?.nativeAvailable ? `<p class="research-warning-copy">${T('需要配置原生 Hermes 才能执行自然语言研究任务。下面的知识检索仍可直接使用。', 'Native Hermes is required for delegated research work. You can still search your knowledge below.')}</p>` : active ? `<small style="margin-top:10px">${T('先完成当前任务中的待办或主人决定。', 'Finish the current task or its pending owner decision first.')}</small>` : ''}</section>${policyCandidateViews()}${latest ? taskView(latest) : ''}`;
}
function policyCandidateViews(taskId) {
  const candidates = (ui.state.policyCandidates ?? []).filter(candidate => candidate.status === 'pending' && (!taskId || candidate.taskId === taskId));
  return candidates.map(candidate => `<section class="panel research-approval"><div class="research-status-line"><h2 id="approval-${esc(candidate.id)}" tabindex="-1">${T('确认助理为你整理的长期规则', 'Review the standing rule proposed by your assistant')}</h2><span class="tag warn">${T('尚未生效', 'Not effective yet')}</span></div><p class="lead">${T('助理把你的要求整理成了下面的明确范围。确认后才写入授权账本；提议本身没有授予任何权限。', 'Your assistant translated the request into this explicit scope. Confirmation writes it to your authorization ledger; the proposal itself grants no authority.')}</p>
    ${candidate.policy.label ? `<strong>${esc(candidate.policy.label)}</strong>` : ''}<dl class="definition-list"><dt>${T('规则', 'Decision')}</dt><dd>${esc({ allow: T('允许', 'Allow'), ask: T('每次询问', 'Ask each time'), deny: T('禁止', 'Deny') }[candidate.policy.effect] ?? candidate.policy.effect)}</dd><dt>${T('动作', 'Actions')}</dt><dd>${esc(candidate.policy.actions.map(actionTitle).join(', '))}</dd><dt>${T('资源范围', 'Resources')}</dt><dd>${esc((candidate.policy.resources?.length ? candidate.policy.resources : [candidate.policy.resourceClass]).filter(Boolean).map(resourceTitle).join(', '))}</dd><dt>${T('接收方', 'Recipients')}</dt><dd>${esc(candidate.policy.recipients.join(', '))}</dd><dt>${T('用途', 'Purposes')}</dt><dd>${esc(candidate.policy.purposes.map(purposeTitle).join(', '))}</dd><dt>${T('期限', 'Validity')}</dt><dd>${T('当前协作项目内，直到撤销', 'Within this collaboration project, until revoked')}</dd></dl>
    ${details(`policy-candidate-${candidate.id}`, T('完整规则与内容指纹', 'Exact rule and content fingerprint'), `<pre>${pretty(candidate.policy)}</pre><small class="mono">${esc(candidate.hash)}</small>`)}<div class="toolbar"><button class="button primary" data-action="allow-policy" data-id="${esc(candidate.id)}" ${ui.busy ? 'disabled' : ''}>${T('确认并记住这条规则', 'Confirm and remember rule')}</button><button class="button" data-action="deny-policy" data-id="${esc(candidate.id)}" ${ui.busy ? 'disabled' : ''}>${T('不采用这条规则', 'Do not adopt rule')}</button></div></section>`).join('');
}
function workspaceInspectionView() {
  const inventory = workspaceInventory(ui.state, { lang: ui.lang });
  if (!inventory) return `<section class="panel"><h2>${T('我的工作区', 'My workspace')}</h2><p class="lead">${T('当前身份尚未保存完整的工作区清单。新建一位观众的体验会从各自的初始文件创建独立空间。', 'This identity has no complete workspace inventory. A new visitor experience creates independent spaces from each researcher’s initial files.')}</p></section>`;
  const { profile } = ui.state;
  const primary = inventory.files.filter(file => !file.path.startsWith('skills/'));
  const skillFiles = inventory.files.filter(file => file.path.startsWith('skills/'));
  const fileRows = files => `<div class="research-workspace-files">${files.map(file => `<article class="research-workspace-file"><div><strong>${esc(file.label)}</strong><code>${esc(file.path)}</code></div><small class="mono" title="${esc(file.hash)}">${esc(file.hash.slice(0, 12))}${file.hash ? '…' : ''}</small></article>`).join('')}</div>`;
  const runtimeFiles = [
    ['profile.json', T('本方当前知识和定义', 'Current own knowledge and definitions')],
    ['inbox.json / outbox.json', T('实际收到和发出的消息', 'Actually received and sent messages')],
    ['artifacts.json', T('本地草稿与工作产物', 'Local drafts and artifacts')],
    ['tasks.json', T('任务进度与本方 checkpoint', 'Task progress and own checkpoints')],
    ['authorization.sqlite', T('本方独立授权账本', 'Own authoritative authorization ledger')],
    ['seed/', T('本次体验使用的初始文件副本', 'Initial files copied for this experience')],
  ];
  const topics = new Map((profile.knowledge?.nodes ?? []).map(node => [node.id, node.label]));
  const annotationRows = (profile.reportAnnotations ?? []).map(annotation => {
    const report = ui.state.conference?.reports?.find(item => item.id === annotation.reportId);
    return `<article class="research-record"><strong>${esc(annotation.reportId)} · ${esc(report?.title ?? '')}</strong><p>${annotation.topicIds?.length ? annotation.topicIds.map(id => esc(topics.get(id) ?? id)).join(' · ') : T('当前没有标注相关的本方研究主题。', 'No related own research topic is currently annotated.')}</p></article>`;
  }).join('');
  return `<section class="panel research-workspace-intro"><div><p class="eyebrow">${esc(inventory.role)} · WORKSPACE</p><h2>${T('我的独立工作区', 'My independent workspace')}</h2><p class="lead">${T('初始文件保存这个研究者的完整起始条件。本次运行的知识、授权、收发件和产物保存在独立目录中。', 'Initial files preserve this researcher’s starting conditions. This experience stores its knowledge, permissions, messages and artifacts in a separate runtime directory.')}</p></div><span class="tag">${T('本方主人视角', 'Own owner perspective')}</span></section>
    <div class="research-workspace-grid"><section class="panel"><div class="research-status-line"><h3>${T('初始内容', 'Initial contents')}</h3><span class="tag good">${inventory.seedVersion ? `v${esc(inventory.seedVersion)}` : T('版本未记录', 'Version not recorded')}</span></div><code class="research-folder-path">${esc(inventory.seedPath)}/</code><p class="research-workspace-copy">${T('每位新观众从这些已审阅的文件开始；这一份初始内容在本次运行中保留。', 'Each new visitor starts from these reviewed files. This initial copy is retained throughout the experience.')}</p>${fileRows(primary)}${skillFiles.length ? details('workspace-skill-files', `${T('技能说明文件', 'Skill instruction files')} · ${skillFiles.length}`, fileRows(skillFiles)) : ''}</section>
    <section class="panel"><h3>${T('本次运行', 'This experience')}</h3><code class="research-folder-path">${esc(inventory.runtimePath)}/</code><div class="research-workspace-counters"><span><strong>${inventory.knowledgeCount}</strong>${T('条本地知识', 'own records')}</span><span><strong>${inventory.materialCount}</strong>${T('份材料', 'materials')}</span><span><strong>${inventory.inboxCount}</strong>${T('封收件', 'received messages')}</span><span><strong>${inventory.outboxCount}</strong>${T('封发件', 'sent messages')}</span><span><strong>${inventory.artifactCount}</strong>${T('份工作产物', 'artifacts')}</span></div><div class="research-workspace-files">${runtimeFiles.map(([name, meaning]) => `<article class="research-workspace-file"><div><strong>${meaning}</strong><code>${name}</code></div></article>`).join('')}</div><div class="toolbar research-actions"><button class="button" data-tab="knowledge">${T('查看知识与证据', 'Inspect knowledge')}</button><button class="button" data-tab="ontology">${T('查看本体与技能', 'Inspect ontology & skills')}</button><button class="button" data-tab="authorization">${T('查看授权账本', 'Inspect permissions')}</button></div></section></div>
    ${annotationRows ? `<section class="panel"><h3>${T('本方如何理解报告', 'My interpretation of presentations')}</h3><p class="research-workspace-copy">${T('这些标注属于本方知识。对方只有在实际收到分享后才会知道。', 'These annotations belong to this researcher. The peer learns them only through actual exchange.')}</p><div class="research-data-list">${annotationRows}</div></section>` : ''}
    <section class="panel"><h3>${T('本地研究材料', 'Local research materials')}</h3><div class="research-data-list">${(profile.materials ?? []).map(material => `<article class="research-record"><div class="toolbar"><strong>${esc(material.label)}</strong><span class="tag">v${esc(material.version)}</span></div><small>${esc(material.id)} · ${material.visibility === 'public' && material.ownerConfirmedVisibility ? T('主人确认可公开', 'Owner-confirmed public') : T('保存在本地，分享需要适用许可', 'Stored locally; disclosure requires applicable permission')}</small>${details(`workspace-material-${material.id}`, T('查看本方材料与来源', 'Inspect own material and sources'), `<div class="research-data-list">${Object.entries(material.fields ?? {}).map(([field, value]) => `<div><strong>${esc(reviewFieldLabel(field))}</strong><p class="research-review-value">${esc(reviewValue(value))}</p></div>`).join('')}</div><small class="mono">${esc((material.sourceIds ?? []).join(', '))}</small>`)}</article>`).join('')}</div></section>
    <section class="panel">${details('workspace-integrity', T('核对初始版本、文件指纹与存储空间', 'Verify seed version, file fingerprints and storage namespace'), `<dl class="definition-list"><dt>${T('初始版本', 'Seed version')}</dt><dd>${esc(inventory.seedVersion || T('未记录', 'Not recorded'))}</dd><dt>Seed hash</dt><dd class="mono">${esc(inventory.seedHash)}</dd><dt>Manifest hash</dt><dd class="mono">${esc(inventory.manifestHash)}</dd><dt>${T('原生 KG namespace', 'Native KG namespace')}</dt><dd class="mono">${esc(inventory.namespace || T('当前使用本机持久化空间', 'Using the local persistent workspace'))}</dd></dl><pre>${pretty(inventory.files)}</pre>`)}</section>`;
}
function knowledgeView() {
  const graph = ui.queryResult ?? ui.state.profile.knowledge; const nodes = graph.nodes ?? []; const edges = graph.edges ?? [];
  const index = new Map(nodes.map(node => [node.id, node]));
  return `${researchGoalView()}<section class="panel"><h2>${T('检索自己的研究知识与证据', 'Search my research knowledge and evidence')}</h2><p class="lead">${ui.owner === 'Alice' ? T('例如：哪些实验和本体版本支持这条研究结论？', 'For example: which experiment and ontology versions support this claim?') : T('例如：哪些观察与研究发现支持这个交互方案？', 'For example: which observations and findings support this interaction design?')}</p>
    <form id="research-query" class="research-query"><label class="field"><span>${T('关键词或记录内容', 'Keyword or record content')}</span><input id="knowledge-query" name="query" value="${esc(ui.query)}" placeholder="${ui.owner === 'Alice' ? 'experiment / claim / mapping' : 'prototype / finding / observation'}"></label><button class="button primary" ${ui.busy ? 'disabled' : ''}>${T('检索并展开两跳证据', 'Search with two evidence hops')}</button><button class="button" type="button" data-action="clear-query">${T('查看全部', 'Show all')}</button></form>
    <div class="toolbar">${(ui.owner === 'Alice' ? ['experiment', 'claim', 'ontology-source'] : ['prototype', 'finding', 'observation']).map(query => `<button class="button quiet" data-query="${query}">${esc(query)}</button>`).join('')}</div>
    <div class="research-stats"><div class="research-stat"><strong>${nodes.length}</strong><span>${T('条知识记录', 'records')}</span></div><div class="research-stat"><strong>${edges.length}</strong><span>${T('条关系', 'relations')}</span></div></div>
    ${edges.length ? `<div class="research-data-list">${edges.slice(0, 25).map(edge => `<div class="research-mini-graph"><span class="tag">${esc(index.get(edge.source)?.label ?? edge.source)}</span><span class="muted">— ${esc(suffix(edge.relation))} →</span><span class="tag">${esc(index.get(edge.target)?.label ?? edge.target)}</span></div>`).join('')}</div>` : ''}
    <div class="research-data-list">${nodes.length ? nodes.map(node => `<article class="research-record"><div class="toolbar"><strong>${esc(node.label)}</strong><span class="tag">${esc(suffix(node.type))}</span></div><small class="mono">${esc(node.id)}</small>${details(`node-${node.id}`, T('内容、版本与来源', 'Content, version and provenance'), `<pre>${pretty(node.properties)}</pre><dl class="definition-list"><dt>${T('版本', 'Version')}</dt><dd>${esc(node.version)}</dd><dt>${T('来源', 'Source')}</dt><dd class="mono">${esc(typeof node.source === 'object' ? JSON.stringify(node.source) : node.source)}</dd></dl>`)}</article>`).join('') : `<p class="research-empty">${T('没有找到匹配记录。', 'No matching records.')}</p>`}</div>
  </section>${ui.state.artifacts.length ? `<section class="panel"><h2>${T('我的工作草稿', 'My working artifacts')}</h2><div class="research-data-list">${ui.state.artifacts.map(artifact => `<article class="research-record"><strong>${esc(artifact.title)}</strong><small>${esc(artifact.kind)} · v${artifact.version} · ${T('保存在本地', 'stored locally')}</small><pre>${pretty(artifact.fields)}</pre><small class="mono">${esc((artifact.sourceRefs ?? []).join(', '))}</small></article>`).join('')}</div></section>` : ''}`;
}
function ontologyView() {
  const ontology = ui.state.profile.ontology;
  return `<section class="panel"><div class="research-status-line"><h2>${T('我的应用 Ontology', 'My application ontology')}</h2><span class="tag">v${esc(ontology.version)}</span></div><p class="lead">${T('这套知识体系同时服务日常研究和本次协作。任务只选取需要的模块；研究中的本体工件不会改变 agent 自身的 schema。', 'This application ontology supports ordinary research and collaboration. Tasks select relevant modules; ontology artifacts studied as research objects do not replace the agent’s own schema.')}</p><small class="mono">${esc(ontology.id)} · ${esc(ontology.hash)}</small>
    ${(ontology.modules ?? []).map(module => `<details class="research-module" data-detail="module-${esc(module.id)}" ${ui.openDetails.has(`module-${module.id}`) ? 'open' : ''}><summary><strong>${esc(module.name)}</strong><span class="tag">${module.concepts?.length ?? 0} ${T('类', 'classes')}</span><code>${esc(module.id)}</code></summary><div class="module-body"><small>${T('依赖', 'Dependencies')}: ${esc((module.dependencies ?? []).join(', ') || '—')}</small><div class="research-data-list">${(module.concepts ?? []).map(concept => `<article class="research-record"><strong>${esc(concept.label ?? concept.id)}</strong><code>${esc(concept.id)}</code><p>${esc(concept.definition)}</p>${concept.parent ? `<small>${T('父类', 'Parent')}: ${esc(concept.parent)}</small>` : ''}${concept.properties?.length ? `<pre>${pretty(concept.properties)}</pre>` : ''}</article>`).join('')}</div>${module.relations?.length ? `<h3 style="margin-top:16px">${T('关系定义', 'Relations')}</h3><div class="research-data-list">${module.relations.map(relation => `<article class="research-record"><strong>${esc(relation.id)}</strong><p>${esc(relation.definition)}</p><small>${esc((relation.domain ?? []).join(', '))} → ${esc((relation.range ?? []).join(', '))}</small></article>`).join('')}</div>` : ''}</div></details>`).join('')}</section>
    <section class="panel"><h2>${T('与知识体系搭配的 Skills', 'Skills that use this knowledge')}</h2><p class="lead">${T('每项技能列出所依赖的模块、输入输出、工具和外部影响。技能说明本身不会授予权限。', 'Each skill declares ontology dependencies, input/output types, tools and side effects. Skill instructions do not grant permission.')}</p><div class="research-skill-grid">${ui.state.profile.skills.map(skill => `<article><h3>${esc(skill.label)}</h3><p>${esc(skill.description)}</p><small class="mono">${esc(skill.id)}</small>${details(`skill-${skill.id}`, T('依赖与执行能力', 'Dependencies and execution capabilities'), `<dl class="definition-list"><dt>${T('模块', 'Modules')}</dt><dd>${esc(skill.modules.join(', '))}</dd><dt>${T('输入', 'Input')}</dt><dd>${esc(skill.inputTypes.join(', '))}</dd><dt>${T('输出', 'Output')}</dt><dd>${esc(skill.outputTypes.join(', '))}</dd><dt>${T('工具', 'Tools')}</dt><dd>${esc(skill.tools.join(', '))}</dd><dt>${T('影响', 'Effects')}</dt><dd>${esc(skill.sideEffects.join(', '))}</dd></dl>`)}</article>`).join('')}</div></section>`;
}
function authorizationView() {
  const a = ui.state.authorizations; const peer = ui.owner === 'Alice' ? 'Bob' : 'Alice';
  return `${approvalViews()}${policyCandidateViews()}<section class="panel"><h2>${T('长期规则', 'Standing rules')}</h2><p class="lead">${T('这些规则跨任务保留。助理可以检索规则，每次发送或预约仍由执行服务检查当前范围、撤销状态和次数。', 'Rules persist across tasks. Assistants can retrieve them; execution checks the current scope, revocations and usage limits for each send or booking.')}</p>
    <div class="research-data-list">${a.policies.map(policy => `<article class="research-record"><div class="toolbar"><strong>${esc(policy.effect)} · ${esc((policy.resources?.length ? policy.resources : [policy.resourceClass]).filter(Boolean).map(resourceTitle).join(', '))}</strong><span class="tag ${policy.status === 'active' ? 'good' : ''}">${esc(statusLabel(policy.status))}</span></div><p>${T('接收方', 'Recipient')}: ${esc(policy.recipients.join(', '))} · ${T('用途', 'Purpose')}: ${esc(policy.purposes.map(purposeTitle).join(', '))}</p><small>${T('有效期', 'Valid')}: ${esc(timeText(policy.expiresAt))} · ${T('已使用', 'Uses')}: ${policy.uses ?? 0}</small>${policy.status === 'active' ? `<button class="button quiet" style="margin-top:10px" data-action="revoke" data-id="${esc(policy.id)}" ${ui.busy ? 'disabled' : ''}>${T('撤销这条规则', 'Revoke rule')}</button>` : ''}${details(`policy-${policy.id}`, T('完整规则与版本', 'Full rule and revision'), `<pre>${pretty(policy)}</pre>`)}</article>`).join('')}</div>
    <form id="research-policy" class="research-rule"><label class="field"><span>${T('我制定的规则', 'My standing decision')}</span><select id="policy-effect"><option value="allow" ${ui.policyEffect === 'allow' ? 'selected' : ''}>${T('允许自动分享', 'Allow automatic sharing')}</option><option value="ask" ${ui.policyEffect === 'ask' ? 'selected' : ''}>${T('每次先问我', 'Ask me each time')}</option><option value="deny" ${ui.policyEffect === 'deny' ? 'selected' : ''}>${T('禁止分享', 'Deny sharing')}</option></select></label><label class="field"><span>${T('在当前项目中向', 'In this project, with')} ${peer}</span><select id="policy-resource"><option value="availability" ${ui.policyResource === 'availability' ? 'selected' : ''}>${T('约见所需忙闲', 'Scoped availability')}</option><option value="report-interests" ${ui.policyResource === 'report-interests' ? 'selected' : ''}>${T('参会报告兴趣', 'Presentation interests')}</option><option value="public" ${ui.policyResource === 'public' ? 'selected' : ''}>${T('主人确认公开的材料', 'Owner-confirmed public materials')}</option></select></label><button class="button primary" ${ui.busy ? 'disabled' : ''}>${T('确认并记住规则', 'Confirm and remember rule')}</button></form><small style="margin-top:12px">${T('这次确认会写入你的授权账本。对方的规则不会因此改变。', 'Confirmation writes to your authorization ledger. The peer’s rules remain independent.')}</small></section>
    <section class="panel"><h2>${T('具体许可与使用记录', 'Exact grants and operation history')}</h2><div class="research-data-list">${a.grants.length ? a.grants.map(grant => `<article class="research-record"><div class="toolbar"><strong>${esc(actionTitle(grant.intent.action))}</strong><span class="tag">${esc(statusLabel(grant.status))}</span></div><p>${esc(grant.intent.resourceId)} → ${esc(grant.intent.recipient)}</p><small>${T('已使用', 'Used')}: ${grant.uses ?? 0} / ${grant.maxUses} · ${T('剩余', 'Remaining')}: ${grant.remaining ?? Math.max(0, grant.maxUses - (grant.uses ?? 0) - (grant.reserved ?? 0))} · ${T('期限', 'Until')}: ${esc(timeText(grant.expiresAt))}</small>${grant.status === 'active' ? `<button class="button quiet" style="margin-top:10px" data-action="revoke" data-id="${esc(grant.id)}" ${ui.busy ? 'disabled' : ''}>${T('撤销未使用许可', 'Revoke remaining permission')}</button>` : ''}${details(`grant-${grant.id}`, T('批准的确切范围', 'Exact approved scope'), `<pre>${pretty(grant)}</pre>`)}</article>`).join('') : `<p class="research-empty">${T('还没有单独签发的具体许可。', 'No exact grants have been issued yet.')}</p>`}</div>
    ${details('authorization-operations', `${T('实际操作', 'Actual operations')} · ${a.operations.length}`, `<div class="research-data-list">${a.operations.map(operation => `<article class="research-record"><div class="toolbar"><strong>${esc(actionTitle(operation.intent.action))}</strong><span class="tag">${esc(statusLabel(operation.status))}</span></div><small class="mono">${esc(operation.id)}</small><pre>${pretty({ intent: operation.intent, basisId: operation.basisId, receipt: operation.receipt })}</pre></article>`).join('') || `<p class="research-empty">${T('暂无操作。', 'No operations yet.')}</p>`}</div>`)}
    ${details('authorization-decisions', `${T('主人决定历史', 'Owner decision history')} · ${a.decisions.length}`, `<pre>${pretty(a.decisions)}</pre>`)}
    ${details('authorization-projection', T('KG 中可检索的授权投影', 'Discoverable authorization projection in KG'), `<p class="lead">${T('图谱投影用于发现和解释；有效许可始终以独立账本为准。', 'The graph projection supports discovery and explanation. The independent ledger remains authoritative.')}</p><pre>${pretty(ui.state.authorizationProjection)}</pre>`)}
    </section>`;
}
function accessView() {
  return `<section class="panel research-access"><p class="eyebrow">BOB · OWNER WINDOW</p><h1>${T('进入 Bob 的独立主人窗口', 'Open Bob’s independent owner window')}</h1><p class="lead">${T('这里使用 Bob 自己的凭证查看资料并作决定，不会使用 Alice 的授权。', 'This window uses Bob’s own credential to inspect information and make decisions. Alice’s permission is not reused.')}</p>
    <form id="bob-access">${ui.meta?.openControls ? `<p>${T('当前为本机演示，操作员可直接代表 Bob 进入。', 'Local demo controls allow the operator to enter as Bob.')}</p>` : `<label class="field"><span>${T('操作员 PIN', 'Operator PIN')}</span><input id="operator-pin" type="password" autocomplete="off" value="${esc(ui.pin)}" required></label>`}<button class="button primary" ${ui.busy ? 'disabled' : ''}>${T('以 Bob 主人身份进入', 'Enter as Bob’s owner')}</button></form></section>`;
}
async function refresh(force = false) {
  if (!ui.token || !ui.workspaceId || ui.busy) return;
  const workspace = ui.workspaceId; const token = ui.token;
  const state = await api(base());
  if (workspace !== ui.workspaceId || token !== ui.token) return;
  ui.state = state; ui.access = false; render(force);
}
async function mutate(action) {
  if (ui.busy) return;
  ui.busy = true; notify(''); render(true);
  try { await action(); }
  catch (error) { notify(error.message, true); }
  finally { ui.busy = false; render(true); }
}
root.addEventListener('input', event => {
  if (event.target.id === 'knowledge-query') ui.query = event.target.value;
  if (event.target.id === 'operator-pin') ui.pin = event.target.value;
  if (event.target.id === 'research-goal-input') ui.goal = event.target.value;
  if (event.target.id === 'research-command-input') ui.command = event.target.value;
});
root.addEventListener('change', event => {
  const element = event.target;
  if (element.id === 'research-mode') ui.mode = element.value;
  if (element.id === 'policy-effect') ui.policyEffect = element.value;
  if (element.id === 'policy-resource') ui.policyResource = element.value;
  if (element.id === 'research-command-type') ui.commandType = element.value;
  if (element.id === 'conversation-task') { ui.conversationTaskId = element.value; render(true); }
  if (element.dataset.selection) {
    const fields = ui.selections.get(element.dataset.selection);
    if (element.checked) fields.add(element.dataset.field); else fields.delete(element.dataset.field);
    const button = root.querySelector(`[data-action="allow"][data-id="${CSS.escape(element.dataset.request)}"]`);
    if (button) button.disabled = ui.busy || !fields.size;
  }
});
root.addEventListener('click', event => {
  const element = event.target.closest('button[data-action],button[data-tab],button[data-query]');
  if (!element || element.disabled) return;
  if (element.dataset.tab) { ui.tab = element.dataset.tab; render(true); return; }
  if (element.dataset.query) { ui.query = element.dataset.query; runQuery(); return; }
  const action = element.dataset.action;
  if (action === 'clear-query') { ui.query = ''; ui.queryResult = null; render(true); return; }
  mutate(async () => {
    if (action === 'create') {
      if (ui.workspaceId && ui.token) {
        await api(`${base()}/end`, {});
        try { sessionStorage.removeItem(credentialKey()); } catch { /* Credentials remain scoped to the ended workspace. */ }
      }
      const result = await api('/api/research/workspaces', {}, null);
      ui.workspaceId = result.workspaceId; ui.owner = result.owner; ui.token = result.token; ui.state = result.state; ui.access = false;
      ui.queryResult = null; ui.goal = ''; ui.command = ''; ui.commandType = 'auto'; ui.conversationTaskId = null;
      ui.tab = 'collaboration'; ui.selections.clear(); ui.openDetails.clear(); remember();
      history.replaceState(null, '', `/research.html?workspace=${encodeURIComponent(ui.workspaceId)}`);
      return;
    }
    if (action === 'start') {
      ui.state = await api(`${base()}/commands`, { text: presetCommand(element.dataset.type), type: element.dataset.type, mode: ui.mode });
      ui.conversationTaskId = ui.state.tasks.at(-1)?.id;
    }
    if (action === 'resume') ui.state = await api(`${base()}/tasks/${encodeURIComponent(element.dataset.id)}/resume`, {});
    if (action === 'revoke') ui.state = await api(`${base()}/revoke`, { id: element.dataset.id });
    if (action === 'allow-policy' || action === 'deny-policy') {
      const candidate = (ui.state.policyCandidates ?? []).find(item => item.id === element.dataset.id);
      if (!candidate) throw new Error(T('请读取当前规则提议后再确认。', 'Reload the current rule proposal before deciding.'));
      ui.state = await api(`${base()}/policy-candidates/${encodeURIComponent(candidate.id)}/decision`, { decision: action === 'allow-policy' ? 'allow' : 'deny', expectedHash: candidate.hash });
    }
    if (action === 'allow' || action === 'deny') {
      const request = ui.state.authorizations.requests.find(item => item.id === element.dataset.id);
      const selected = ui.selections.get(`${request.id}:${request.revision}`) ?? new Set(request.intent.fields);
      ui.state = await api(`${base()}/decisions/${encodeURIComponent(request.id)}`, { decision: action === 'allow' ? 'allow' : 'deny',
        ...(action === 'allow' ? { fields: [...selected] } : {}), expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
    }
  });
});
async function runQuery() { await mutate(async () => { ui.queryResult = await api(`${base()}/query`, { query: ui.query, hops: 2 }); }); }
root.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'research-query') { runQuery(); return; }
  mutate(async () => {
    if (event.target.id === 'research-command') {
      ui.state = await api(`${base()}/commands`, { text: ui.command, type: ui.commandType, mode: ui.commandType === 'research_work' ? 'native' : ui.mode });
      ui.conversationTaskId = ui.state.tasks.at(-1)?.id;
      ui.command = '';
    }
    if (event.target.id === 'research-goal') {
      ui.state = await api(`${base()}/research-task`, { goal: ui.goal });
      ui.queryResult = null;
    }
    if (event.target.id === 'research-policy') {
      const scope = ui.policyResource === 'public' ? { resourceClass: 'public' } : { resources: [ui.policyResource] };
      ui.state = await api(`${base()}/policies`, { effect: ui.policyEffect, actions: ['peer.send'], ...scope,
        recipients: [ui.owner === 'Alice' ? 'Bob' : 'Alice'], purposes: ['academic_coordination'] });
      notify(T('规则已记录，后续任务会检索当前有效版本。', 'Rule recorded. Subsequent tasks will retrieve the current version.'));
    }
    if (event.target.id === 'bob-access') {
      let admin;
      if (!ui.meta.openControls) admin = (await api('/api/admin/login', { pin: ui.pin }, null)).token;
      const result = await api(`/api/admin/research/workspaces/${encodeURIComponent(ui.workspaceId)}/claim/Bob`, {}, admin ?? null);
      ui.owner = 'Bob'; ui.token = result.token; ui.pin = ''; remember(); ui.access = false;
      ui.state = await api(base());
    }
  });
});
document.getElementById('research-language').addEventListener('click', () => { ui.lang = ui.lang === 'zh' ? 'en' : 'zh'; store(localStorage, 'research-language', ui.lang); render(true); });
async function boot() {
  [ui.catalog, ui.meta] = await Promise.all([api('/api/research/catalog', undefined, null), api('/api/meta', undefined, null)]);
  if (!ui.workspaceId && ui.owner === 'Alice') {
    const previous = readStorage(localStorage, 'research-alice-resume');
    if (previous?.workspaceId && previous.owner === 'Alice' && previous.token) Object.assign(ui, previous);
  }
  const saved = ui.workspaceId ? readStorage(sessionStorage, credentialKey()) : null;
  if (saved?.token) ui.token = saved.token;
  if (ui.workspaceId && ui.owner === 'Bob' && !ui.token) ui.access = true;
  if (ui.token) {
    try { await refresh(true); }
    catch (error) { ui.token = null; ui.state = null; ui.access = ui.owner === 'Bob'; notify(error.message, true); }
  }
  render(true);
}
boot().catch(error => { notify(error.message, true); render(true); });
setInterval(() => { refresh().catch(error => { notify(error.message, true); }); }, 1500);
