import { RuntimeError, invariant } from './runtime-helpers.mjs';

const BOB_ACTIONS = new Set(['request_more', 'meeting', 'no_match', 'share_brief']);
const CONNECTIVITY_ACK = 'Synthetic connectivity test acknowledged.';
const diagnostic = (code, message, detail) => Object.freeze({ code, message, detail, retryable: true });

/** Fixed classifications only. Neither this table nor the returned diagnostic contains provider text. */
export const MODEL_OUTPUT_DIAGNOSTICS = Object.freeze({
  MISSING_PROPOSAL: diagnostic('MODEL_INVALID_OUTPUT', 'The model returned no planning choice.', '模型没有返回本轮可用的提案。'),
  UNFINISHED_PROPOSAL: diagnostic('MODEL_INVALID_OUTPUT', 'The model did not finish a usable planning proposal.', '模型提案未完整生成。'),
  TRUNCATED_PROPOSAL: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal was truncated before completion.', '模型输出达到长度限制，提案未完整生成。'),
  REFUSED_PROPOSAL: diagnostic('MODEL_INVALID_OUTPUT', 'The model provider declined to return a planning proposal.', '模型服务没有提供本轮提案。'),
  MULTIPLE_PROPOSALS: diagnostic('MODEL_INVALID_OUTPUT', 'The model returned more than one planning tool call.', '模型同时返回多个提案；本轮只允许一个明确提案。'),
  UNSUPPORTED_TOOL: diagnostic('MODEL_INVALID_OUTPUT', 'The model returned an unsupported planning tool.', '模型返回了本轮不允许的工具。'),
  INVALID_TOOL_ARGUMENTS: diagnostic('MODEL_INVALID_OUTPUT', 'The model planning tool arguments must be a JSON string.', '模型的提案参数格式不正确，应返回完整 JSON 对象。'),
  MISSING_JSON: diagnostic('MODEL_INVALID_OUTPUT', 'The model returned no bounded JSON proposal.', '模型没有返回长度范围内的 JSON 提案。'),
  INVALID_JSON: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal is not valid JSON.', '模型提案的 JSON 格式不完整或无效。'),
  NON_OBJECT_JSON: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal must be a JSON object.', '模型应返回一个提案对象，而非列表或其他值。'),
  FORBIDDEN_FIELDS: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal contains a forbidden field.', '模型提案含有本轮禁止的字段。'),
  JSON_STRUCTURE_LIMIT: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal exceeds the JSON structure limit.', '模型提案的嵌套或内容规模超过限制。'),
  RESPONSE_SIZE_LIMIT: diagnostic('MODEL_INVALID_OUTPUT', 'The model response exceeded the size limit.', '模型服务响应超过大小限制。'),
  INVALID_RESPONSE_JSON: diagnostic('MODEL_INVALID_OUTPUT', 'The model response is not valid JSON.', '模型服务返回的响应格式无效。'),
  ONTOLOGY_SELECTION: diagnostic('MODEL_INVALID_OUTPUT', 'The model must select registered mapping identifiers or explicitly choose none.', '模型的概念对应选择格式不完整，应选择本轮候选或明确拒绝。'),
  REFUSAL_MAPPING_IDS: diagnostic('MODEL_INVALID_OUTPUT', 'A rejected or none proposal cannot include accepted mappings.', '模型表达了拒绝，同时附带概念对应；拒绝不能登记为接受。'),
  INCOMPLETE_MAPPING: diagnostic('MODEL_INVALID_OUTPUT', 'The model accepted an incomplete set of registered mapping identifiers.', '模型表示接受，却漏选了本任务必要的概念对应；尚未形成双方认可。'),
  MISSING_MESSAGE: diagnostic('MODEL_INVALID_OUTPUT', 'The model must propose a bounded message.', '模型没有提供长度范围内的说明文字。'),
  UNSUPPORTED_PROPOSAL_FIELDS: diagnostic('MODEL_INVALID_OUTPUT', 'The model planning proposal contains unsupported fields.', '模型提案多出了本轮不允许的字段。'),
  MISSING_ACTION: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal is missing the required action object.', '模型没有提供本轮需要的下一步行动。'),
  UNSUPPORTED_ACTION: diagnostic('MODEL_INVALID_OUTPUT', 'The model action.type is not permitted for this planning step.', '模型选择了本轮不允许的行动。'),
  UNSUPPORTED_ACTION_FIELDS: diagnostic('MODEL_INVALID_OUTPUT', 'The model action contains fields not permitted for this planning step.', '模型行动中包含不属于该行动的字段。'),
  INVALID_MEETING_SHAPE: diagnostic('MODEL_INVALID_MEETING', 'The model meeting action is missing action.meeting.day or action.meeting.time.', '模型约会提案没有完整提供日期和时段。'),
  MEETING_OUTSIDE_SHARED_TIME: diagnostic('MODEL_INVALID_MEETING', 'The model meeting is outside the actually shared free-time intersection.', '模型提议的时段不在实际共享的共同空闲时间内，或不满足任务时长。'),
  INVALID_BRIEF_FIELDS: diagnostic('MODEL_INVALID_OUTPUT', 'The model brief requires a nonempty unique action.fields list.', '模型没有明确列出要共享的简报字段，或字段重复。'),
  INVALID_BRIEF_SHAPE: diagnostic('MODEL_INVALID_OUTPUT', 'The model brief requires action.values and action.resource = meeting_brief.', '模型简报提案缺少字段内容或正确的资源类型。'),
  BRIEF_SOURCE_MISMATCH: diagnostic('MODEL_INVALID_OUTPUT', 'The model brief must propose actual Bob data only.', '模型简报提案与 Bob 的实际源数据不一致，未发送任何简报。'),
  INVALID_ALICE_REPLY: diagnostic('MODEL_INVALID_OUTPUT', 'The model Alice reply must contain only a message.', 'Alice 的说明应只含文字；模型加入了本轮不允许的行动或字段。'),
  INVALID_CONNECTIVITY_ACK: diagnostic('MODEL_INVALID_OUTPUT', 'The model did not acknowledge the synthetic connectivity check.', '模型服务已响应，但没有提供有效的连接测试确认。'),
  INVALID_PROPOSAL: diagnostic('MODEL_INVALID_OUTPUT', 'The model proposal failed validation.', '模型结果未通过本轮提案校验。'),
});

