import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { reveal } from './disclosure-helpers.mjs';

const require = createRequire(import.meta.url);
const playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
const pin = 'language-smoke-pin';
const app = await createDemoServer({ host: '127.0.0.1', port: 0, adminPin: pin, persist: false, minimaxApiKey: '' });
const address = await app.listen();
const artifacts = resolve('artifacts/language-browser');
await mkdir(artifacts, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [], mutations = [], checked = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
const act = name => page.locator('[data-participant-action="' + name + '"]').first();
const toggle = page.locator('#language-toggle');
const language = () => page.locator('html').getAttribute('lang');
const waitText = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const current = async () => {
  const credential = await credentials();
  return page.evaluate(async ({ id, token }) => (await fetch('/api/sessions/' + id, { headers: { Authorization: 'Bearer ' + token } })).json(), credential);
};
async function switchTo(expected) {
  const before = mutations.length;
  await toggle.click();
  await page.waitForFunction(expected => document.documentElement.lang === expected, expected);
  assert.equal(mutations.length, before, 'A language switch must never submit an action.');
}
async function preview(stage, choice) {
  await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
  await act('preview').click();
  await act('confirm').waitFor();
}
try {
  await page.goto('http://127.0.0.1:' + address.port);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]')?.disabled);
  assert.equal(await language(), 'zh-CN');
  await waitText('h1', '你的智能体');
  assert.equal(await toggle.textContent(), 'English');
  assert.equal(await toggle.getAttribute('aria-label'), '切换到英文');
  await page.screenshot({ path: resolve(artifacts, 'start-zh.png'), fullPage: true });
  await switchTo('en'); await waitText('h1', 'What may your agent share?');
  assert.equal(await toggle.textContent(), '中文');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]')?.disabled);
  assert.equal(await language(), 'en');
  checked.push('Browser preference, button accessibility, remembered choice and reload');

  await page.locator('#admin-open').click();
  await page.locator('#admin-pin').fill(pin);
  await switchTo('zh-CN');
  assert.equal(await page.locator('#admin-pin').inputValue(), pin);
  assert.equal(await page.locator('#admin-dialog').evaluate(node => node.open), true);
  await page.locator('#admin-login-form button[type="submit"]').click();
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  await page.locator('[data-view="models"]').click();
  const model = await reveal(page.locator('[data-model-path="agents.Alice.model"]'));
  assert.match(await page.locator('[data-model-diff] td[colspan]').textContent(), /[\u4e00-\u9fff]/);
  await model.fill('custom-bilingual-model');
  const key = await reveal(page.locator('[data-model-key]')); await key.fill('sk-cp-local-draft-only');
  const originalModel = await model.evaluate(node => { window.qaModelNode = node; return node.value; });
  await switchTo('en');
  assert.equal(await model.inputValue(), originalModel);
  assert.equal(await key.inputValue(), 'sk-cp-local-draft-only');
  assert.equal(await model.evaluate(node => node === window.qaModelNode), true);
  await waitText('#models-view h2', 'Model configuration');
  checked.push('Open login dialog, unsaved model draft and key survive switching without node replacement');

  await page.locator('[data-view="config"]').click();
  const raw = await reveal(page.locator('[data-config-json]'));
  const json = await raw.inputValue(); await raw.fill(json + ' ');
  await switchTo('zh-CN');
  assert.equal(await raw.inputValue(), json + ' ');
  assert.match(await page.locator('[data-config-diff] td[colspan]').textContent(), /[\u4e00-\u9fff]/);
  await waitText('#config-view h2', 'Bob 配置');
  checked.push('Unsubmitted JSON editor stays exact');

  await page.locator('[data-view="participant"]').click();
  // Implicit option values are kept as protocol enums in Chinese mode.
  const daySelect = await reveal(page.locator('select[data-conditions-row-path]').first());
  assert.ok((await daySelect.locator('option').evaluateAll(nodes => nodes.map(node => node.value))).every(value => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(value)));
  const beforeDay = await daySelect.inputValue();
  await switchTo('en'); assert.equal(await daySelect.inputValue(), beforeDay);
  checked.push('Translated calendar options retain canonical values');

  await page.locator('#start-consent').check();
  await act('start').click();
  await page.locator('input[name="initial-choice"]').first().waitFor();
  await preview('initial', 'free');
  const payload = await page.locator('.preview-box pre').textContent();
  const before = await current();
  await switchTo('zh-CN');
  assert.equal(await page.locator('input[name="initial-choice"][value="free"]').isChecked(), true);
  assert.equal(await page.locator('.preview-box pre').textContent(), payload);
  assert.deepEqual(await current(), before);
  await waitText('.preview-box .tag', '未发送');
  checked.push('Active round, radio choice, exact payload and server state survive switching');
  await act('confirm').click();
  await page.locator('input[name="additional-choice"]').first().waitFor();
  await preview('additional', 'narrow'); await act('confirm').click();
  await act('admin_review').waitFor();
  await act('admin_review').click();
  await page.locator('[data-approval-decision="allow_once"]').waitFor();
  const approvalValues = await page.locator('#admin-dialog-body .operator-exact-value').allTextContents();
  assert.ok(approvalValues.length > 0, 'Pending Bob values are readable without opening raw JSON.');
  await page.locator('input[name="approval-field"][value="agenda"]').uncheck();
  await switchTo('en');
  assert.equal(await page.locator('input[name="approval-field"][value="agenda"]').isChecked(), false);
  assert.deepEqual(await page.locator('#admin-dialog-body .operator-exact-value').allTextContents(), approvalValues);
  assert.equal(await page.locator('#admin-dialog').evaluate(node => node.open), true);
  await page.locator('[data-approval-decision="allow_once"]').click();
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  await waitText('#participant-view', 'Both agents confirmed');
  assert.equal((await current()).task.outcome, 'arranged');
  checked.push('Controlled sharing, Thursday match and narrowed Bob approval complete across languages');
  await act('end').click(); await switchTo('zh-CN');
  assert.equal(await page.locator('#end-dialog').evaluate(node => node.open), true);
  await page.locator('#end-confirm').click(); await act('fresh').waitFor();
  await page.locator('[data-view="research"]').click();
  await page.locator('[data-research-run]').first().waitFor();
  await page.locator('[data-research-run]').first().click();
  await page.locator('[data-trace-position]').waitFor();
  await waitText('#research-view h2', '研究');
  await switchTo('en'); await waitText('#research-view h2', 'Research review');
  checked.push('End confirmation and recorded research timeline work in both languages');

  await page.locator('[data-view="participant"]').click();
  for (const width of [320, 736, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const expected of ['en', 'zh-CN']) {
      if (await language() !== expected) await switchTo(expected);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal page overflow at ' + width + 'px / ' + expected);
      assert.equal(await toggle.isVisible(), true);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: resolve(artifacts, 'round-zh.png'), fullPage: true });
  checked.push('Language button and both layouts at 320, 736 and 1280 pixels');
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ checked, errors }, null, 2));
  console.log(JSON.stringify({ checked, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ checked, errors }, null, 2));
  throw error;
} finally { await browser.close(); await app.close(); }
