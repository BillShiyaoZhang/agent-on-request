import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, probeModel, modelOutputDiagnostic, MODEL_OUTPUT_DIAGNOSTICS } from '../src/model-provider.mjs';
import { DEFAULT_MODEL_CONFIG } from '../src/model-store.mjs';

const settings = DEFAULT_MODEL_CONFIG.agents.Alice;
const connection = { provider: 'minimax_cn_token_plan', baseUrl: 'https://api.minimax.cn/v1', apiKey: 'sk-cp-synthetic-test-secret' };
const args = { connection, settings, system: 'Propose one action.', context: { synthetic: true } };
const response = body => new Response(JSON.stringify(body), { status: 200 });

test('MiniMax M3 uses the China endpoint, subscription key and proposal tool without unsupported JSON mode', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return response({ choices: [{ finish_reason: 'tool_calls', message: { content: '', reasoning_content: 'PRIVATE_REASONING',
      tool_calls: [{ type: 'function', function: { name: 'submit_proposal', arguments: JSON.stringify({ message: 'Ready.', action: { type: 'request_more' } }) } }] } }] });
  });
  assert.deepEqual(await callProvider(args), { message: 'Ready.', action: { type: 'request_more' } });
  assert.equal(request.url, 'https://api.minimax.cn/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${connection.apiKey}`);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.model, 'MiniMax-M3');
  assert.equal(request.body.max_completion_tokens, 4096);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.reasoning_split, true);
  assert.equal(request.body.response_format, undefined);
  assert.equal(request.body.tool_choice, 'required');
  assert.equal(request.body.tools[0].function.name, 'submit_proposal');
  assert.equal(JSON.stringify(request.body).includes(connection.apiKey), false);
});

test('final JSON fallback strips think blocks; probes never echo provider text or reasoning', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ choices: [{ finish_reason: 'stop', message: {
    content: '<think>PRIVATE_REASONING</think>\n```json\n{"message":"PROVIDER_TEXT_SECRET"}\n```', reasoning_content: 'HIDDEN' } }] }));
  assert.deepEqual(await callProvider(args), { message: 'PROVIDER_TEXT_SECRET' });
  const result = await probeModel({ config: DEFAULT_MODEL_CONFIG, revision: 1, apiKey: connection.apiKey }, 'Bob');
  assert.equal(result.role, 'Bob');
  assert.equal(result.response, 'Synthetic connectivity test acknowledged.');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('proposal schemas require stage-specific Bob actions and complete meeting and brief shapes', async t => {
  let input;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    input = JSON.parse(options.body);
    return response({ choices: [{ finish_reason: 'stop', message: { content: '{"message":"ok"}' } }] });
  });
  await callProvider({ ...args, context: { allowedActions: ['request_more', 'meeting', 'no_match'] } });
  const parameters = input.tools[0].function.parameters;
  assert.deepEqual(parameters.required, ['message', 'action']);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties.action.properties.type.enum, ['request_more', 'meeting', 'no_match']);
  assert.deepEqual(parameters.properties.action.oneOf.find(branch => branch.properties.type.enum[0] === 'meeting').required, ['type', 'meeting']);
  assert.deepEqual(parameters.properties.action.properties.meeting.required, ['day', 'time']);
  assert.deepEqual(parameters.properties.action.oneOf.find(branch => branch.properties.type.enum[0] === 'no_match').required, ['type']);
  await callProvider({ ...args, context: { allowedActions: ['share_brief'], ownBrief: { topic: 'Synthetic topic', agenda: { step: 1 } } } });
  const action = input.tools[0].function.parameters.properties.action;
  assert.deepEqual(action.required, ['type', 'fields', 'values', 'resource']);
  assert.deepEqual(action.properties.fields.items.enum, ['topic', 'agenda']);
  assert.equal(action.properties.values.additionalProperties, false);
  assert.deepEqual(Object.keys(action.properties.values.properties), ['topic', 'agenda']);
  assert.deepEqual(action.properties.resource.enum, ['meeting_brief']);
  await callProvider({ ...args, context: { purpose: 'intro', ownCalendar: [] } });
  assert.deepEqual(input.tools[0].function.parameters.required, ['message']);
  assert.equal(input.tools[0].function.parameters.properties.action, undefined);
});

