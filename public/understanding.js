const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// The IDs and expected answers mirror the existing server actions. Presentation
// never substitutes an expected answer for a participant's original choice.
export const UNDERSTANDING_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'received_scope', action: 'answer_prediction', localKey: 'prediction', inputName: 'prediction-answer',
    title: 'Could Bob read entries outside the scope you approved?', shortTitle: 'What Bob can see', expected: 'approved_snapshot',
    options: Object.freeze([
      Object.freeze({ value: 'approved_snapshot', label: 'Only the approved snapshot' }),
      Object.freeze({ value: 'outside_scope', label: 'Entries outside the approved scope too' }),
      Object.freeze({ value: 'not_sure', label: 'I am not sure' })
    ]),
    explanations: Object.freeze({
      approved_snapshot: 'Bob receives only snapshots you explicitly confirmed. A preview or a permission limit does not deliver extra calendar entries.',
      outside_scope: 'The approval covers an exact snapshot, not access to Alice’s whole calendar. Bob cannot read other entries just because a connection exists.',
      not_sure: 'Look at the receipt: its confirmed fields and time window show what Bob received. Other calendar entries stayed with Alice.'
    })
  }),
  Object.freeze({
    id: 'withdrawal', action: 'answer_revocation', localKey: 'revocation', inputName: 'revocation-answer',
    title: 'What does stopping future sharing do?', shortTitle: 'What stopping changes', expected: 'future_only',
    options: Object.freeze([
      Object.freeze({ value: 'future_only', label: 'Stops new sharing; already received information remains' }),
      Object.freeze({ value: 'delete_received', label: 'Deletes information already received by Bob' }),
      Object.freeze({ value: 'not_sure', label: 'I am not sure' })
    ]),
    explanations: Object.freeze({
      future_only: 'Stopping closes future sharing. Information Bob already received remains in the receipt history.',
      delete_received: 'Stopping prevents new sharing; it does not remove snapshots already delivered. Starting a new round resets the demo and is a different action.',
      not_sure: 'Compare the boundary and the receipts: new sharing is stopped, while confirmed deliveries remain.'
    })
  }),
  Object.freeze({
    id: 'ontology_alignment', action: 'answer_alignment', localKey: 'alignmentAnswer', inputName: 'alignment-answer', requiresOntology: true,
    title: 'What does accepting a concept mapping authorize?', shortTitle: 'Meaning and permission', expected: 'mapping_not_permission',
    options: Object.freeze([
      Object.freeze({ value: 'mapping_not_permission', label: 'A task-scoped interpretation; sharing still needs approval' }),
      Object.freeze({ value: 'mapping_grants_access', label: 'Access to the other agent’s private data' }),
      Object.freeze({ value: 'not_sure', label: 'I am not sure' })
    ]),
    explanations: Object.freeze({
      mapping_not_permission: 'A mapping explains how to interpret a confirmed payload for this task. Each owner still controls the fields and scope that may be sent.',
      mapping_grants_access: 'A semantic agreement is not a data grant. The mapping cannot bypass either owner’s disclosure decision.',
      not_sure: 'Compare the alignment registry with the receipts: accepted meanings and actual deliveries are separate states.'
    })
  }),
  Object.freeze({
    id: 'task_module', action: 'answer_module', localKey: 'moduleAnswer', inputName: 'module-answer', requiresOntology: true,
    title: 'Which ontology concepts were selected to arrange the discussion time?', shortTitle: 'Why select a module?', expected: 'task_subset',
    options: Object.freeze([
      Object.freeze({ value: 'task_subset', label: 'Only the time and booking concepts needed for this discussion' }),
      Object.freeze({ value: 'whole_ontology', label: 'Both agents’ entire ontologies and private data' }),
      Object.freeze({ value: 'not_sure', label: 'I am not sure' })
    ]),
    explanations: Object.freeze({
      task_subset: 'The scheduling task selects interval, weekday and booking-status modules. Calendar details and the meeting brief remain outside that alignment.',
      whole_ontology: 'The agents selected a relevant subset. A task module limits the alignment scope; it does not export an entire ontology or store.',
      not_sure: 'The selected-modules card shows the actual concepts. The excluded-modules list shows what was not included in this alignment.'
    })
  })
]);

export const understandingQuestionForInput = name => UNDERSTANDING_QUESTIONS.find(question => question.inputName === name);
const optionLabel = (question, value) => question.options.find(option => option.value === value)?.label ?? String(value ?? 'Not answered');
const hasAnswer = (answers, id) => Boolean(answers && Object.hasOwn(answers, id) && typeof answers[id] === 'string' && answers[id]);
function pendingAnswerFor(pending, sessionId, action) {
  // Stop or End can be placed ahead of an unresolved first answer. Its original
  // intent still belongs on screen after refresh, while feedback stays hidden.
  const seen = new Set();
  for (let intent = pending; intent && !seen.has(intent); intent = intent.prior) {
    seen.add(intent);
    if (intent.sessionId === sessionId && intent.body?.action === action) return intent.body.answer;
  }
}

