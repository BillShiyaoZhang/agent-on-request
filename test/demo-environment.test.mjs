import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { loadDemoEnvironment } from '../src/demo-environment.mjs';
import { DEFAULT_MODEL_CONFIG, ModelStore } from '../src/model-store.mjs';
import { clone } from '../src/config.mjs';

// Deliberately fictional credentials; never read the actual project .env.
const FIRST_KEY = 'sk-cp-fictional-env-key-one';
const SECOND_KEY = 'sk-cp-fictional-env-key-two';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-demo-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.data', 'demo');
  await mkdir(directory, { recursive: true });
  return { root, directory, envFile: path.join(root, '.env'), modelFile: path.join(directory, 'models.json') };
}
const compatible = () => ({ ...clone(DEFAULT_MODEL_CONFIG), provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:8089/v1' });

test('dotenv settings load automatically without replacing explicit process settings or returning secrets', async t => {
  const files = await fixture(t);
  await writeFile(files.envFile, '# Fictional local settings\nMINIMAX_TOKEN_PLAN_KEY=' + FIRST_KEY + '\nDEMO_PORT=4327\n');
  const environment = { DEMO_PORT: '4328' };
  const result = await loadDemoEnvironment({ root: files.root, environment });
  assert.equal(environment.MINIMAX_TOKEN_PLAN_KEY, FIRST_KEY);
  assert.equal(environment.DEMO_PORT, '4328');
  assert.deepEqual(result, { file: '.env', migrated: false, keyConfigured: true });
  assert.equal(JSON.stringify(result).includes(FIRST_KEY), false);
});

test('existing demo key migrates privately into dotenv and disappears from persisted model metadata', async t => {
  const files = await fixture(t);
  const oldStore = new ModelStore({ directory: files.directory, apiKey: FIRST_KEY }); await oldStore.init();
  const before = oldStore.view();
  const environment = {};
  assert.equal((await loadDemoEnvironment({ root: files.root, environment })).migrated, true);
  assert.equal(parseEnv(await readFile(files.envFile, 'utf8')).MINIMAX_TOKEN_PLAN_KEY, FIRST_KEY);
  const persisted = JSON.parse(await readFile(files.modelFile, 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'apiKey'), false);
  assert.equal(persisted.keySource, 'environment');
  assert.equal(JSON.stringify(persisted).includes(FIRST_KEY), false);
  assert.equal(persisted.revision, before.revision);
  const restarted = new ModelStore({ directory: files.directory, environmentApiKey: environment.MINIMAX_TOKEN_PLAN_KEY }); await restarted.init();
  assert.equal(restarted.snapshot().apiKey, FIRST_KEY);
  assert.deepEqual(restarted.view(), before);
  assert.equal((await loadDemoEnvironment({ root: files.root, environment: {} })).migrated, false, 'Migration is idempotent.');
  if (process.platform !== 'win32') assert.equal((await stat(files.envFile)).mode & 0o777, 0o600);
});

test('an existing dotenv key wins over a legacy disk key and unrelated local settings are retained', async t => {
  const files = await fixture(t);
  await new ModelStore({ directory: files.directory, apiKey: FIRST_KEY }).init();
  const original = '# Preserve this comment\nMINIMAX_TOKEN_PLAN_KEY=' + SECOND_KEY + '\nDEMO_PORT=4331\n';
  await writeFile(files.envFile, original);
  const environment = {};
  await loadDemoEnvironment({ root: files.root, environment });
  assert.equal(await readFile(files.envFile, 'utf8'), original);
  const store = new ModelStore({ directory: files.directory, environmentApiKey: environment.MINIMAX_TOKEN_PLAN_KEY }); await store.init();
  assert.equal(store.snapshot().apiKey, SECOND_KEY);
  assert.equal(environment.DEMO_PORT, '4331');
  assert.equal((await readFile(files.modelFile, 'utf8')).includes(FIRST_KEY), false);
});

test('environment-managed key changes are used after restart without copying either secret into model JSON', async t => {
  const files = await fixture(t);
  const store = new ModelStore({ directory: files.directory, environmentApiKey: FIRST_KEY }); await store.init();
  const previousRound = store.snapshot();
  const draft = clone(DEFAULT_MODEL_CONFIG); draft.agents.Alice.temperature = 0.7;
  await store.apply({ config: draft, expectedRevision: store.view().revision });
  const restarted = new ModelStore({ directory: files.directory, environmentApiKey: SECOND_KEY }); await restarted.init();
  assert.equal(restarted.snapshot().apiKey, SECOND_KEY);
  assert.equal(previousRound.apiKey, FIRST_KEY);
  assert.equal(restarted.view().config.agents.Alice.temperature, 0.7);
  const text = await readFile(files.modelFile, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(text), 'apiKey'), false);
  for (const value of [FIRST_KEY, SECOND_KEY]) assert.equal(text.includes(value), false);
  assert.equal(JSON.stringify(restarted).includes(SECOND_KEY), false);
});

test('an empty legacy saved configuration uses the official MiniMax environment fallback', async t => {
  const files = await fixture(t);
  const draft = clone(DEFAULT_MODEL_CONFIG); draft.agents.Bob.temperature = 0.6;
  await writeFile(files.modelFile, JSON.stringify({ schemaVersion: 1, revision: 4, config: draft, apiKey: '' }));
  const store = new ModelStore({ directory: files.directory, environmentApiKey: FIRST_KEY }); await store.init();
  assert.equal(store.snapshot().apiKey, FIRST_KEY);
  assert.equal(store.view().revision, 4);
  assert.equal(store.view().config.agents.Bob.temperature, 0.6);
  const persisted = JSON.parse(await readFile(files.modelFile, 'utf8'));
  assert.equal(persisted.keySource, 'environment');
  assert.equal(Object.hasOwn(persisted, 'apiKey'), false);
});

test('explicit clear stays cleared after restart even while dotenv still provides the key', async t => {
  const files = await fixture(t);
  const store = new ModelStore({ directory: files.directory, environmentApiKey: FIRST_KEY }); await store.init();
  await store.apply({ config: DEFAULT_MODEL_CONFIG, clearKey: true, expectedRevision: store.view().revision });
  const restarted = new ModelStore({ directory: files.directory, environmentApiKey: SECOND_KEY }); await restarted.init();
  assert.equal(restarted.snapshot().apiKey, '');
  assert.equal(restarted.view().keyConfigured, false);
  assert.equal(JSON.parse(await readFile(files.modelFile, 'utf8')).keySource, 'cleared');
});

test('environment credential never follows a compatible provider or a changed endpoint', async t => {
  const files = await fixture(t);
  const store = new ModelStore({ directory: files.directory, environmentApiKey: FIRST_KEY }); await store.init();
  await assert.rejects(store.apply({ config: compatible(), expectedRevision: store.view().revision }), { code: 'MODEL_KEY_RECONFIRM' });
  await store.apply({ config: compatible(), clearKey: true, expectedRevision: store.view().revision });
  const restarted = new ModelStore({ directory: files.directory, environmentApiKey: SECOND_KEY }); await restarted.init();
  assert.equal(restarted.snapshot().apiKey, '');
  assert.equal(restarted.view().config.provider, 'openai_compatible');
  const local = new ModelStore({ persist: false, initialConfig: compatible(), environmentApiKey: FIRST_KEY }); await local.init();
  assert.equal(local.snapshot().apiKey, '');
  await restarted.apply({ config: compatible(), apiKey: 'fictional-local-provider-key', expectedRevision: restarted.view().revision });
  const explicit = new ModelStore({ directory: files.directory, environmentApiKey: SECOND_KEY }); await explicit.init();
  assert.equal(explicit.snapshot().apiKey, 'fictional-local-provider-key');
});

test('a blank dotenv placeholder accepts migration and parse errors never echo credential-bearing source', async t => {
  const files = await fixture(t);
  await new ModelStore({ directory: files.directory, apiKey: FIRST_KEY }).init();
  await writeFile(files.envFile, '# Empty placeholder\nMINIMAX_TOKEN_PLAN_KEY=\nDEMO_PORT=4327\n');
  const environment = {}; await loadDemoEnvironment({ root: files.root, environment });
  assert.equal(environment.MINIMAX_TOKEN_PLAN_KEY, FIRST_KEY);
  assert.equal(environment.DEMO_PORT, '4327');
  await writeFile(files.modelFile, '{"apiKey":"' + FIRST_KEY);
  await assert.rejects(loadDemoEnvironment({ root: files.root, environment: {} }), error => error.code === 'DEMO_ENVIRONMENT' && !error.message.includes(FIRST_KEY));
});
