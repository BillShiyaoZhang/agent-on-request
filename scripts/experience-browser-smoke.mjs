import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDemoServer } from '../src/server.mjs';
import { renderUnderstandingHtml, renderAnswerComparisonHtml, UNDERSTANDING_QUESTIONS } from '../public/understanding.js';
import { renderParticipantHtml } from '../public/participant-ui.js';

// Pure rendering must not disclose which option is expected before confirmation.
const initialState = { session: { id: 'qa-render', mode: 'controlled', ended: false, researchConsent: true }, task: { outcome: 'boundary_kept' }, answers: {} };
assert.equal(renderUnderstandingHtml({ state: initialState }).includes('data-understanding-expected='), false);
assert.equal(renderUnderstandingHtml({ state: initialState }).includes('data-participant-action='), false, 'Selection submits directly without an initial submit button.');
assert.equal(renderUnderstandingHtml({ state: initialState, local: { prediction: 'outside_scope' } }).includes('data-understanding-expected='), false);
const interruptedPending = { sessionId: 'qa-render', body: { action: 'stop_sharing' }, prior: { sessionId: 'qa-render', body: { action: 'answer_prediction', answer: 'outside_scope' } } };
const interruptedHtml = renderUnderstandingHtml({ state: initialState, pending: interruptedPending });
assert.match(interruptedHtml, /name="prediction-answer" value="outside_scope" checked/);
assert.equal(interruptedHtml.includes('data-understanding-expected='), false);
assert.equal(renderUnderstandingHtml({ state: { ...initialState, task: { outcome: null } } }), '');
assert.equal(renderUnderstandingHtml({ state: { ...initialState, session: { ...initialState.session, mode: 'replay' }, answers: { received_scope: 'approved_snapshot' } } }), '');
assert.equal(renderUnderstandingHtml({ state: { ...initialState, session: { ...initialState.session, ended: true } } }), '');
const historicalEvents = [{ kind: 'prediction', questionId: 'received_scope', answer: 'outside_scope', correct: false }];
const originalEvents = JSON.stringify(historicalEvents);
assert.match(renderAnswerComparisonHtml(historicalEvents), /Entries outside the approved scope too/);
assert.match(renderAnswerComparisonHtml(historicalEvents), /Not answered\. Missing answers are not incorrect answers\./);
assert.match(renderAnswerComparisonHtml(historicalEvents), /data-understanding-recorded-correct="received_scope">No/);
assert.equal(JSON.stringify(historicalEvents), originalEvents);
assert.match(renderAnswerComparisonHtml([{ kind: 'prediction', questionId: 'received_scope', answer: 'approved_snapshot' }]), /Not recorded/);
assert.equal(UNDERSTANDING_QUESTIONS[0].expected, 'approved_snapshot');
const participantRender = state => renderParticipantHtml({ state, heading: 'QA', mode: state.session.mode });
const waitingBrief = participantRender({ session: { mode: 'controlled', stage: 'waiting_admin' }, task: {}, waiting: { reason: 'admin' }, pendingApprovals: [{ status: 'pending', resource: 'meeting_brief', summary: 'Optional brief' }], messages: [{ from: 'Bob', text: 'OLD wider request', kind: 'request' }], receipts: { bobToAlice: [{ status: 'received', fields: ['day', 'time', 'status'], values: { day: 'Thu', time: '15:00–15:30', status: 'Free' } }] } });
assert.match(waitingBrief, /Shared time confirmed/);
assert.match(waitingBrief, /15:00–15:30/);
assert.equal(waitingBrief.split('participant-inspection-stack')[0].includes('OLD wider request'), false, 'A pending brief replaces the old wider-calendar request in the main flow.');
const pausedProgress = participantRender({ session: { mode: 'controlled', stage: 'paused', paused: true }, choices: { initial: 'free' }, task: {} });
assert.match(pausedProgress, /<li class="current"><span>2<\/span><strong>Follow progress<\/strong>/);
assert.match(pausedProgress, /<li class=""><span>3<\/span><strong>See the result<\/strong>/);
assert.equal(participantRender({ session: { mode: 'replay', stage: 'replay' }, task: {} }).includes('class="experience-progress"'), false);
assert.equal((participantRender({ session: { mode: 'controlled', stage: 'ended', ended: true }, task: { outcome: 'ended' } }).match(/class="skipped"/g) || []).length, 2);