export function modelOutputDiagnostic(error) {
  if (!['MODEL_INVALID_OUTPUT', 'MODEL_INVALID_MEETING'].includes(error?.code)) return null;
  const entry = Object.entries(MODEL_OUTPUT_DIAGNOSTICS).find(([, item]) => item.code === error.code && item.message === error.message);
  const [reasonCode, item] = entry || ['INVALID_PROPOSAL', MODEL_OUTPUT_DIAGNOSTICS.INVALID_PROPOSAL];
  return { reasonCode, detail: item.detail, retryable: item.retryable };
}

function stageContract(context) {
  if (context?.purpose === 'ontology_alignment') {
    const ids = (context.candidates || []).map(candidate => candidate.id).filter(id => typeof id === 'string');
    return 'OUTPUT CONTRACT: Call submit_proposal exactly once. Return only the three required keys message, decision, selectedMappingIds. '
      + 'message must be a nonempty string; decision must be accept, reject, or none. selectedMappingIds must be an actual JSON array of strings, never a string, object, or comma-separated list. '
      + 'For accept, select ALL supplied candidate identifiers exactly once. For reject or none, use an empty array. '
      + `A complete acceptance object is ${JSON.stringify({ message: 'The supplied task correspondences are acceptable.', decision: 'accept', selectedMappingIds: ids })}. `
      + `A complete refusal object is ${JSON.stringify({ message: 'No supplied correspondence is acceptable.', decision: 'none', selectedMappingIds: [] })}. `
      + 'Choose your decision from the supplied definitions. Do not return or copy the input context, candidates, mappings, task, action, permissions, analysis, or any additional keys. This proposal never authorizes data sharing.';
  }
  if (context?.purpose === 'connectivity_test' && context.synthetic === true) return `OUTPUT CONTRACT: Call submit_proposal exactly once with ${JSON.stringify({ message: CONNECTIVITY_ACK })}. Add no other keys.`;
  const actions = Array.isArray(context?.allowedActions) ? context.allowedActions.filter(type => BOB_ACTIONS.has(type)) : [];
  if (!actions.length) return 'OUTPUT CONTRACT: Call submit_proposal exactly once with one JSON object containing only message, a nonempty string. Do not copy the input context or add an action, permission, reasoning, or other keys.';
  return `OUTPUT CONTRACT: Call submit_proposal exactly once with one JSON object containing only message and action. message must be a nonempty string. action.type must be one of ${JSON.stringify(actions)}. `
    + 'request_more and no_match contain only action.type. meeting contains only action.type and action.meeting; meeting contains only day and time from the actual sharedIntersection for the exact task duration. '
    + 'share_brief contains only action.type, action.fields, action.values, and action.resource="meeting_brief"; choose existing ownBrief fields and copy their exact JSON values. '
    + 'Do not put nested action fields at the top level, copy the context, invent source values, or add authorization, permissions, reasoning, or extra keys.';
}

