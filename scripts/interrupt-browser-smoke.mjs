import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createDemoServer } from '../src/server.mjs';

let playwright;
try { playwright = await import('playwright'); }
catch { const require = createRequire(import.meta.url); try { playwright = require('playwright'); } catch (error) { if (!process.env.DEMO_PLAYWRIGHT_MODULE) throw error; playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE); } }
const pin = process.env.ADMIN_PIN; assert.ok(pin, 'Set ADMIN_PIN; no credentials are saved by this test.');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let heldSignal = deferred(); const held = [];
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body), context = JSON.parse(input.messages[1].content);
  if (context.ownCalendar) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ message: 'Synthetic Alice is ready.' }) } }] }));
  } else {
    held.push(response); heldSignal.resolve(); // Bob planning never finishes until deliberately released.
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const app = await createDemoServer({ host: '127.0.0.1', port: 0, persist: false, adminPin: pin, modelBaseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', modelName: 'local-held-model', modelApiKey: '' });
const address = await app.listen();
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1024, height: 900 } }); page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const action = name => page.locator('[data-participant-action="' + name + '"]').first();
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const pending = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.pending')));
const passed = [];
try {
  await page.goto('http://127.0.0.1:' + address.port);
  for (const mode of ['end', 'stop_sharing', 'end_unknown']) {
    const interrupt = mode === 'stop_sharing' ? mode : 'end';
    heldSignal = deferred();
    if (await action('fresh').isVisible()) await action('fresh').click();
    await page.locator('input[name="start-mode"][value="live"]').check();
    await action('start').click(); await page.locator('input[name="initial-choice"][value="free"]').check();
    const auth = await credentials();
    await action('preview').click(); await action('confirm').waitFor();
    const releaseOriginal = deferred(), originalArrived = deferred(), safetyArrived = deferred(), releaseSafety = deferred();
    let stale, originalBody, safetyBody, confirmed, safetyRequests = 0;
    await page.route('**/api/sessions/*/actions', async route => {
      const body = route.request().postDataJSON();
      if (body.action === 'share_initial') {
        originalBody = body; await route.fetch(); await releaseOriginal.promise;
        // Reproduce an old successful HTTP snapshot arriving after interruption.
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: stale }) }); originalArrived.resolve();
      } else if (body.action === interrupt) {
        safetyRequests++; safetyBody ??= body;
        const response = await route.fetch(); confirmed = (await response.json()).state; safetyArrived.resolve();
        if (mode === 'end_unknown' && safetyRequests === 1) await route.abort('failed');
        else { await releaseSafety.promise; await route.fulfill({ response }); }
      } else await route.continue();
    });
    await action('confirm').click();
    await heldSignal.promise;
    stale = app.engine.view(app.engine.get(auth.id));
    assert.equal(stale.receipts.aliceToBob.length, 1); assert.equal(stale.receipts.aliceToBob[0].status, 'received');
    assert.equal((await pending()).requestId, originalBody.requestId);
    assert.equal(await page.locator('input[name="initial-choice"]').first().isDisabled(), true);
    assert.equal(await action('preview').isDisabled(), true);
    assert.equal(await action('end').isDisabled(), false);
    assert.equal(await action('stop_sharing').isDisabled(), false);
    const started = performance.now();
    if (interrupt === 'end') { await action('end').click(); await page.locator('#end-confirm').click(); }
    else await action('stop_sharing').click();
    await Promise.race([safetyArrived.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Interruption waited for the held model.')), 3000))]);
    assert.ok(performance.now() - started < 3000);
    assert.equal(confirmed.alice.stopped, true);
    if (interrupt === 'end') assert.equal(confirmed.session.ended, true);
    assert.deepEqual(confirmed.receipts.aliceToBob, stale.receipts.aliceToBob);
    const outstanding = await pending();
    assert.equal(outstanding.body.action, interrupt); assert.deepEqual(outstanding.prior.body, originalBody);
    assert.equal(await action('fresh').count(), 0, 'No new round before the restriction response is confirmed.');
    if (mode === 'end_unknown') {
      await page.waitForFunction(() => !document.querySelector('[data-participant-action="verify_pending"]').disabled);
      const retained = await pending(); assert.deepEqual(retained.body, safetyBody);
      releaseSafety.resolve(); await action('verify_pending').click();
    } else {
      await action('refresh').click();
      if (interrupt === 'end') await page.locator('h2').filter({ hasText: 'Waiting for End confirmation' }).waitFor();
      assert.equal(await page.locator('#end-confirm').isDisabled(), true);
      releaseSafety.resolve();
    }
    await page.waitForFunction(() => sessionStorage.getItem('agent-on-request.pending') === null);
    if (interrupt === 'end') await action('fresh').waitFor();
    else await page.waitForFunction(() => document.querySelector('#participant-view').textContent.includes('Future Alice sharing is stopped.'));
    const late = page.waitForResponse(value => value.request().method() === 'POST' && value.request().postDataJSON()?.action === 'share_initial');
    releaseOriginal.resolve(); await originalArrived.promise; await late;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (interrupt === 'end') { assert.equal(await action('fresh').isVisible(), true); assert.equal(await page.locator('input[name="initial-choice"]').count(), 0); }
    else { assert.match(await page.locator('#participant-view').textContent(), /Future Alice sharing is stopped\./); assert.equal(await page.locator('input[name="initial-choice"]:enabled,input[name="additional-choice"]:enabled').count(), 0); }
    assert.equal(await pending(), null);
    // A stale GET does not carry a request callback generation. This separately
    // verifies version monotonicity for the normal background refresh path.
    await page.route('**/api/sessions/' + auth.id, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) }), { times: 1 });
    await page.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === '/api/sessions/' + auth.id);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (interrupt === 'end') assert.equal(await action('fresh').isVisible(), true);
    else assert.match(await page.locator('#participant-view').textContent(), /Future Alice sharing is stopped\./);
    // Releasing the provider's original late proposal cannot add any new effect.
    const heldResponse = held.at(-1);
    if (!heldResponse.destroyed) { heldResponse.writeHead(200, { 'Content-Type': 'application/json' }); heldResponse.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: 'Late Bob proposal.', action: { type: 'request_more' } }) } }] })); }
    const final = app.engine.view(app.engine.get(auth.id)); assert.equal(final.alice.stopped, true); assert.deepEqual(final.receipts.aliceToBob, stale.receipts.aliceToBob); assert.equal(final.receipts.bobToAlice.length, 0);
    assert.equal(safetyRequests, mode === 'end_unknown' ? 2 : 1);
    await page.unroute('**/api/sessions/*/actions');
    if (interrupt === 'stop_sharing') { await action('end').click(); await page.locator('#end-confirm').click(); await action('fresh').waitFor(); }
    passed.push(mode + ': immediate restriction, original ID retained, actual receipt preserved, stale response cannot revive UI');
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed, pageErrors: errors, externalProviderCalls: 0, service: 'Disposed non-persistent QA copy; port 4317 untouched.' }, null, 2));
} finally { await browser.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await app.close(); }
