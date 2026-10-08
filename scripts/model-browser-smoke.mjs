import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { reveal } from './disclosure-helpers.mjs';

let playwright;
try { playwright = await import('playwright'); }
catch { const require = createRequire(import.meta.url); try { playwright = require('playwright'); } catch (error) { if (!process.env.DEMO_PLAYWRIGHT_MODULE) throw error; playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE); } }
const pin = process.env.ADMIN_PIN;
assert.ok(pin, 'Set ADMIN_PIN; credentials are never written by this script.');
// Always use an isolated, non-persistent app. Never alter the event service.
const app = await createDemoServer({ host: '127.0.0.1', port: 0, adminPin: pin, persist: false, minimaxApiKey: '' });
const address = await app.listen();
const demoUrl = 'http://127.0.0.1:' + address.port;
const calls = [];
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  calls.push(JSON.parse(body));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: 'Synthetic connectivity test acknowledged.' }) } }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1024, height: 900 } }); page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const modelPosts = [];
page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/admin/models/')) modelPosts.push(new URL(request.url()).pathname); });
let token, baseline;
const response = path => page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === 'POST');
const modelAction = name => page.locator('[data-model-action="' + name + '"]').first();
const field = path => page.locator('[data-model-path="' + path + '"]');
async function fill(path, value) { await reveal(field(path)); await field(path).fill(value); }
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const admin = (path, body) => page.evaluate(async ({ path, body, token }) => {
  const value = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!value.ok) throw new Error('Admin smoke request failed: ' + value.status + ' ' + path); return value.json();
}, { path, body, token });
const current = async () => { const value = await credentials(); return page.evaluate(async ({ id, token }) => (await fetch('/api/sessions/' + id, { headers: { Authorization: 'Bearer ' + token } })).json(), value); };
async function models() { await page.locator('[data-view="models"]').click(); await field('agents.Alice.model').waitFor(); }
async function apply() {
  const validated = response('/api/admin/models/validate'); await modelAction('validate').click(); assert.equal((await (await validated).json()).valid, true);
  await page.waitForFunction(() => !document.querySelector('[data-model-action="apply"]').disabled);
  const saved = response('/api/admin/models/apply'); await modelAction('apply').click(); const value = await (await saved).json();
  await page.waitForFunction(() => !document.querySelector('[data-model-action="validate"]').disabled); return value;
}
async function saveKey({ enter = false } = {}) {
  const saved = response('/api/admin/models/apply');
  if (enter) await page.locator('[data-model-key]').press('Enter'); else await modelAction('save-key').click();
  const result = await saved; assert.equal(result.status(), 200);
  const value = await result.json();
  await page.waitForFunction(() => document.querySelector('[data-model-key-notice]').textContent.includes('API key saved for Alice and Bob.'));
  await page.waitForFunction(() => !document.querySelector('[data-model-action="validate"]').disabled);
  return { value, submitted: result.request().postDataJSON() };
}
try {
  await page.goto(demoUrl);
  await page.locator('#admin-open').click(); await page.locator('#admin-pin').fill(pin);
  const logged = response('/api/admin/login'); await page.locator('#admin-login-form button[type="submit"]').click(); token = (await (await logged).json()).token;
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  baseline = await admin('/api/admin/models');
  await models();
  assert.equal(await field('agents.Alice.model').inputValue(), baseline.config.agents.Alice.model);
  assert.equal(await field('agents.Bob.model').inputValue(), baseline.config.agents.Bob.model);
  assert.equal(await page.locator('[data-model-key]').inputValue(), '');
  assert.equal(await modelAction('save-key').isVisible(), true);
  assert.equal(await modelAction('save-key').isDisabled(), true);
  assert.equal(await field('agents.Alice.model').isVisible(), true);
  assert.equal(await field('agents.Bob.model').isVisible(), true);
  assert.equal(await field('agents.Alice.temperature').isVisible(), false);
  assert.equal(await field('agents.Alice.timeoutSeconds').isVisible(), false);
  assert.equal(await field('baseUrl').isVisible(), false);
  assert.equal(await page.locator('[data-model-disclosure="review-diff"]').getAttribute('open'), null);
  // Handover screenshot shows the pristine default revision without a current round.
  await mkdir(resolve(process.env.DEMO_ARTIFACTS || 'artifacts'), { recursive: true });
  await page.screenshot({ path: resolve(process.env.DEMO_ARTIFACTS || 'artifacts', 'models.png'), fullPage: true });
  // Ephemeral sentinel is never saved; it verifies that leaving clears the field.
  const sentinel = 'test-only-' + randomUUID(); await page.locator('[data-model-key]').fill(sentinel);
  await page.locator('[data-view="participant"]').click();
  assert.equal(await page.locator('[data-model-key]').inputValue(), '');
  await page.locator('[data-participant-action="start"]').click(); await page.locator('input[name="initial-choice"]').first().waitFor();
  const before = await current(); await models();
  assert.equal(baseline.keyConfigured, false, 'The isolated app must start without a provider key.');
  // Generated dummy credential exists only in this non-persistent QA copy.
  // Never call the external preset: switch to loopback and explicitly clear it.
  await fill('agents.Alice.temperature', '0.7');
  const validationCount = modelPosts.filter(path => path.endsWith('/validate')).length;
  const dummyKey = 'sk-cp-qa-' + randomUUID(); await page.locator('[data-model-key]').fill(dummyKey);
  assert.equal(await modelAction('save-key').isDisabled(), false);
  assert.equal(await modelAction('apply').isDisabled(), true, 'Saving just the key does not require validating the parameter draft.');
  const firstKeySave = await saveKey(); const keySaved = firstKeySave.value; assert.equal(keySaved.keyConfigured, true);
  assert.deepEqual(firstKeySave.submitted.config, baseline.config, 'Key-only save submits saved settings, never unsaved parameter edits.');
  assert.equal(firstKeySave.submitted.expectedRevision, baseline.revision);
  assert.equal(firstKeySave.submitted.apiKey, dummyKey);
  assert.equal(await field('agents.Alice.temperature').inputValue(), '0.7', 'Unsaved parameter draft remains on screen.');
  assert.equal(await field('agents.Alice.temperature').isVisible(), true, 'Expanded parameters remain open after key-only save.');
  assert.deepEqual(keySaved.config, baseline.config);
  assert.equal(modelPosts.filter(path => path.endsWith('/validate')).length, validationCount);
  assert.equal(JSON.stringify(keySaved).includes(dummyKey), false);
  assert.equal(JSON.stringify(await admin('/api/admin/models')).includes(dummyKey), false);
  assert.equal(await page.locator('[data-model-key]').inputValue(), '');
  assert.equal(await page.evaluate(value => JSON.stringify(sessionStorage).includes(value), dummyKey), false);
  const replacementKey = 'sk-cp-qa-' + randomUUID(); await page.locator('[data-model-key]').fill(replacementKey);
  const enterSave = await saveKey({ enter: true });
  assert.equal(enterSave.submitted.expectedRevision, keySaved.revision);
  assert.deepEqual(enterSave.submitted.config, baseline.config);
  assert.equal(enterSave.submitted.apiKey, replacementKey);
  assert.equal(enterSave.value.keyConfigured, true);
  assert.equal(await field('agents.Alice.temperature').inputValue(), '0.7');
  assert.equal(await page.locator('[data-model-key]').inputValue(), '');
  assert.equal(await modelAction('save-key').isDisabled(), true);
  assert.equal(modelPosts.filter(path => path.endsWith('/validate')).length, validationCount, 'Click and Enter key saves both skip draft validation.');
  assert.deepEqual((await admin('/api/admin/models')).config, baseline.config);
  assert.equal(JSON.stringify(enterSave.value).includes(replacementKey), false);
  assert.equal((await current()).session.modelRevision, before.session.modelRevision);
  await page.locator('[data-model-provider]').selectOption('openai_compatible');
  assert.equal(await field('baseUrl').isVisible(), true, 'Changing provider reveals the connection draft for review.');
  await fill('baseUrl', baseUrl);
  await page.locator('[data-model-key]').fill('not-saved-' + randomUUID());
  assert.equal(await modelAction('save-key').isDisabled(), true, 'Provider / endpoint drafts must be reviewed and saved together.');
  const beforeBlockedEnter = modelPosts.filter(path => path.endsWith('/apply')).length;
  await page.locator('[data-model-key]').press('Enter');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(modelPosts.filter(path => path.endsWith('/apply')).length, beforeBlockedEnter, 'Enter cannot bypass a disabled key-only save.');
  await page.locator('[data-model-key]').fill('');
  await fill('agents.Alice.model', 'local-smoke-alice'); await fill('agents.Bob.model', 'local-smoke-bob');
  await fill('agents.Alice.temperature', '0.6'); await fill('agents.Bob.temperature', '0.8');
  await fill('agents.Alice.maxTokens', '512'); await fill('agents.Bob.maxTokens', '768');
  await reveal(field('agents.Alice.thinking'));
  await field('agents.Alice.thinking').selectOption('adaptive');
  const check = response('/api/admin/models/validate'); await modelAction('validate').click(); assert.equal((await (await check).json()).valid, true);
  await page.locator('[data-model-diff]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-model-diff]').isVisible(), true, 'Validation reveals the exact configuration diff.');
  assert.equal(await modelAction('apply').isDisabled(), true, 'An existing key cannot silently move to a different provider.');
  await reveal(page.locator('[data-model-clear-key]')); await page.locator('[data-model-clear-key]').check();
  assert.equal(await page.locator('[data-model-key]').isDisabled(), true);
  assert.equal(await modelAction('save-key').isDisabled(), true);
  const saved = await apply(); assert.ok(saved.revision > baseline.revision);
  assert.equal(saved.keyConfigured, false);
  assert.equal(saved.config.agents.Alice.temperature, 0.6); assert.equal(saved.config.agents.Bob.maxTokens, 768);
  assert.equal(saved.config.agents.Alice.thinking, 'adaptive');
  assert.equal((await current()).session.modelRevision, before.session.modelRevision);
  for (const role of ['Alice', 'Bob']) {
    const tested = response('/api/admin/models/test'); await page.locator('[data-model-action="test"][data-model-role="' + role + '"]').click();
    const value = await (await tested).json(); assert.equal(value.role, role); assert.equal(value.model, saved.config.agents[role].model); assert.ok(value.latencyMs >= 0);
    await page.waitForFunction(role => document.querySelector('[data-model-test="' + role + '"]').textContent.includes('Connection successful · fictional test data'), role);
  }
  assert.equal(calls.length, 2); assert.equal(calls[0].model, 'local-smoke-alice'); assert.equal(calls[1].model, 'local-smoke-bob');
  assert.equal(calls[0].temperature, 0.6); assert.equal(calls[1].max_tokens, 768);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(value => JSON.stringify(sessionStorage).includes(value), sentinel), false);
  for (const secret of [dummyKey, replacementKey]) {
    assert.equal(await page.evaluate(value => JSON.stringify(sessionStorage).includes(value), secret), false);
    assert.equal(JSON.stringify(await admin('/api/admin/models')).includes(secret), false);
  }
  for (const theme of ['light', 'dark']) for (const width of [320, 736, 1024]) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.locator('[data-view="console"]').click(); await page.locator('[data-console-action="reset"]').waitFor();
  const resetResponse = response('/api/admin/sessions/' + before.session.id + '/intervene'); await page.locator('[data-console-action="reset"]').click();
  const reset = await (await resetResponse).json(); assert.equal(reset.state.session.modelRevision, saved.revision);
  assert.equal(reset.state.models.agents.Alice.model, 'local-smoke-alice'); assert.equal(reset.state.models.agents.Bob.model, 'local-smoke-bob');
  // Restore the exact prior public config after the dummy QA key was explicitly cleared.
  const latest = await admin('/api/admin/models'); await admin('/api/admin/models/apply', { config: baseline.config, expectedRevision: latest.revision });
  await models(); await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1024, height: 900 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['First level shows provider, key and both models; optional parameters stay collapsed', 'Expanded parameters survive key saves; provider changes reveal the connection; validation reveals the diff', 'Save API key by click and Enter without validation; unsaved role draft preserved but not saved', 'Changed provider / endpoint and explicit clearKey disable key-only save; Enter cannot bypass', 'Write-only dummy key / redacted GET / field clears / no browser persistence / explicit clearKey', 'Validated role-specific model / temperature / tokens / thinking; saved next-round only', 'Alice and Bob real API connectivity tests through local fake provider', 'New round snapshots saved revision; previous public config restored', 'Light/dark at 320/736/1024; no horizontal overflow; pristine r1 handover screenshot'], pageErrors: errors, externalProviderCalls: 0, note: 'Isolated non-persistent QA copy; event service is unchanged and dummy key is cleared.' }, null, 2));
} finally {
  if (baseline && token) { try { const latest = await admin('/api/admin/models'); if (JSON.stringify(latest.config) !== JSON.stringify(baseline.config)) await admin('/api/admin/models/apply', { config: baseline.config, expectedRevision: latest.revision }); } catch { /* Server shutdown requires operator cleanup of QA state. */ } }
  await browser.close(); await new Promise(resolve => provider.close(resolve)); await app.close();
}