function feedbackHtml(question, answer, { recordedCorrect, research = false } = {}) {
  const matched = answer === question.expected;
  const unsure = answer === 'not_sure';
  const tone = unsure ? 'unsure' : matched ? 'matched' : 'different';
  const label = unsure ? 'You selected “not sure”' : matched ? 'Your answer matches the boundary' : 'Your answer differs from the boundary';
  const explanation = question.explanations[answer] || 'Compare the original answer with the expected boundary below.';
  return '<div class="understanding-feedback ' + tone + '" data-understanding-feedback="' + question.id + '" role="status"><div class="understanding-feedback-heading"><span class="understanding-result-mark" aria-hidden="true">' + (matched ? '✓' : unsure ? '?' : '↔') + '</span><strong>' + label + '</strong></div><div class="understanding-comparison"><div class="understanding-answer original"><small>' + (research ? 'Recorded answer' : 'Your original answer') + '</small><strong data-understanding-original="' + question.id + '">' + escapeHtml(optionLabel(question, answer)) + '</strong></div><div class="understanding-answer expected"><small>Expected boundary</small><strong data-understanding-expected="' + question.id + '">' + escapeHtml(optionLabel(question, question.expected)) + '</strong></div></div><p>' + escapeHtml(explanation) + '</p>' + (research ? '<small class="understanding-recorded-check">Recorded correctness: <strong data-understanding-recorded-correct="' + question.id + '">' + (typeof recordedCorrect === 'boolean' ? recordedCorrect ? 'Yes' : 'No' : 'Not recorded') + '</strong></small>' : '<small>Your first answer is kept. This explanation does not change it.</small>') + '</div>';
}

export function renderUnderstandingHtml({ state, local = {}, busy = false, interruptBusy = false, pending = null } = {}) {
  if (!state?.session || !state.task?.outcome || state.session.mode === 'replay') return '';
  const ended = Boolean(state.session.ended);
  const answers = state.answers || {};
  if (ended && !UNDERSTANDING_QUESTIONS.some(question => hasAnswer(answers, question.id))) return '';
  const blocked = Boolean(busy || interruptBusy || pending);
  return '<section class="panel understanding-panel"><div class="panel-heading"><div><h3>Check your understanding</h3><small>Choose once. Your answer is saved before its explanation appears.</small></div><span class="tag">Optional</span></div><p class="muted understanding-consent-note">' + (state.session.researchConsent ? 'Research consent is on. Your first answers are recorded for this round.' : 'Research consent is off. You still get feedback; no research answer is stored.') + '</p><div class="understanding-question-grid">' + UNDERSTANDING_QUESTIONS.filter(question => (!question.requiresOntology || state.ontology) && (!ended || hasAnswer(answers, question.id))).map((question, index) => {
    const confirmed = hasAnswer(answers, question.id);
    const pendingAnswer = pendingAnswerFor(pending, state.session.id, question.action);
    const answer = confirmed ? answers[question.id] : typeof pendingAnswer === 'string' && pendingAnswer ? pendingAnswer : local[question.localKey];
    const selected = typeof answer === 'string' && Boolean(answer);
    // Lock the very first choice immediately, including when its request needs
    // retry. Feedback is revealed only by a server-confirmed state.answers value.
    const locked = selected || confirmed || ended || blocked;
    const retryable = selected && !confirmed && !ended && !blocked;
    const status = !selected ? 'Pick the answer that best describes your understanding.' : pending && !busy ? 'Your original answer needs verification. Use Verify the same submission above.' : blocked ? 'Confirming your original answer…' : 'Your answer is not confirmed yet. Retry the same answer to see feedback.';
    const action = confirmed ? '<span class="tag good understanding-received" data-understanding-received="' + question.id + '">Answer received</span>' : retryable ? '<button class="button section-actions" data-participant-action="' + question.action + '">Retry the same answer</button>' : '';
    return '<article class="understanding-question" data-understanding-question="' + question.id + '"><div class="understanding-question-heading"><span class="understanding-question-number" aria-hidden="true">' + (index + 1) + '</span><h4>' + question.shortTitle + '</h4></div><fieldset ' + (locked ? 'disabled' : '') + '><legend>' + question.title + '</legend><div class="choices">' + question.options.map(option => '<label class="choice understanding-option"><input type="radio" name="' + question.inputName + '" value="' + option.value + '" ' + (answer === option.value ? 'checked' : '') + '><span>' + option.label + '</span></label>').join('') + '</div></fieldset>' + (confirmed ? feedbackHtml(question, answer) : '<p class="understanding-answer-status muted" data-understanding-status="' + question.id + '">' + status + '</p>') + action + '</article>';
  }).join('') + '</div></section>';
}

export function renderAnswerComparisonHtml(events = []) {
  const source = Array.isArray(events) ? events : [];
  return '<section class="understanding-research-review"><div class="panel-heading"><div><h3>Understanding answers</h3><small>Original recorded choices, expected boundaries and recorded correctness.</small></div><span class="tag">Read-only</span></div><div class="understanding-question-grid">' + UNDERSTANDING_QUESTIONS.map(question => {
    const event = source.find(item => {
      const data = item?.data && typeof item.data === 'object' ? item.data : item;
      return ['prediction', 'understanding'].includes(item?.kind || item?.type) && data?.questionId === question.id && typeof data.answer === 'string' && data.answer;
    });
    const data = event?.data && typeof event.data === 'object' ? event.data : event;
    return '<article class="understanding-question"><h4>' + question.title + '</h4>' + (event ? feedbackHtml(question, data.answer, { recordedCorrect: data.correct, research: true }) : '<p class="muted understanding-missing">Not answered. Missing answers are not incorrect answers.</p>') + '</article>';
  }).join('') + '</div><details class="understanding-evidence-note" data-disclosure-id="understanding-research-note"><summary>How to read this comparison</summary><p class="muted">These are checks after the round’s result. Receipts are available for inspection; the record does not establish whether they were inspected. A different answer or “not sure” does not tell us why it was chosen. Missing correctness stays missing, and the original choice and recorded boolean are never rewritten.</p></details></section>';
}
