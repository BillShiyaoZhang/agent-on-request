import { RuntimeError, invariant } from './runtime-helpers.mjs';

const BOB_ACTIONS = new Set(['request_more', 'meeting', 'no_match', 'share_brief']);
function proposalTool(context) {
  const actions = Array.isArray(context?.allowedActions) ? context.allowedActions.filter(type => BOB_ACTIONS.has(type)) : [];
  const parameters = { type: 'object', additionalProperties: false,
    properties: { message: { type: 'string', minLength: 1, maxLength: 4000, description: 'Short participant-facing message, without private data or reasoning.' } }, required: ['message'] };
  if (actions.length) {
    const action = { type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', enum: actions, description: 'Choose exactly one listed action name.' } }, required: ['type'] };
    if (actions.includes('meeting')) action.properties.meeting = { type: 'object', additionalProperties: false,
      properties: { day: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
        time: { type: 'string', description: 'A 30-minute HH:mm–HH:mm interval inside sharedIntersection.' } }, required: ['day', 'time'] };
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

function parseProposal(data) {
  invariant(!data?.error && (!data?.base_resp?.status_code || data.base_resp.status_code === 0),
    'MODEL_PROVIDER_ERROR', 'The model provider rejected this request.', 502);
  const choice = data?.choices?.[0];
  invariant(choice && !['length', 'content_filter'].includes(choice.finish_reason) && !choice.message?.refusal,
    'MODEL_INVALID_OUTPUT', 'The model did not finish a usable planning proposal.', 502);
  const calls = choice.message?.tool_calls;
  let source;
  if (calls?.length) {
    invariant(calls.length === 1 && calls[0]?.type === 'function' && calls[0].function?.name === 'submit_proposal',
      'MODEL_INVALID_OUTPUT', 'The model returned an unsupported planning tool.', 502);
    source = calls[0].function.arguments;
  } else {
    source = choice.message?.content;
    if (typeof source === 'string') source = source.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  }
  invariant(typeof source === 'string' && source.length <= 262144, 'MODEL_INVALID_OUTPUT', 'The model returned no bounded JSON proposal.', 502);
  let result;
  try { result = JSON.parse(source); } catch { throw new RuntimeError('MODEL_INVALID_OUTPUT', 'The model proposal is not valid JSON.', 502); }
  invariant(result && typeof result === 'object' && !Array.isArray(result), 'MODEL_INVALID_OUTPUT', 'The model proposal must be a JSON object.', 502);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    invariant(!Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype', 'reasoning_content', 'reasoning_details'].includes(key)),
      'MODEL_INVALID_OUTPUT', 'The model proposal contains a forbidden field.', 502);
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(result);
  return result;
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
  const input = { model: settings.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }],
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
    return parseProposal(data);
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
    system: 'This is a synthetic connectivity check. Submit a JSON object with a short message acknowledging the test. Never include keys or reasoning.',
    context: { purpose: 'connectivity_test', role, synthetic: true }, signal });
  invariant(typeof result.message === 'string' && result.message.trim().length > 0 && result.message.length <= 2000,
    'MODEL_INVALID_OUTPUT', 'The model did not acknowledge the synthetic connectivity check.', 502);
  return { role, model: snapshot.config.agents[role].model, latencyMs: Date.now() - started,
    response: 'Synthetic connectivity test acknowledged.' };
}
