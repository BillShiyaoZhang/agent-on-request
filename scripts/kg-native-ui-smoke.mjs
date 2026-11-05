import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname));
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/kg-native-ui');
await mkdir(artifacts, { recursive: true });
const managementResponse = await fetch(new URL('/api/admin/native', base));
assert.equal(managementResponse.status, 200);
const management = await managementResponse.json();
assert.equal(management.enabled, true);
const errors = [], checked = [];
const browser = await chromium.launch({ headless: true,
  ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });

async function pageFor(url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  return page;
}

try {
  const operator = await pageFor(new URL('/console', base).href);
  await operator.getByRole('heading', { name: 'Native agent management', exact: true }).waitFor();
  assert.equal(await operator.getByRole('link', { name: 'Open KG workbench', exact: true }).count(), 2);
  assert.equal(await operator.getByRole('link', { name: 'Open Hermes management', exact: true }).count(), 2);
  await operator.screenshot({ path: resolve(artifacts, 'native-management.png'), fullPage: true });
  checked.push('The operator console opens both role-specific KG-plugin and Hermes management interfaces.');
  await operator.close();

  for (const role of ['Alice', 'Bob']) {
    const interfaces = management.agents[role];
    const graph = await pageFor(interfaces.kgUrl);
    await graph.getByText('已连接记忆服务', { exact: true }).waitFor();
    await graph.getByRole('heading', { name: '知识图谱工作区', exact: true }).waitFor();
    await graph.getByRole('button', { name: '探索', exact: true }).click();
    await graph.locator('[aria-label="交互知识图谱"]').waitFor();
    await graph.locator('.graph-node-shape').first().waitFor();
    assert.equal(new URL(graph.url()).hash.includes('token='), false, 'The native workbench consumes its fragment token.');
    await graph.screenshot({ path: resolve(artifacts, role.toLowerCase() + '-native-kg.png'), fullPage: true });
    checked.push(role + ' native KG-plugin authenticates and renders its interactive knowledge graph.');
    await graph.close();

    const hermes = await pageFor(new URL('/skills', interfaces.hermesUrl).href);
    await hermes.getByRole('heading', { name: /Skills/i }).first().waitFor();
    const skill = role === 'Alice' ? /send_scoped_snapshot|Send an approved snapshot/i : /send_scoped_reply|Send a scoped reply/i;
    await hermes.getByText(skill).first().waitFor();
    await hermes.getByRole('textbox').first().fill(role === 'Alice' ? 'send_scoped_snapshot' : 'send_scoped_reply');
    await hermes.getByText(skill).first().waitFor();
    await hermes.screenshot({ path: resolve(artifacts, role.toLowerCase() + '-native-skills.png'), fullPage: true });
    await hermes.goto(new URL('/config', interfaces.hermesUrl).href);
    await hermes.getByRole('heading', { name: /Config|Settings/i }).first().waitFor();
    await hermes.screenshot({ path: resolve(artifacts, role.toLowerCase() + '-native-settings.png'), fullPage: true });
    checked.push(role + ' native Hermes skill management and configuration pages load with the seeded role capability.');
    await hermes.close();
  }
  assert.deepEqual(errors, []);
  const report = { checked, pageErrors: errors, externalProviderCalls: 0, artifacts };
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
