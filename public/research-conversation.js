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

export function describeActivity(entry = {}, { lang = 'zh', task, conference } = {}) {
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
      const contents = materialText(payload, lang);
      return { title: T(`${from} 分享获准内容`, `${from} shared permitted content`), body: contents
        ? `${contents}\n${receipt}` : T(`这份材料已经发送。${receipt}可展开查看交付内容。`, `The material was sent. ${receipt} Expand to inspect the delivered content.`) };
    }
    if (entry.name === 'peer_request') {
      const request = ({ availability: ['请提供可用于约见的空闲时间', 'Please provide availability for a meeting'],
        report_interests: ['请提供符合你研究需求的报告', 'Please share presentations matching your research interests'],
        research_material: ['请提供可获准分享的研究材料', 'Please provide research material that may be shared with permission'],
        agenda_review: ['请审阅讨论议程并提出意见', 'Please review the discussion agenda'] })[data.kind];
      return { title: T(`${from} 向 ${to} 请求协作`, `${from} requested help from ${to}`),
        body: request ? `${request[lang === 'en' ? 1 : 0]}。${T('请求已经送达，所需内容尚待对方提供。', 'The request was delivered; the requested content has not yet been provided.')}`
          : T('协作请求已经送达对方。', 'The collaboration request was delivered to the peer.') };
    }
    if (entry.name === 'alignment_propose' || entry.name === 'alignment_accept') {
      const mappings = list(data.mappings), invalid = mappings.filter(mapping => mapping.valid === false);
      if (entry.name === 'alignment_accept') return { title: data.status === 'accepted' ? T('双方接受任务内的概念对应', 'Task-scoped correspondences accepted') : T('这组概念对应未被接受', 'Correspondences not accepted'),
        body: data.status === 'accepted' ? T(`对方审阅后接受了 ${mappings.length} 项对应；限定条件和相关关系仍然保留，没有把所有概念当作同义词。`, `The peer reviewed and accepted ${mappings.length} correspondences. Conditions and related meanings remain distinct; these are not blanket synonyms.`)
          : T('审阅发现对应不满足当前定义或适用条件，需要重新讨论。', 'The proposed correspondences did not meet the current definitions or conditions and need further discussion.') };
      const conditional = mappings.filter(mapping => mapping.relation === 'conditional').length;
      const related = mappings.filter(mapping => mapping.relation === 'related').length;
      return { title: T(`${from} 提议对齐概念含义`, `${from} proposed semantic correspondences`),
        body: T(`已向 ${to} 提交 ${mappings.length} 项对应供审阅${conditional ? `，其中 ${conditional} 项只在特定条件下成立` : ''}${related ? `，${related} 项只表示相关` : ''}。${invalid.length ? '其中有候选未通过适用范围检查，不能直接接受。' : '仍需对方审阅，提议本身不代表已经接受。'}`,
          `${mappings.length} correspondences were proposed to ${to}${conditional ? `; ${conditional} are conditional` : ''}${related ? `; ${related} express related meanings` : ''}. ${invalid.length ? 'Some candidates failed the scope check and cannot be accepted as-is.' : 'Peer review is still required; proposing is not acceptance.'}`) };
    }
    return { title: T('收到协作信息', 'Collaboration information'), body: T('这条信息已记入双方的协作记录，可展开查看原始内容。', 'This information is recorded in the collaboration history. Expand to inspect the original content.') };
  }
  if (entry.kind === 'approval') {
    if (entry.status === 'pending') {
      const policy = entry.name === 'authorization_propose_policy';
      return { title: T('需要主人授权', 'Owner authorization needed'), body: entry.redacted
        ? T(`${entry.role} 正在等待自己的主人决定；待审内容保留在本方窗口。`, `${entry.role} is waiting for their owner’s decision. Pending content stays in that owner’s window.`)
        : policy ? T('Agent 提议了一条长期规则，需要主人确认后才会生效。', 'The agent proposed a standing rule. It takes effect only after owner confirmation.')
          : T(`Agent 请求${requestAction(data.intent, lang)}。这一步正在等待主人决定，尚未执行。`, `The agent requests permission to ${requestAction(data.intent, lang)}. It is waiting for the owner’s decision and has not executed this step.`) };
    }
    const denied = entry.status === 'denied' || data.decision === 'deny';
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
