import { canonical, hashPayload, invariant } from './runtime-helpers.mjs';

const clone = value => structuredClone(value);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const REQUIRED_CALENDAR_FIELDS = ['day', 'time', 'status'];
const safeField = field => typeof field === 'string' && field.length <= 128 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(field)
  && !/^(?:__proto__|prototype|constructor|authorization|credentials?|secret|token|password|passwd|apikey|accesstoken|refreshtoken|clientsecret|adminpin|privatekey|privatekeypem)$/i.test(field.replace(/[_-]/g, ''));
export const ONTOLOGY_DIALOGUE_VERSION = 'task-modular-dialogue-v1';

const property = (id, label, definition, datatype, constraints = {}) => ({ id, label, definition, datatype, constraints });
const concept = (id, label, definition, properties = []) => ({ id, label, definition, properties });
const module = (id, owner, name, purpose, concepts, constraints = []) => ({ id, owner, name, purpose, concepts, constraints });

/** Published fictional schemas, independently namespaced and versioned. No calendar values occur here. */
export function ontologyDefinitions({ scenario = 'distinct' } = {}) {
  invariant(['distinct', 'ambiguous'].includes(scenario), 'ONTOLOGY_SCENARIO', 'Choose a supported ontology scenario.');
  const aliceFree = scenario === 'ambiguous'
    ? 'The calendar has no occupied event in this interval. It says nothing about willingness to accept a meeting.'
    : 'The calendar has no occupied event and the owner explicitly offers this interval for a meeting invitation.';
  const Alice = {
    id: 'urn:demo:alice:calendar', version: scenario === 'ambiguous' ? '1.1-occupancy' : '1.0-invitation', owner: 'Alice',
    modules: [
      module('alice:time', 'Alice', 'Calendar interval', 'Interpret calendar dates and bounded time intervals.', [
        concept('alice:CalendarEntry', 'CalendarEntry', 'A calendar interval with an occupancy status, expressed as a weekday label and a clock range.', [
          property('alice:day', 'day', 'Weekday of this calendar entry.', 'string', { enum: DAYS }),
          property('alice:time', 'time', 'Same-day local clock interval in the demo shared timezone.', 'string', { pattern: 'HH:MM–HH:MM', startBeforeEnd: true }),
        ]),
      ], ['Intervals are on one day and use the same fictional week and Asia/Shanghai timezone.']),
      module('alice:status', 'Alice', 'Calendar status', 'Determine what Free and Busy mean for a meeting task.', [
        concept('alice:CalendarStatus', 'CalendarStatus', 'Occupancy classification attached to a CalendarEntry.', [
          property('alice:status', 'status', 'Calendar occupancy; its meaning is defined by the Free and Busy concepts.', 'string', { enum: ['Free', 'Busy'] }),
        ]),
        concept('alice:Free', 'Free', aliceFree),
        concept('alice:Busy', 'Busy', 'The interval is occupied and cannot be used for this meeting.'),
      ], ['An unoccupied calendar interval does not imply permission unless the owner explicitly defines or confirms that meaning.']),
      module('alice:details', 'Alice', 'Calendar details', 'Describe an event, without helping determine a shared meeting time.', [
        concept('alice:EventDescription', 'EventDescription', 'The title and personal note of a calendar entry.', [
          property('alice:title', 'title', 'Event title.', 'string'),
          property('alice:note', 'note', 'Personal calendar note.', 'string'),
        ]),
      ]),
      module('alice:brief', 'Alice', 'Received meeting context', 'Understand an optional topic or agenda received from another owner.', [
        concept('alice:MeetingContext', 'MeetingContext', 'Optional meeting preparation context.', [
          property('alice:topic', 'topic', 'Subject of the meeting.', 'string'),
          property('alice:agenda', 'agenda', 'Proposed discussion outline.', 'string'),
        ]),
      ]),
    ],
  };
  const Bob = {
    id: 'urn:demo:bob:appointments', version: '2.0-booking', owner: 'Bob',
    modules: [
      module('bob:time', 'Bob', 'Booking interval', 'Represent candidate meeting intervals as numeric minutes.', [
        concept('bob:BookableSlot', 'BookableSlot', 'A bounded interval whose eligibility for a meeting invitation is explicit.', [
          property('bob:weekday', 'weekday', 'ISO weekday number, Monday = 1.', 'integer', { minimum: 1, maximum: 7 }),
          property('bob:startMinute', 'startMinute', 'Minutes after local midnight at the interval start.', 'integer', { minimum: 0, maximum: 1439 }),
          property('bob:endMinute', 'endMinute', 'Minutes after local midnight at the interval end.', 'integer', { minimum: 1, maximum: 1439 }),
        ]),
      ], ['startMinute < endMinute; no cross-midnight intervals.', 'Intervals use the same fictional week and Asia/Shanghai timezone.']),
      module('bob:status', 'Bob', 'Booking eligibility', 'Distinguish calendar occupancy from the owner allowing an invitation.', [
        concept('bob:InvitationEligibility', 'InvitationEligibility', 'Whether an owner permits a meeting invitation in this interval.', [
          property('bob:bookable', 'bookable', 'The owner allows this interval to be considered for a meeting invitation.', 'boolean'),
        ]),
        concept('bob:Free', 'Free', 'The owner permits a meeting invitation in this interval; this label is a booking preference, not merely calendar occupancy.'),
      ], ['Neither a concept mapping nor invitation eligibility authorizes data disclosure or books an actual meeting.']),
      module('bob:brief', 'Bob', 'Meeting brief', 'Describe optional preparation material for a meeting.', [
        concept('bob:MeetingBrief', 'MeetingBrief', 'An optional topic and discussion outline owned by Bob.', [
          property('bob:topic', 'topic', 'Subject of the meeting.', 'string'),
          property('bob:agenda', 'agenda', 'Proposed discussion outline.', 'string'),
        ]),
      ]),
    ],
  };
  return { Alice, Bob };
}

