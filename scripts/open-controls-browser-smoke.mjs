import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { createAgentCommDirect } from '../src/agent-comm-direct.mjs';
import { reveal } from './disclosure-helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/open-controls-browser');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const errors = [], checked = [];

async function localApp(options, run) {
  const app = await createDemoServer({ host: '127.0.0.1', port: 0, persist: false, minimaxApiKey: '', ...options });
  try {
    const address = await app.listen();
    await run(app, 'http://127.0.0.1:' + address.port);
  } finally { await app.close(); }
}

async function newPage(locale) {
  const page = await browser.newPage({ locale, viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  return page;
}

const action = (page, name) => page.locator('[data-participant-action="' + name + '"]').first();
const consoleAction = (page, name) => page.locator('[data-console-action="' + name + '"]');
const step = (page, name) => page.locator('[data-audience-step="' + name + '"]');
const response = (page, path, method = 'POST') => page.waitForResponse(res =>
  new URL(res.url()).pathname === path && res.request().method() === method);
const credentials = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));

async function checkMobile(page) {
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function share(page, stage, choice) {
  const { id } = await credentials(page);
  await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
  await action(page, 'preview').click();
  const confirmed = response(page, '/api/sessions/' + id + '/actions');
  await action(page, 'confirm').click();
  assert.equal((await confirmed).status(), 200);
}

async function editAgent(page, role) {
  const roleButton = page.locator('[data-conditions-role="' + role + '"]');
  await reveal(roleButton);
  await roleButton.click();

  const label = page.locator('[data-conditions-row-path="kg.nodes"][data-key="label"][data-owner="' + role + '"]').first();
  await reveal(label);
  await label.fill(role + ' smoke test concept');
  await label.press('Tab');

  const skill = page.locator('[data-conditions-disclosure="add-skill-' + role + '"]');
  await reveal(skill);
  await skill.locator(':scope > summary').click();
  await skill.locator('[data-conditions-extension-input="skillId"]').fill(role.toLowerCase() + '_smoke_skill');
  await skill.locator('[data-conditions-extension-input="skillLabel"]').fill(role + ' smoke test skill');
  await skill.locator('[data-conditions-extension-input="skillDescription"]').fill('Synthetic planning guidance.');
  await skill.locator('[data-conditions-action="add-skill"]').click();
}

try {
  const bridge = process.env.DEMO_TEST_AGENT_COMM_DIRECT;
  const transport = bridge ? createAgentCommDirect({ command: resolve(bridge) }) : undefined;
  await localApp({ openControls: true, peerTransport: transport }, async (app, url) => {
    const audience = await newPage('zh-CN');
    const operator = await newPage('en-US');
    const loginRequests = [], audienceAdminRequests = [];
    audience.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/admin/')) audienceAdminRequests.push(path);
    });
    for (const page of [audience, operator]) page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/admin/login') loginRequests.push(req.method());
    });
    try {
      await audience.goto(url);
      await step(audience, 'intro').waitFor();
      assert.equal(await audience.locator('[data-platform-url]').innerText(), 'https://agent-collaboration-platform.example');
      assert.equal(await audience.locator('#console-view, #admin-open, #conditions-view').count(), 0);
      await checkMobile(audience);
      await audience.screenshot({ path: resolve(artifacts, 'audience-intro.png'), fullPage: true });

      await operator.goto(url + '/console');
      for (const view of ['console', 'conditions', 'config', 'models', 'research']) {
        await operator.locator('[data-view="' + view + '"]').waitFor();
      }
      assert.equal(await operator.locator('#participant-view').count(), 0);
      assert.equal(await operator.locator('#admin-open').isVisible(), false);
      for (const role of ['Alice', 'Bob']) {
        const card = operator.locator('[data-agent-comm="' + role + '"]');
        await card.getByText('Agent available', { exact: true }).waitFor();
        if (transport) {
          await card.getByText('Listening', { exact: true }).waitFor();
          assert.equal(await card.locator('code').innerText(), transport.status().addresses[role]);
        } else await card.getByText('Inactive in this runtime', { exact: true }).waitFor();
      }
      await checkMobile(operator);
      await operator.screenshot({ path: resolve(artifacts, 'console.png'), fullPage: true });
      checked.push('Separate audience and console URLs, architecture placeholder URL, mobile layout and both ' + (transport ? 'native Agent Comm TCP listeners.' : 'IPC transport statuses.'));

      await consoleAction(operator, 'conditions').click();
      await editAgent(operator, 'Alice');
      await editAgent(operator, 'Bob');
      const validated = response(operator, '/api/conditions/resolve');
      await operator.locator('[data-conditions-action="validate"]').click();
      assert.equal((await validated).status(), 200);
      const saved = response(operator, '/api/admin/conditions/default', 'PUT');
      await operator.locator('[data-conditions-action="save-default"]').click();
      assert.equal((await saved).status(), 200);
      await operator.locator('[data-view="console"]').click();

      await action(audience, 'start').click();
      await step(audience, 'collaboration').waitFor();
      await audience.locator('[data-audience-observation]').waitFor();
      await checkMobile(audience);
      assert.equal(await audience.locator('[data-participant-action="perspective"]').count(), 0);
      const { id } = await credentials(audience);
      const round = () => app.engine.view(app.engine.get(id));
      for (const role of ['Alice', 'Bob']) {
        assert.equal(round().initialConditions.agents[role].kg.nodes[0].label, role + ' smoke test concept');
        assert.ok(round().initialConditions.agents[role].skills.includes(role.toLowerCase() + '_smoke_skill'));
      }
      checked.push('The operator edits and saves both KGs and custom skills, and a separate audience tab starts with the saved defaults.');

      await action(audience, 'alignment_accept').click();
      await share(audience, 'initial', 'free');
      await share(audience, 'additional', 'narrow');
      assert.equal(round().session.stage, 'waiting_admin');
      assert.equal(await action(audience, 'admin_review').count(), 0);
      await consoleAction(operator, 'refresh').click();
      await consoleAction(operator, 'approvals').click();
      await operator.locator('input[name="approval-field"][value="agenda"]').uncheck();
      const approval = round().pendingApprovals[0];
      const approved = response(operator, '/api/admin/approvals/' + approval.id + '/decision');
      await operator.locator('[data-approval-decision="allow_once"]').click();
      assert.equal((await approved).status(), 200);
      assert.deepEqual(Object.keys(round().receipts.bobToAlice.at(-1).values), ['topic']);

      await audience.bringToFront();
      await step(audience, 'summary').waitFor();
      await audience.locator('[data-outcome]').waitFor();
      assert.match(await audience.locator('[data-outcome]').innerText(), /15:00/);
      const trace = audience.locator('[data-audience-trace]');
      await trace.locator(':scope > summary').click();
      await trace.locator('[data-from="Bob"]').first().waitFor();
      assert.equal(await trace.locator('.receipt').count(), 4);
      for (const direction of ['Alice → Bob', 'Bob → Alice']) {
        await reveal(trace.locator('[data-protocol-move]').filter({ hasText: direction }).first());
      }
      await checkMobile(audience);
      await audience.screenshot({ path: resolve(artifacts, 'audience-summary.png'), fullPage: true });
      const stored = await credentials(audience);
      await audience.reload();
      await step(audience, 'summary').waitFor();
      assert.deepEqual(await credentials(audience), stored);
      await action(audience, 'end').click();
      await audience.locator('#end-confirm').click();
      await action(audience, 'fresh').click();
      await step(audience, 'intro').waitFor();
      assert.deepEqual(loginRequests, []);
      assert.deepEqual(audienceAdminRequests, []);
      checked.push('Separate operator approval narrows actual delivery to the topic, advances the audience to the result and trace, and survives audience reload.');
    } catch (error) {
      await Promise.allSettled([audience.screenshot({ path: resolve(artifacts, 'audience-failure.png'), fullPage: true }),
        operator.screenshot({ path: resolve(artifacts, 'console-failure.png'), fullPage: true })]);
      throw error;
    } finally { await audience.close(); await operator.close(); }
  });

  const adminPin = 'separate-operator-fixture';
  const addresses = { Alice: '/ip4/127.0.0.1/tcp/7653', Bob: '/ip4/127.0.0.1/tcp/7654' };
  let bridgeOnline = true;
  const peerTransport = { start() {}, close() {}, status: () => ({ online: bridgeOnline, addresses }) };
  await localApp({ adminPin, peerTransport }, async (_app, url) => {
    const page = await newPage('en-US');
    try {
      await page.goto(url + '/console');
      assert.equal((await page.request.get(url + '/api/admin/runtime')).status(), 401);
      await page.locator('#admin-open').click();
      await page.locator('#admin-pin').fill(adminPin);
      await page.locator('#admin-login-form button[type="submit"]').click();
      await consoleAction(page, 'conditions').waitFor();
      for (const role of ['Alice', 'Bob']) {
        const card = page.locator('[data-agent-comm="' + role + '"]');
        await card.getByText('Listening', { exact: true }).waitFor();
        assert.equal(await card.locator('code').innerText(), addresses[role]);
      }
      bridgeOnline = false;
      await consoleAction(page, 'refresh').click();
      await page.locator('[data-agent-comm="Alice"]').getByText('Offline', { exact: true }).waitFor();
      await page.locator('[data-agent-comm="Bob"]').getByText('Offline', { exact: true }).waitFor();
      await page.reload();
      await page.locator('#admin-open').waitFor();
      assert.equal(await page.locator('[data-view="conditions"]').isVisible(), false);
      checked.push('Event-mode console requires the PIN, reflects both listening and offline states from a direct transport fixture, and clears the in-memory login on reload.');
    } finally { await page.close(); }
  });
  assert.deepEqual(errors, []);
  const report = JSON.stringify({ checked, errors, artifacts }, null, 2);
  await writeFile(resolve(artifacts, 'open-controls-browser-report.json'), report);
  console.log(report);
} catch (error) {
  console.error(JSON.stringify({ checked, errors, artifacts }, null, 2));
  throw error;
} finally { await browser.close(); }
