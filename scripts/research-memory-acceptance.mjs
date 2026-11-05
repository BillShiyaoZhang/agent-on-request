import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname));
let token, workspace;
async function api(route, body) {
  const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json(); assert(response.ok, `${route}: ${value.error?.code} ${value.error?.message}`); return value;
}
assert.equal((await api('/api/meta')).openControls, true);
const catalog = await api('/api/research/catalog'); assert(catalog.nativeAvailable && catalog.conference.synthetic);
const created = await api('/api/research/workspaces', {}); token = created.token; workspace = `/api/research/workspaces/${created.workspaceId}`;
const deadline = () => Date.now() + 360_000;
try {
  await api(workspace + '/research-task', { goal: '以后在当前协作项目中，仅允许向 Bob 分享我的研究简报 alice:research-brief 的 summary 字段，其余字段仍需要具体批准。请整理成长期规则候选让我确认；现在不要发送任何材料。' });
  let candidate; const firstBudget = deadline();
  while (!candidate) {
    const state = await api(workspace), task = state.tasks.at(-1);
    assert.notEqual(task.status, 'paused', task.error);
    candidate = state.policyCandidates.find(c => c.status === 'pending');
    assert(Date.now() < firstBudget, 'No policy candidate was prepared.'); if (!candidate) await delay(1000);
  }
  assert.deepEqual(candidate.policy.fields, ['summary']);
  assert(candidate.policy.resources.includes('alice:research-brief'));
  const before = await api(workspace); assert(!before.authorizations.policies.some(p => p.id === candidate.policyId));
  const confirmed = await api(`${workspace}/policy-candidates/${candidate.id}/decision`, { decision: 'allow', expectedHash: candidate.hash });
  const adopted = confirmed.policyCandidates.find(c => c.id === candidate.id), policyId = adopted.policyId;
  assert(policyId && confirmed.authorizations.policies.some(p => p.id === policyId && p.status === 'active'));
  console.log('Native agent proposed summary-only standing permission; synthetic owner confirmed its exact scope.');
  await api(workspace + '/research-task', { goal: '查最新的正式授权，核对现在是否允许向 Bob 分享研究简报 alice:research-brief 的 summary 字段。请使用授权查询工具，并保存一份带规则来源的简短答复；不要发送资料。' });
  const secondBudget = deadline(); let final;
  while (true) {
    final = await api(workspace); const task = final.tasks.at(-1);
    assert.notEqual(task.status, 'paused', task.error);
    if (task.status === 'completed') break;
    assert(Date.now() < secondBudget, 'Authorization recall did not complete.'); await delay(1000);
  }
  const task = final.tasks.at(-1);
  assert(final.events.some(e => e.taskId === task.id && (e.kind === 'authorization_recalled' && e.policyIds.includes(policyId)
    || e.kind === 'authorization_checked' && e.basisId === policyId && e.status === 'allowed')));
  assert.equal(final.messages.length, 0, 'Checking permission must not send the material.');
  assert(final.artifacts.some(a => a.taskId === task.id));
  const directory = path.resolve(process.env.DEMO_ARTIFACTS || 'artifacts/research-memory-acceptance'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ workspaceId: created.workspaceId, policyId, fields: candidate.policy.fields,
    confirmed: true, recalledInLaterTask: true, dataSent: false, checkedAt: new Date().toISOString() }, null, 2));
  console.log('Later native task recalled the formal standing rule and saved a sourced answer without sending data.');
} finally { await api(workspace + '/end', {}).catch(() => {}); }