function normalizedTask(input = {}) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'ONTOLOGY_TASK', 'An ontology task must be an object.');
  const type = input.type ?? 'schedule';
  invariant(['schedule', 'brief'].includes(type), 'ONTOLOGY_TASK', 'Only scheduling and optional briefing are supported.');
  if (type === 'brief') {
    const fields = input.fields ?? ['topic', 'agenda'];
    invariant(Array.isArray(fields) && fields.length > 0 && fields.every(field => ['topic', 'agenda'].includes(field))
      && new Set(fields).size === fields.length, 'ONTOLOGY_TASK', 'Briefing requires a bounded topic/agenda selection.');
    return { id: `brief-${[...fields].sort().join('-')}`, type, fields: [...fields] };
  }
  const durationMinutes = input.durationMinutes ?? 30;
  invariant(Number.isSafeInteger(durationMinutes) && durationMinutes > 0 && durationMinutes <= 480,
    'ONTOLOGY_TASK', 'Meeting duration must be between 1 and 480 minutes.');
  return { id: `schedule-${durationMinutes}m`, type, durationMinutes };
}

function selectModules(definitions, task) {
  const selectedIds = task.type === 'brief' ? ['alice:brief', 'bob:brief'] : ['alice:time', 'alice:status', 'bob:time', 'bob:status'];
  const all = [...definitions.Alice.modules, ...definitions.Bob.modules];
  return {
    selectedModules: all.filter(item => selectedIds.includes(item.id)),
    // An excluded module reveals only its label and purpose, not its complete schema or data.
    excludedModules: all.filter(item => !selectedIds.includes(item.id)).map(({ id, owner, name, purpose }) => ({ id, owner, name, purpose })),
  };
}

const SCHEDULING_RULES = [
  ['entry', 'alice:CalendarEntry', 'bob:BookableSlot', 'conditional', 'calendar_entry_to_slot', 'Interpret only a received entry with an accepted status meaning; do not infer permission from an absent status.'],
  ['weekday', 'alice:day', 'bob:weekday', 'equivalent', 'weekday_to_number', 'Mon→1, Tue→2, Wed→3, Thu→4, Fri→5, Sat→6, Sun→7.'],
  ['start', 'alice:time', 'bob:startMinute', 'projection', 'interval_start', 'Parse the start clock value and convert it to minutes after midnight.'],
  ['end', 'alice:time', 'bob:endMinute', 'projection', 'interval_end', 'Parse the end clock value and convert it to minutes after midnight.'],
  ['eligibility', 'alice:status', 'bob:bookable', 'conditional', 'free_to_bookable', 'Free→true only under the explicit owner-confirmed invitation interpretation; Busy→false.'],
  ['free-meaning', 'alice:Free', 'bob:Free', 'conditional', 'owner_permitted_meeting', 'The labels are not sufficient evidence of equivalence. Limit correspondence to the owner-confirmed meeting invitation purpose.'],
];
const BRIEF_RULES = [
  ['brief', 'bob:MeetingBrief', 'alice:MeetingContext', 'equivalent', 'brief_context', 'Interpret only the topic or agenda fields actually received.'],
  ['topic', 'bob:topic', 'alice:topic', 'equivalent', 'identity', 'Preserve an actually received topic string.'],
  ['agenda', 'bob:agenda', 'alice:agenda', 'equivalent', 'identity', 'Preserve an actually received agenda string.'],
];

function termIndex(modules) {
  const entries = modules.flatMap(item => item.concepts.flatMap(term => [term, ...term.properties]));
  return new Map(entries.map(term => [term.id, term]));
}

function expectedMappings(task, modules) {
  const index = termIndex(modules);
  const rules = task.type === 'brief' ? BRIEF_RULES.filter(([id]) => id === 'brief' || task.fields.includes(id)) : SCHEDULING_RULES;
  return rules.map(([id, source, target, relation, transform, rule]) => ({
    id: `map:${id}`, source, target, relation, transform, rule,
    sourceDefinition: index.get(source).definition,
    targetDefinition: index.get(target).definition,
    status: 'proposed',
  }));
}

/** The model proposes correspondence and a bounded, registered transformation; it cannot add code or disclosure grants. */
export function defaultOntologyProposal({ scenario = 'distinct', task } = {}) {
  const effectiveTask = normalizedTask(task);
  const { selectedModules } = selectModules(ontologyDefinitions({ scenario }), effectiveTask);
  return { mappings: expectedMappings(effectiveTask, selectedModules).map(({ source, target, relation, transform }) => ({ source, target, relation, transform })) };
}

