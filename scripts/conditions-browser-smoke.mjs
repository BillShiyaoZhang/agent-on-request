import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { hashValue } from '../src/config.mjs';

let playwright;
try { playwright = await import('playwright'); }
catch { const require = createRequire(import.meta.url); try { playwright = require('playwright'); } catch (error) { if (!process.env.DEMO_PLAYWRIGHT_MODULE) throw error; playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE); } }

// This regression always creates disposable agents and never connects to a real model.
const pin = 'conditions-qa-' + randomUUID();
const app = await createDemoServer({ host: '127.0.0.1', port: 0, adminPin: pin, persist: false, minimaxApiKey: '' });
const address = await app.listen(), url = 'http://127.0.0.1:' + address.port;
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/conditions-browser');
await mkdir(artifacts, { recursive: true });
let browser;
const errors = [], checked = [];
try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  page.setDefaultTimeout(15000);
  let expectedConflict = false, expectedInvalidDefinition = false, adminToken;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !(expectedConflict && /409/.test(message.text())) && !(expectedInvalidDefinition && /422/.test(message.text()))) errors.push(message.text()); });
  const conditionAction = name => page.locator('[data-conditions-action="' + name + '"]');
  const participantAction = name => page.locator('[data-participant-action="' + name + '"]').first();
  const postResponse = path => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  const validate = async () => { const response = postResponse('/api/conditions/resolve'); await conditionAction('validate').click(); const value = await response; assert.equal(value.status(), 200); await page.waitForFunction(() => document.querySelector('[data-conditions-review-status]')?.textContent === 'Validated draft' && !document.querySelector('[data-conditions-action="validate"]').disabled); return value.json(); };
  const choosePreset = async id => { const response = postResponse('/api/conditions/resolve'); await page.locator('[data-conditions-preset="' + id + '"]').check(); const value = await response; assert.equal(value.status(), 200); await page.waitForFunction(() => document.querySelector('[data-conditions-review-status]')?.textContent === 'Validated draft' && !document.querySelector('[data-conditions-action="validate"]').disabled); return value.json(); };
  const openDetails = async selector => { const details = page.locator(selector); if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click(); };
  const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
  const current = async () => { const stored = await credentials(); const response = await page.request.get(url + '/api/sessions/' + stored.id, { headers: { Authorization: 'Bearer ' + stored.token } }); assert.equal(response.status(), 200); return response.json(); };
  const admin = async (path, data) => { const response = await page.request[data ? 'post' : 'get'](url + path, { headers: { Authorization: 'Bearer ' + adminToken }, ...(data ? { data } : {}) }); assert.equal(response.status(), 200); return response.json(); };
  async function share(stage, choice) {
    await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
    const previewResponse = postResponse('/api/sessions/' + (await credentials()).id + '/preview'); await participantAction('preview').click(); const preview = await (await previewResponse).json();
    const confirmed = postResponse('/api/sessions/' + (await credentials()).id + '/actions'); await participantAction('confirm').click(); const result = await confirmed; assert.equal(result.status(), 200); await page.waitForFunction(() => !document.querySelector('[data-participant-action="confirm"]')); return preview;
  }

  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]')?.disabled);
  assert.equal(await page.locator('[data-conditions-preview] .knowledge-svg').count(), 2);
  assert.equal(await page.locator('[data-conditions-preview] .agent-section').count(), 8);
  assert.equal(await page.locator('[data-conditions-preview] pre').count(), 0, 'Agent overview has no primary raw JSON.');
  assert.equal(app.models.view().keyConfigured, false);
  checked.push('Default initialization resolves with two readable graphs and capability, data and authorization cards.');

  const minimal = await choosePreset('minimal'); assert.equal(minimal.requiresResearcher, true);
  assert.equal(await participantAction('start').isDisabled(), true);
  assert.equal(await page.locator('[data-conditions-researcher-needed]').isVisible(), true);
  await page.locator('[data-conditions-role="Bob"]').click();
  assert.equal(await page.locator('[data-conditions-component][data-owner="Bob"]').first().isDisabled(), true);
  await choosePreset('conference'); await page.locator('[data-conditions-role="Alice"]').click();
  const composedResponse = postResponse('/api/conditions/resolve'); await page.locator('[data-conditions-component="alice-data-free"]').check();
  const composed = await (await composedResponse).json(); assert.ok(composed.conditions.agents.Alice.data.calendar.every(row => row.status === 'Free'));
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="validate"]').disabled);
  checked.push('Role component composition changes Alice while unsigned Bob controls and changed-Bob starts remain gated.');

  await openDetails('.custom-condition-editor');
  await page.locator('[data-conditions-path="authorization.maxUses"]').fill('4');
  assert.equal(await participantAction('start').isDisabled(), true);
  await conditionAction('add-row').filter({ hasText: 'Add node' }).click();
  await page.locator('[data-conditions-row-path="kg.nodes"][data-key="label"]').last().fill('Study protocol QA');
  const customized = await validate();
  assert.equal(customized.conditions.agents.Alice.authorization.maxUses, 4);
  assert.equal(customized.conditions.agents.Alice.kg.nodes.at(-1).label, 'Study protocol QA');
  assert.equal(await participantAction('start').isEnabled(), true);
  await openDetails('.advanced-condition-editor:not(.saved-condition-bundles)');
  await page.locator('[data-conditions-json]').fill('{');
  assert.equal(await participantAction('start').isDisabled(), true);
  await conditionAction('parse-json').click(); assert.match(await page.locator('[data-conditions-notice]').innerText(), /Definition error/);
  await conditionAction('discard-json').click(); const restored = await validate(); assert.deepEqual(restored.conditions, customized.conditions);
  checked.push('Structured KG and authorization edits require exact revalidation; malformed JSON never becomes a valid draft.');

  await page.locator('#admin-open').click(); await page.locator('#admin-pin').fill(pin);
  const loginResponse = postResponse('/api/admin/login'); await page.locator('#admin-login-form button[type="submit"]').click(); adminToken = (await (await loginResponse).json()).token;
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  // A resolved fixture is complete: missing brief keys must stay missing even
  // when its original preset or current owner template supplies those keys.
  const importedFixture = structuredClone(restored.conditions);
  importedFixture.agents.Bob.data.brief = { topic: 'Imported synthetic topic' };
  await openDetails('.saved-condition-bundles');
  const importedResponse = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-import]').setInputFiles({ name: 'complete-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedFixture)) });
  const imported = await (await importedResponse).json();
  assert.deepEqual(imported.conditions, importedFixture); assert.equal(imported.hash, hashValue(importedFixture));
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  for (const [name, definition] of [['unsupported-version', { presetId: 'conference', schemaVersion: 2 }], ['unknown-field', { presetId: 'conference', unrecognizedCondition: true }]]) {
    expectedInvalidDefinition = true;
    const invalidImportResponse = postResponse('/api/conditions/resolve');
    await page.locator('[data-conditions-import]').setInputFiles({ name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)) });
    assert.equal((await invalidImportResponse).status(), 422, 'Imported composition validation must retain ' + name + '.');
    await page.waitForFunction(() => !document.querySelector('[data-conditions-action="validate"]').disabled);
    expectedInvalidDefinition = false;
    const retained = await validate(); assert.deepEqual(retained.conditions, importedFixture); assert.equal(retained.hash, imported.hash);
  }
  const largeFixture = structuredClone(importedFixture);
  largeFixture.agents.Bob.data.brief.rows = Array.from({ length: 6000 }, (_, index) => ({ label: 'fictional', value: index % 10 }));
  const compactLarge = Buffer.from(JSON.stringify(largeFixture)); assert.ok(compactLarge.length < 262144);
  const largeImportResponse = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-import]').setInputFiles({ name: 'large-complete-fixture.json', mimeType: 'application/json', buffer: compactLarge });
  assert.equal((await largeImportResponse).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="download"]').disabled);
  const downloadedEvent = page.waitForEvent('download'); await conditionAction('download').click();
  const downloaded = await downloadedEvent, prettyFixture = await readFile(await downloaded.path());
  assert.ok(prettyFixture.length > 262144, 'Pretty download exceeds the compact HTTP request limit.');
  const roundTripResponse = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-import]').setInputFiles({ name: downloaded.suggestedFilename(), mimeType: 'application/json', buffer: prettyFixture });
  const roundTripHttp = await roundTripResponse; assert.equal(roundTripHttp.status(), 200);
  const roundTrip = await roundTripHttp.json(); assert.deepEqual(roundTrip.conditions, largeFixture); assert.equal(roundTrip.hash, hashValue(largeFixture));
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  const restoreImportedResponse = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-import]').setInputFiles({ name: 'restore-complete-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedFixture)) });
  assert.equal((await restoreImportedResponse).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  checked.push('A large complete fixture downloads as pretty JSON above 256 KiB and imports back with exact conditions and hash while its compact request remains within the HTTP limit.');
  assert.equal(await page.locator('[data-conditions-preset]:checked').count(), 0, 'A complete fixture can explicitly select its original starter kit again.');
  await page.locator('[data-conditions-role="Bob"]').click(); await openDetails('.custom-condition-editor');
  assert.equal(await page.locator('[data-conditions-component="bob-data-template"]').isChecked(), false, 'An imported data definition differs from the owner component and can be replaced explicitly.');
  await page.locator('[data-conditions-path="data.brief.topic"]').fill('Edited imported topic');
  const editedImport = await validate();
  assert.deepEqual(editedImport.conditions.agents.Bob.data.brief, { topic: 'Edited imported topic' });
  assert.deepEqual(editedImport.conditions.agents.Alice, importedFixture.agents.Alice);
  const componentImportResponse = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-component="bob-skills-scheduling"]').check();
  const componentImport = await (await componentImportResponse).json();
  assert.deepEqual(componentImport.conditions.agents.Bob.skills, ['read_synthetic_calendar', 'send_scoped_reply']);
  assert.deepEqual(componentImport.conditions.agents.Bob.data.brief, editedImport.conditions.agents.Bob.data.brief);
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="validate"]').disabled);
  await openDetails('.advanced-condition-editor:not(.saved-condition-bundles)');
  const completeProfiles = JSON.parse(await page.locator('[data-conditions-json]').inputValue());
  completeProfiles.Bob.data.brief = {};
  await page.locator('[data-conditions-json]').fill(JSON.stringify(completeProfiles));
  const definedImportResponse = postResponse('/api/conditions/resolve'); await conditionAction('parse-json').click();
  const definedImport = await (await definedImportResponse).json();
  assert.deepEqual(definedImport.conditions.agents.Bob.data.brief, {});
  assert.deepEqual(definedImport.conditions.agents.Alice, importedFixture.agents.Alice);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  // Invalid complete-profile edits must not poison the accepted structured draft.
  expectedInvalidDefinition = true;
  await page.locator('[data-conditions-json]').fill(JSON.stringify({ Alice: null }));
  const invalidDefinitionResponse = postResponse('/api/conditions/resolve'); await conditionAction('parse-json').click();
  assert.equal((await invalidDefinitionResponse).status(), 422);
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="validate"]').disabled);
  expectedInvalidDefinition = false;
  await page.locator('[data-conditions-role="Alice"]').click();
  const afterRejectedDefinition = await validate(); assert.deepEqual(afterRejectedDefinition.conditions, definedImport.conditions);
  checked.push('Complete fixture import preserves missing brief keys and exact hashes; structured, category and complete-profile edits remain usable. Invalid composition imports and profile definitions are rejected without replacing the accepted draft.');
  await page.locator('[data-conditions-role="Alice"]').click();
  await openDetails('.saved-condition-bundles'); await page.locator('[data-conditions-bundle-name]').fill('Reproducible QA fixture');
  const savedResponse = postResponse('/api/admin/conditions'); await conditionAction('save-bundle').click(); const saved = (await (await savedResponse).json()).bundle;
  assert.equal(saved.revision, 1); assert.deepEqual(saved.conditions, definedImport.conditions);
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="save-bundle"]').disabled);
  assert.notEqual(await page.locator('.saved-condition-bundles').getAttribute('open'), null);
  // Simulate a concurrent researcher update; the stale visible editor must not overwrite it.
  const concurrent = await admin('/api/admin/conditions', { name: saved.name, input: saved.conditions, expectedRevision: 1 }); assert.equal(concurrent.bundle.revision, 2);
  expectedConflict = true; const conflictResponse = postResponse('/api/admin/conditions'); await conditionAction('save-bundle').click(); assert.equal((await conflictResponse).status(), 409);
  await page.waitForFunction(() => !document.querySelector('[data-conditions-action="save-bundle"]').disabled); expectedConflict = false;
  assert.match(await page.locator('[data-conditions-notice]').innerText(), /revision|changed|刷新|版本|更新/i);
  assert.equal((await admin('/api/admin/conditions')).bundles[0].revision, 2);
  const refreshResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/conditions' && response.request().method() === 'GET'); await conditionAction('refresh-bundles').click(); await refreshResponse;
  await choosePreset('minimal'); await openDetails('.saved-condition-bundles');
  await page.locator('[data-conditions-bundle]').selectOption(saved.id);
  const loadedResponse = postResponse('/api/conditions/resolve'); await conditionAction('load-bundle').click(); const loaded = await (await loadedResponse).json(); assert.deepEqual(loaded.conditions, saved.conditions); assert.equal(loaded.hash, saved.hash);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  checked.push('Saved bundles reproduce the exact fixture and hash; concurrent stale revisions return 409 without silent overwrite.');
  await page.screenshot({ path: resolve(artifacts, 'initial-conditions.png'), fullPage: true });

  await page.locator('#start-consent').check();
  const startedResponse = postResponse('/api/sessions'); await participantAction('start').click(); const startedHttp = await startedResponse, started = await startedHttp.json();
  assert.deepEqual(started.state.initialConditions, saved.conditions);
  assert.equal(startedHttp.request().postDataJSON().expectedConditionsHash, saved.hash);
  await page.locator('input[name="initial-choice"]').first().waitFor();
  const initialState = await current(); assert.equal(initialState.agentStates.Bob.stats.receivedNodes, 0);
  await share('initial', 'free'); const receivedState = await current(); assert.ok(receivedState.agentStates.Bob.stats.receivedNodes > 0);
  const bob = page.locator('#live-agent-states [data-state-role="Bob"]');
  await bob.locator('[data-knowledge-origin]').selectOption('received'); await bob.locator('.knowledge-node').first().click();
  const provenance = await bob.locator('[data-knowledge-detail]').innerText(); assert.match(provenance, /Receipt provenance/); assert.match(provenance, /Confirmed fields: day, time, status/); assert.match(provenance, /Operation/);
  await bob.locator('[data-knowledge-query]').fill('no-match-qa'); assert.equal(await bob.locator('.knowledge-node').count(), 0); await bob.locator('[data-knowledge-query]').fill('');
  await page.locator('#live-agent-states').screenshot({ path: resolve(artifacts, 'agent-knowledge-receipt.png') });
  await participantAction('end').click(); await page.locator('#end-confirm').click(); await participantAction('fresh').waitFor();
  checked.push('A real confirmed receipt grows only Bob’s received graph and exposes fields, sender and operation provenance.');

  await page.locator('[data-view="research"]').click(); await page.locator('[data-trace-slider]').waitFor();
  const runs = (await admin('/api/admin/research')).runs; const run = runs.find(item => item.sessionId === started.state.session.id) || runs[0];
  assert.ok(run.trace.length > 3);
  assert.equal(await page.locator('#research-agent-replay [data-state-role="Bob"] .received-tag').innerText(), '0 received');
  await page.locator('[data-trace-latest]').click(); assert.ok(Number((await page.locator('#research-agent-replay [data-state-role="Bob"] .received-tag').innerText()).split(' ')[0]) > 0);
  assert.match(await page.locator('[data-trace-position]').innerText(), new RegExp('Step ' + run.trace.length + ' of ' + run.trace.length));
  await page.locator('[data-trace-slider]').focus(); await page.locator('[data-trace-slider]').press('Home');
  assert.equal(await page.locator('#research-agent-replay [data-state-role="Bob"] .received-tag').innerText(), '0 received');
  assert.match(await page.locator('[data-trace-diff]').innerText(), /Initial snapshot/);
  await page.locator('[data-trace-latest]').click(); await page.locator('#research-agent-replay').screenshot({ path: resolve(artifacts, 'research-state-replay.png') });
  checked.push('Closed consented runs replay initial and latest stored states through both slider keyboard input and step buttons.');

  for (const width of [320, 736]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, 'Research layout fits width ' + width + ' / ' + colorScheme);
    await page.screenshot({ path: resolve(artifacts, 'research-' + width + '-' + colorScheme + '.png'), fullPage: true });
    await page.locator('[data-view="participant"]').click(); if (await participantAction('fresh').isVisible()) await participantAction('fresh').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, 'Initialization layout fits width ' + width + ' / ' + colorScheme);
    await page.screenshot({ path: resolve(artifacts, 'initial-' + width + '-' + colorScheme + '.png'), fullPage: true });
    // Return to the same retained historical run for the next viewport.
    await page.locator('[data-view="research"]').click(); await page.locator('[data-trace-slider]').waitFor();
  }
  checked.push('Initialization and historical review fit 320px and 736px viewports in both light and dark mode.');
  await page.locator('[data-view="participant"]').click();
  await choosePreset('minimal');
  await choosePreset('conference');
  const readonlyResolved = postResponse('/api/conditions/resolve'); await page.locator('[data-conditions-component="alice-skills-readonly"]').check();
  assert.equal((await (await readonlyResolved).json()).conditions.agents.Alice.skills.includes('send_scoped_snapshot'), false);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  await participantAction('start').click(); await page.locator('input[name="initial-choice"]').first().waitFor();
  await page.locator('input[name="initial-choice"][value="free"]').check();
  const readonlyPreviewResponse = postResponse('/api/sessions/' + (await credentials()).id + '/preview'); await participantAction('preview').click();
  assert.equal((await readonlyPreviewResponse).status(), 200);
  await participantAction('confirm').waitFor(); assert.equal(await participantAction('confirm').isDisabled(), true);
  assert.match(await page.locator('.preview-box').innerText(), /inspection and preview, but sending is disabled/);
  await share('initial', 'none');
  assert.equal((await current()).receipts.aliceToBob.length, 0);
  checked.push('Observation-only Alice can preview exact information, cannot confirm a send, and can still decline sharing.');
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'conditions-browser-report.json'), JSON.stringify({ checked, errors, screenshots: 11 }, null, 2));
  console.log(JSON.stringify({ ok: true, checked, artifacts }, null, 2));
} finally { await browser?.close(); await app.close(); }
