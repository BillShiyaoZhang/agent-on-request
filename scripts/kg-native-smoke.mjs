import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
const directory = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/kg-native-smoke');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname), 'Use the local synthetic demo.');

async function request(url, { method = 'GET', body, token, expected = 200 } = {}) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value;
  try { value = await response.json(); } catch { value = {}; }
  assert.equal(response.status, expected, new URL(url).pathname + ' returned ' + response.status + ' ' + (value.error?.code || ''));
  return value;
}

const app = (route, options) => request(new URL(route, base), options);
const meta = await app('/api/meta');
assert.equal(meta.openControls, true);
assert.deepEqual(meta.knowledge, { provider: 'kg-plugin', persistent: true });
const management = await app('/api/admin/native');
assert.equal(management.enabled, true);
const services = Object.fromEntries(['Alice', 'Bob'].map(role => {
  const url = new URL(management.agents[role].kgUrl);
  assert(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname));
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert(token && token.length >= 16);
  url.hash = '';
  return [role, { url, token }];
}));
const native = (role, route, options = {}) => request(new URL(route, services[role].url), { ...options, token: services[role].token });
const health = Object.fromEntries(await Promise.all(['Alice', 'Bob'].map(async role => [role, await native(role, '/api/demo/health')])));
assert.notEqual(health.Alice.namespace, health.Bob.namespace);
for (const role of ['Alice', 'Bob']) {
  assert.equal(health[role].role, role);
  const foreign = role === 'Alice' ? 'Bob' : 'Alice';
  const response = await fetch(new URL('/api/v1/status', services[role].url), {
    headers: { Authorization: 'Bearer ' + services[foreign].token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 401, 'Role credentials must not open the peer native console.');
  await native(role, '/api/v1/status');
}

const reportPath = resolve(directory, 'report.json');
if (process.argv.includes('--verify-persisted')) {
  const previous = JSON.parse(await readFile(reportPath, 'utf8'));
  for (const role of ['Alice', 'Bob']) {
    const snapshot = await native(role, '/api/demo/rounds/' + previous.sessionId + '/' + previous.epoch);
    assert.deepEqual(snapshot.result.task, previous.task);
    assert.deepEqual(snapshot.receipts, previous.receipts[role]);
  }
  console.log('Native KG persisted result and exact receipts verified for both roles.');
  process.exit(0);
}

async function nativeCards(role) {
  const result = [];
  let offset = 0, total;
  do {
    const page = await native(role, '/api/v1/memories?limit=100&offset=' + offset);
    result.push(...page.items);
    total = page.total;
    offset += page.items.length;
    assert(page.items.length || offset >= total, 'Native pagination must advance.');
  } while (offset < total);
  return result;
}

const rounds = [];
async function create() {
  const value = await app('/api/sessions', { method: 'POST', expected: 201,
    body: { mode: 'controlled', researchConsent: false } });
  const round = { token: value.token, state: value.state };
  rounds.push(round);
  return round;
}
async function action(round, name, body = {}) {
  const submission = { action: name, requestId: randomUUID(), expectedVersion: round.state.session.version, ...body };
  const value = await app('/api/sessions/' + round.state.session.id + '/actions', { method: 'POST', token: round.token,
    body: submission });
  round.state = value.state;
  return submission;
}
async function choose(round, stage, choice) {
  const before = await native('Bob', '/api/demo/rounds/' + round.state.session.id + '/' + round.state.session.epoch);
  const preview = await app('/api/sessions/' + round.state.session.id + '/preview', { method: 'POST', token: round.token, body: { stage, choice } });
  const after = await native('Bob', '/api/demo/rounds/' + round.state.session.id + '/' + round.state.session.epoch);
  assert.deepEqual(after.receipts, before.receipts, 'Preview cannot populate the recipient native KG.');
  return action(round, stage === 'initial' ? 'share_initial' : 'respond_additional', { choice, previewHash: preview.payloadHash });
}

let correction;
try {
  const initial = await create();
  const cards = await nativeCards('Alice');
  const calendar = cards.find(card => card.props?.x_demo_scope === 'default' && card.props?.x_demo_kind === 'calendar'
    && card.props?.x_demo_day === 'Tue' && card.props?.x_demo_status === 'Free');
  assert(calendar, 'The default includes a native Tuesday free-time record.');
  const originalTime = calendar.props.x_demo_time;
  const newTime = originalTime === '10:00–10:45' ? '10:00–10:30' : '10:00–10:45';
  await native('Alice', '/api/v1/memories/correct', { method: 'POST', body: {
    uri: calendar.uri, expected_version: calendar.version, operation_id: randomUUID(),
    reason: 'Synthetic native-source acceptance', changes: { props: { x_demo_time: newTime } },
  } });
  correction = { uri: calendar.uri, originalTime };
  const defaultAfter = await native('Alice', '/api/demo/default');
  assert(defaultAfter.profile.data.calendar.some(row => row.day === 'Tue' && row.time === newTime));
  const round = await create();
  assert(round.state.alice.calendar.some(row => row.day === 'Tue' && row.time === newTime));
  const frozenCard = (await nativeCards('Alice')).find(card => card.props?.x_demo_scope === 'round'
    && card.props?.x_demo_session === round.state.session.id && card.props?.x_demo_kind === 'calendar');
  assert(frozenCard && frozenCard.read_only === true, 'Native management presents captured round records as read-only.');
  await native('Alice', '/api/v1/memories/correct', { method: 'POST', expected: 403, body: {
    uri: frozenCard.uri, expected_version: frozenCard.version, operation_id: randomUUID(),
    reason: 'Verify captured round protection', changes: { props: { x_demo_time: '09:00–09:30' } },
  } });
  const oldState = await app('/api/sessions/' + initial.state.session.id, { token: initial.token });
  assert.deepEqual(oldState.alice.calendar, initial.state.alice.calendar, 'An initialized round keeps its captured native source.');
  await action(initial, 'end');

  const initialSubmission = await choose(round, 'initial', 'free');
  assert.equal(round.state.session.stage, 'additional');
  await choose(round, 'additional', 'narrow');
  assert.equal(round.state.session.stage, 'waiting_admin');
  const ref = '/api/demo/rounds/' + round.state.session.id + '/' + round.state.session.epoch;
  const beforeApproval = await native('Alice', ref);
  assert.equal(beforeApproval.receipts.length, 1);
  const approval = (await app('/api/admin/sessions/' + round.state.session.id + '/approvals')).approvals.find(item => item.status === 'pending');
  assert(approval && approval.fields.includes('topic') && approval.fields.includes('agenda'));
  const approved = await app('/api/admin/approvals/' + approval.id + '/decision', { method: 'POST', body: {
    decision: 'allow_once', fields: ['topic'], expectedPolicyRevision: approval.policyRevision, expectedPayloadHash: approval.payloadHash,
  } });
  round.state = approved.state;
  assert.equal(round.state.task.outcome, 'arranged');
  const snapshots = Object.fromEntries(await Promise.all(['Alice', 'Bob'].map(async role => [role, await native(role, ref)])));
  assert.deepEqual(snapshots.Alice.receipts, round.state.receipts.bobToAlice);
  assert.deepEqual(snapshots.Bob.receipts, round.state.receipts.aliceToBob);
  assert.deepEqual(snapshots.Alice.receipts.at(-1).values, { topic: approval.values.topic });
  assert.equal(JSON.stringify(snapshots.Alice.receipts).includes(approval.values.agenda), false);
  for (const role of ['Alice', 'Bob']) {
    assert.deepEqual(snapshots[role].result.task, round.state.task);
    assert(snapshots[role].graph.nodes.some(node => node.origin === 'received'));
  }
  const last = snapshots.Alice.receipts.at(-1);
  await native('Alice', ref + '/receipts', { method: 'POST', expected: 403, body: { direction: 'bobToAlice', receipt: last } });
  await native('Alice', ref + '/result', { method: 'PUT', expected: 403,
    body: { result: { ...snapshots.Alice.result, task: { outcome: 'arranged', meeting: { day: 'Mon', time: '09:00–09:30' } } } } });
  await app('/api/sessions/' + round.state.session.id + '/actions', { method: 'POST', token: round.token, body: initialSubmission });
  assert.deepEqual((await native('Alice', ref)).receipts, snapshots.Alice.receipts, 'Repeated owner intent cannot duplicate a native receipt.');
  await app('/api/sessions/' + round.state.session.id + '/actions', { method: 'POST', expected: 409, token: round.token,
    body: { ...initialSubmission, choice: 'full' } });
  const report = { checked: ['Role-local native credentials and namespaces', 'Native record correction drives the next round',
    'Initialized snapshot remains fixed and native history is read-only', 'Preview makes no recipient write', 'Exact narrowed Bob receipt is native data',
    'Native graphs and summary share the persisted result', 'Native UI credential cannot forge a delivery',
    'Repeated owner intent preserves exact receipts and changed reuse conflicts'],
    sessionId: round.state.session.id, epoch: round.state.session.epoch, task: round.state.task,
    receipts: Object.fromEntries(['Alice', 'Bob'].map(role => [role, snapshots[role].receipts])), externalProviderCalls: 0 };
  await mkdir(directory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checked: report.checked, externalProviderCalls: 0, report: reportPath }, null, 2));
} finally {
  if (correction) {
    const detail = await native('Alice', '/api/v1/memories/detail', { method: 'POST', body: { uri: correction.uri } });
    await native('Alice', '/api/v1/memories/correct', { method: 'POST', body: { uri: correction.uri,
      expected_version: detail.version, operation_id: randomUUID(), reason: 'Restore the synthetic acceptance baseline',
      changes: { props: { x_demo_time: correction.originalTime } } } });
  }
  for (const round of rounds) {
    if (round.state.session.ended) continue;
    round.state = await app('/api/sessions/' + round.state.session.id, { token: round.token });
    await action(round, 'end');
  }
}