export const ontologyProposalSchema = {
  type: 'object', additionalProperties: false, required: ['mappings'],
  properties: {
    message: { type: 'string', maxLength: 1000 },
    mappings: { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['source', 'target', 'relation', 'transform'],
      properties: {
        source: { type: 'string', maxLength: 100 }, target: { type: 'string', maxLength: 100 },
        relation: { type: 'string', enum: ['equivalent', 'projection', 'conditional'] },
        transform: { type: 'string', enum: ['calendar_entry_to_slot', 'weekday_to_number', 'interval_start', 'interval_end', 'free_to_bookable', 'owner_permitted_meeting', 'brief_context', 'identity'] },
      },
    } },
  },
};

export function validateOntologyProposal(proposal, { scenario = 'distinct', task } = {}) {
  const effectiveTask = normalizedTask(task);
  const { selectedModules } = selectModules(ontologyDefinitions({ scenario }), effectiveTask);
  const expected = expectedMappings(effectiveTask, selectedModules);
  const invalid = message => invariant(false, 'ONTOLOGY_INVALID_PROPOSAL', message, 422);
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || Object.keys(proposal).some(key => !['mappings', 'message'].includes(key))) invalid('A proposal contains only a mappings list and an optional bounded message.');
  if (proposal.message !== undefined && (typeof proposal.message !== 'string' || proposal.message.length > 1000)) invalid('An ontology proposal message must be bounded.');
  if (!Array.isArray(proposal.mappings) || proposal.mappings.length !== expected.length) invalid('The proposal must cover exactly the selected task module.');
  const seen = new Set();
  for (const item of proposal.mappings) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'relation,source,target,transform') invalid('Mapping fields must be source, target, relation and transform.');
    const key = canonical([item.source, item.target]);
    if (seen.has(key)) invalid('An ontology proposal cannot repeat a correspondence.');
    seen.add(key);
    const known = expected.find(candidate => candidate.source === item.source && candidate.target === item.target);
    if (!known) invalid('A correspondence leaves the selected task modules.');
    if (item.transform !== known.transform) invalid('A correspondence proposes an unregistered transformation.');
    // A model may try lexical equivalence for Free; this becomes a visible semantic challenge, never an accepted equivalence.
    const challengeable = ['map:free-meaning', 'map:eligibility', 'map:entry'].includes(known.id) && item.relation === 'equivalent';
    if (item.relation !== known.relation && !challengeable) invalid('A correspondence uses an unsupported semantic relation.');
  }
  return expected.map(item => ({ ...item, relation: proposal.mappings.find(candidate => candidate.source === item.source && candidate.target === item.target).relation }));
}

function append(state, { from = 'Alice', to = 'Bob', move, kind = move, reasonCode, message, moduleIds = [], mappingIds = [] }) {
  state.transcript.push({ sequence: state.transcript.length + 1, from, to, move, kind, reasonCode, message, moduleIds, mappingIds });
}

function seal(state) {
  state.registry.hash = hashPayload({ version: state.registry.version, ontologyVersions: state.ontologyVersions,
    revision: state.revision, status: state.status, task: state.task, mappings: state.registry.mappings, facts: state.registry.facts, receipts: state.registry.receipts,
    interpretation: state.interpretation });
  return state;
}

export function createOntologyDialogue({ scenario = 'distinct', task, mode = 'controlled', proposal, autoAccept = true } = {}) {
  const effectiveTask = normalizedTask(task);
  invariant(['controlled', 'live', 'replay'].includes(mode), 'ONTOLOGY_MODE', 'Choose a supported dialogue mode.');
  const definitions = ontologyDefinitions({ scenario });
  const selection = selectModules(definitions, effectiveTask);
  const mappings = validateOntologyProposal(proposal ?? defaultOntologyProposal({ scenario, task: effectiveTask }), { scenario, task: effectiveTask });
  const state = {
    version: ONTOLOGY_DIALOGUE_VERSION, revision: 1, scenario, mode, task: effectiveTask,
    status: scenario === 'ambiguous' && effectiveTask.type === 'schedule' ? 'needs_clarification' : 'awaiting_alignment',
    ontologyVersions: Object.fromEntries(Object.entries(definitions).map(([owner, value]) => [owner, { id: value.id, version: value.version, hash: hashPayload(value) }])),
    ...selection,
    proposal: { source: proposal ? 'model' : 'guided', mappings },
    interpretation: { calendarFreeMeansBookable: null, scope: effectiveTask.id, authorizesDisclosure: false },
    transcript: [], registry: { version: 1, mappingVersion: null, mappings: [], facts: [], receipts: [], hash: null },
  };
  append(state, { move: 'join', reasonCode: 'TASK_JOIN', message: 'Alice and Bob join a task while keeping separate owners and ontology namespaces.' });
  append(state, { move: 'pick', kind: 'module_selection', reasonCode: 'TASK_WORKING_SUBSET',
    message: effectiveTask.type === 'brief' ? 'Select the optional brief module for this task; calendar modules are outside this dialogue.' : 'Select interval and status definitions needed for the meeting; event details and optional brief are outside this dialogue.',
    moduleIds: state.selectedModules.map(item => item.id) });
  append(state, { move: 'propose', kind: 'proposal', reasonCode: proposal ? 'VALIDATED_MODEL_PROPOSAL' : 'GUIDED_PROPOSAL',
    message: 'Propose correspondences inside the selected modules, with bounded registered transformations.', mappingIds: mappings.map(item => item.id) });
  if (effectiveTask.type === 'schedule') {
    append(state, { from: 'Bob', to: 'Alice', move: 'decide', kind: 'challenge', reasonCode: 'FREE_IS_NOT_LEXICAL_EQUIVALENCE',
      message: 'Free is a shared label with different definitions. Calendar occupancy alone does not establish invitation eligibility.',
      mappingIds: ['map:free-meaning', 'map:eligibility', 'map:entry'] });
  }
  seal(state);
  if (autoAccept && state.status === 'awaiting_alignment') return resolveOntologyDialogue(state, { decision: 'accept' });
  return state;
}

