// Capture a fresh synthetic Guided run. No provider calls or existing demo data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from '../../src/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DEMO_PLAYWRIGHT_MODULE || '/Users/shiyaozhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = fileURLToPath(new URL('./assets/', import.meta.url));
await mkdir(out, { recursive: true });
const app = await createDemoServer({ host: '127.0.0.1', port: 0, openControls: true, persist: false,
  directory: '/private/tmp/agent-symposium-capture', minimaxApiKey: '', environmentApiKey: '' });
let browser;
try {
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 2, locale: 'en-GB', colorScheme: 'light' });
  const alice = await context.newPage();
  await alice.goto(base + '/research.html');
  await alice.locator('[data-action="create"]').click();
  await alice.locator('[data-type="schedule"]').waitFor();
  const owner = await alice.evaluate(() => JSON.parse(localStorage.getItem('research-alice-resume')));
  const root = `/api/research/workspaces/${owner.workspaceId}`;
  const api = async (route, token = owner.token, data) => {
    const res = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await res.json(); assert(res.ok, `${route}: ${value.error?.message}`); return value;
  };
  const bob = await context.newPage();
  await bob.goto(`${base}/research.html?workspace=${owner.workspaceId}&owner=Bob`);
  await bob.locator('#bob-access button').click();
  await bob.locator('[data-tab="authorization"]').waitFor();
  const bobOwner = await bob.evaluate(() => Object.keys(sessionStorage).filter(k => k.endsWith(':Bob')).map(k => JSON.parse(sessionStorage.getItem(k)))[0]);
  assert(bobOwner?.token);
  const refresh = async page => { await page.reload(); await page.locator('[data-type="schedule"]').waitFor(); };
  const shot = async (page, name, selector) => {
    const target = typeof selector === 'string' ? page.locator(selector).first() : selector || page;
    await target.screenshot({ path: out + name + '.png', ...(selector ? {} : { fullPage: true }) });
  };
  await shot(alice, '01-overview');
  await alice.locator('[data-type="schedule"]').click();
  await alice.locator('.research-conversation-status .tag.good').waitFor();
  let state = await api(root);
  assert.equal(state.tasks.at(-1).result.meeting.day, 'Thu');
  await alice.locator('details[data-detail^="conversation-result-"] > summary').click();
  await shot(alice, '02-schedule', 'details[data-detail^="conversation-result-"]');
  await alice.locator('[data-type="select_presentation"]').click();
  await alice.locator('.research-conversation-status .tag.good').waitFor();
  await alice.locator('details[data-detail^="conversation-result-"] > summary').click();
  await shot(alice, '03-mappings', 'details[data-detail^="conversation-result-"]');
  state = await api(root); assert.equal(state.tasks.at(-1).result.report.id, 'R3');
  const mapState = state.tasks.at(-1);
  await alice.locator('[data-type="prepare_discussion"]').click();
  await alice.locator('.research-approval').waitFor();
  for (const field of ['method', 'results', 'note']) {
    const checkbox = alice.locator(`.research-approval input[data-field="${field}"]`);
    if (await checkbox.count()) await checkbox.uncheck();
  }
  await shot(alice, '04-summary-only', '.research-approval');
  const allowResponse = alice.waitForResponse(res => res.request().method() === 'POST' && res.url().includes('/decisions/'));
  await alice.locator('.research-approval [data-action="allow"]').click();
  assert.equal((await allowResponse).status(), 200);
  await alice.getByRole('button', { name: 'Approve and continue booking', exact: true }).waitFor();
  await shot(alice, '06-booking', '.research-approval');
  await alice.getByRole('button', { name: 'Approve and continue booking', exact: true }).click();
  await alice.locator('.research-conversation-status .tag.good').waitFor();
  await alice.locator('details[data-detail^="conversation-result-"] > summary').click();
  await shot(alice, '07-result', '.research-result');
  await refresh(bob);
  const delivery = bob.getByText('Inspect delivered information and receipts', { exact: true });
  await delivery.click();
  const received = bob.locator('.research-evidence > section').filter({ has: bob.getByRole('heading', { name: 'Information I actually received', exact: true }) });
  const summary = received.locator('.research-record').filter({ hasText: 'research-brief' }).first();
  await shot(bob, '08-received-summary', summary);
  state = await api(root);
  assert.equal(state.tasks.at(-1).result.reservation.status, 'confirmed');
  const privateMessages = state.messages.filter(m => m.resourceId.includes('research-brief'));
  assert.equal(privateMessages.length, 1);
  for (const message of privateMessages) assert.deepEqual(Object.keys(message.payload), ['summary']);
  const proof = {
    mode: 'controlled', synthetic: true, tasks: state.tasks.map(t => ({ type: t.type, status: t.status, outcome: t.result?.outcome })),
    presentation: mapState.result.report.id, mappings: mapState.mappings.map(m => ({ source: m.source, target: m.target, relation: m.relation })),
    privateMaterialDeliveries: privateMessages.map(m => ({ from: m.from, to: m.to, fields: Object.keys(m.payload), receipt: m.receipt.status })),
    booking: state.tasks.at(-1).result.reservation.status,
  };
  await writeFile(out + 'capture-verification.json', JSON.stringify(proof, null, 2));
  await api(root + '/end', owner.token, {});
  console.log(JSON.stringify({ screenshots: 7, ...proof }, null, 2));
} finally { await browser?.close(); await app.close(); }
