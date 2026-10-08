import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clone } from '../src/config.mjs';
import { DEFAULT_MODEL_CONFIG, ModelStore } from '../src/model-store.mjs';
import { ResearchStore } from '../src/research-store.mjs';

// Deliberately fictional credentials and reasoning, never actual provider data.
const SECRET = 'sk-cp-fictional-research-test-key';
const REASONING = 'fictional-private-reasoning-text';
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-demo-model-research-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function session(overrides = {}) {
  return { id: 'fictional-session', epoch: 1, mode: 'live', researchConsent: true,
    consentVersion: 'research-v1', scenarioVersion: 'synthetic-calendar-v1', configRevision: 4,
    startedAt: Date.now(), ...overrides };
}
function publicRound(snapshot) {
  return { revision: snapshot.revision, ...clone(snapshot.config), apiKey: snapshot.apiKey,
    reasoning_content: REASONING, disclosure: 'fictional disclosure excluded from research' };
}
function parseCsvLine(line) {
  const cells = []; let cell = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += character;
  }
  assert.equal(quoted, false, 'CSV cell must close its quotes');
  cells.push(cell);
  return cells;
}
function assertNoSecrets(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(REASONING), false);
  assert.equal(serialized.includes('api.minimax.cn'), false);
  assert.equal(serialized.includes('baseUrl'), false);
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('reasoning_content'), false);
}

test('research persists the round model snapshot through global edits, reload and both export formats', async t => {
  const directory = await temporary(t);
  const models = new ModelStore({ persist: false, apiKey: SECRET });
  await models.init();
  const original = models.snapshot();
  const firstSession = session({ models: publicRound(original) });
  const research = new ResearchStore({ directory });
  const firstId = await research.start(firstSession);

  const edited = clone(DEFAULT_MODEL_CONFIG);
  edited.agents.Alice.model = 'fictional model, version two';
  edited.agents.Bob.temperature = 0.4;
  edited.agents.Bob.thinking = 'adaptive';
  await models.apply({ config: edited, expectedRevision: 1 });
  await research.append(firstSession, { kind: 'config_changed', configRevision: 9,
    models: publicRound(models.snapshot()), modelRevision: 2, apiKey: SECRET, reasoning: REASONING });
  // Neither a later global configuration nor a caller's subsequent mutation can
  // overwrite the research condition captured when this round started.
  firstSession.models.agents.Alice.model = 'mutated-after-start';
  await research.finish(firstSession, 'arranged');

  const secondSession = session({ id: 'fictional-session-two', models: publicRound(models.snapshot()) });
  await research.start(secondSession);
  await research.finish(secondSession, 'declined');
  const loaded = new ResearchStore({ directory });
  await loaded.init();
  const first = loaded.list().runs.find(run => run.runId === firstId);
  assert.equal(first.configRevision, 4, 'Bob config and model conditions have separate revisions');
  assert.equal(first.modelRevision, 1);
  assert.deepEqual(first.models, { revision: 1, provider: original.config.provider, agents: original.config.agents });
  assert.equal(first.events[0].modelRevision, undefined);
  assert.equal(first.events[0].models, undefined);
  const second = loaded.list().runs.find(run => run.runId !== firstId);
  assert.equal(second.modelRevision, 2);
  assert.equal(second.models.agents.Alice.model, edited.agents.Alice.model);
  assert.equal(second.models.agents.Bob.temperature, 0.4);
  assert.equal(second.models.agents.Bob.thinking, 'adaptive');

  const disk = await readFile(path.join(directory, 'runs.json'), 'utf8');
  const jsonl = loaded.export('jsonl');
  const csv = loaded.export('csv');
  for (const value of [loaded.list(), disk, jsonl, csv]) assertNoSecrets(value);
  assert.deepEqual(JSON.parse(jsonl.trim().split('\n')[0]).models, first.models);
  const lines = csv.trimEnd().split('\r\n');
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
  const firstRow = rows.find(row => row.runId === firstId);
  assert.equal(firstRow.modelRevision, '1');
  assert.deepEqual(JSON.parse(firstRow.models), first.models);
  const secondRow = rows.find(row => row.runId === second.runId);
  assert.deepEqual(JSON.parse(secondRow.models), second.models, 'CSV quotes model names containing commas');
});