export function startOntologyDialogue(options = {}) { return createOntologyDialogue({ ...options, autoAccept: false }); }

function assertIntegrity(state) {
  invariant(state?.version === ONTOLOGY_DIALOGUE_VERSION, 'ONTOLOGY_STATE', 'A supported ontology dialogue is required.');
  invariant(Number.isSafeInteger(state.revision) && state.revision > 0, 'ONTOLOGY_STATE_CHANGED', 'The dialogue revision is invalid.', 409);
  invariant(['awaiting_alignment', 'needs_clarification', 'accepted', 'rejected'].includes(state.status)
    && ['controlled', 'live', 'replay'].includes(state.mode), 'ONTOLOGY_STATE_CHANGED', 'The ontology dialogue status or mode is invalid.', 409);
  const expected = seal(clone(state)).registry.hash;
  invariant(expected === state.registry.hash, 'ONTOLOGY_STATE_CHANGED', 'The ontology registry changed outside the dialogue.', 409);
  const definitions = ontologyDefinitions({ scenario: state.scenario });
  const task = normalizedTask(state.task);
  invariant(canonical(state.task) === canonical(task), 'ONTOLOGY_STATE_CHANGED', 'The task registry was changed outside the dialogue.', 409);
  invariant(Object.entries(definitions).every(([owner, value]) => state.ontologyVersions[owner]?.hash === hashPayload(value)),
    'ONTOLOGY_STATE_CHANGED', 'The ontology version changed outside the dialogue.', 409);
  const { selectedModules } = selectModules(definitions, task);
  invariant(canonical(selectedModules) === canonical(state.selectedModules), 'ONTOLOGY_STATE_CHANGED', 'The selected ontology definitions were changed.', 409);
  if (state.status === 'accepted') {
    const accepted = expectedMappings(task, selectedModules).map(item => ({ ...item, status: 'accepted' }));
    invariant(canonical(accepted) === canonical(state.registry.mappings) && state.registry.mappingVersion === hashPayload({ task, ontologyVersions: state.ontologyVersions, mappings: accepted }),
      'ONTOLOGY_STATE_CHANGED', 'Accepted correspondences cannot be changed outside a dialogue.', 409);
    invariant(task.type !== 'schedule' || state.interpretation.calendarFreeMeansBookable === true,
      'ONTOLOGY_STATE_CHANGED', 'Scheduling requires an accepted invitation interpretation.', 409);
  }
}