function proposalTool(context) {
  if (context?.purpose === 'ontology_alignment') {
    const ids = (context.candidates || []).map(candidate => candidate.id).filter(id => typeof id === 'string');
    return { type: 'function', function: { name: 'submit_proposal',
      description: 'Select only supplied semantic correspondences or choose none. This does not authorize data sharing.',
      parameters: { type: 'object', additionalProperties: false, required: ['message', 'decision', 'selectedMappingIds'],
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 1000, description: 'Brief explanation using only supplied definitions.' },
          decision: { type: 'string', enum: ['accept', 'reject', 'none'], description: 'Accept the complete task mapping set, or explicitly refuse it with reject/none.' },
          selectedMappingIds: { type: 'array', uniqueItems: true, minItems: 0, maxItems: ids.length,
            description: 'A JSON array of supplied identifier strings. accept requires all identifiers; reject/none requires [].',
            items: ids.length ? { type: 'string', enum: ids } : { type: 'string' } },
        }, oneOf: [
          { properties: { decision: { enum: ['accept'] }, selectedMappingIds: { minItems: ids.length, maxItems: ids.length } } },
          { properties: { decision: { enum: ['reject', 'none'] }, selectedMappingIds: { maxItems: 0 } } },
        ] } } };
  }
  const actions = Array.isArray(context?.allowedActions) ? context.allowedActions.filter(type => BOB_ACTIONS.has(type)) : [];
  const parameters = { type: 'object', additionalProperties: false,
    properties: { message: { type: 'string', minLength: 1, maxLength: 4000, description: 'Short participant-facing message, without private data or reasoning.' } }, required: ['message'] };
  if (context?.purpose === 'connectivity_test' && context.synthetic === true) parameters.properties.message = {
    type: 'string', const: CONNECTIVITY_ACK, minLength: 1, maxLength: 2000,
    description: 'Copy this fixed acknowledgement exactly into message; no action or extra fields.'
  };
  if (actions.length) {
    const action = { type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', enum: actions, description: 'Choose exactly one listed action name.' } }, required: ['type'] };
    if (actions.includes('meeting')) action.properties.meeting = { type: 'object', additionalProperties: false,
      properties: { day: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
        time: { type: 'string', description: `A ${context?.task?.durationMinutes || 30}-minute HH:mm–HH:mm interval inside sharedIntersection.` } }, required: ['day', 'time'] };
    if (actions.includes('share_brief')) {
      const fields = Object.keys(context.ownBrief ?? {});
      action.properties.fields = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: fields } };
      action.properties.values = { type: 'object', additionalProperties: false,
        properties: Object.fromEntries(fields.map(field => [field, { const: context.ownBrief[field], description: 'Copy this field exactly from ownBrief; do not invent or summarize it.' }])) };
      action.properties.resource = { type: 'string', enum: ['meeting_brief'] };
      if (actions.length === 1) action.required.push('fields', 'values', 'resource');
    }
    action.oneOf = actions.map(type => ({ type: 'object', properties: { type: { enum: [type] } },
      required: ['type', ...(type === 'meeting' ? ['meeting'] : type === 'share_brief' ? ['fields', 'values', 'resource'] : [])] }));
    parameters.properties.action = action;
    parameters.required.push('action');
  }
  return { type: 'function', function: { name: 'submit_proposal',
    description: 'Submit exactly one planning proposal using this schema. Submission proposes data only; the controller separately verifies and authorizes any transfer.', parameters } };
}

