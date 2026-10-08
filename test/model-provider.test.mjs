import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, probeModel } from '../src/model-provider.mjs';
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

test('provider errors do not expose response bodies, connection errors or subscription credentials', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response('RAW_SECRET', { status: 401 }));
  await assert.rejects(callProvider(args), { code: 'MODEL_PROVIDER_ERROR', message: 'The model provider returned HTTP 401.' });
  mocked.mock.mockImplementation(async () => { throw new Error(connection.apiKey); });
  await assert.rejects(callProvider(args), error => { assert.equal(error.code, 'MODEL_PROVIDER_ERROR'); assert.equal(error.message.includes(connection.apiKey), false); return true; });
  await assert.rejects(callProvider({ ...args, connection: { ...connection, apiKey: '' } }), { code: 'MODEL_UNAVAILABLE' });
});