export function resolveOntologyDialogue(dialogue, { decision, calendarFreeMeansBookable } = {}) {
  assertIntegrity(dialogue);
  invariant(['accept', 'clarify', 'reject'].includes(decision), 'ONTOLOGY_DECISION', 'Choose accept, clarify or reject.');
  invariant(['awaiting_alignment', 'needs_clarification'].includes(dialogue.status), 'ONTOLOGY_ALREADY_DECIDED', 'This ontology dialogue has already ended.', 409);
  const state = clone(dialogue);
  state.revision++;
  const scheduling = state.task.type === 'schedule';
  if (calendarFreeMeansBookable !== undefined) invariant(typeof calendarFreeMeansBookable === 'boolean', 'ONTOLOGY_DECISION', 'The owner interpretation must be an explicit boolean.');
  if (decision === 'clarify' && calendarFreeMeansBookable === undefined) {
    invariant(scheduling, 'ONTOLOGY_DECISION', 'Only calendar invitation meaning needs owner clarification.');
    state.status = 'needs_clarification';
    append(state, { from: 'Bob', to: 'Alice', move: 'propose', kind: 'clarify', reasonCode: 'CLARIFICATION_REQUESTED',
      message: 'Ask Alice’s owner whether an unoccupied interval may be considered for this meeting invitation. No correspondence is accepted yet.',
      mappingIds: ['map:free-meaning', 'map:eligibility', 'map:entry'] });
    return seal(state);
  }
  if (decision === 'clarify') invariant(scheduling && typeof calendarFreeMeansBookable === 'boolean', 'ONTOLOGY_CLARIFICATION_REQUIRED', 'Clarification requires an explicit owner interpretation.', 409);
  if (decision !== 'reject' && scheduling && state.scenario === 'ambiguous') {
    invariant(typeof calendarFreeMeansBookable === 'boolean', 'ONTOLOGY_CLARIFICATION_REQUIRED', 'The owner must clarify whether an unoccupied interval may receive a meeting invitation.', 409);
  }
  const rejected = decision === 'reject' || scheduling && calendarFreeMeansBookable === false;
  if (rejected) {
    state.status = 'rejected';
    state.interpretation.calendarFreeMeansBookable = calendarFreeMeansBookable ?? null;
    append(state, { from: 'Alice', to: 'Bob', move: 'decide', kind: 'reject', reasonCode: calendarFreeMeansBookable === false ? 'OWNER_DID_NOT_PERMIT_INTERPRETATION' : 'ALIGNMENT_REJECTED',
      message: 'The proposed interpretation was rejected. No accepted mapping or inferred meeting permission is registered.', mappingIds: state.proposal.mappings.map(item => item.id) });
  } else {
    if (scheduling) {
      state.interpretation.calendarFreeMeansBookable = true;
      append(state, { from: 'Alice', to: 'Bob', move: 'propose', kind: 'clarify', reasonCode: state.scenario === 'ambiguous' ? 'OWNER_TASK_SCOPED_CLARIFICATION' : 'SCHEMA_INVITATION_DEFINITION',
        message: state.scenario === 'ambiguous' ? 'Alice’s owner confirms that the shared Free intervals may be considered for this meeting invitation only. This does not authorize sharing any data.' : 'Alice’s published Free definition explicitly offers an interval for an invitation. Keep the correspondence limited to this meeting task.',
        mappingIds: ['map:free-meaning', 'map:eligibility', 'map:entry'] });
    }
    state.status = 'accepted';
    // Repair unsafe lexical-equivalence proposals into the explicit, bounded conditional correspondence.
    state.registry.mappings = expectedMappings(state.task, state.selectedModules).map(item => ({ ...item, status: 'accepted' }));
    const revisedIds = state.proposal.mappings.filter(item => state.registry.mappings.find(accepted => accepted.id === item.id)?.relation !== item.relation).map(item => item.id);
    if (revisedIds.length) append(state, { from: 'Alice', to: 'Bob', move: 'propose', kind: 'counter_proposal', reasonCode: 'BOUNDED_COUNTER_PROPOSAL',
      message: 'Replace the challenged lexical equivalence with the explicit task-scoped conditional correspondence. Bob must decide on this revised proposal.',
      mappingIds: revisedIds });
    state.registry.mappingVersion = hashPayload({ task: state.task, ontologyVersions: state.ontologyVersions, mappings: state.registry.mappings });
    append(state, { from: 'Bob', to: 'Alice', move: 'decide', kind: 'accept', reasonCode: 'TASK_SCOPED_MAPPING_ACCEPTED',
      message: 'Accept the validated task-scoped mappings. Data disclosure still requires a separate owner decision and an actual receipt.', mappingIds: state.registry.mappings.map(item => item.id) });
  }
  append(state, { move: 'end', reasonCode: 'DIALOGUE_ENDED', message: 'The ontology dialogue ends with a recorded decision.' });
  append(state, { from: 'Bob', to: 'Alice', move: 'end', reasonCode: 'DIALOGUE_ENDED', message: 'The ontology dialogue ends with a recorded decision.' });
  append(state, { move: 'close', reasonCode: 'REGISTRY_CLOSED', message: 'Close this dialogue and preserve its ontology versions, decision and mapping registry.' });
  return seal(state);
}

function requireAccepted(dialogue, type) {
  assertIntegrity(dialogue);
  invariant(dialogue.status === 'accepted' && dialogue.registry.mappings.length > 0,
    'ONTOLOGY_NOT_ALIGNED', 'Data cannot be interpreted before the task-scoped mappings are accepted.', 409);
  invariant(dialogue.task.type === type, 'ONTOLOGY_TASK_MISMATCH', 'The accepted mapping belongs to another task.', 409);
}

function parseInterval(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value.replace(/[–—−]/g, '-').replace(/\s/g, ''));
  if (!match) return null;
  const [h1, m1, h2, m2] = match.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const startMinute = h1 * 60 + m1, endMinute = h2 * 60 + m2;
  return startMinute < endMinute ? { startMinute, endMinute } : null;
}

function validateProjection(rows, fields) {
  invariant(Array.isArray(rows) && Array.isArray(fields) && fields.every(safeField)
    && new Set(fields).size === fields.length, 'ONTOLOGY_PROJECTION', 'The received projection needs rows and unique fields.');
  invariant(rows.every(row => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => fields.includes(key))), 'ONTOLOGY_UNAUTHORIZED_FIELD', 'A received row contains a field outside the declared disclosure projection.', 403);
}

/** Only transforms fields present in the received projection; it never reads an Alice fixture. */
export function interpretAliceCalendar({ dialogue, rows = [], fields = [] } = {}) {
  requireAccepted(dialogue, 'schedule');
  validateProjection(rows, fields);
  if (!rows.length) return [];
  invariant(REQUIRED_CALENDAR_FIELDS.every(field => fields.includes(field)) && rows.every(row => REQUIRED_CALENDAR_FIELDS.every(field => Object.hasOwn(row, field))),
    'ONTOLOGY_MISSING_FIELDS', 'No meeting eligibility can be inferred from missing day, time or status.', 409);
  return rows.map(row => {
    const weekday = DAYS.indexOf(row.day) + 1;
    const interval = parseInterval(row.time);
    const status = typeof row.status === 'string' ? row.status.toLowerCase() : '';
    invariant(weekday > 0 && interval && ['free', 'busy'].includes(status), 'ONTOLOGY_INVALID_VALUE', 'A received value violates the accepted calendar module constraints.', 422);
    return { weekday, ...interval, bookable: status === 'free' };
  });
}