function negativeOntologyProposal(result, context) {
  if (context?.purpose !== 'ontology_alignment' || !result || typeof result !== 'object' || Array.isArray(result)
    || !Object.hasOwn(result, 'decision') || !['none', 'reject'].includes(result.decision)) return null;
  // A parsed negative decision cannot be corrected into acceptance. Discard all supplied
  // IDs and extra data; this projection can only decline the current task correspondence.
  const message = typeof result.message === 'string' && result.message.trim() && result.message.length <= 4000
    ? result.message.trim() : 'The model declined the supplied task correspondences.';
  return { message, decision: result.decision, selectedMappingIds: [] };
}

function parseProposal(data, context) {
  invariant(!data?.error && (!data?.base_resp?.status_code || data.base_resp.status_code === 0),
    'MODEL_PROVIDER_ERROR', 'The model provider rejected this request.', 502);
  const choice = data?.choices?.[0];
  invariant(choice && typeof choice === 'object', 'MODEL_INVALID_OUTPUT', 'The model returned no planning choice.', 502);
  const assertCompletion = () => {
    invariant(choice.finish_reason !== 'length', 'MODEL_INVALID_OUTPUT', 'The model proposal was truncated before completion.', 502);
    invariant(choice.finish_reason !== 'content_filter' && !choice.message?.refusal,
      'MODEL_INVALID_OUTPUT', 'The model provider declined to return a planning proposal.', 502);
  };
  try {
    const calls = choice.message?.tool_calls;
    let source;
    invariant(calls === undefined || calls === null || Array.isArray(calls),
      'MODEL_INVALID_OUTPUT', 'The model returned an unsupported planning tool.', 502);
    if (Array.isArray(calls) && calls.length) {
      invariant(calls.length === 1, 'MODEL_INVALID_OUTPUT', 'The model returned more than one planning tool call.', 502);
      invariant(calls[0]?.type === 'function' && calls[0].function?.name === 'submit_proposal',
        'MODEL_INVALID_OUTPUT', 'The model returned an unsupported planning tool.', 502);
      source = calls[0].function.arguments;
      invariant(typeof source === 'string', 'MODEL_INVALID_OUTPUT', 'The model planning tool arguments must be a JSON string.', 502);
    } else {
      source = choice.message?.content;
      if (typeof source === 'string') source = source.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
    }
    invariant(typeof source === 'string', 'MODEL_INVALID_OUTPUT', 'The model returned no bounded JSON proposal.', 502);
    let result;
    try { result = JSON.parse(source); } catch { throw new RuntimeError('MODEL_INVALID_OUTPUT', 'The model proposal is not valid JSON.', 502); }
    invariant(result && typeof result === 'object' && !Array.isArray(result), 'MODEL_INVALID_OUTPUT', 'The model proposal must be a JSON object.', 502);
    const negative = negativeOntologyProposal(result, context);
    if (negative) return negative;
    assertCompletion();
    invariant(source.length <= 262144, 'MODEL_INVALID_OUTPUT', 'The model returned no bounded JSON proposal.', 502);
    const pending = [{ value: result, depth: 0 }];
    let nodes = 1;
    while (pending.length) {
      const { value, depth } = pending.pop();
      if (!value || typeof value !== 'object') continue;
      invariant(depth <= 32, 'MODEL_INVALID_OUTPUT', 'The model proposal exceeds the JSON structure limit.', 502);
      invariant(!Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype', 'reasoning_content', 'reasoning_details'].includes(key)),
        'MODEL_INVALID_OUTPUT', 'The model proposal contains a forbidden field.', 502);
      const children = Object.values(value);
      nodes += children.length;
      invariant(nodes <= 8192, 'MODEL_INVALID_OUTPUT', 'The model proposal exceeds the JSON structure limit.', 502);
      for (const child of children) pending.push({ value: child, depth: depth + 1 });
    }
    return result;
  } catch (error) {
    assertCompletion();
    throw error;
  }
}

