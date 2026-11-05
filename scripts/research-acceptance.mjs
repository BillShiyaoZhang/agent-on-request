import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Synthetic acceptance only: the script acts as the two fictional owners.
const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname));
const mode = process.argv.includes('--native') ? 'native' : 'controlled';
const output = path.resolve(process.env.DEMO_ARTIFACTS || `artifacts/research-acceptance-${mode}`);
const tokens = {};
async function api(route, body, role = 'Alice') {
  const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json(); assert(response.ok, `${route}: ${value.error?.code} ${value.error?.message}`); return value;
}
const catalog = await api('/api/research/catalog'); assert.equal(catalog.conference.synthetic, true);
if (mode === 'native') assert.equal(catalog.nativeAvailable, true, 'Configure the real native Hermes research profiles.');
const meta = await api('/api/meta'); assert.equal(meta.openControls, true, 'Use the dedicated localhost synthetic demo, not an event participant account.');
const created = await api('/api/research/workspaces', {}); tokens.Alice = created.token;
const workspace = `/api/research/workspaces/${created.workspaceId}`;
tokens.Bob = (await api(`/api/admin/research/workspaces/${created.workspaceId}/claim/Bob`, {})).token;
const decisions = [], results = [];
try {
  for (const type of ['schedule', 'select_presentation', 'prepare_discussion']) {
    await api(workspace + '/tasks', { type, mode }); let lastStatus;
    const deadline = Date.now() + (mode === 'native' ? 360_000 : 30_000);
    while (true) {
      const state = await api(workspace); const task = state.tasks.at(-1);
      if (task.status !== lastStatus) { console.log(`${mode} ${type}: ${task.status}`); lastStatus = task.status; }
      if (task.status === 'paused') throw new Error(`${type}: ${task.error}`);
      if (task.status === 'completed') { results.push({ type, taskId: task.id, result: task.result }); break; }
      assert(Date.now() < deadline, `${type} did not complete within its acceptance budget`);
      for (const role of ['Alice', 'Bob']) {
        const owner = role === 'Alice' ? state : await api(workspace, undefined, role);
        for (const request of owner.authorizations.requests.filter(r => r.status === 'pending')) {
          const booking = request.intent.action === 'reservation.submit';
          const fields = booking ? request.intent.fields : request.intent.fields.filter(f => !['results', 'note'].includes(f));
          assert(fields.length > 0);
          await api(workspace + `/decisions/${request.id}`, { decision: 'allow', fields,
            expectedRevision: request.revision, expectedPayloadHash: request.payloadHash }, role);
          decisions.push({ owner: role, action: request.intent.action, fields });
          console.log(`synthetic owner ${role}: approved ${request.intent.action} (${fields.join(', ')})`);
        }
      }
      await delay(mode === 'native' ? 1500 : 20);
    }
  }
  const state = await api(workspace);
  assert.equal(results[0].result.outcome, 'common_time_found');
  assert.equal(results[1].result.report.id, 'R3');
  assert.equal(results[2].result.reservation.status, 'confirmed');
  for (const message of state.messages.filter(m => m.resourceId.includes('research-brief'))) {
    assert(!Object.hasOwn(message.payload, 'note')); assert(!Object.hasOwn(message.payload, 'results'));
  }
  const report = { mode, workspaceId: created.workspaceId, checkedAt: new Date().toISOString(), results, decisions,
    deliveryCount: state.messages.length, authorizationUses: state.authorizations.operations.length,
    nativeRunCount: state.events.filter(e => e.kind === 'native_run_completed').length };
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`All three ${mode} scenarios passed; report saved under ${output}.`);
} finally { await api(workspace + '/end', {}).catch(() => {}); }
