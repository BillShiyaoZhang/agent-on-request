import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Optional QA dependency: install Playwright locally, expose it through NODE_PATH,
// or set DEMO_PLAYWRIGHT_MODULE to a runtime-provided module path. No app dependency.
let playwright;
try { playwright = await import('playwright'); }
catch {
  const require = createRequire(import.meta.url);
  try { playwright = require('playwright'); }
  catch (error) {
    if (!process.env.DEMO_PLAYWRIGHT_MODULE) throw error;
    playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE);
  }
}
const pin = process.env.ADMIN_PIN;
assert.ok(pin, 'Set ADMIN_PIN; the smoke test never saves credentials.');
// Without an explicit QA URL, use a disposable app and never alter the event service.
let isolatedApp, url = process.env.DEMO_URL;
if (!url) {
  const { createDemoServer } = await import('../src/server.mjs');
  isolatedApp = await createDemoServer({ host: '127.0.0.1', port: 0, adminPin: pin, persist: false, minimaxApiKey: '' });
  const address = await isolatedApp.listen(); url = 'http://127.0.0.1:' + address.port;
}
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts');
await mkdir(artifacts, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
page.setDefaultTimeout(12000);
const errors = [], expectedNetworkErrors = [], checked = [];
let expectedAbort = false, adminToken;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') (expectedAbort ? expectedNetworkErrors : errors).push(message.text());
});
const act = name => page.locator('[data-participant-action="' + name + '"]').first();
const configAction = name => page.locator('[data-config-action="' + name + '"]');
const response = (path, method = 'POST') => page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method);
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const state = async () => {
  const value = await credentials();
  return page.evaluate(async ({ id, token }) => (await fetch('/api/sessions/' + id, { headers: { Authorization: 'Bearer ' + token } })).json(), value);
};
const admin = (path, body) => page.evaluate(async ({ path, body, token }) => {
  const result = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!result.ok) throw new Error('Admin QA request failed ' + result.status + ' ' + path);
  return result.json();
}, { path, body, token: adminToken });
async function start(consent = false) {
  if (await act('fresh').isVisible()) await act('fresh').click();
  await page.locator('#start-consent').waitFor();
  assert.equal(await page.locator('#start-consent').isChecked(), false);
  if (consent) await page.locator('#start-consent').check();
  await act('start').click();
  await page.locator('input[name="initial-choice"]').first().waitFor();
}
async function preview(stage, choice) {
  await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
  const received = response('/api/sessions/' + (await credentials()).id + '/preview');
  await act('preview').click();
  const value = await (await received).json();
  await act('confirm').waitFor();
  assert.equal(await page.locator('.preview-box .tag').textContent(), 'Not yet sent');
  return value;
}
async function confirm() {
  const received = response('/api/sessions/' + (await credentials()).id + '/actions');
  await act('confirm').click();
  const value = await (await received).json();
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="confirm"]'));
  return value.state;
}
async function end() {
  await act('end').click(); await page.locator('#end-confirm').click();
  await act('fresh').waitFor();
}
async function login(approval = false) {
  if (approval) await act('admin_review').click(); else await page.locator('#admin-open').click();
  if (await page.locator('#admin-pin').isVisible()) {
    await page.locator('#admin-pin').fill(pin);
    const received = response('/api/admin/login');
    await page.locator('#admin-login-form button[type="submit"]').click();
    adminToken = (await (await received).json()).token;
  }
  if (!approval) await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
}
async function nav(view) {
  await page.locator('[data-view="' + view + '"]').click();
  await page.locator('#' + view + '-view').waitFor();
  if (view === 'config') await page.locator('[data-config-path="persona"]').waitFor();
  if (view === 'models') await page.locator('[data-model-path="agents.Alice.model"]').waitFor();
  if (view === 'research') await page.locator('.summary-item').first().waitFor();
  if (view === 'console') await page.locator('[data-console-action="reset"]').waitFor();
}
async function setJson(value) {
  await page.locator('summary').filter({ hasText: 'All configuration · JSON' }).click();
  await page.locator('[data-config-json]').fill(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  await configAction('parse-json').click();
}
async function applyConfig() {
  const validated = response('/api/admin/config/validate'); await configAction('validate').click();
  assert.equal((await (await validated).json()).valid, true);
  await page.waitForFunction(() => !document.querySelector('[data-config-action="apply"]').disabled);
  const applied = response('/api/admin/config/apply'); await configAction('apply').click();
  const value = await (await applied).json();
  await page.waitForFunction(() => !document.querySelector('[data-config-action="validate"]').disabled);
  return value;
}
try {
  await page.goto(url); await start();
  const exact = await preview('initial', 'free');
  await page.screenshot({ path: resolve(artifacts, 'participant.png'), fullPage: true });
  // The server processes this request; its response is deliberately lost.
  let intercepted;
  expectedAbort = true;
  await page.route('**/api/sessions/*/actions', async route => {
    intercepted = route.request().postDataJSON();
    await route.fetch(); await route.abort('failed');
    await page.unroute('**/api/sessions/*/actions');
  }, { times: 1 });
  await act('confirm').click(); await act('verify_pending').waitFor();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.pending')));
  assert.deepEqual(saved.body, intercepted);
  const beforeReload = await credentials();
  await page.reload(); await act('verify_pending').waitFor();
  assert.deepEqual(await credentials(), beforeReload);
  expectedAbort = false;
  const retried = response('/api/sessions/' + beforeReload.id + '/actions');
  await act('verify_pending').click();
  const retryResponse = await retried;
  assert.deepEqual(retryResponse.request().postDataJSON(), intercepted);
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="verify_pending"]'));
  let actual = await state();
  assert.equal(actual.receipts.aliceToBob.length, 1);
  for (const key of ['rows', 'fields', 'window']) assert.deepEqual(actual.receipts.aliceToBob[0][key], exact[key]);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  checked.push('Lost response: same session / request / intent, one exact received snapshot');
  await end(); await start(true);
  await preview('initial', 'busy'); await confirm();
  await preview('additional', 'narrow'); await confirm();
  await act('admin_review').waitFor(); await login(true);
  await page.locator('[data-approval-decision="allow_once"]').first().waitFor();
  const waiting = await state();
  await page.keyboard.press('Escape');
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual((await state()).pendingApprovals, waiting.pendingApprovals);
  await act('admin_review').click();
  await page.locator('[data-approval-decision="allow_once"]').first().waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(artifacts, 'authorization.png') });
  await page.locator('[data-approval-decision="deny"]').first().click();
  await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
  actual = await state(); assert.equal(actual.task.outcome, 'arranged');
  for (const [name, value, action] of [['prediction', 'approved_snapshot', 'answer_prediction'], ['revocation', 'future_only', 'answer_revocation']]) {
    await page.locator('input[name="' + name + '-answer"][value="' + value + '"]').check();
    const received = response('/api/sessions/' + actual.session.id + '/actions'); await act(action).click(); await received;
    await page.waitForFunction(action => document.querySelector('[data-participant-action="' + action + '"]').textContent.includes('received'), action);
  }
  const receiptBeforeStop = (await state()).receipts;
  const stopped = response('/api/sessions/' + actual.session.id + '/actions'); await act('stop_sharing').click(); await stopped;
  assert.deepEqual((await state()).receipts, receiptBeforeStop);
  await end(); await nav('research');
  const recorded = await admin('/api/admin/research');
  assert.ok(recorded.summary.taskCompleted >= 1); assert.ok(recorded.summary.completed >= 1);
  for (const format of ['csv', 'jsonl']) {
    const download = page.waitForEvent('download'); await page.locator('[data-research-action="' + format + '"]').click();
    const item = await download; assert.equal(await item.failure(), null);
  }
  await page.locator('[data-research-filter="mode"]').selectOption('controlled');
  assert.equal(await page.locator('.research-table tbody tr').count(), recorded.runs.filter(run => run.mode === 'controlled').length);
  checked.push('Consented real research: optional answers, stop, end, filter, CSV and JSONL');
  await nav('participant'); await start(); await preview('initial', 'free'); await confirm();
  await nav('config');
  const configBefore = await admin('/api/admin/config?sessionId=' + (await credentials()).id);
  const baseline = configBefore.template;
  await setJson('{ invalid');
  assert.equal(await page.locator('[data-config-path="persona"]').isDisabled(), true);
  assert.match(await page.locator('[data-config-notice]').textContent(), /parse error/i);
  await configAction('discard-json').click();
  const changed = structuredClone(baseline); changed.extensions = { ...changed.extensions, browserSmoke: { retained: true } };
  await page.locator('[data-config-json]').fill(JSON.stringify(changed)); await configAction('parse-json').click();
  await page.locator('[data-config-path="persona"]').fill('Bob is a calm browser-smoke collaborator.');
  assert.equal(JSON.parse(await page.locator('[data-config-json]').inputValue()).extensions.browserSmoke.retained, true);
  await page.locator('[data-config-profile-name]').fill('browser-smoke');
  const profilesSaved = response('/api/admin/profiles'); await configAction('save-profile').click(); await profilesSaved;
  await page.waitForFunction(() => !document.querySelector('[data-config-action="load-profile"]').disabled);
  await page.locator('[data-config-profile]').selectOption('browser-smoke');
  await configAction('load-profile').click();
  const templateApplied = await applyConfig();
  assert.equal(templateApplied.activeRevision, configBefore.activeRevision);
  assert.equal(templateApplied.template.extensions.browserSmoke.retained, true);
  const receiptsBefore = (await state()).receipts;
  await page.locator('input[name="config-target"][value="session"]').check();
  await page.locator('[data-config-path="persona"]').fill('Bob is temporarily configured for this round only.');
  const temporary = await applyConfig(); assert.equal(temporary.state.session.paused, true);
  assert.deepEqual(temporary.state.receipts, receiptsBefore);
  assert.equal(temporary.state.choices.additional, null);
  await nav('console'); await page.locator('[data-console-action="resume"]').click();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-console-action="pause"]')));
  const oldCredentials = await credentials();
  const resetReceived = response('/api/admin/sessions/' + oldCredentials.id + '/intervene');
  await page.locator('[data-console-action="reset"]').click();
  const reset = await (await resetReceived).json();
  assert.notEqual(reset.state.session.id, oldCredentials.id);
  assert.equal(reset.state.session.researchConsent, false);
  assert.equal(reset.state.bob.configRevision, templateApplied.templateRevision);
  assert.equal(reset.state.receipts.aliceToBob.length, 0);
  await page.waitForFunction(id => JSON.parse(sessionStorage.getItem('agent-on-request.session')).id !== id, oldCredentials.id);
  await nav('config'); await setJson(baseline); await applyConfig();
  assert.ok((await admin('/api/admin/config/versions')).versions.length >= 3);
  await page.screenshot({ path: resolve(artifacts, 'bob-config.png'), fullPage: true });
  checked.push('JSON validation / unknown keys / profile / template vs temporary revision / reset / archive');
  await nav('participant'); await preview('initial', 'free'); await confirm();
  await preview('additional', 'narrow'); await confirm();
  // Exercise every actual panel at all required sizes, with both opaque themes.
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [320, 736, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['participant', 'console', 'config', 'models', 'research']) {
        await nav(view);
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
        assert.ok(dimensions.scroll <= dimensions.width + 1, theme + '/' + width + '/' + view + ' overflow: ' + JSON.stringify(dimensions));
        if (view === 'participant') {
          await act('admin_review').click();
          await page.locator('[data-approval-decision="allow_once"]').first().waitFor();
          const dialog = await page.locator('#admin-dialog').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
          assert.ok(dialog.scroll <= dialog.width + 1, theme + '/' + width + '/approval overflow');
          await page.locator('[data-approval-decision="allow_round"]').last().focus();
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog')?.id), 'admin-dialog');
          await page.keyboard.press('Escape'); await page.locator('#admin-dialog').waitFor({ state: 'hidden' });
          assert.ok((await state()).pendingApprovals.some(item => item.status === 'pending'));
        }
      }
    }
  }
  checked.push('Light + dark, five panels and approval dialog, 320 / 736 / 1024: no overflow; Tab trapped and Escape leaves pending');
  assert.deepEqual(errors, []);
  await nav('participant'); await end();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).sort()), ['agent-on-request.session']);
  console.log(JSON.stringify({ passed: checked, pageErrors: errors, expectedNetworkErrors: expectedNetworkErrors.length, artifacts, records: isolatedApp ? 'Disposable non-persistent QA service; records vanish when this service closes. Event service unchanged.' : 'QA records and browser-smoke profile remain in the explicitly selected service; clear before an event.' }, null, 2));
} finally { await browser.close(); await isolatedApp?.close(); }