/** One attempt. Workers own bounded retries; only this trusted parent has a provider key and network access. */
export async function callProvider({ connection, settings, system, context, signal }) {
  invariant(connection?.baseUrl && settings?.model && (connection.provider !== 'minimax_cn_token_plan' || connection.apiKey),
    'MODEL_UNAVAILABLE', '请先在管理员模型配置中保存 Token Plan 专用 Key。', 503);
  const abort = new AbortController();
  const cancelled = () => abort.abort(signal?.reason ?? 'cancelled');
  if (signal?.aborted) cancelled(); else signal?.addEventListener('abort', cancelled, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; abort.abort('timeout'); }, settings.timeoutSeconds * 1000);
  timer.unref();
  const miniMax = connection.provider === 'minimax_cn_token_plan';
  const input = { model: settings.model, messages: [{ role: 'system', content: `${system}\n${stageContract(context)}` }, { role: 'user', content: JSON.stringify(context) }],
    stream: false, temperature: settings.temperature, tools: [proposalTool(context)],
    ...(miniMax ? { max_completion_tokens: settings.maxTokens, thinking: { type: settings.thinking ?? 'disabled' }, reasoning_split: true, tool_choice: 'required' }
      : { max_tokens: settings.maxTokens, response_format: { type: 'json_object' }, store: false }) };
  try {
    const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
      body: JSON.stringify(input), signal: abort.signal, redirect: 'error'
    });
    invariant(response.ok, 'MODEL_PROVIDER_ERROR', `The model provider returned HTTP ${response.status}.`, 502);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; invariant(bytes <= 1048576, 'MODEL_INVALID_OUTPUT', 'The model response exceeded the size limit.', 502); chunks.push(chunk); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RuntimeError('MODEL_INVALID_OUTPUT', 'The model response is not valid JSON.', 502); }
    return parseProposal(data, context);
  } catch (error) {
    if (expired) throw new RuntimeError('MODEL_TIMEOUT', 'The model request timed out; no action was executed.', 504);
    if (signal?.aborted) throw new RuntimeError('STALE_EPOCH', 'The model request was cancelled by the controller.', 409);
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('MODEL_PROVIDER_ERROR', 'The model provider could not be reached.', 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
}

export async function probeModel(snapshot, role, signal) {
  invariant(['Alice', 'Bob'].includes(role), 'MODEL_ROLE', 'Choose Alice or Bob.');
  const started = Date.now();
  const result = await callProvider({ connection: { ...snapshot.config, apiKey: snapshot.apiKey }, settings: snapshot.config.agents[role],
    system: `This is a synthetic connectivity check. Call submit_proposal exactly once with these complete JSON arguments: ${JSON.stringify({ message: CONNECTIVITY_ACK })}. `
      + 'message is a required string. Copy the fixed acknowledgement exactly; do not add action, keys, reasoning or any other fields. This submits data only and performs no transfer.',
    context: { purpose: 'connectivity_test', role, synthetic: true }, signal });
  invariant(typeof result.message === 'string' && result.message.trim().length > 0 && result.message.length <= 2000,
    'MODEL_INVALID_OUTPUT', 'The model did not acknowledge the synthetic connectivity check.', 502);
  return { role, model: snapshot.config.agents[role].model, latencyMs: Date.now() - started,
    response: CONNECTIVITY_ACK };
}