test('nested round snapshots are captured once and model revision follows their actual revision', async () => {
  const research = new ResearchStore({ persist: false });
  const input = { session: session({ modelRevision: 999 }), models: { revision: 7, ...clone(DEFAULT_MODEL_CONFIG) } };
  const starting = research.start(input);
  input.models.agents.Bob.maxTokens = 1024;
  await starting;
  const recorded = research.list().runs[0];
  assert.equal(recorded.modelRevision, 7);
  assert.equal(recorded.models.revision, 7);
  assert.equal(recorded.models.agents.Bob.maxTokens, 4096);
  const again = await research.start(input);
  assert.equal(again, recorded.runId);
  assert.equal(research.list().runs[0].models.agents.Bob.maxTokens, 4096);
  recorded.models.agents.Bob.model = 'mutated-export';
  assert.equal(research.list().runs[0].models.agents.Bob.model, 'MiniMax-M3');
});

test('load strictly filters model metadata and atomically scrubs closed records on disk', async t => {
  const directory = await temporary(t);
  const models = { revision: 12, ...clone(DEFAULT_MODEL_CONFIG), apiKey: SECRET,
    reasoning_content: REASONING, extra: { raw: SECRET } };
  models.agents.Alice.apiKey = SECRET;
  models.agents.Alice.reasoning_content = REASONING;
  models.agents.Alice.baseUrl = 'https://api.minimax.cn/v1';
  models.agents.Eve = { model: SECRET };
  const run = { runId: 'fictional-closed-run', mode: 'live', scenarioVersion: 'synthetic-calendar-v1',
    consentVersion: 'research-v1', startedAt: new Date().toISOString(), status: 'arranged',
    configRevision: 3, modelRevision: 999, models, quality: [], events: [], apiKey: SECRET };
  await writeFile(path.join(directory, 'runs.json'), JSON.stringify({ schemaVersion: 1, runs: [run] }));
  const research = new ResearchStore({ directory });
  await research.init();
  const clean = research.list().runs[0];
  assert.equal(clean.modelRevision, 12);
  assert.deepEqual(clean.models, { revision: 12, provider: DEFAULT_MODEL_CONFIG.provider, agents: DEFAULT_MODEL_CONFIG.agents });
  assert.equal(clean.status, 'arranged', 'scrubbing is not a new participant outcome');
  assert.equal(clean.endedAt, undefined, 'scrubbing does not fabricate an end timestamp');
  assertNoSecrets(await readFile(path.join(directory, 'runs.json'), 'utf8'));
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'runs.json'))).mode & 0o777, 0o600);
});

test('older and malformed model conditions remain missing rather than acquiring the current global model', async t => {
  const directory = await temporary(t);
  const baseline = { runId: 'fictional-legacy-run', mode: 'controlled', startedAt: new Date().toISOString(),
    status: 'declined', configRevision: 1, quality: [], events: [] };
  const malformed = { ...baseline, runId: 'fictional-malformed-run', modelRevision: 6,
    models: { revision: 6, ...clone(DEFAULT_MODEL_CONFIG) } };
  malformed.models.agents.Bob.retryLimit = 99;
  await writeFile(path.join(directory, 'runs.json'), JSON.stringify({ schemaVersion: 1,
    runs: [baseline, { ...baseline, runId: 'fictional-null-run', modelRevision: null, models: null }, malformed] }));
  const research = new ResearchStore({ directory });
  await research.init();
  const runs = research.list().runs;
  assert.deepEqual(runs.map(run => run.models), [null, null, null]);
  assert.deepEqual(runs.map(run => run.modelRevision), [null, null, 6]);
  assert.deepEqual(runs.map(run => run.status), ['declined', 'declined', 'declined']);
  const newSession = session({ models: undefined });
  await research.start(newSession);
  const latest = research.list().runs.at(-1);
  assert.equal(latest.modelRevision, null);
  assert.equal(latest.models, null);
});

test('model snapshots do not bypass consent or create replay records and storage', async t => {
  const directory = path.join(await temporary(t), 'absent');
  const research = new ResearchStore({ directory });
  const models = { revision: 1, ...clone(DEFAULT_MODEL_CONFIG), apiKey: SECRET };
  for (const input of [session({ researchConsent: false, models }), session({ mode: 'replay', models })]) {
    assert.equal(await research.start(input), null);
    assert.equal(await research.append(input, { kind: 'stage', models, apiKey: SECRET }), false);
    assert.equal(await research.finish(input, 'arranged'), false);
  }
  assert.deepEqual(research.list().runs, []);
  assert.equal(research.export('jsonl'), '');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