/** Bob interprets his own availability in his own ontology; this is not a peer alignment. */
export function toBobNativeSlots(availableTimes = []) {
  invariant(Array.isArray(availableTimes), 'ONTOLOGY_INVALID_VALUE', 'Bob availability must be an array.');
  return availableTimes.map(slot => {
    if (Number.isSafeInteger(slot?.weekday) && Number.isSafeInteger(slot.startMinute) && Number.isSafeInteger(slot.endMinute)
      && typeof slot.bookable === 'boolean') {
      invariant(slot.weekday >= 1 && slot.weekday <= 7 && slot.startMinute >= 0 && slot.endMinute <= 1439 && slot.startMinute < slot.endMinute,
        'ONTOLOGY_INVALID_VALUE', 'Bob’s native slot violates its booking interval constraints.', 422);
      return { weekday: slot.weekday, startMinute: slot.startMinute, endMinute: slot.endMinute, bookable: slot.bookable };
    }
    const weekday = DAYS.indexOf(slot?.day) + 1;
    const interval = parseInterval(slot?.time);
    invariant(weekday > 0 && interval, 'ONTOLOGY_INVALID_VALUE', 'Bob’s availability violates its local interval constraints.', 422);
    return { weekday, ...interval, bookable: slot.bookable !== false };
  });
}

const formatMinute = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export function findBookableIntersections({ dialogue, receivedRows = [], receivedFields = REQUIRED_CALENDAR_FIELDS,
  availableTimes = [], durationMinutes = dialogue?.task?.durationMinutes ?? 30 } = {}) {
  requireAccepted(dialogue, 'schedule');
  invariant(durationMinutes === dialogue.task.durationMinutes, 'ONTOLOGY_TASK_MISMATCH', 'A mapping must be queried for its registered meeting duration.', 409);
  // Incomplete authorized projections remain received facts, but are not sufficient for an eligibility query.
  validateProjection(receivedRows, receivedFields);
  if (!REQUIRED_CALENDAR_FIELDS.every(field => receivedFields.includes(field))) return [];
  const received = interpretAliceCalendar({ dialogue, rows: receivedRows, fields: receivedFields });
  const own = toBobNativeSlots(availableTimes);
  return intersectNativeSlots(received, own, durationMinutes);
}

function intersectNativeSlots(received, own, durationMinutes) {
  const seen = new Set(), result = [];
  for (const candidate of received.filter(slot => slot.bookable)) for (const slot of own.filter(item => item.bookable)) {
    if (candidate.weekday !== slot.weekday) continue;
    const startMinute = Math.max(candidate.startMinute, slot.startMinute), endMinute = Math.min(candidate.endMinute, slot.endMinute);
    if (endMinute - startMinute < durationMinutes) continue;
    const day = DAYS[slot.weekday - 1], time = `${formatMinute(startMinute)}–${formatMinute(endMinute)}`;
    const key = canonical([day, time]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ day, time });
  }
  return result;
}

/** Call only after the receiver verifies a real receipt. The registry is a semantic state used by scheduling queries. */
export function registerOntologyReceipt(dialogue, { receiptId, payloadHash, direction = 'aliceToBob', rows = [], fields = [], values = {} } = {}) {
  assertIntegrity(dialogue);
  invariant(typeof receiptId === 'string' && receiptId.length > 0 && receiptId.length <= 200 && /^[a-f0-9]{64}$/.test(payloadHash),
    'ONTOLOGY_RECEIPT', 'A semantic fact requires a real receipt identifier and payload digest.');
  invariant(['aliceToBob', 'bobToAlice'].includes(direction), 'ONTOLOGY_RECEIPT', 'Choose a supported receipt direction.');
  invariant(Array.isArray(fields) && fields.every(safeField) && new Set(fields).size === fields.length,
    'ONTOLOGY_RECEIPT', 'A semantic receipt requires bounded safe field identifiers.');
  const state = clone(dialogue);
  const existing = state.registry.receipts.find(item => item.receiptId === receiptId && item.direction === direction);
  if (existing) {
    invariant(existing.payloadHash === payloadHash && existing.projectionHash === hashPayload({ rows, fields, values }),
      'ONTOLOGY_RECEIPT_CONFLICT', 'A receipt identifier cannot register different source content.', 409);
    return state;
  }
  let semanticValues = [], reasonCode = null;
  if (state.status !== 'accepted') reasonCode = 'ALIGNMENT_NOT_ACCEPTED';
  else if (state.task.type === 'schedule' && direction === 'aliceToBob') {
    validateProjection(rows, fields);
    if (!REQUIRED_CALENDAR_FIELDS.every(field => fields.includes(field))) reasonCode = 'INSUFFICIENT_AUTHORIZED_FIELDS';
    else semanticValues = interpretAliceCalendar({ dialogue: state, rows, fields });
  } else if (state.task.type === 'brief' && direction === 'bobToAlice') {
    invariant(fields.every(field => state.task.fields.includes(field)) && Object.keys(values).every(field => fields.includes(field))
      && fields.every(field => typeof values[field] === 'string'), 'ONTOLOGY_UNAUTHORIZED_FIELD', 'Brief interpretation cannot use fields outside the received task projection.', 403);
    semanticValues = fields.length ? [Object.fromEntries(fields.map(field => [field, values[field]]))] : [];
  } else reasonCode = 'OUTSIDE_TASK_MODULE';
  state.revision++;
  state.registry.receipts.push({ receiptId, payloadHash, direction, fields: [...fields], projectionHash: hashPayload({ rows, fields, values }), interpreted: semanticValues.length > 0, reasonCode });
  semanticValues.forEach((value, index) => state.registry.facts.push({
    id: `fact:${direction}:${receiptId}:${index}`, concept: state.task.type === 'schedule' ? 'bob:BookableSlot' : 'alice:MeetingContext',
    values: value, receiptId, payloadHash, mappingVersion: state.registry.mappingVersion,
    mappingIds: state.registry.mappings.filter(item => state.task.type === 'schedule' || item.id === 'map:brief' || fields.includes(item.id.slice(4))).map(item => item.id),
    sourceFields: state.task.type === 'schedule' ? [...REQUIRED_CALENDAR_FIELDS] : [...fields],
  }));
  return seal(state);
}

