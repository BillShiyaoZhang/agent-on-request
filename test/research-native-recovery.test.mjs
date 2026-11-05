import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResearchEngine } from '../src/research-engine.mjs';

function savedWorkspace(directory, workspaceId) {
  const db = new DatabaseSync(path.join(directory, 'workspaces.sqlite'));
  try { return JSON.parse(db.prepare('SELECT state FROM workspaces WHERE id=?').get(workspaceId).state); }
  finally { db.close(); }
}

async function crashFixture(t, { knownRun = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-native-restart-'));
  const active = { engine: null };
  t.after(async () => { await active.engine?.close(); await rm(directory, { recursive: true, force: true }); });
  active.engine = new ResearchEngine({ directory, persist: true, nativeClient: { run: async () => ({ status: 'completed' }) } });
  await active.engine.init();
  const created = await active.engine.create();
  await active.engine.start(created.workspaceId, { type: 'research_work', mode: 'native', goal: 'Prepare a sourced research note.' }, 'Alice');
  await Promise.allSettled([...active.engine.running]);
  const w = active.engine.get(created.workspaceId), task = w.tasks.at(-1);
  const record = { ...task.nativeRuns.Alice, runId: knownRun ? 'run_before_restart' : null,
    input: 'PRIVATE-PERSISTED-EXACT-INPUT\nRetain this request body byte for byte.',
    instructions: 'PRIVATE-PERSISTED-EXACT-INSTRUCTIONS\nUse only this role-bound task.',
    status: knownRun ? 'unsettled' : 'submitted' };
  task.nativeRuns.Alice = record; task.status = 'running'; task.error = null;
  await active.engine.save(w); await active.engine.close(); active.engine = null;
  return { directory, created, taskId: task.id, record,
    async open(nativeClient) { active.engine = new ResearchEngine({ directory, persist: true, nativeClient }); await active.engine.init(); return active.engine; } };
}

test('native request body is durable before admission and the admitted run ID is durable before polling continues', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-native-admission-'));
  let engine, workspaceId; const observed = [];
  t.after(async () => { await engine?.close(); await rm(directory, { recursive: true, force: true }); });
  const nativeClient = { run: async args => {
    const before = savedWorkspace(directory, workspaceId).tasks.at(-1).nativeRuns.Alice;
    assert.equal(before.status, 'submitted'); assert.equal(before.runId, null);
    assert.equal(before.requestId, args.requestId);
    assert.equal(before.input, args.input); assert.equal(before.instructions, args.instructions);
    observed.push(before);
    await args.onAdmitted({ runId: 'run_durable_admission', requestId: args.requestId });
    const admitted = savedWorkspace(directory, workspaceId).tasks.at(-1).nativeRuns.Alice;
    assert.equal(admitted.runId, 'run_durable_admission');
    assert.equal(admitted.requestId, args.requestId);
    return { runId: 'run_durable_admission', status: 'completed' };
  } };
  engine = new ResearchEngine({ directory, persist: true, nativeClient }); await engine.init();
  const created = await engine.create(); workspaceId = created.workspaceId;
  await engine.start(workspaceId, { type: 'research_work', mode: 'native', goal: 'Trace the current research claim to its evidence.' }, 'Alice');
  await Promise.allSettled([...engine.running]);
  assert.equal(observed.length, 1);
  const w = engine.get(workspaceId), task = w.tasks.at(-1);
  assert.equal(task.nativeRuns.Alice.status, 'settled');
  assert.equal(task.nativeRuns.Alice.runId, 'run_durable_admission');
  const own = engine.view(w, 'Alice'), peer = engine.view(w, 'Bob');
  const status = await engine.tool(workspaceId, task.id, 'Alice', 'task_status');
  assert.ok(!Object.hasOwn(own.tasks.at(-1), 'nativeRuns'));
  assert.ok(!Object.hasOwn(status.task, 'nativeRuns'));
  for (const visible of [own, peer, status]) {
    const text = JSON.stringify(visible);
    assert.ok(!text.includes(observed[0].requestId));
    assert.ok(!text.includes(observed[0].assignmentId));
    assert.ok(!text.includes('run_durable_admission'));
    assert.ok(!text.includes(observed[0].instructions));
  }
});