test('ontology proposals specify complete identifier arrays and exactly three output keys', async t => {
  const candidates = [{ id: 'mapping-day' }, { id: 'mapping-time' }, { id: 'mapping-free' }];
  let input;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    input = JSON.parse(options.body);
    return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
      function: { name: 'submit_proposal', arguments: JSON.stringify({ message: 'I agree with these definitions.', decision: 'accept', selectedMappingIds: candidates.map(item => item.id) }) } }] } }] });
  });
  const output = await callProvider({ ...args, context: { purpose: 'ontology_alignment', candidates, task: { type: 'schedule' } } });
  assert.deepEqual(output.selectedMappingIds, candidates.map(item => item.id));
  const schema = input.tools[0].function.parameters;
  assert.deepEqual(schema.required, ['message', 'decision', 'selectedMappingIds']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ['message', 'decision', 'selectedMappingIds']);
  assert.equal(schema.properties.selectedMappingIds.type, 'array');
  assert.equal(schema.properties.selectedMappingIds.uniqueItems, true);
  assert.deepEqual(schema.properties.selectedMappingIds.items.enum, candidates.map(item => item.id));
  const accept = schema.oneOf.find(branch => branch.properties.decision.enum.includes('accept'));
  const refuse = schema.oneOf.find(branch => branch.properties.decision.enum.includes('none'));
  assert.deepEqual(accept.properties.selectedMappingIds, { minItems: candidates.length, maxItems: candidates.length });
  assert.deepEqual(refuse.properties.selectedMappingIds, { maxItems: 0 });
  const contract = input.messages[0].content;
  assert(contract.includes(JSON.stringify({ message: 'The supplied task correspondences are acceptable.', decision: 'accept', selectedMappingIds: candidates.map(item => item.id) })));
  assert(contract.includes(JSON.stringify({ message: 'No supplied correspondence is acceptable.', decision: 'none', selectedMappingIds: [] })));
  assert(contract.includes('actual JSON array of strings, never a string'));
  assert(contract.includes('Do not return or copy the input context'));
  assert(contract.includes('This proposal never authorizes data sharing.'));
  assert.equal(input.tool_choice, 'required');
  assert.equal(input.response_format, undefined);
});

test('both connectivity probes give submit_proposal a complete fixed acknowledgement contract', async t => {
  const inputs = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const input = JSON.parse(options.body); inputs.push(input);
    const message = input.tools[0].function.parameters.properties.message.const;
    return response({ choices: [{ finish_reason: 'tool_calls', message: { reasoning_content: 'SYNTHETIC_PRIVATE_REASONING',
      tool_calls: [{ type: 'function', function: { name: 'submit_proposal', arguments: JSON.stringify({ message }) } }] } }] });
  });
  for (const role of ['Alice', 'Bob']) {
    const result = await probeModel({ config: DEFAULT_MODEL_CONFIG, apiKey: connection.apiKey }, role);
    assert.equal(result.response, 'Synthetic connectivity test acknowledged.');
    const input = inputs.at(-1), schema = input.tools[0].function.parameters;
    assert.deepEqual(schema.required, ['message']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.message.type, 'string');
    assert.equal(schema.properties.message.const, result.response);
    assert.equal(schema.properties.message.maxLength, 2000);
    assert.equal(schema.properties.action, undefined);
    assert(input.messages[0].content.includes('Call submit_proposal exactly once'));
    assert(input.messages[0].content.includes(JSON.stringify({ message: result.response })));
    assert.deepEqual(JSON.parse(input.messages[1].content), { purpose: 'connectivity_test', role, synthetic: true });
    assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'), false);
  }
  assert.equal(inputs.length, 2, 'each explicit probe makes exactly one provider request');
});