export function queryRegisteredMeetingSlots({ dialogue, availableTimes = [] } = {}) {
  requireAccepted(dialogue, 'schedule');
  const slots = dialogue.registry.facts.filter(fact => fact.concept === 'bob:BookableSlot'
    && fact.mappingVersion === dialogue.registry.mappingVersion).map(fact => fact.values);
  return intersectNativeSlots(slots, toBobNativeSlots(availableTimes), dialogue.task.durationMinutes);
}

const SAFE_TRANSCRIPT = {
  TASK_JOIN: ['join', 'join', 'Alice and Bob join a task while keeping separate owners and ontology namespaces.'],
  TASK_WORKING_SUBSET: ['pick', 'module_selection', 'Select only the ontology modules required by this task.'],
  GUIDED_PROPOSAL: ['propose', 'proposal', 'Propose registered correspondences inside the selected modules.'],
  VALIDATED_MODEL_PROPOSAL: ['propose', 'proposal', 'The model proposes correspondences that pass the bounded module and transformation checks.'],
  FREE_IS_NOT_LEXICAL_EQUIVALENCE: ['decide', 'challenge', 'The label Free does not establish equivalence between calendar occupancy and invitation eligibility.'],
  OWNER_TASK_SCOPED_CLARIFICATION: ['propose', 'clarify', 'Alice’s owner permits the invitation interpretation for this meeting task. Data disclosure still requires a separate decision.'],
  SCHEMA_INVITATION_DEFINITION: ['propose', 'clarify', 'Alice’s published definition explicitly offers this interval for a meeting invitation.'],
  CLARIFICATION_REQUESTED: ['propose', 'clarify', 'Ask the owner to clarify whether an unoccupied interval may receive a meeting invitation. No correspondence is accepted yet.'],
  BOUNDED_COUNTER_PROPOSAL: ['propose', 'counter_proposal', 'Propose a bounded conditional correspondence in place of the challenged equivalence; the peer must decide on the revision.'],
  OWNER_DID_NOT_PERMIT_INTERPRETATION: ['decide', 'reject', 'The owner did not permit the invitation interpretation. No mapping is accepted.'],
  ALIGNMENT_REJECTED: ['decide', 'reject', 'The proposed alignment was rejected. No mapping is accepted.'],
  TASK_SCOPED_MAPPING_ACCEPTED: ['decide', 'accept', 'Accept validated task-scoped mappings; disclosure permission and receipt remain separate.'],
  DIALOGUE_ENDED: ['end', 'end', 'The dialogue ends with a recorded decision.'],
  REGISTRY_CLOSED: ['close', 'close', 'Preserve ontology versions, decision and mapping registry.'],
};
const DIGEST = /^[a-f0-9]{64}$/;
const boundedId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Strict research/export whitelist. Stored model text and unrelated protocol fields never become instructions or public evidence. */
export function sanitizeOntologyDialogue(dialogue) {
  assertIntegrity(dialogue);
  const task = normalizedTask(dialogue.task);
  const definitions = ontologyDefinitions({ scenario: dialogue.scenario });
  const selection = selectModules(definitions, task);
  const proposalMappings = validateOntologyProposal({ mappings: dialogue.proposal.mappings.map(({ source, target, relation, transform }) => ({ source, target, relation, transform })) }, { scenario: dialogue.scenario, task });
  const mappings = dialogue.status === 'accepted' ? expectedMappings(task, selection.selectedModules).map(item => ({ ...item, status: 'accepted' })) : [];
  const receipts = dialogue.registry.receipts.map(item => {
    invariant(boundedId(item.receiptId) && DIGEST.test(item.payloadHash) && DIGEST.test(item.projectionHash)
      && ['aliceToBob', 'bobToAlice'].includes(item.direction) && Array.isArray(item.fields)
      && item.fields.every(safeField)
      && new Set(item.fields).size === item.fields.length && typeof item.interpreted === 'boolean'
      && [null, 'ALIGNMENT_NOT_ACCEPTED', 'INSUFFICIENT_AUTHORIZED_FIELDS', 'OUTSIDE_TASK_MODULE'].includes(item.reasonCode),
    'ONTOLOGY_STATE_CHANGED', 'Receipt registry evidence is invalid.', 409);
    return { receiptId: item.receiptId, payloadHash: item.payloadHash, direction: item.direction, fields: [...item.fields],
      projectionHash: item.projectionHash, interpreted: item.interpreted, reasonCode: item.reasonCode };
  });
  const facts = dialogue.registry.facts.map(item => {
    const receipt = receipts.find(candidate => candidate.receiptId === item.receiptId && candidate.payloadHash === item.payloadHash && candidate.interpreted);
    invariant(receipt && boundedId(item.id) && item.mappingVersion === dialogue.registry.mappingVersion
      && Array.isArray(item.mappingIds) && item.mappingIds.length > 0 && item.mappingIds.every(id => mappings.some(mapping => mapping.id === id))
      && Array.isArray(item.sourceFields) && item.sourceFields.every(field => receipt.fields.includes(field)),
    'ONTOLOGY_STATE_CHANGED', 'A semantic fact has no valid receipt and mapping provenance.', 409);
    let values;
    if (task.type === 'schedule') {
      invariant(item.concept === 'bob:BookableSlot' && receipt.direction === 'aliceToBob'
        && Object.keys(item.values).sort().join(',') === 'bookable,endMinute,startMinute,weekday',
      'ONTOLOGY_STATE_CHANGED', 'A scheduling fact includes values outside its module.', 409);
      values = toBobNativeSlots([item.values])[0];
      invariant(REQUIRED_CALENDAR_FIELDS.every(field => item.sourceFields.includes(field)),
        'ONTOLOGY_STATE_CHANGED', 'A scheduling fact is missing its disclosed source fields.', 409);
    } else {
      invariant(item.concept === 'alice:MeetingContext' && receipt.direction === 'bobToAlice'
        && Object.keys(item.values).every(field => task.fields.includes(field) && item.sourceFields.includes(field) && typeof item.values[field] === 'string'),
      'ONTOLOGY_STATE_CHANGED', 'A briefing fact includes values outside its task or received fields.', 409);
      values = Object.fromEntries(Object.entries(item.values));
    }
    return { id: item.id, concept: item.concept, values, receiptId: item.receiptId, payloadHash: item.payloadHash,
      mappingVersion: item.mappingVersion, mappingIds: [...item.mappingIds], sourceFields: [...item.sourceFields] };
  });
  const transcript = dialogue.transcript.map(item => {
    const safe = SAFE_TRANSCRIPT[item.reasonCode];
    invariant(safe && Number.isSafeInteger(item.sequence) && item.sequence > 0 && ['Alice', 'Bob'].includes(item.from)
      && ['Alice', 'Bob'].includes(item.to), 'ONTOLOGY_STATE_CHANGED', 'The dialogue transcript contains an unsupported event.', 409);
    return { sequence: item.sequence, from: item.from, to: item.to, move: safe[0], kind: safe[1], reasonCode: item.reasonCode,
      message: safe[2], moduleIds: (item.moduleIds ?? []).filter(id => selection.selectedModules.some(entry => entry.id === id)),
      mappingIds: (item.mappingIds ?? []).filter(id => proposalMappings.some(entry => entry.id === id)) };
  });
  const result = {
    version: ONTOLOGY_DIALOGUE_VERSION, revision: dialogue.revision, scenario: dialogue.scenario, mode: dialogue.mode, task, status: dialogue.status,
    ontologyVersions: clone(dialogue.ontologyVersions), ...selection,
    proposal: { source: dialogue.proposal.source === 'model' ? 'model' : 'guided', mappings: proposalMappings },
    interpretation: { calendarFreeMeansBookable: dialogue.interpretation.calendarFreeMeansBookable === null ? null : dialogue.interpretation.calendarFreeMeansBookable === true,
      scope: task.id, authorizesDisclosure: false },
    transcript, registry: { version: 1, mappingVersion: dialogue.registry.mappingVersion, mappings, facts, receipts, hash: null },
  };
  if (Array.isArray(dialogue.protocol)) result.protocol = dialogue.protocol.map(item => {
    const move = item.move ?? ({ module: 'pick', proposal: 'propose', decision: 'decide', ack: 'end' })[item.kind];
    invariant(Number.isSafeInteger(item.sequence) && item.sequence > 0 && ['Alice', 'Bob'].includes(item.from)
      && ['Alice', 'Bob'].includes(item.to) && ['join', 'pick', 'propose', 'decide', 'end', 'close'].includes(move),
    'ONTOLOGY_STATE_CHANGED', 'The signed protocol evidence contains an invalid move or role.', 409);
    // Preserve a recorded runtime check, never infer cryptographic verification merely from signature-shaped text.
    const entry = { sequence: item.sequence, from: item.from, to: item.to, move,
      verified: item.verified === true, verification: item.verified === true ? 'runtime_confirmed' : 'reload_hash_only' };
    if (item.payloadHash !== undefined) {
      invariant(DIGEST.test(item.payloadHash), 'ONTOLOGY_STATE_CHANGED', 'Protocol payload digest is invalid.', 409);
      entry.payloadHash = item.payloadHash;
    }
    if (item.mappingVersion !== undefined) {
      invariant(item.mappingVersion === null || DIGEST.test(item.mappingVersion), 'ONTOLOGY_STATE_CHANGED', 'Protocol mapping version is invalid.', 409);
      entry.mappingVersion = item.mappingVersion;
    }
    if (item.version !== undefined) {
      invariant(Number.isSafeInteger(item.version) && item.version > 0 && item.version <= 10, 'ONTOLOGY_STATE_CHANGED', 'Protocol evidence version is invalid.', 409);
      entry.version = item.version;
    }
    if (item.signature !== undefined) {
      invariant(typeof item.signature === 'string' && /^[A-Za-z0-9+/=]{80,200}$/.test(item.signature), 'ONTOLOGY_STATE_CHANGED', 'Protocol evidence signature is invalid.', 409);
      entry.signature = item.signature;
    }
    return entry;
  });
  return seal(result);
}