for (const knownRun of [true, false]) test(`restart reconciles ${knownRun ? 'the known native run' : 'a lost admission using the exact persisted body'} before a fresh assignment`, async t => {
  const f = await crashFixture(t, { knownRun }); const events = [];
  const nativeClient = {
    reconcile: async args => { events.push({ kind: 'reconcile', args: structuredClone(args) }); return { settled: true, runId: args.runId ?? 'run_recovered_admission' }; },
    run: async args => { events.push({ kind: 'run', args: { role: args.role, requestId: args.requestId } }); await args.onAdmitted({ runId: 'run_after_restart', requestId: args.requestId }); return { status: 'completed' }; },
  };
  const engine = await f.open(nativeClient), w = engine.get(f.created.workspaceId);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'reconcile');
  assert.deepEqual(events[0].args, { role: 'Alice', runId: f.record.runId, requestId: f.record.requestId, input: f.record.input, instructions: f.record.instructions });
  assert.equal(engine.task(w, f.taskId).status, 'paused');
  assert.equal(engine.task(w, f.taskId).nativeRuns.Alice.status, 'settled');
  assert.equal(engine.blockedRoles.has('Alice'), false);
  for (const role of ['Alice', 'Bob']) assert.ok(!JSON.stringify(engine.view(w, role)).includes('PRIVATE-PERSISTED-EXACT-'));
  assert.ok(!JSON.stringify(await engine.tool(w.id, f.taskId, 'Alice', 'task_status')).includes('PRIVATE-PERSISTED-EXACT-'));
  await engine.resume(w.id, f.taskId); await Promise.allSettled([...engine.running]);
  assert.equal(events[1].kind, 'run');
  assert.equal(events[1].args.role, 'Alice');
  assert.notEqual(events[1].args.requestId, f.record.requestId);
  assert.equal(events.filter(event => event.kind === 'run').length, 1);
});

for (const failure of ['not_stopped', 'transport_failure', 'malformed_proof']) test(`unconfirmed native recovery remains visible and blocks new assignments (${failure})`, async t => {
  const f = await crashFixture(t); let runs = 0, canSettle = false;
  const nativeClient = {
    reconcile: async () => {
      if (canSettle) return { settled: true };
      if (failure === 'transport_failure') throw Object.assign(new Error('Local transport unavailable.'), { code: 'HERMES_RESEARCH_TRANSPORT' });
      if (failure === 'malformed_proof') return undefined;
      return { settled: false };
    },
    run: async () => { runs++; return { status: 'completed' }; },
  };
  const engine = await f.open(nativeClient), w = engine.get(f.created.workspaceId);
  assert.equal(engine.blockedRoles.has('Alice'), true);
  const task = engine.task(w, f.taskId);
  assert.equal(task.status, 'paused'); assert.ok(task.error);
  assert.notEqual(task.nativeRuns.Alice.status, 'settled');
  await assert.rejects(engine.resume(w.id, f.taskId));
  await assert.rejects(engine.start(w.id, { type: 'research_work', mode: 'native', goal: 'A different owner task must wait.' }, 'Alice'));
  assert.equal(runs, 0);
  assert.ok(!JSON.stringify(engine.view(w, 'Alice')).includes(f.record.instructions));
  canSettle = true; await engine.resume(w.id, f.taskId); await Promise.allSettled([...engine.running]);
  assert.equal(runs, 1);
});

test('persisted native work cannot be reused when the configured client has no reconciliation capability', async t => {
  const f = await crashFixture(t); let runs = 0;
  const engine = await f.open({ run: async () => { runs++; return { status: 'completed' }; } });
  assert.equal(engine.blockedRoles.has('Alice'), true);
  assert.ok(engine.task(engine.get(f.created.workspaceId), f.taskId).error.includes('HERMES_RUN_UNSETTLED'));
  await assert.rejects(engine.resume(f.created.workspaceId, f.taskId), { code: 'HERMES_RUN_UNSETTLED' });
  assert.equal(runs, 0);
});
