import test from 'node:test';
import assert from 'node:assert/strict';
import { createKGClient } from '../src/kg-client.mjs';
import { resolveConditions } from '../src/condition-service.mjs';

const endpoints = {
  Alice: { url: 'http://127.0.0.1:18765', token: 'synthetic-alice-native-token' },
  Bob: { url: 'http://127.0.0.1:18766', token: 'synthetic-bob-native-token' },
};

test('native KG endpoint identity and namespace checks happen before initial fixture writes', async t => {
  for (const failure of ['wrong-role', 'same-namespace']) {
    await t.test(failure, async () => {
      const requests = [];
      const client = createKGClient({ endpoints, async fetchImpl(input, options) {
        requests.push({ path: new URL(input).pathname, method: options.method });
        const role = new URL(input).port === '18765' ? 'Alice' : 'Bob';
        return new Response(JSON.stringify({ ok: true, provider: 'kg',
          role: failure === 'wrong-role' ? 'Alice' : role,
          namespace: failure === 'same-namespace' ? 'urn:shared:' : 'urn:' + role.toLowerCase() + ':' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
      } });
      await assert.rejects(client.initialize(resolveConditions()), error => error.code === (failure === 'wrong-role' ? 'KG_ROLE' : 'KG_ISOLATION'));
      assert(requests.length > 0);
      assert(requests.every(request => request.method === 'GET' && request.path === '/api/demo/health'),
        'A mismatched native service must fail before writing either starting profile.');
    });
  }
});

test('native KG errors and invalid receipts retain role context without returning service secrets', async () => {
  const client = createKGClient({ endpoints, fetchImpl: async () => new Response(JSON.stringify({
    detail: 'Bearer private-service-credential-must-not-escape',
  }), { status: 503, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(client.defaults(), error => error.code === 'KG_UNAVAILABLE'
    && error.message.includes('Alice') && !error.message.includes('private-service-credential'));
  await assert.rejects(client.recordReceipt({ sessionId: 'synthetic-round', epoch: 1,
    direction: 'aliceToBob', receipt: { status: 'pending', operationId: 'unconfirmed' } }),
  error => error.code === 'KG_RECEIPT');
});
