import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Destructive only to the running process of the named fictional QA service;
// the persistent audience, ledger and KG volumes are deliberately retained.
const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:14327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) && base.port === '14327');
assert(process.argv.includes('--restart-qa-app'), 'Explicitly select the isolated QA app restart.');
const output = path.resolve(process.env.DEMO_ARTIFACTS || 'artifacts/research-restart-acceptance');
let token, root, fresh;
async function api(route, data, credential = token) {
  const response = await fetch(new URL(route, base), { method: data === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60_000) });
  const value = await response.json();
  assert(response.ok, `${route}: ${value.error?.code} ${value.error?.message}`); return value;
}
async function decide(request, decision, fields) {
  return api(`${root}/decisions/${request.id}`, { decision, ...(fields ? { fields } : {}),
    expectedRevision: request.revision, expectedPayloadHash: request.payloadHash });
}
assert.equal((await api('/api/meta')).openControls, true);
const created = await api('/api/research/workspaces', {});
token = created.token; root = `/api/research/workspaces/${created.workspaceId}`;
try {
  const policyId = `restart-summary-${created.workspaceId}`;
  await api(root + '/policies', { id: policyId, effect: 'allow', actions: ['peer.send'],
    resources: ['alice:research-brief'], fields: ['summary'], recipients: ['Bob'], purposes: ['academic_coordination'] });
  let state = await api(root + '/tasks', { type: 'prepare_discussion', mode: 'controlled' });
  const disclosure = state.authorizations.requests.find(request => request.status === 'pending' && request.intent.action === 'peer.send');
  assert(disclosure); await decide(disclosure, 'allow', ['method']);
  state = await api(root);
  const booking = state.authorizations.requests.find(request => request.status === 'pending' && request.intent.action === 'reservation.submit');
  assert(booking); await decide(booking, 'deny'); state = await api(root);
  const grant = state.authorizations.grants.find(item => item.decisionId && item.intent.resourceId === 'alice:research-brief');
  assert(grant && grant.uses === 1 && grant.reserved === 0);
  assert.equal(state.tasks.at(-1).status, 'partial');
  const namespace = state.workspace.nativeNamespace;
  const delivered = state.messages.find(message => message.resourceId === 'alice:research-brief');
  assert(delivered && Object.keys(delivered.payload).join(',') === 'method');
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--project-name', 'agent-on-request-research-qa', 'restart', 'demo'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const response = await fetch(new URL('/api/meta', base), { signal: AbortSignal.timeout(3000) });
      if (response.ok) break;
    } catch {}
    assert(Date.now() < deadline, 'The isolated QA app did not return after restart.'); await delay(300);
  }
  const restored = await api(root);
  assert.equal(restored.workspace.nativeNamespace, namespace);
  assert.equal(restored.authorizations.policies.find(item => item.id === policyId).status, 'active');
  assert.deepEqual(restored.authorizations.policies.find(item => item.id === policyId).fields, ['summary']);
  assert.equal(restored.authorizations.grants.find(item => item.id === grant.id).uses, 1);
  assert.deepEqual(restored.messages.find(message => message.id === delivered.id).receipt, delivered.receipt);
  const next = await api(root + '/tasks', { type: 'prepare_discussion', mode: 'controlled' });
  const nextDisclosure = next.authorizations.requests.find(request => request.status === 'pending' && request.intent.action === 'peer.send');
  assert(nextDisclosure && nextDisclosure.id !== disclosure.id && nextDisclosure.intent.taskId !== disclosure.intent.taskId);
  assert.equal(next.authorizations.grants.find(item => item.id === grant.id).uses, 1);
  fresh = await api('/api/research/workspaces', {}, null);
  assert(!fresh.state.authorizations.policies.some(item => item.id === policyId));
  assert.equal(fresh.state.authorizations.grants.length, 0);
  assert.equal(fresh.state.messages.length, 0);
  assert.notEqual(fresh.state.workspace.nativeNamespace, namespace);
  const report = { verifiedAt: new Date().toISOString(), seed: restored.profile.seed, workspaceId: created.workspaceId,
    namespace, policyId, standingRuleRecalledAfterAppRestart: true, deliveredOperationId: delivered.id,
    consumedGrantId: grant.id, nextTaskRequestedFreshDisclosure: true, newAudienceHasNoPriorAuthorization: true };
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`QA app restart preserved the standing rule and receipt without reusing a consumed grant; report saved under ${output}.`);
} finally {
  if (fresh) await api(`/api/research/workspaces/${fresh.workspaceId}/end`, {}, fresh.token).catch(() => {});
  await api(root + '/end', {}).catch(() => {});
}
