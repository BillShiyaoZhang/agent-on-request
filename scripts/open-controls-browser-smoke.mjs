import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { reveal } from './disclosure-helpers.mjs';

const require = createRequire(import.meta.url);
const playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
// Never read event credentials or contact a real provider in this regression.
const app = await createDemoServer({ host: '127.0.0.1', port: 0, persist: false, minimaxApiKey: '', openControls: true });
const address = await app.listen(), url = 'http://127.0.0.1:' + address.port;
const artifacts = resolve('artifacts/open-controls-browser');
await mkdir(artifacts, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [], loginRequests = [], checked = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/login') loginRequests.push(request.method()); });
const act = name => page.locator('[data-participant-action="' + name + '"]').first();
const postResponse = path => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const state = async () => app.engine.view(app.engine.get((await credentials()).id));
async function direct(path) {
  const response = await page.request.get(url + path);
  assert.equal(response.status(), 200, 'Direct API requires no token: ' + path);
  return response.json();
}
async function controlsVisible() {
  for (const view of ['participant', 'console', 'config', 'models', 'research']) assert.equal(await page.locator('[data-view="' + view + '"]').isVisible(), true);
  assert.equal(await page.locator('#admin-open').isVisible(), false);
  assert.equal(await page.locator('#admin-logout').isVisible(), false);
  assert.equal(await page.locator('#admin-pin').count(), 0);
}
async function share(stage, choice) {
  await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
  await act('preview').click(); await act('confirm').waitFor(); await act('confirm').click();
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="confirm"]'));
}

