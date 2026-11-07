// Audience-facing summaries of recorded activity. These functions describe
// evidence already exposed by the service; they do not create agent messages,
// infer private material or turn a permission into proof of execution.
const language = lang => (zh, en) => lang === 'en' ? en : zh;
const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const peer = role => role === 'Alice' ? 'Bob' : 'Alice';
const days = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };
const day = (value, lang) => lang === 'en' ? text(value) : days[value] ?? text(value);
const scoped = (entries, task) => list(entries).filter(entry => !task?.id || entry.taskId === task.id)
  .slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
const structured = value => {
  if (!/^[{[]/.test(text(value))) return false;
  try { JSON.parse(value); return true; } catch { return false; }
};
const fieldsText = (fields, lang) => list(fields).map(field => ({ summary: ['摘要', 'summary'], method: ['方法', 'method'],
  results: ['结果', 'results'], note: ['备注', 'notes'], title: ['标题', 'title'], day: ['日期', 'day'],
  time: ['时间', 'time'], attendees: ['人数', 'attendees'], agenda: ['议程', 'agenda'], venueId: ['场地', 'venue']
}[field]?.[lang === 'en' ? 1 : 0] ?? text(field))).filter(Boolean).join(lang === 'en' ? ', ' : '、');
const materialText = (payload, lang) => Object.entries(payload ?? {}).filter(([, value]) => typeof value === 'string' && !structured(value))
  .slice(0, 8).map(([field, value]) => `${fieldsText([field], lang)}${lang === 'en' ? ': ' : '：'}${value}`).join('\n');
const requestAction = (intent, lang) => intent?.action === 'reservation.submit'
  ? language(lang)('提交场地预约', 'submit the venue reservation')
  : language(lang)('向合作方分享资料', 'share material with the collaborator');

/** Presentation-only inventory of the authenticated owner's workspace. No
 * peer catalogue is consulted and no filesystem path is opened by this view.
 */
export function workspaceInventory(state, { lang = 'zh' } = {}) {
  const owner = state?.owner, workspace = state?.workspace, profile = state?.profile;
  if (!['Alice', 'Bob'].includes(owner) || workspace?.role !== owner || profile?.role !== owner
    || workspace.manifest && workspace.manifest.role !== owner) return null;
  const expectedSeed = `workspaces/${owner.toLowerCase()}`;
  const expectedRuntime = `runs/${state.workspaceId}/${owner.toLowerCase()}`;
  if (workspace.seedPath !== expectedSeed || workspace.runtimePath !== expectedRuntime) return null;
  const T = language(lang);
  const labels = {
    'README.md': T('工作区说明', 'Workspace guide'), 'ontology.json': T('独立应用本体', 'Own application ontology'),
    'knowledge.json': T('研究知识与证据', 'Research knowledge and evidence'), 'calendar.json': T('完整起始日程', 'Complete initial calendar'),
    'materials.json': T('起始研究材料', 'Initial research materials'), 'interests.json': T('本方研究兴趣', 'Own research interests'),
    'report-annotations.json': T('本方对报告的理解', 'Own presentation annotations'),
    'skills.json': T('技能能力清单', 'Skill contracts'), 'policies.json': T('初始授权规则模板', 'Initial policy templates'),
  };
  const files = Object.entries(workspace.manifest?.files ?? {}).filter(([name]) =>
    /^[A-Za-z0-9_.\/-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..'))
    .map(([name, record]) => {
      const skill = list(profile.skills).find(item => item.path === `${expectedSeed}/${name}`);
      return { path: name, label: labels[name] || text(skill?.label) || name, hash: text(record?.sha256), description: text(record?.description) };
    }).sort((a, b) => a.path.localeCompare(b.path));
  return {
    role: owner, seedPath: expectedSeed, runtimePath: expectedRuntime,
    seedVersion: text(workspace.seed?.version), seedHash: text(workspace.seed?.hash),
    manifestHash: text(workspace.manifest?.hash), namespace: text(workspace.nativeNamespace), files,
    knowledgeCount: list(profile.knowledge?.nodes).length, materialCount: list(profile.materials).length,
    skillCount: list(profile.skills).length,
    inboxCount: list(state.messages).filter(message => message.to === owner).length,
    outboxCount: list(state.messages).filter(message => message.from === owner).length,
    artifactCount: list(state.artifacts).filter(artifact => artifact.owner === owner).length,
  };
}

function resultDescription(result, lang) {
  const T = language(lang);
  switch (result?.outcome) {
    case 'common_time_found': return { title: T('找到共同讨论时间', 'A shared discussion time was found'),
      body: T(`双方交换的空闲时间支持 ${day(result.meeting?.day, lang)} ${text(result.meeting?.time)} 的讨论。`,
        `The exchanged availability supports a discussion on ${day(result.meeting?.day, lang)} ${text(result.meeting?.time)}.`) };
    case 'no_common_time': return { title: T('暂时没有共同时间', 'No shared time found'), body: T('已交换的时段没有满足条件的共同空闲时间。', 'The exchanged slots contain no suitable shared time.') };
    case 'presentation_selected': return { title: T('选定共同参加的报告', 'A shared presentation was selected'),
      body: T(`双方共同选择 ${text(result.report?.id)}《${text(result.report?.title)}》。这场报告分别符合两位研究者的需求。`,
        `Both selected ${text(result.report?.id)}: ${text(result.report?.title)}. It meets each researcher's own interests.`) };
    case 'no_shared_presentation': return { title: T('暂时没有共同报告', 'No shared presentation found'), body: T('当前交换的信息中没有同时符合双方需求的报告。', 'The exchanged information contains no presentation meeting both researchers’ interests.') };
    case 'discussion_prepared': return { title: T('讨论已准备好，场地已确认', 'Discussion ready; venue confirmed'),
      body: T(`议程和材料协作已完成；场地预约服务确认了 ${day(result.reservation?.day, lang)} ${text(result.reservation?.time)} 的预约。`,
        `The agenda and material preparation are complete. The venue service confirmed the booking for ${day(result.reservation?.day, lang)} ${text(result.reservation?.time)}.`) };
    case 'reservation_confirmed_preparation_pending': return { title: T('场地已确认，准备工作继续', 'Venue confirmed; preparation continues'), body: T('预约已有确认回执，讨论准备尚未全部完成。', 'The booking has a confirmation receipt. Discussion preparation is still in progress.') };
    case 'prepared_not_submitted': return { title: T('保留议程，预约未提交', 'Agenda retained; booking not submitted'), body: T('主人拒绝了预约操作，已经准备的议程继续保留。', 'The owner declined the booking action. The prepared agenda is retained.') };
    case 'sharing_declined': return { title: T('主人拒绝了这次分享', 'Owner declined this disclosure'), body: T('这次资料没有发送，任务按决定停止。', 'This material was not sent. The task stopped in line with the decision.') };
    case 'research_work_saved': return { title: T('研究成果已保存', 'Research work saved'), body: T('已保存有来源的研究成果，可由主人查看。', 'Sourced research work has been saved for the owner to inspect.') };
    case 'policy_remembered': return { title: T('长期规则已确认并记录', 'Standing rule confirmed and saved'), body: T('后续动作会重新检查这条规则的适用范围；记录规则本身没有发送资料。', 'Future actions will check this rule’s scope. Saving the rule did not send any material.') };
    case 'policy_not_adopted': return { title: T('没有采用这条规则', 'Proposed rule not adopted'), body: T('主人没有批准规则提议，原有授权仍按当前状态检查。', 'The owner declined the proposed rule. Existing permissions remain subject to their current state.') };
    default: return { title: T('任务结果已记录', 'Task outcome recorded'), body: T('结果已保存在任务记录中，可以展开查看依据。', 'The outcome is saved in the task record; expand the details to inspect its evidence.') };
  }
}

// Resolve the state of the exact request shown in an immutable conversation
// event. A renewed request can reuse an ID, so decisions must match its revision.
export function authorizationHistory(entry, { entries = [], authorizations = {}, policyCandidates = [], owner } = {}) {
  if (entry?.kind !== 'approval') return null;
  const requestId = entry.requestId ?? entry.details?.requestId ?? entry.details?.id;
  if (!requestId) return null;
  const idOf = item => item.requestId ?? item.details?.requestId ?? item.details?.id;
  const isRequest = item => !text(item.from).startsWith('owner:') && !['owner_decision', 'owner_policy_decision'].includes(item.name);
  const events = scoped(entries, { id: entry.taskId }).filter(item => item.kind === 'approval'
    && item.role === entry.role && idOf(item) === requestId);
  const original = isRequest(entry) ? entry : events.findLast(item => isRequest(item) && item.sequence <= entry.sequence);
  const revision = original?.revision ?? original?.details?.revision;
  const laterRequest = original && events.find(item => isRequest(item) && item.sequence > original.sequence);
  const decisionEvent = isRequest(entry) ? events.find(item => !isRequest(item)
    && item.sequence > entry.sequence && (!laterRequest || item.sequence < laterRequest.sequence)) : entry;
  const own = !entry.redacted && (!owner || owner === entry.role);
  const ownerRole = value => text(value).split(':').at(-1);
  const ledger = own && (!authorizations.owner || ownerRole(authorizations.owner) === entry.role) ? authorizations : {};
  const current = list(ledger.requests).find(item => item.id === requestId && item.intent?.taskId === entry.taskId);
  const policy = own ? list(policyCandidates).find(item => item.id === requestId && item.taskId === entry.taskId) : null;
  const decision = current && list(ledger.decisions).find(item => item.requestId === requestId
    && (!item.owner || ownerRole(item.owner) === entry.role) && item.requestRevision === revision
    && (!original?.details?.payloadHash || item.originalPayloadHash === original.details.payloadHash));
  const currentMatches = current && (current.revision === revision || decision && current.decisionId === decision.id);
  let status = decision ? decision.decision === 'deny' ? 'denied' : 'approved'
    : decisionEvent?.status ?? policy?.status ?? (currentMatches ? current.status : null) ?? entry.status;
  if (status === 'pending' && current && current.revision > revision) status = 'superseded';
  const request = own ? original?.details ?? (currentMatches ? current : null) ?? policy ?? null : null;
  const visibleDecision = own ? decision ?? (decisionEvent && !decisionEvent.redacted
    ? { ...decisionEvent.details, at: decisionEvent.at, status: decisionEvent.status } : null)
    ?? (policy?.decidedAt ? { decision: policy.status === 'denied' ? 'deny' : 'allow', at: policy.decidedAt } : null) : null;
  return { requestId, revision, status, isRequest: isRequest(entry), request, decision: visibleDecision,
    canReview: Boolean(own && request), requestedAt: original?.at ?? request?.createdAt };
}

export function describeActivity(entry = {}, { lang = 'zh', task, conference, authorization } = {}) {
  const T = language(lang), data = entry.redacted ? {} : entry.details ?? {}, from = text(entry.from), to = text(entry.to);
  if (entry.kind === 'command') return { title: T('主人交办任务', 'Owner instruction'),
    body: !entry.redacted && text(entry.text) || T('主人已向自己的 agent 发出指令，原文仅主人可见。', 'The owner sent an instruction to their agent. Its text is private to the owner.') };
  if (entry.kind === 'response') return { title: T('Agent 给主人的说明', 'Agent explanation to owner'),
    body: entry.redacted ? T('回复正文仅该 agent 的主人可见。', 'The reply text is visible only to this agent’s owner.')
      : structured(entry.text) ? T('Agent 返回了一份结构化说明，可展开查看原文。', 'The agent returned a structured explanation. Expand the details to inspect it.')
        : text(entry.text) || T('Agent 已返回说明，任务结果仍以实际记录为依据。', 'The agent returned an explanation. Actual records establish the task outcome.') };
  if (entry.kind === 'result') return resultDescription(data.result ?? data, lang);
  if (entry.kind === 'message') {
    if (entry.redacted) return { title: T('协作消息已记录', 'Collaboration message recorded'), body: T('消息正文仅向获准的接收方显示。', 'The message text is visible only to its authorized recipient.') };
    if (entry.name === 'peer_send') {
      const payload = data.payload ?? {}, confirmed = data.receipt?.status === 'received';
      const receipt = confirmed ? T(`${to} 已确认收到。`, `${to} confirmed reception.`) : T('接收状态见实际回执。', 'The receipt records reception status.');
      if (data.resourceId === 'availability') {
        const slots = list(payload.slots).map(slot => `${day(slot.day, lang)} ${text(slot.time)}`).filter(value => value.trim());
        return { title: T(`${from} 分享空闲时间`, `${from} shared availability`),
          body: slots.length ? T(`可用于约见的时段：${slots.join('；')}。${receipt}`, `Offered meeting slots: ${slots.join('; ')}. ${receipt}`)
            : T(`已发送本次约见所需的忙闲信息。${receipt}`, `Scoped meeting availability was sent. ${receipt}`) };
      }
      if (data.resourceId === 'report-interests') {
        const reports = list(payload.reportIds).map(id => {
          const report = list(conference?.reports).find(item => item.id === id);
          return report ? `${id}${lang === 'en' ? ': ' : '《'}${report.title}${lang === 'en' ? '' : '》'}` : text(id);
        }).filter(Boolean);
        return { title: T(`${from} 分享参会兴趣`, `${from} shared presentation interests`),
          body: reports.length ? T(`符合本方研究需求的报告有：${reports.join('；')}。${receipt}`, `Presentations matching this researcher’s interests: ${reports.join('; ')}. ${receipt}`)
            : T(`已分享本方的报告兴趣。${receipt}`, `Presentation interests were shared. ${receipt}`) };
      }
      if (data.resourceId === 'working-ontology') {
        const ontology = payload.ontology ?? {}, modules = list(ontology.modules);
        const names = modules.map(module => text(module.name)).filter(Boolean).slice(0, 4);
        const version = text(ontology.version);
        return { title: T(`${from} 发送本次任务的概念定义`, `${from} shared task-relevant concept definitions`),
          body: T(`已发送 ${modules.length} 组定义${version ? `（版本 ${version}）` : ''}${names.length ? `，包括：${names.join('、')}` : ''}。${receipt}具体对应关系仍需双方协商。`,
            `${modules.length} groups of definitions were sent${version ? ` (version ${version})` : ''}${names.length ? `, including: ${names.join(', ')}` : ''}. ${receipt} Correspondences still require peer discussion.`) };
      }
      if (data.resourceId === 'capabilities') {
        const skills = list(payload.skills), names = skills.map(skill => text(skill.label)).filter(Boolean).slice(0, 4);
        return { title: T(`${from} 介绍自己的能力`, `${from} described their capabilities`),
          body: T(`介绍了 ${skills.length} 项能力${names.length ? `：${names.join('、')}${skills.length > names.length ? '等' : ''}` : ''}。${receipt}`,
            `Shared ${skills.length} capabilities${names.length ? `, including ${names.join(', ')}` : ''}. ${receipt}`) };
      }
      const contents = materialText(payload, lang);
      return { title: T(`${from} 分享获准内容`, `${from} shared permitted content`), body: contents
        ? `${contents}\n${receipt}` : T(`这份材料已经发送。${receipt}可展开查看交付内容。`, `The material was sent. ${receipt} Expand to inspect the delivered content.`) };
    }
    if (entry.name === 'peer_request') {
      const request = ({ availability: ['请提供可用于约见的空闲时间', 'Please provide availability for a meeting'],
        report_interests: ['请提供符合你研究需求的报告', 'Please share presentations matching your research interests'],
        research_material: ['请提供可获准分享的研究材料', 'Please provide research material that may be shared with permission'],
        agenda_review: ['请审阅讨论议程并提出意见', 'Please review the discussion agenda'],
        ontology: ['请提供本次任务所需的概念定义', 'Please provide concept definitions relevant to this task'],
        capabilities: ['请介绍你可以提供的协作能力', 'Please describe the capabilities you can contribute'] })[data.kind];
      return { title: T(`${from} 向 ${to} 请求协作`, `${from} requested help from ${to}`),
        body: request ? `${request[lang === 'en' ? 1 : 0]}。${T('请求已经送达，所需内容尚待对方提供。', 'The request was delivered; the requested content has not yet been provided.')}`
          : T('协作请求已经送达对方。', 'The collaboration request was delivered to the peer.') };
    }
    if (entry.name === 'alignment_propose' || entry.name === 'alignment_accept') {
      const mappings = list(data.mappings);
      if (entry.name === 'alignment_accept') return { title: data.status === 'accepted' ? T('双方接受任务内的概念对应', 'Task-scoped correspondences accepted') : T('这组概念对应未被接受', 'Correspondences not accepted'),
        body: data.status === 'accepted' ? T(`对方审阅后接受了 ${mappings.length} 项对应。后续协作按记录的关系与适用条件使用。`, `The peer reviewed and accepted ${mappings.length} correspondences. Further collaboration uses their recorded relations and conditions.`)
          : T('对方已审阅并拒绝这组对应。双方可以根据已交换的定义继续讨论；具体记录可展开查看。', 'The peer reviewed and declined these correspondences. Discussion can continue from the exchanged definitions; expand to inspect the review record.') };
      const conditional = mappings.filter(mapping => mapping.relation === 'conditional').length;
      const related = mappings.filter(mapping => mapping.relation === 'related').length;
      return { title: T(`${from} 提议对齐概念含义`, `${from} proposed semantic correspondences`),
        body: T(`已向 ${to} 提交 ${mappings.length} 项对应供审阅${conditional ? `，其中 ${conditional} 项只在特定条件下成立` : ''}${related ? `，${related} 项只表示相关` : ''}。仍需对方审阅，提议本身不代表已经接受。`,
          `${mappings.length} correspondences were proposed to ${to}${conditional ? `; ${conditional} are conditional` : ''}${related ? `; ${related} express related meanings` : ''}. Peer review is still required; proposing is not acceptance.`) };
    }
    return { title: T('收到协作信息', 'Collaboration information'), body: T('这条信息已记入双方的协作记录，可展开查看原始内容。', 'This information is recorded in the collaboration history. Expand to inspect the original content.') };
  }
  if (entry.kind === 'approval') {
    const status = authorization?.status ?? entry.status;
    if (authorization?.isRequest && status !== 'pending') {
      const states = { denied: ['已拒绝', 'denied'], approved: ['已批准', 'approved'], expired: ['已过期', 'expired'],
        revoked: ['已撤销', 'revoked'], superseded: ['已更新', 'superseded'] };
      const label = states[status] ?? ['已处理', 'resolved'];
      const intent = authorization.request?.intent ?? data.intent;
      const policy = entry.name === 'authorization_propose_policy';
      return { title: T(`授权请求${label[0]}`, `Authorization request ${label[1]}`), body: entry.redacted
        ? T(`${entry.role} 的主人已处理这次请求；具体内容仅在本方主人窗口可见。`, `${entry.role}’s owner resolved this request. Its details remain private to that owner.`)
        : status === 'denied' ? policy ? T('主人已拒绝这条长期规则提议，规则没有生效。', 'The owner declined this standing-rule proposal. The rule did not take effect.')
          : T(`Agent 请求${requestAction(intent, lang)}。主人已拒绝，这次请求未获许可。`, `The agent requested permission to ${requestAction(intent, lang)}. The owner declined this request; no permission was granted.`)
          : status === 'approved' ? T('主人已批准这次请求。可展开查看当时的请求与批准范围；实际执行结果以回执为准。', 'The owner approved this request. Expand to inspect the original request and approved scope; receipts establish the execution result.')
            : T('这版请求已结束，不再等待主人决定。可展开查看当时的请求与记录。', 'This request revision is closed and is no longer awaiting an owner decision. Expand to inspect its recorded details.') };
    }
    if (status === 'pending') {
      const policy = entry.name === 'authorization_propose_policy';
      return { title: T('需要主人授权', 'Owner authorization needed'), body: entry.redacted
        ? T(`${entry.role} 正在等待自己的主人决定；待审内容保留在本方窗口。`, `${entry.role} is waiting for their owner’s decision. Pending content stays in that owner’s window.`)
        : policy ? T('Agent 提议了一条长期规则，需要主人确认后才会生效。', 'The agent proposed a standing rule. It takes effect only after owner confirmation.')
          : T(`Agent 请求${requestAction(data.intent, lang)}。这一步正在等待主人决定，尚未执行。`, `The agent requests permission to ${requestAction(data.intent, lang)}. It is waiting for the owner’s decision and has not executed this step.`) };
    }
    const denied = status === 'denied' || data.decision === 'deny';
    if (denied) return { title: T('主人拒绝了这次请求', 'Owner declined this request'), body: T('这次请求没有获得许可。Agent 会按决定继续或停止，不会把拒绝当作批准。', 'This request did not receive permission. The agent will continue or stop in line with the decision.') };
    if (entry.name === 'owner_policy_decision') return { title: T('主人确认了长期规则', 'Owner confirmed the standing rule'), body: T('规则已经记录；每次执行仍会检查用途、范围和有效状态。', 'The rule was recorded. Each execution still checks its purpose, scope and current validity.') };
    const fields = fieldsText(data.approvedIntent?.fields, lang);
    return { title: T('主人已授权，Agent 可以继续', 'Owner authorized the next step'),
      body: entry.redacted ? T('主人决定已记录，具体授权范围仅本方主人可见。', 'The owner’s decision was recorded. Its exact scope is private to that owner.')
        : T(`本次批准${fields ? `的范围是：${fields}` : '已经记录'}。Agent 将按许可继续，实际执行结果随后按回执核验。`, `This approval${fields ? ` covers: ${fields}` : ' was recorded'}. The agent can continue within that permission. Actual execution will be verified with a receipt.`) };
  }
  if (entry.kind === 'checkpoint') {
    if (entry.status === 'needs_owner' || entry.status === 'owner_decision_required') return { title: T('在关键步骤等待主人', 'Waiting for the owner at a key step'), body: T('当前进度已保存，取得主人决定后会从这里继续。', 'Progress has been saved. Work can resume here after the owner decides.') };
    if (entry.status === 'waiting_peer') return { title: T('等待合作方提供信息', 'Waiting for the collaborator'), body: !entry.redacted && text(entry.text) || T('当前进度已保存，收到对方的实际信息后继续。', 'Progress has been saved. Work continues after information actually arrives from the peer.') };
    return { title: T('已保存协作进度', 'Progress saved'), body: !entry.redacted && text(entry.text) || T('Agent 已记录当前进度，可从保存的状态继续。', 'The agent recorded its progress and can continue from the saved state.') };
  }
  if (entry.kind === 'run') return { title: T('Agent 运行状态', 'Agent run status'), body: entry.status === 'failed'
    ? T('这一轮运行遇到问题，任务状态中保留了后续处理入口。', 'This run encountered a problem. The task retains its recovery controls.')
    : entry.status === 'started' ? T('Agent 已开始处理当前任务。', 'The agent started working on the task.')
      : T('这一轮运行已经结束；业务任务是否完成仍由实际结果决定。', 'This run ended. Actual results determine whether the task is complete.') };
  return { title: T('协作动作', 'Collaboration action'), body: T('动作已记录，可展开查看细节。', 'The action was recorded. Expand to inspect the details.') };
}

const toolState = (name, lang) => ({
  knowledge_search: ['正在查找研究资料', 'Searching research knowledge'], knowledge_record: ['正在整理研究证据', 'Organizing research evidence'],
  ontology_describe: ['正在读取概念定义', 'Reading concept definitions'], peer_describe: ['正在了解对方的概念', 'Inspecting the peer’s concepts'],
  artifact_prepare: ['正在准备讨论材料', 'Preparing discussion material'], artifact_revise: ['正在修订工作草稿', 'Revising a draft'],
  peer_request: ['正在请求对方协作', 'Requesting collaboration'], peer_send: ['正在发送获准内容', 'Sending permitted content'],
  alignment_propose: ['正在提出概念对应', 'Proposing correspondences'], alignment_accept: ['正在审阅概念对应', 'Reviewing correspondences'],
  authorization_check: ['正在检查当前权限', 'Checking current permission'], authorization_list: ['正在取回授权记忆', 'Retrieving authorization memory'],
  authorization_request: ['正在准备授权请求', 'Preparing an authorization request'], authorization_propose_policy: ['正在准备规则提议', 'Preparing a rule proposal'],
  resource_search: ['正在查询可用场地', 'Searching available venues'], reservation_submit: ['正在提交已批准的预约', 'Submitting the approved booking'],
  receipt_inspect: ['正在核验实际结果', 'Checking actual receipts'], task_status: ['正在读取协作进度', 'Reading collaboration progress'],
  task_checkpoint: ['正在保存任务进度', 'Saving progress'], research_skills_list: ['正在选择适用技能', 'Choosing a skill'], research_skill_view: ['正在读取技能方法', 'Reading skill instructions'],
}[name]?.[lang === 'en' ? 1 : 0] ?? language(lang)('正在处理当前任务', 'Working on the current task'));

const completedToolState = (name, lang) => ({
  knowledge_search: ['已完成研究资料检索', 'Research search completed'], knowledge_record: ['已保存研究证据', 'Research evidence saved'],
  ontology_describe: ['已读取概念定义', 'Concept definitions retrieved'], peer_describe: ['已读取合作方定义', 'Peer definitions retrieved'],
  artifact_prepare: ['已准备工作草稿', 'Working draft prepared'], artifact_revise: ['已修订工作草稿', 'Working draft revised'],
  peer_request: ['已提出协作请求', 'Collaboration request sent'], peer_send: ['已取得信息发送结果', 'Information send result received'],
  alignment_propose: ['已提出概念对应', 'Correspondences proposed'], alignment_accept: ['已完成概念对应审阅', 'Correspondence review completed'],
  authorization_check: ['已检查当前权限', 'Current permission checked'], authorization_list: ['已取回授权记忆', 'Authorization memory retrieved'],
  authorization_request: ['已处理授权请求', 'Authorization request processed'], authorization_propose_policy: ['已准备规则提议', 'Rule proposal prepared'],
  resource_search: ['已完成场地查询', 'Venue search completed'], reservation_submit: ['已取得预约操作结果', 'Booking operation result received'],
  receipt_inspect: ['已查询实际回执', 'Actual receipts inspected'], task_status: ['已读取协作进度', 'Collaboration progress retrieved'],
  task_checkpoint: ['已保存任务进度', 'Task progress saved'], research_skills_list: ['已列出适用技能', 'Available skills listed'], research_skill_view: ['已读取技能方法', 'Skill instructions retrieved'],
}[name]?.[lang === 'en' ? 1 : 0] ?? language(lang)('刚完成一项工具动作', 'A tool action just finished'));

const timelineKinds = new Set(['command', 'message', 'response', 'result', 'approval', 'tool', 'run', 'checkpoint']);
const hiddenChannel = /^(?:analysis|thinking|reasoning|private(?:[_ -]?(?:thinking|reasoning))?|chain[_ -]?of[_ -]?thought|reasoning_content)$/i;
const hiddenField = /^(?:analysis|thinking|reasoning|reasoning_content|reasoningContent|private[_-]?(?:thinking|reasoning)|privateThinking|privateReasoning|chain[_-]?of[_-]?thought|chainOfThought)$/i;
const activeToolStatuses = new Set(['started', 'running', 'in_progress', 'queued']);
const finishedToolStatuses = new Set(['completed', 'failed', 'error', 'cancelled', 'denied']);
const checkpointStatus = status => ({ needs_owner: 'needs_owner', owner_decision_required: 'needs_owner',
  waiting_peer: 'waiting_peer', paused: 'paused', failed: 'failed', error: 'failed',
  checkpoint_saved: 'recorded', complete: 'completed', completed: 'completed', verified_task_finished: 'completed' })[status];
const runFinished = entry => entry.kind === 'run' && ['completed', 'failed', 'error', 'cancelled', 'paused'].includes(entry.status)
  || entry.kind === 'checkpoint' && entry.name === 'native_run'
    && ['checkpoint_saved', 'owner_decision_required', 'verified_task_finished'].includes(entry.status);

// The activity API exposes tool boundaries and public checkpoint summaries, not
// model reasoning. Keep this projection safe even if an unexpected event shape
// reaches the browser, and never reconstruct content from a redacted record.
function timelineEntry(entry) {
  if (!entry || !timelineKinds.has(entry.kind)
    || ['kind', 'channel', 'type', 'visibility'].some(key => hiddenChannel.test(text(entry[key])))
    || hiddenChannel.test(text(entry.name))
    || /(?:^|[_:.-])(?:private[_-]?(?:thinking|reasoning)|chain[_-]?of[_-]?thought|thinking|reasoning_content)(?:$|[_:.-])/i.test(text(entry.name))) return null;
  if (entry.redacted) {
    const metadata = ['id', 'sequence', 'at', 'taskId', 'role', 'kind', 'direction', 'from', 'to',
      'name', 'status', 'callId', 'requestId', 'revision', 'messageId', 'redacted'];
    return Object.fromEntries(metadata.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
  }
  const publicValue = value => {
    if (Array.isArray(value)) return value.map(publicValue).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') return value;
    if (['kind', 'channel', 'type', 'visibility'].some(key => hiddenChannel.test(text(value[key])))) return undefined;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !hiddenField.test(key))
      .map(([key, item]) => [key, publicValue(item)]).filter(([, item]) => item !== undefined));
  };
  return publicValue(entry);
}

const toolPhase = name => ({
  task_status: 'review', research_skills_list: 'review', research_skill_view: 'review',
  knowledge_search: 'review', ontology_describe: 'review', peer_describe: 'review', authorization_list: 'review',
  knowledge_record: 'prepare', artifact_prepare: 'prepare', artifact_revise: 'prepare', resource_search: 'prepare',
  peer_request: 'collaborate', peer_send: 'collaborate', alignment_propose: 'collaborate', alignment_accept: 'collaborate',
  authorization_check: 'authorize', authorization_request: 'authorize', authorization_propose_policy: 'authorize',
  reservation_submit: 'execute', receipt_inspect: 'verify',
})[name];
const phaseTitle = (phase, lang) => ({
  review: ['查阅任务与研究资料', 'Review task and research material'],
  prepare: ['整理证据与准备材料', 'Organize evidence and prepare material'],
  collaborate: ['处理协作与概念对应', 'Handle collaboration and correspondences'],
  authorize: ['检查权限与准备授权', 'Check permissions and prepare authorization'],
  execute: ['提交预约操作', 'Submit the booking operation'],
  verify: ['核验实际执行回执', 'Inspect actual execution receipts'],
}[phase]?.[lang === 'en' ? 1 : 0] ?? language(lang)('处理任务步骤', 'Work on the task'));

/** A chronological chat projection of recorded evidence. Steps are collapsed
 * presentation groups, not invented model turns or private thinking. A late
 * tool result stays with its original call even when messages arrive meanwhile.
 * Status describes that recorded step; it does not establish business success.
 */
export function conversationTimeline(entries, { role, task, lang = 'zh', conference } = {}) {
  const timeline = [], metadata = new Map(), calls = new Map(), seen = new Set(), runs = [];
  let current = null, activeRun = null;
  const events = scoped(list(entries).filter(Boolean), task).filter(entry => !role || entry.role === role)
    .map(timelineEntry).filter(Boolean);
  const eventId = (entry, index) => text(entry.id) || `${text(entry.taskId)}:${text(entry.role)}:${entry.sequence ?? index}:${entry.kind}:${text(entry.at)}`;
  const closeStep = () => { if (current) metadata.get(current).sealed = true; current = null; };
  const makeStep = (entry, index, phase) => {
    const step = { kind: 'step', id: `step:${eventId(entry, index)}`, title: '', status: 'recorded',
      entries: [], toolCallCount: 0, startedAt: null, endedAt: null, durationMs: null };
    metadata.set(step, { phase, sealed: false, calls: new Map(), runs: new Set(activeRun ? [activeRun] : []) });
    if (activeRun) activeRun.lastStep = step;
    timeline.push(step); current = step; return step;
  };
  const stepFor = (entry, index, phase) => {
    if (current && phase && metadata.get(current).phase && metadata.get(current).phase !== phase) closeStep();
    const step = current ?? makeStep(entry, index, phase);
    if (phase && !metadata.get(step).phase) metadata.get(step).phase = phase;
    return step;
  };
  const callKey = (entry, id) => `${text(entry.taskId)}:${text(entry.role)}:${id}`;
  const direction = entry => {
    if (entry.kind === 'command' || entry.kind === 'approval'
      && (entry.status !== 'pending' || text(entry.from).startsWith('owner:'))) return 'incoming';
    if (['response', 'result', 'approval'].includes(entry.kind)) return 'outgoing';
    if (entry.to === role || entry.direction === 'incoming') return 'incoming';
    if (entry.from === role || entry.direction === 'outgoing') return 'outgoing';
    return 'local';
  };

  events.forEach((entry, index) => {
    const id = eventId(entry, index);
    if (seen.has(id)) return;
    seen.add(id);
    if (['command', 'message', 'response', 'result', 'approval'].includes(entry.kind)) {
      closeStep();
      timeline.push({ kind: 'message', id: `message:${id}`, direction: direction(entry), entry });
      return;
    }
    if (entry.kind === 'tool') {
      const aliases = [entry.callId, entry.status === 'started' ? entry.id : null].filter(Boolean);
      const existing = aliases.map(alias => calls.get(callKey(entry, alias))).find(Boolean);
      const step = existing?.step ?? stepFor(entry, index, toolPhase(entry.name));
      const meta = metadata.get(step), key = existing?.key ?? callKey(entry, entry.callId ?? entry.id ?? id);
      const call = meta.calls.get(key) ?? { status: entry.status, entries: [] };
      call.status = entry.status; call.entries.push(entry); meta.calls.set(key, call);
      for (const alias of new Set([...aliases, entry.id, entry.callId].filter(Boolean))) calls.set(callKey(entry, alias), { step, key });
      step.entries.push(entry);
      return;
    }
    if (entry.kind === 'run' && entry.status === 'started') {
      closeStep();
      const step = stepFor(entry, index);
      activeRun = { step, lastStep: step, name: entry.name, taskId: entry.taskId, role: entry.role, end: null };
      runs.push(activeRun); metadata.get(step).runs.add(activeRun); step.entries.push(entry);
      return;
    }
    if (runFinished(entry)) {
      const run = [...runs].reverse().find(item => !item.end && item.name === entry.name
        && item.role === entry.role && item.taskId === entry.taskId);
      const step = run?.lastStep ?? stepFor(entry, index);
      step.entries.push(entry);
      if (run) { run.end = entry; if (activeRun === run) activeRun = null; }
      closeStep();
      return;
    }
    const step = stepFor(entry, index);
    step.entries.push(entry);
    if (entry.kind === 'checkpoint' && checkpointStatus(entry.status)) closeStep();
  });

  for (const step of timeline.filter(item => item.kind === 'step')) {
    const meta = metadata.get(step), records = step.entries;
    const lastCheckpoint = records.findLast(entry => entry.kind === 'checkpoint' && checkpointStatus(entry.status));
    const failed = records.some(entry => ['failed', 'error', 'denied'].includes(entry.status));
    const toolCalls = [...meta.calls.values()];
    const openCall = toolCalls.some(call => activeToolStatuses.has(call.status));
    const ownRunEnd = records.findLast(runFinished);
    const running = [...meta.runs].some(run => !run.end) && (!meta.sealed || !toolCalls.length);
    step.toolCallCount = toolCalls.length;
    const paused = ownRunEnd?.status === 'paused' || ownRunEnd?.status === 'cancelled'
      || toolCalls.some(call => call.status === 'cancelled');
    const completed = toolCalls.length > 0 && toolCalls.every(call => finishedToolStatuses.has(call.status))
      || ownRunEnd?.status === 'completed';
    step.status = failed ? 'failed' : paused ? 'paused' : lastCheckpoint ? checkpointStatus(lastCheckpoint.status)
      : openCall || running ? 'running' : completed ? 'completed' : 'recorded';
    step.title = meta.phase ? phaseTitle(meta.phase, lang)
      : describeActivity(lastCheckpoint ?? records.at(-1), { lang, task, conference }).title;
    const publicCheckpoint = records.findLast(entry => entry.kind === 'checkpoint' && !entry.redacted && text(entry.text) && !structured(entry.text));
    const summaryRecord = lastCheckpoint ?? records.findLast(entry => entry.kind === 'checkpoint'
      || entry.kind === 'run' && (['completed', 'failed'].includes(entry.status)
        || entry.status === 'started' && !toolCalls.length));
    if (publicCheckpoint) step.summary = text(publicCheckpoint.text);
    else if (summaryRecord) step.summary = describeActivity(summaryRecord, { lang, task, conference }).body;
    const times = records.map(entry => ({ at: entry.at, ms: Date.parse(entry.at) })).filter(value => Number.isFinite(value.ms));
    if (times.length) {
      const first = times.reduce((a, b) => a.ms <= b.ms ? a : b), last = times.reduce((a, b) => a.ms >= b.ms ? a : b);
      step.startedAt = first.at;
      const ended = step.status !== 'running' && (ownRunEnd || lastCheckpoint
        || toolCalls.length && toolCalls.every(call => finishedToolStatuses.has(call.status)));
      if (ended) { step.endedAt = last.at; step.durationMs = Math.max(0, last.ms - first.ms); }
    }
  }
  return timeline;
}

export function describeAgentState({ role, task, entries = [], owner, requests = [], policyCandidates = [], lang = 'zh' } = {}) {
  const T = language(lang);
  const state = (tone, label, body, needsOwner = false, requestIds = []) => ({ tone, label, body, needsOwner, requestIds });
  if (!task) return state('idle', T('等待任务', 'Ready for a task'), T('主人发送指令后，这里会显示当前进度。', 'Current progress appears here after the owner sends an instruction.'));
  const all = scoped(entries, task), own = all.filter(entry => entry.role === role), latest = own.at(-1);
  if (task.status === 'cancelled') return state('done', T('本次任务已停止', 'Task stopped'), T('活动任务已结束，已经发生的消息和结果保留在记录中。', 'Active work has ended. Existing messages and results remain in the history.'));
  if (task.status === 'completed' && (task.result || own.some(entry => entry.kind === 'result'))) return state('done', T('任务已完成', 'Task complete'), resultDescription(task.result ?? own.findLast(entry => entry.kind === 'result')?.details, lang).body);
  if (task.status === 'partial') return state('done', T('部分工作已完成', 'Partially complete'), task.result ? resultDescription(task.result, lang).body : T('已完成的工作保留，仍有步骤没有执行。', 'Completed work is retained; some steps were not executed.'));
  if (task.status === 'paused') return state('error', T('已暂停，等待恢复', 'Paused; recovery needed'), T('需要先核验当前状态，再从已保存的进度恢复。', 'Verify the current state before resuming saved work.'));

  const pending = new Map();
  for (const entry of all.filter(item => item.kind === 'approval')) {
    const id = entry.requestId ?? entry.details?.requestId ?? entry.details?.id;
    if (!id) continue;
    if (entry.status === 'pending') pending.set(id, entry);
    else if (['approved', 'denied', 'revoked', 'expired'].includes(entry.status)) pending.delete(id);
  }
  const ownRequests = role === owner ? list(requests).filter(item => item.status === 'pending' && item.intent?.taskId === task.id) : [];
  const ownCandidates = role === owner ? list(policyCandidates).filter(item => item.status === 'pending' && item.taskId === task.id) : [];
  const ownEvents = [...pending.values()].filter(entry => entry.role === role);
  if (ownRequests.length || ownCandidates.length || ownEvents.length) {
    const intent = ownRequests[0]?.intent ?? ownEvents[0]?.details?.intent;
    const ids = [...new Set([...ownRequests.map(item => item.id), ...ownCandidates.map(item => item.id), ...ownEvents.map(item => item.requestId ?? item.details?.id)].filter(Boolean))];
    return state('approval', T(`等待 ${role} 的主人授权`, `Waiting for ${role}’s owner`),
      intent?.action === 'reservation.submit' ? T('预约表单已准备好；主人批准后才会提交。', 'The reservation form is ready. It will only be submitted after owner approval.')
        : ownCandidates.length || ownEvents.some(entry => entry.name === 'authorization_propose_policy') ? T('长期规则需要主人确认后才会生效。', 'The standing rule takes effect only after owner confirmation.')
        : T('分享范围需要主人决定；待审资料尚未发送。', 'The owner must decide what may be shared. The pending material has not been sent.'), role === owner, role === owner ? ids : []);
  }
  if (latest?.kind === 'tool' && latest.status === 'started') return state('working', toolState(latest.name, lang), T('这项动作正在进行，具体调用与输出可展开查看。', 'This action is in progress. Expand execution details to inspect the call and output.'));
  if (latest?.kind === 'tool' && latest.status === 'failed') return state('error', T('这一步遇到问题', 'This step encountered a problem'), T('当前工具动作未正常完成，需要根据错误记录处理。可以展开执行细节查看原因。', 'The current tool action did not complete normally. Expand execution details to inspect the error and determine recovery.'));
  if (task.status === 'needs_owner') {
    const otherPending = [...pending.values()].find(entry => entry.role !== role);
    if (otherPending) return state('waiting', T(`等待 ${otherPending.role} 的主人决定`, `Waiting for ${otherPending.role}’s owner`), T('合作方正在处理授权步骤，收到后续信息或状态后继续。', 'The collaborator is handling an authorization step. Work continues when further information or status arrives.'));
    if (task.checkpoints?.[role]?.status === 'needs_owner') return state('approval', T(`等待 ${role} 的主人决定`, `Waiting for ${role}’s owner`), T('当前进度已保存，需要主人决定下一步。', 'Progress is saved. The owner needs to decide the next step.'), role === owner);
    return state('waiting', T('等待协作中的主人决定', 'Waiting for an owner decision'), T('协作停在需要人类决定的步骤；具体待审内容只在对应主人窗口显示。', 'Collaboration is waiting at a human decision step. Exact pending content appears only in the corresponding owner’s window.'));
  }
  if (task.status === 'completed') return state('waiting', T('等待核验结果', 'Awaiting a verified result'), T('运行状态已经更新，尚无可供汇报的核验结果。', 'The run status changed, but no verified result is available yet.'));
  if (latest?.kind === 'approval' && ['approved', 'denied'].includes(latest.status)) return state('working', T('已收到主人决定，继续处理', 'Owner decision received; continuing'), T('Agent 正按当前决定检查下一步，执行结果会另行核验。', 'The agent is checking the next step against the decision. Execution results will be verified separately.'));
  if (latest?.kind === 'checkpoint' && (latest.status === 'waiting_peer'
    || latest.name === 'native_run' && latest.status === 'checkpoint_saved' && task.checkpoints?.[role]?.status === 'waiting_peer')) return state('waiting', T(`等待 ${peer(role)} 的消息`, `Waiting for ${peer(role)}`), T('进度已保存，收到对方的实际信息后继续。', 'Progress is saved. Work continues after information actually arrives from the peer.'));
  if (latest?.kind === 'message' && latest.name === 'peer_request' && latest.direction === 'outgoing') return state('waiting', T(`等待 ${peer(role)} 回复`, `Waiting for ${peer(role)} to respond`), T('协作请求已送达，对方尚未提供所需内容。', 'The request was delivered. The peer has not yet provided the requested content.'));
  if (latest?.kind === 'message' && latest.direction === 'incoming') return state('working', T('已收到合作方消息', 'Peer message received'), T('正在依据实际收到的信息继续处理任务。', 'Continuing with the information actually received.'));
  if (latest?.kind === 'tool') return state('working', completedToolState(latest.name, lang), T('这项动作的结果已经返回，Agent 将据此安排下一步。任务的最终结果会单独核验。', 'This action returned a result for the agent’s next step. The final task outcome will be verified separately.'));
  return state('working', T('正在处理任务', 'Working on the task'), T('Agent 正在准备下一步；收到消息或需要主人决定时会在这里更新。', 'The agent is preparing its next step. This view updates when a message arrives or an owner decision is needed.'));
}