test('connectivity probes retain bounded string validation and never retry malformed acknowledgements', async t => {
  let proposed, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
      function: { name: 'submit_proposal', arguments: JSON.stringify(proposed) } }] } }] });
  });
  for (proposed of [{}, { message: '' }, { message: { content: 'SYNTHETIC_PROVIDER_SECRET' } }, { message: 'x'.repeat(2001) }]) {
    const before = calls;
    await assert.rejects(probeModel({ config: DEFAULT_MODEL_CONFIG, apiKey: connection.apiKey }, 'Alice'), error => {
      assert.equal(error.code, 'MODEL_INVALID_OUTPUT');
      assert.equal(error.message, 'The model did not acknowledge the synthetic connectivity check.');
      assert.equal(error.message.includes('PROVIDER_SECRET'), false);
      return true;
    });
    assert.equal(calls, before + 1);
  }
});

test('truncation, refusals, business errors, unregistered tools and unsafe JSON cannot become successful plans', async t => {
  const cases = [
    { choices: [{ finish_reason: 'length', message: { content: '{"message":"partial"}' } }] },
    { choices: [{ message: { refusal: 'REFUSAL_SECRET', content: '{"message":"refused"}' } }] },
    { base_resp: { status_code: 1008, status_msg: 'BUSINESS_SECRET' } },
    { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'execute_shell', arguments: '{}' } }] } }] },
    { choices: [{ message: { content: '{"message":"ok","__proto__":{"evil":true}}' } }] },
    { choices: [{ message: { content: '{"message":"ok","reasoning_content":"SECRET"}' } }] },
    { choices: [{ message: { content: 'not JSON SECRET' } }] }
  ];
  let current;
  t.mock.method(globalThis, 'fetch', async () => response(current));
  for (current of cases) await assert.rejects(callProvider(args), error => {
    assert.ok(['MODEL_INVALID_OUTPUT', 'MODEL_PROVIDER_ERROR'].includes(error.code));
    assert.equal(error.message.includes('SECRET'), false); return true;
  });
});

test('invalid model response shapes have fixed actionable diagnostics without raw text or inner retries', async t => {
  const tool = arguments_ => ({ type: 'function', function: { name: 'submit_proposal', arguments: arguments_ } });
  const cases = [
    [{ choices: [] }, 'MISSING_PROPOSAL'],
    [{ choices: [{ finish_reason: 'length', message: { content: 'RAW_SECRET' } }] }, 'TRUNCATED_PROPOSAL'],
    [{ choices: [{ finish_reason: 'content_filter', message: { content: 'RAW_SECRET' } }] }, 'REFUSED_PROPOSAL'],
    [{ choices: [{ message: { refusal: 'RAW_SECRET' } }] }, 'REFUSED_PROPOSAL'],
    [{ choices: [{ message: { tool_calls: [tool('{}'), tool('{}')] } }] }, 'MULTIPLE_PROPOSALS'],
    [{ choices: [{ message: { tool_calls: 'RAW_SECRET', content: '{"message":"otherwise valid"}' } }] }, 'UNSUPPORTED_TOOL'],
    [{ choices: [{ message: { tool_calls: [tool({ message: 'RAW_SECRET' })] } }] }, 'INVALID_TOOL_ARGUMENTS'],
    [{ choices: [{ message: { content: null } }] }, 'MISSING_JSON'],
    [{ choices: [{ message: { content: '{"message":"RAW_SECRET"' } }] }, 'INVALID_JSON'],
    [{ choices: [{ message: { content: '"RAW_SECRET"' } }] }, 'NON_OBJECT_JSON'],
    [{ choices: [{ message: { content: '{"message":"ok","prototype":{"secret":"RAW_SECRET"}}' } }] }, 'FORBIDDEN_FIELDS'],
  ];
  let current, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(current); });
  for (const [body, reasonCode] of cases) {
    current = body;
    const before = calls;
    await assert.rejects(callProvider(args), error => {
      const diagnostic = modelOutputDiagnostic(error);
      assert.equal(error.code, 'MODEL_INVALID_OUTPUT');
      assert.equal(diagnostic.reasonCode, reasonCode);
      assert.equal(typeof diagnostic.detail, 'string');
      assert.equal(diagnostic.retryable, true);
      assert.equal(JSON.stringify({ message: error.message, diagnostic }).includes('RAW_SECRET'), false);
      assert.deepEqual(Object.keys(diagnostic).sort(), ['detail', 'reasonCode', 'retryable']);
      return true;
    });
    assert.equal(calls, before + 1);
  }
});