try {
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]')?.disabled);
  await controlsVisible();
  assert.equal((await direct('/api/meta')).openControls, true);
  assert.equal((await direct('/api/admin/models')).keyConfigured, false);
  await direct('/api/admin/config'); await direct('/api/admin/sessions'); await direct('/api/admin/research');
  await page.screenshot({ path: resolve(artifacts, 'direct-home-zh.png'), fullPage: true });
  checked.push('Startup exposes all five views without login/logout buttons or a PIN; configuration, models, sessions and research APIs accept no token');

  await page.locator('[data-view="config"]').click();
  const persona = page.locator('[data-config-path="persona"]');
  await reveal(persona); await persona.fill('Bob is a patient direct-control demo collaborator.');
  const configValidated = postResponse('/api/admin/config/validate');
  await page.locator('[data-config-action="validate"]').click();
  assert.equal((await configValidated).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-config-action="apply"]')?.disabled);
  const configApplied = postResponse('/api/admin/config/apply');
  await page.locator('[data-config-action="apply"]').click();
  assert.equal((await configApplied).status(), 200);
  assert.equal((await direct('/api/admin/config')).template.persona, 'Bob is a patient direct-control demo collaborator.');
  checked.push('Bob template fields validate and apply directly without a sign-in request');

  await page.locator('[data-view="models"]').click();
  const temperature = page.locator('[data-model-path="agents.Alice.temperature"]');
  await reveal(temperature); await temperature.fill('0.4');
  const modelValidated = postResponse('/api/admin/models/validate');
  await page.locator('[data-model-action="validate"]').click();
  assert.equal((await modelValidated).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-model-action="apply"]')?.disabled);
  const modelApplied = postResponse('/api/admin/models/apply');
  await page.locator('[data-model-action="apply"]').click();
  assert.equal((await modelApplied).status(), 200);
  assert.equal((await direct('/api/admin/models')).config.agents.Alice.temperature, 0.4);
  assert.equal((await direct('/api/admin/models')).keyConfigured, false);
  await controlsVisible();
  checked.push('Alice/Bob model settings are reachable and public parameters save directly; the test keeps the model key empty');

  await page.locator('[data-view="participant"]').click();
  const bobRole = page.locator('[data-conditions-role="Bob"]');
  await reveal(bobRole); await bobRole.click();
  const topic = page.locator('[data-conditions-path="data.brief.topic"]');
  await reveal(topic); assert.equal(await topic.isDisabled(), false);
  const customTopic = 'A directly edited fictional brief';
  await topic.fill(customTopic);
  const definition = page.locator('[data-conditions-disclosure="json"]');
  await reveal(definition); await definition.locator(':scope > summary').click();
  assert.equal((await definition.innerText()).includes('研究者登录'), false);
  assert.equal((await definition.innerText()).includes('sign-in'), false);
  const resolved = postResponse('/api/conditions/resolve');
  await page.locator('[data-conditions-action="validate"]').click();
  assert.equal((await resolved).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]')?.disabled);
  await page.locator('#start-consent').check(); await act('start').click();
  await page.locator('input[name="initial-choice"]').first().waitFor();
  assert.equal((await state()).initialConditions.agents.Bob.data.brief.topic, customTopic);
  await share('initial', 'free'); await share('additional', 'narrow');
  const pending = app.engine.approvals((await state()).session.id).find(approval => approval.status === 'pending');
  assert.equal(pending.values.topic, customTopic);
  await act('admin_review').click(); await page.locator('[data-approval-decision="allow_once"]').waitFor();
  assert.equal(await page.locator('#admin-pin').count(), 0);
  assert.equal(await page.locator('#admin-login-form').count(), 0);
  await page.locator('input[name="approval-field"][value="agenda"]').uncheck();
  await page.keyboard.press('Escape'); await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  await act('admin_review').click(); await page.locator('[data-approval-decision="allow_once"]').waitFor();
  assert.equal(await page.locator('input[name="approval-field"][value="agenda"]').isChecked(), false);
  await page.screenshot({ path: resolve(artifacts, 'direct-approval-zh.png') });
  await page.locator('[data-approval-decision="allow_once"]').click(); await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual((await state()).receipts.bobToAlice.at(-1).values, { topic: customTopic });
  assert.equal((await state()).task.outcome, 'arranged');
  checked.push('Bob initial conditions edit and create directly; a complete real controlled round opens scoped approval without PIN, preserves the narrowed draft and delivers only the approved topic');

  await page.locator('[data-view="console"]').click();
  await page.locator('[data-console-action="pause"]').waitFor();
  await page.locator('[data-console-action="pause"]').click();
  await page.locator('[data-console-action="resume"]').waitFor();
  assert.equal((await state()).session.paused, true);
  await page.locator('[data-console-action="resume"]').click();
  await page.locator('[data-console-action="pause"]').waitFor();
  assert.equal((await state()).session.paused, false);
  await page.locator('[data-view="participant"]').click();
  await act('end').click(); await page.locator('#end-confirm').click(); await act('fresh').waitFor();
  await page.locator('[data-view="research"]').click(); await page.locator('[data-research-run]').first().waitFor();
  assert.equal((await direct('/api/admin/research')).runs.length, 1);
  await page.locator('[data-trace-latest]').click();
  await reveal(page.locator('[data-research-action="jsonl"]'));
  const download = page.waitForEvent('download'); await page.locator('[data-research-action="jsonl"]').click();
  assert.equal(await (await download).failure(), null);
  await page.screenshot({ path: resolve(artifacts, 'direct-research-zh.png'), fullPage: true });
  checked.push('Operator pause/resume and the ended consented round’s timeline/export are available directly');

  const stored = await credentials();
  await page.reload(); await act('fresh').waitFor(); await controlsVisible();
  assert.deepEqual(await credentials(), stored);
  await page.locator('[data-view="research"]').click(); await page.locator('[data-research-run]').first().waitFor();
  await page.route('**/api/meta', route => route.abort('failed'), { times: 1 });
  await page.reload(); await page.locator('#retry-boot').waitFor();
  await page.locator('#retry-boot').click(); await act('fresh').waitFor(); await controlsVisible();
  assert.deepEqual(await credentials(), stored);
  for (const width of [320, 736, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en'); await controlsVisible();
  assert.deepEqual(loginRequests, []); assert.deepEqual(errors, []);
  checked.push('Refresh and explicit reconnect automatically restore direct controls and the same participant round; both languages and 320/736/1280px need zero login requests');
  await rm(resolve(artifacts, 'failure.png'), { force: true });
  await writeFile(resolve(artifacts, 'open-controls-browser-report.json'), JSON.stringify({ checked, loginRequests, errors, artifacts }, null, 2));
  console.log(JSON.stringify({ checked, loginRequests, errors, artifacts }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ checked, loginRequests, errors }, null, 2)); throw error;
} finally { await browser.close(); await app.close(); }
