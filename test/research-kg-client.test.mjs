import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchKGClient } from '../src/research-kg-client.mjs';
import { researchProfile } from '../src/research-profiles.mjs';
import { hashPayload } from '../src/runtime-helpers.mjs';

const endpoints = { Alice: { url: 'http://127.0.0.1:8765', token: 'alice-native-service-token' }, Bob: { url: 'http://127.0.0.1:8766', token: 'bob-native-service-token' } };
const profiles = () => ({ Alice: researchProfile('Alice'), Bob: researchProfile('Bob') });
const native = (role, profile = researchProfile(role)) => ({ role, profile, provenance: { provider: 'kg', namespace: `urn:research:${role.toLowerCase()}:`, revision: 'revision-1' } });

test('research native client seeds independent actual profiles and preserves owner edits on later reads', async () => {
  const calls = [];
  const edited = researchProfile('Alice');
  edited.ontology.modules[0].concepts[0].label = 'Owner-edited Person';
  const { hash: _, ...definition } = edited.ontology; edited.ontology.hash = hashPayload(definition);
  const client = createResearchKGClient({ endpoints, fetchImpl: async (url, options) => {
    const role = new URL(url).port === '8765' ? 'Alice' : 'Bob';
    assert.equal(options.headers.Authorization, `Bearer ${endpoints[role].token}`);
    assert.equal(options.redirect, 'error'); calls.push({ role, url, options });
    return Response.json(native(role, options.method === 'GET' && role === 'Alice' ? edited : researchProfile(role)));
  } });
  const initialized = await client.initialize(profiles());
  assert.equal(initialized.Alice.role, 'Alice');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(JSON.parse(calls[0].options.body).seedOnly, true);
  assert.equal((await client.profile('Alice')).ontology.modules[0].concepts[0].label, 'Owner-edited Person');
});

test('native profile validation rejects role crossover, shared namespaces and forged ontology hashes', async () => {
  const swapped = createResearchKGClient({ endpoints, fetchImpl: async () => Response.json(native('Bob')) });
  await assert.rejects(swapped.profile('Alice'), error => error.code === 'RESEARCH_KG_ROLE');
  const shared = createResearchKGClient({ endpoints, fetchImpl: async url => {
    const role = new URL(url).port === '8765' ? 'Alice' : 'Bob';
    return Response.json({ ...native(role), provenance: { provider: 'kg', namespace: 'shared' } });
  } });
  await assert.rejects(shared.initialize(profiles()), error => error.code === 'RESEARCH_KG_ISOLATION');
  const invalid = researchProfile('Alice'); invalid.ontology.hash = '0'.repeat(64);
  const altered = createResearchKGClient({ endpoints, fetchImpl: async () => Response.json(native('Alice', invalid)) });
  await assert.rejects(altered.profile('Alice'), error => error.code === 'RESEARCH_KG_PROFILE');
});

test('authorization projection accepts numeric durable outbox IDs and carries no execution authority', async () => {
  let request;
  const client = createResearchKGClient({ endpoints, fetchImpl: async (url, options) => {
    request = { url, ...options }; return Response.json({ role: 'Alice', ok: true, authority: false });
  } });
  const event = { workspaceId: 'workspace-1', id: 3, topic: 'grant', recordId: 'grant-1' };
  assert.equal((await client.project('Alice', event)).authority, false);
  assert.deepEqual(JSON.parse(request.body), { event });
  assert.match(request.url, /\/api\/research\/projections$/);
});

test('native service failures never become seed profiles or disclose remote response bodies', async () => {
  const client = createResearchKGClient({ endpoints, fetchImpl: async () => Response.json({ detail: 'private response body' }, { status: 500 }) });
  await assert.rejects(client.profile('Alice'), error => error.code === 'RESEARCH_KG_UNAVAILABLE' && !error.message.includes('private response'));
  assert.throws(() => createResearchKGClient({ endpoints: { Alice: endpoints.Alice, Bob: endpoints.Alice } }), error => error.code === 'RESEARCH_KG_ISOLATION');
});

test('daily research memory writes carry a workspace and the authenticated role service credential', async () => {
  let request;
  const client = createResearchKGClient({ endpoints, fetchImpl: async (url, options) => {
    request = { url, ...options }; return Response.json({ role: 'Bob', ok: true, visibility: 'private' });
  } });
  const input = { workspaceId: 'workspace-b', nodes: [{ id: 'bob:new-note', type: 'bob:DesignNote' }], edges: [] };
  assert.equal((await client.record('Bob', input)).visibility, 'private');
  assert.match(request.url, /\/api\/research\/knowledge$/);
  assert.equal(request.headers.Authorization, `Bearer ${endpoints.Bob.token}`);
  assert.deepEqual(JSON.parse(request.body), input);
});