test('deep or broad JSON proposals fail bounded validation instead of producing a generic transport error', async t => {
  let current;
  t.mock.method(globalThis, 'fetch', async () => response({ choices: [{ message: { content: JSON.stringify(current) } }] }));
  let nested = { message: 'RAW_SECRET' };
  for (let i = 0; i < 40; i++) nested = { value: nested };
  for (current of [nested, { message: 'RAW_SECRET', values: Array.from({ length: 8200 }, () => 0) }]) {
    await assert.rejects(callProvider(args), error => {
      assert.equal(error.code, 'MODEL_INVALID_OUTPUT');
      assert.equal(modelOutputDiagnostic(error).reasonCode, 'JSON_STRUCTURE_LIMIT');
      assert.equal(error.message.includes('RAW_SECRET'), false);
      return true;
    });
  }
});

test('complete explicit ontology refusals are projected safely before correction could turn them into acceptance', async t => {
  let current, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(current); });
  const context = { purpose: 'ontology_alignment', candidates: [{ id: 'mapping-topic' }], task: { type: 'brief' } };
  let nested = { secret: 'RAW_REFUSAL_SECRET' };
  for (let index = 0; index < 40; index++) nested = { nested };
  const refusals = [
    { decision: 'none' },
    { decision: 'reject', message: '   ', selectedMappingIds: { invented: true }, authorization: { grant: true } },
    { decision: 'none', message: 'x'.repeat(4001), selectedMappingIds: ['mapping-topic'] },
    { decision: 'none', message: '', reasoning_content: 'RAW_REFUSAL_SECRET', nested },
    { decision: 'reject', message: 'I decline the task mapping.', arbitrary: 'x'.repeat(300000) },
  ];
  for (const refusal of refusals) {
    current = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(refusal) } }] };
    const before = calls;
    const result = await callProvider({ ...args, context });
    assert.deepEqual(Object.keys(result), ['message', 'decision', 'selectedMappingIds']);
    assert.equal(result.decision, refusal.decision); assert.deepEqual(result.selectedMappingIds, []);
    assert.equal(result.message, refusal.message === 'I decline the task mapping.' ? refusal.message : 'The model declined the supplied task correspondences.');
    assert.equal(JSON.stringify(result).includes('RAW_REFUSAL_SECRET'), false);
    assert.equal(calls, before + 1);
  }
  for (const finish_reason of ['length', 'content_filter']) {
    current = { choices: [{ finish_reason, message: { refusal: 'RAW_REFUSAL_SECRET', tool_calls: [{ type: 'function',
      function: { name: 'submit_proposal', arguments: '{"decision":"none","message":"I decline."}' } }] } }] };
    assert.deepEqual(await callProvider({ ...args, context }), { message: 'I decline.', decision: 'none', selectedMappingIds: [] });
  }
  current = { choices: [{ message: { content: JSON.stringify({ decision: 'reject', message: 'x'.repeat(1001) }) } }] };
  assert.equal((await callProvider({ ...args, context })).message.length, 1001, 'existing bounded refusal explanations are retained');
});