const require = createRequire(import.meta.url);
const playwright = require(process.env.DEMO_PLAYWRIGHT_MODULE || 'playwright');
const pin = 'experience-qa-' + randomUUID();
// Disposable memory-only agents; no provider key and no real model request.
const app = await createDemoServer({ host: '127.0.0.1', port: 0, adminPin: pin, persist: false, minimaxApiKey: '' });
const address = await app.listen();
const url = 'http://127.0.0.1:' + address.port;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.DEMO_BROWSER_EXECUTABLE ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
page.setDefaultTimeout(15000);
const errors = [], checked = [];
let expectedNetworkFailure = false;
const artifacts = resolve(process.env.DEMO_ARTIFACTS || 'artifacts/experience-understanding');
await mkdir(artifacts, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !/422|409/.test(message.text()) && !(expectedNetworkFailure && /ERR_FAILED|Failed to fetch|net::/.test(message.text()))) errors.push(message.text()); });
const act = action => page.locator('[data-participant-action="' + action + '"]').first();
const postResponse = path => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
const credentials = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.session')));
const state = async () => { const stored = await credentials(); const response = await page.request.get(url + '/api/sessions/' + stored.id, { headers: { Authorization: 'Bearer ' + stored.token } }); assert.equal(response.status(), 200); return response.json(); };
async function start(consent) {
  if (await act('fresh').isVisible()) await act('fresh').click();
  await page.locator('#start-consent').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="start"]').disabled);
  if (consent) await page.locator('#start-consent').check();
  await act('start').click(); await page.locator('input[name="initial-choice"]').first().waitFor();
}
async function finishWithNoSharing() {
  await page.locator('input[name="initial-choice"][value="none"]').check();
  const stored = await credentials();
  const preview = postResponse('/api/sessions/' + stored.id + '/preview'); await act('preview').click(); await preview;
  await page.waitForFunction(() => {
    const heading = document.querySelector('.preview-box h3');
    const bounds = heading?.getBoundingClientRect();
    return document.activeElement === heading && bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
  const sent = postResponse('/api/sessions/' + stored.id + '/actions'); await act('confirm').click(); await sent;
  await page.locator('input[name="prediction-answer"]').first().waitFor();
}
async function share(stage, choice) {
  await page.locator('input[name="' + stage + '-choice"][value="' + choice + '"]').check();
  await page.waitForFunction(({ stage, choice }) => document.activeElement?.name === stage + '-choice' && document.activeElement.value === choice, { stage, choice });
  const stored = await credentials();
  const preview = postResponse('/api/sessions/' + stored.id + '/preview'); await act('preview').click(); await preview;
  const sent = postResponse('/api/sessions/' + stored.id + '/actions'); await act('confirm').click(); assert.equal((await sent).status(), 200);
  await page.waitForFunction(() => {
    const heading = document.querySelector('.experience-heading h2');
    const bounds = heading?.getBoundingClientRect();
    return document.activeElement === heading && bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
}
async function assertCleanParticipant() {
  for (const id of ['participant-Alice', 'participant-Bob', 'participant-evidence']) assert.equal(await page.locator('[data-disclosure-id="' + id + '"]').getAttribute('open'), null, id + ' starts collapsed.');
  assert.equal(await page.locator('#participant-view pre:visible').count(), 0, 'Raw JSON is not in the main flow.');
  assert.equal(await page.locator('#participant-view .knowledge-svg:visible').count(), 0, 'Large knowledge graphs do not precede the choice.');
}
async function end() { await act('end').click(); await page.locator('#end-confirm').click(); await act('fresh').waitFor(); }
try {
  await page.goto(url); await start(true);
  assert.equal(await page.locator('input[name="prediction-answer"]').count(), 0, 'Questions appear only after a task outcome.');
  const initialCredentials = await credentials(), initial = await state();
  const premature = await page.request.post(url + '/api/sessions/' + initialCredentials.id + '/actions', { headers: { Authorization: 'Bearer ' + initialCredentials.token }, data: { action: 'answer_prediction', answer: 'approved_snapshot', expectedVersion: initial.session.version, requestId: randomUUID() } });
  assert.equal(premature.status(), 409); assert.equal((await premature.json()).error.code, 'ANSWER_STAGE');
  assert.deepEqual((await state()).answers, {});
  await assertCleanParticipant();
  await page.screenshot({ path: resolve(artifacts, 'participant-initial.png'), fullPage: true });
  const retainedCategory = await page.evaluate(async snapshot => {
    const { mountAgentStates } = await import('/agent-state.js');
    const fixture = document.createElement('div'); document.body.append(fixture);
    const options = { scope: 'qa-detached-toggle' }, states = { Alice: snapshot };
    mountAgentStates(fixture, states, options);
    const old = fixture.querySelector('[data-state-category="knowledge"]');
    old.open = true; old.dispatchEvent(new Event('toggle'));
    mountAgentStates(fixture, states, options);
    old.open = false; old.dispatchEvent(new Event('toggle'));
    const removedFixture = fixture; const replacement = document.createElement('div'); fixture.replaceWith(replacement);
    mountAgentStates(replacement, states, options);
    // Replacing the whole host also leaves old listeners attached to old nodes.
    const detached = removedFixture.querySelector('[data-state-category="knowledge"]');
    detached.open = false; detached.dispatchEvent(new Event('toggle'));
    mountAgentStates(replacement, states, options);
    const retained = replacement.querySelector('[data-state-category="knowledge"]').open;
    replacement.remove(); return retained;
  }, initial.agentStates.Alice);
  assert.equal(retainedCategory, true, 'Detached category events cannot overwrite the live disclosure state.');
  assert.equal(await page.locator('#participant-view .agent-section').count(), 8, 'All four real sections remain for each agent.');
  assert.equal(await page.locator('#participant-view .state-category[open]').count(), 0, 'Every internal state category starts collapsed.');
  const aliceInspection = page.locator('[data-disclosure-id="participant-Alice"]');
  await aliceInspection.locator(':scope > summary').click();
  assert.equal(await aliceInspection.locator('.state-category:visible').count(), 4);
  assert.equal(await aliceInspection.locator('[data-disclosure-id="participant-calendar"]').getAttribute('open'), null, 'The calendar stays an optional closed detail after the four categories.');
  assert.equal(await aliceInspection.locator('.calendar-table:visible').count(), 0, 'Opening Alice does not expand the calendar table.');
  assert.equal(await page.locator('#participant-view .knowledge-svg:visible').count(), 0, 'Opening Alice first shows four category cards.');
  assert.equal(await aliceInspection.locator('[data-state-category="knowledge"] .state-category-count').innerText(), String(initial.agentStates.Alice.kg.nodes.length));
  await page.screenshot({ path: resolve(artifacts, 'participant-alice-categories.png'), fullPage: true });
  await aliceInspection.locator('[data-state-category="knowledge"] > summary').click();
  assert.equal(await page.locator('#participant-view .knowledge-svg:visible').count(), 1);
  await aliceInspection.locator(':scope > summary').click();
  await share('initial', 'free'); await page.locator('input[name="additional-choice"]').first().waitFor();
  checked.push('Choosing a sharing option retains keyboard focus; a confirmed step change brings its heading into view and focuses it.');
  await assertCleanParticipant();
  assert.equal(await page.locator('[data-disclosure-id="participant-Alice"] [data-state-category="knowledge"]').evaluate(node => node.open), true, 'The selected category survives participant state rerendering.');
  checked.push('Each agent starts with four colored closed categories and a closed calendar; real counts and expansion survive rerenders; stale detached toggles are ignored.');
  await page.screenshot({ path: resolve(artifacts, 'participant-additional.png'), fullPage: true });
  await share('additional', 'keep'); await page.locator('input[name="prediction-answer"]').first().waitFor();
  await assertCleanParticipant();
  checked.push('Initial and additional choices precede optional Alice/Bob/evidence details; no visible raw JSON or large graphs. Direct pre-outcome API answers are rejected with ANSWER_STAGE.');
  assert.equal(await page.locator('[data-understanding-expected]').count(), 0);
  assert.equal(await page.locator('[data-participant-action="answer_prediction"], [data-participant-action="answer_revocation"]').count(), 0, 'Unanswered questions need only a selection.');
  const stored = await credentials(), actionPath = '/api/sessions/' + stored.id + '/actions';
  let releaseAnswer, captureAnswer;
  const answerGate = new Promise(resolve => { releaseAnswer = resolve; });
  const capturedAnswer = new Promise(resolve => { captureAnswer = resolve; });
  const gateRoute = async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'answer_prediction') { captureAnswer(body); await answerGate; }
    await route.continue();
  };
  await page.route('**' + actionPath, gateRoute);
  const confirmed = postResponse(actionPath);
  await page.locator('input[name="prediction-answer"][value="outside_scope"]').check();
  const firstSubmission = await capturedAnswer;
  assert.equal(firstSubmission.answer, 'outside_scope');
  assert.equal(await page.locator('input[name="prediction-answer"][value="approved_snapshot"]').isDisabled(), true);
  assert.equal(await page.locator('[data-understanding-feedback="received_scope"]').count(), 0, 'No explanation until the server confirms the original answer.');
  releaseAnswer(); assert.equal((await confirmed).status(), 200);
  await page.locator('[data-understanding-feedback="received_scope"]').waitFor();
  await page.unroute('**' + actionPath, gateRoute);
  assert.equal((await state()).answers.received_scope, 'outside_scope');
  assert.match(await page.locator('[data-understanding-original="received_scope"]').innerText(), /outside/);
  assert.match(await page.locator('[data-understanding-expected="received_scope"]').innerText(), /Only the approved snapshot/);
  const originalEvent = app.research.list().runs[0].events.find(event => event.questionId === 'received_scope');
  assert.equal(originalEvent.answer, 'outside_scope'); assert.equal(originalEvent.correct, false);
  // Repeating the exact request is idempotent; a later answer cannot replace it.
  const repeated = await page.request.post(url + actionPath, { headers: { Authorization: 'Bearer ' + stored.token }, data: firstSubmission });
  assert.equal(repeated.status(), 200);
  const latest = await state();
  const replacement = await page.request.post(url + actionPath, { headers: { Authorization: 'Bearer ' + stored.token }, data: { action: 'answer_prediction', answer: 'approved_snapshot', expectedVersion: latest.session.version, requestId: randomUUID() } });
  assert.equal(replacement.status(), 409);
  assert.equal(app.research.list().runs[0].events.filter(event => event.questionId === 'received_scope').length, 1);
  checked.push('First selection submits automatically; feedback waits for acknowledgment; original wrong answer is immutable and its request is idempotent.');

  let rejectOnce = true;
  const failRoute = async route => {
    if (route.request().postDataJSON().action === 'answer_revocation' && rejectOnce) { rejectOnce = false; await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA_REJECTED', message: 'QA definite rejection; retry the original answer.' } }) }); }
    else await route.continue();
  };
  await page.route('**' + actionPath, failRoute);
  const rejected = postResponse(actionPath);
  await page.locator('input[name="revocation-answer"][value="not_sure"]').check(); assert.equal((await rejected).status(), 422);
  await page.waitForFunction(() => { const button = document.querySelector('[data-participant-action="answer_revocation"]'); return button && !button.disabled; });
  assert.equal(await page.locator('input[name="revocation-answer"][value="future_only"]').isDisabled(), true);
  assert.equal(await page.locator('[data-understanding-feedback="withdrawal"]').count(), 0);
  const retried = postResponse(actionPath); await act('answer_revocation').click(); assert.equal((await retried).status(), 200);
  await page.locator('[data-understanding-feedback="withdrawal"]').waitFor();
  await page.unroute('**' + actionPath, failRoute);
  assert.equal((await state()).answers.withdrawal, 'not_sure');
  const unsureEvent = app.research.list().runs[0].events.find(event => event.questionId === 'withdrawal');
  assert.equal(unsureEvent.answer, 'not_sure'); assert.equal(unsureEvent.correct, false);
  checked.push('A rejected submission keeps the first answer locked; explicit retry submits the same not_sure value and shows a factual explanation.');

  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.match(await page.locator('[data-understanding-feedback="withdrawal"]').innerText(), /不确定/);
  assert.equal(await page.locator('input[name="prediction-answer"][value="outside_scope"]').isChecked(), true);
  await page.reload(); await page.locator('[data-understanding-feedback="received_scope"]').waitFor();
  assert.equal((await state()).session.id, stored.id);
  assert.equal(await page.locator('input[name="prediction-answer"][value="outside_scope"]').isChecked(), true);
  assert.equal(app.research.list().runs.length, 1);
  assert.equal(app.research.list().runs[0].events.filter(event => event.kind === 'prediction').length, 2);
  await page.locator('[data-disclosure-id="participant-Alice"] > summary').click();
  assert.equal(await page.locator('[data-disclosure-id="participant-Alice"] .state-category[open]').count(), 0, 'A fresh page load has a clean four-category default.');
  await page.locator('[data-disclosure-id="participant-Alice"] [data-state-category="knowledge"] > summary').click();
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Expanded knowledge graph stays within its mobile scrolling viewport.');
  await page.locator('[data-disclosure-id="participant-Alice"] > summary').click();
  for (const theme of ['light', 'dark']) for (const width of [320, 736, 1280]) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, theme + '/' + width + ' feedback overflow');
  }
  await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: resolve(artifacts, 'understanding-feedback.png'), fullPage: true });
  await end(); await page.locator('[data-understanding-feedback="received_scope"]').waitFor();
  assert.equal(await act('answer_prediction').count(), 0);
  assert.equal(await page.locator('[data-understanding-received="received_scope"]').count(), 1, 'Confirmed answers show a compact received state instead of a submission button.');
  checked.push('Chinese feedback, light/dark at 320/736/1280, refresh recovery and closed-round review preserve original choices and do not duplicate records.');

  await page.locator('#language-toggle').click(); await start(false); await finishWithNoSharing();
  const noConsent = await credentials();
  const noConsentPath = '/api/sessions/' + noConsent.id + '/actions';
  let unknownSubmission;
  expectedNetworkFailure = true;
  await page.route('**' + noConsentPath, async route => { unknownSubmission = route.request().postDataJSON(); await route.abort('failed'); }, { times: 1 });
  await page.locator('input[name="prediction-answer"][value="outside_scope"]').check();
  await act('verify_pending').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-participant-action="verify_pending"]').disabled);
  assert.equal(await page.locator('[data-understanding-feedback="received_scope"]').count(), 0);
  assert.equal(await page.locator('input[name="prediction-answer"][value="outside_scope"]').isChecked(), true);
  assert.equal(await page.locator('input[name="prediction-answer"][value="approved_snapshot"]').isDisabled(), true);
  assert.deepEqual((await state()).answers, {});
  await page.reload(); await act('verify_pending').waitFor();
  assert.equal(await page.locator('input[name="prediction-answer"][value="outside_scope"]').isChecked(), true, 'Unconfirmed original answer recovers from pending intent after refresh.');
  assert.equal(await page.locator('[data-understanding-expected="received_scope"]').count(), 0, 'Unknown submission recovery does not reveal the expected answer.');
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('agent-on-request.pending')).body), unknownSubmission);
  expectedNetworkFailure = false;
  const noConsentResponse = postResponse('/api/sessions/' + noConsent.id + '/actions');
  await act('verify_pending').click();
  const verifiedResponse = await noConsentResponse; assert.equal(verifiedResponse.status(), 200); assert.deepEqual(verifiedResponse.request().postDataJSON(), unknownSubmission);
  await page.locator('[data-understanding-feedback="received_scope"]').waitFor();
  assert.equal((await state()).answers.received_scope, 'outside_scope');
  assert.equal(app.research.list().runs.length, 1, 'Feedback with consent off adds no research run or answer.');
  assert.match(await page.locator('.understanding-consent-note').innerText(), /consent is off/);
  checked.push('Unknown network submission and refresh keep the original wrong answer and exact request without exposing expected feedback; explicit verification confirms it. Consent off still gives feedback without a research record.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checked, pageErrors: errors, externalProviderCalls: 0, artifacts, note: 'Isolated memory-only QA app. Original answer IDs and recorded booleans are unchanged.' }, null, 2));
} finally { await browser.close(); await app.close(); }
