import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:4327');
assert(['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/kg-native-skill-smoke');
await mkdir(artifacts, { recursive: true });
async function app(route, { body, token, expected = 200 } = {}) {
  const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert.equal(response.status, expected, route + ': ' + (value.error?.code || response.status));
  return value;
}
const management = await app('/api/admin/native');
assert.equal(management.enabled, true);
const dashboard = new URL(management.agents.Alice.hermesUrl);
assert(['127.0.0.1', '[::1]', 'localhost'].includes(dashboard.hostname));
const browser = await chromium.launch({ headless: true,
  ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
let sessionToken, original, round;
async function native(route, body) {
  const response = await fetch(new URL(route, dashboard), { method: body === undefined ? 'GET' : 'PUT', redirect: 'error',
    headers: { 'X-Hermes-Session-Token': sessionToken, Origin: dashboard.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'Native skill API ' + route);
  return response.json();
}
try {
  const page = await browser.newPage();
  await page.goto(new URL('/skills', dashboard).href);
  await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor();
  sessionToken = await page.evaluate(() => window.__HERMES_SESSION_TOKEN__);
  assert(sessionToken, 'The loopback dashboard supplies its native session identity.');
  const skill = (await native('/api/skills')).find(item => item.name === 'send_scoped_snapshot');
  assert(skill);
  original = skill.enabled;
  await native('/api/skills/toggle', { name: skill.name, enabled: false });
  assert.equal((await native('/api/skills')).find(item => item.name === skill.name).enabled, false);
  round = await app('/api/sessions', { body: { mode: 'controlled', researchConsent: false }, expected: 201 });
  assert.equal(round.state.initialConditions.agents.Alice.skills.includes(skill.name), false);
  const route = '/api/sessions/' + round.state.session.id;
  const preview = await app(route + '/preview', { token: round.token, body: { stage: 'initial', choice: 'free' } });
  const result = await app(route + '/actions', { token: round.token, expected: 403, body: {
    action: 'share_initial', choice: 'free', requestId: randomUUID(), expectedVersion: preview.sessionVersion, previewHash: preview.payloadHash,
  } });
  assert.equal(result.error.code, 'TOOL_DISABLED');
  await native('/api/skills/toggle', { name: skill.name, enabled: original });
  assert.equal((await native('/api/skills')).find(item => item.name === skill.name).enabled, original);
  original = undefined;
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ checked: [
    'The actual native Hermes skill toggle changes the next round’s enabled capability.',
    'The disabled native sending skill prevents confirmation with TOOL_DISABLED.',
    'The original native skill state is restored.',
  ], externalProviderCalls: 0 }, null, 2));
  console.log('Native Hermes skill toggle controls the real next-round send capability; original skill state restored.');
} finally {
  if (original !== undefined) await native('/api/skills/toggle', { name: 'send_scoped_snapshot', enabled: original });
  if (round) {
    const route = '/api/sessions/' + round.state.session.id;
    const state = await app(route, { token: round.token });
    await app(route + '/actions', { token: round.token, body: { action: 'end', requestId: randomUUID(), expectedVersion: state.session.version } });
  }
  await browser.close();
}