test('refusal projection is limited to the current ontology stage and never infers a decision from ambiguous output', async t => {
  let current;
  t.mock.method(globalThis, 'fetch', async () => response(current));
  const context = { purpose: 'ontology_alignment', candidates: [{ id: 'mapping-topic' }] };
  const cases = [
    { choices: [{ message: { content: '{"decision":"none"' } }] },
    { choices: [{ message: { content: '[{"decision":"none"}]' } }] },
    { choices: [{ message: { content: '{"decision":"unknown","reasoning_content":"RAW_REFUSAL_SECRET"}' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{"decision":"accept","message":"ok","selectedMappingIds":["mapping-topic"]}' } }] },
    { choices: [{ message: { content: '{"decision":"none"}', tool_calls: [{ type: 'function', function: { name: 'execute_shell', arguments: '{"decision":"none"}' } }] } }] },
    { choices: [{ message: { tool_calls: [
      { type: 'function', function: { name: 'submit_proposal', arguments: '{"decision":"none"}' } },
      { type: 'function', function: { name: 'submit_proposal', arguments: '{"decision":"accept"}' } },
    ] } }] },
  ];
  for (current of cases) await assert.rejects(callProvider({ ...args, context }), { code: 'MODEL_INVALID_OUTPUT' });
  current = { choices: [{ message: { content: '{"message":"ok","decision":"none","reasoning_content":"RAW_REFUSAL_SECRET"}' } }] };
  for (const purpose of ['intro', 'initial', 'brief', 'connectivity_test']) {
    await assert.rejects(callProvider({ ...args, context: { purpose } }), { code: 'MODEL_INVALID_OUTPUT' });
  }
  current = { base_resp: { status_code: 1008 }, choices: [{ message: { content: '{"decision":"none"}' } }] };
  await assert.rejects(callProvider({ ...args, context }), { code: 'MODEL_PROVIDER_ERROR' });
});

test('semantic validation diagnostics recognize every registered safe message and never copy unknown error text', () => {
  assert(Object.isFrozen(MODEL_OUTPUT_DIAGNOSTICS));
  for (const [reasonCode, definition] of Object.entries(MODEL_OUTPUT_DIAGNOSTICS)) {
    assert(Object.isFrozen(definition));
    assert.deepEqual(modelOutputDiagnostic({ code: definition.code, message: definition.message, raw: 'RAW_SECRET' }),
      { reasonCode, detail: definition.detail, retryable: true });
  }
  const incomplete = modelOutputDiagnostic({ code: 'MODEL_INVALID_OUTPUT', message: 'The model accepted an incomplete set of registered mapping identifiers.' });
  assert.equal(incomplete.reasonCode, 'INCOMPLETE_MAPPING');
  assert.equal(modelOutputDiagnostic({ code: 'MODEL_INVALID_MEETING', message: 'RAW_SECRET' }).reasonCode, 'INVALID_PROPOSAL');
  assert.equal(JSON.stringify(modelOutputDiagnostic({ code: 'MODEL_INVALID_OUTPUT', message: 'RAW_SECRET' })).includes('RAW_SECRET'), false);
  assert.equal(modelOutputDiagnostic({ code: 'MODEL_PROVIDER_ERROR', message: 'RAW_SECRET' }), null);
  assert.equal(modelOutputDiagnostic(null), null);
});

test('provider errors do not expose response bodies, connection errors or subscription credentials', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response('RAW_SECRET', { status: 401 }));
  await assert.rejects(callProvider(args), { code: 'MODEL_PROVIDER_ERROR', message: 'The model provider returned HTTP 401.' });
  mocked.mock.mockImplementation(async () => { throw new Error(connection.apiKey); });
  await assert.rejects(callProvider(args), error => { assert.equal(error.code, 'MODEL_PROVIDER_ERROR'); assert.equal(error.message.includes(connection.apiKey), false); return true; });
  await assert.rejects(callProvider({ ...args, connection: { ...connection, apiKey: '' } }), { code: 'MODEL_UNAVAILABLE' });
});
