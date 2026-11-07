import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchEngine } from '../src/research-engine.mjs';

const validFields = () => ({ title: 'Joint research discussion', day: 'Thu', time: '15:00–15:30', attendees: '8', agenda: 'Discuss methods and review evidence.' });
async function fixture(t) {
  const engine = await new ResearchEngine({ persist: false }).init();
  t.after(() => engine.close());
  const created = await engine.create(), w = engine.get(created.workspaceId);
  await engine.start(w.id, { type: 'prepare_discussion' });
  const task = w.tasks.at(-1);
  const prepare = fields => engine.tool(w.id, task.id, 'Alice', 'artifact_prepare', { kind: 'reservation', title: 'Reviewable reservation', fields, sourceRefs: [] });
  return { engine, w, task, prepare };
}
const reservationError = (field, value, expected) => error => {
  assert.equal(error.code, 'RESERVATION_FIELDS');
  assert.ok(error.message.includes(`"${field}"`));
  assert.ok(error.message.includes(JSON.stringify(value)));
  assert.match(error.message, expected);
  return true;
};

test('reservation validation identifies missing or misspelled required field names', async t => {
  const { prepare } = await fixture(t);
  for (const field of ['title', 'day', 'time', 'attendees', 'agenda']) {
    const fields = validFields();
    delete fields[field];
    await assert.rejects(prepare(fields), error => {
      assert.equal(error.code, 'RESERVATION_FIELDS');
      assert.match(error.message, new RegExp(`Missing reservation field "${field}"`));
      assert.match(error.message, /title, day, time, attendees, agenda/);
      return true;
    });
  }
  const fields = validFields(); delete fields.day; fields.weekday = 'Thu';
  await assert.rejects(prepare(fields), error => {
    assert.equal(error.code, 'RESERVATION_FIELDS');
    assert.match(error.message, /"day"/);
    assert.match(error.message, /weekday/);
    return true;
  });
});

test('invalid day errors list exact weekday values and the submitted value without converting it', async t => {
  const { prepare, w } = await fixture(t);
  for (const day of ['Thursday', '周四', '2026-11-05', 'Thu ', 'thu', '']) {
    await assert.rejects(prepare({ ...validFields(), day }), reservationError('day', day, /Mon, Tue, Wed, Thu, Fri, Sat, Sun/));
  }
  assert.equal(w.artifacts.filter(artifact => artifact.kind === 'reservation').length, 0);
});

test('invalid time errors identify the required format, same-day ordering and submitted value', async t => {
  const { prepare } = await fixture(t);
  for (const time of ['15:30–15:00', '15:00–15:00', '23:30–00:30', '24:00–25:00', '15:60–16:00', '15:00', '3pm-4pm', '15:00—15:30', '']) {
    await assert.rejects(prepare({ ...validFields(), time }), error => {
      reservationError('time', time, /HH:MM–HH:MM/)(error);
      assert.match(error.message, /same-day/);
      assert.match(error.message, /start < end/);
      return true;
    });
  }
});

test('attendees errors require a bounded positive-integer string and retain the invalid input', async t => {
  const { prepare } = await fixture(t);
  for (const attendees of ['0', '0000', '-1', '+2', '2.5', '1e2', ' 2 ', '2 people', 'Alice, Bob', '1001', '01000', '']) {
    await assert.rejects(prepare({ ...validFields(), attendees }), error => {
      reservationError('attendees', attendees, /positive-integer string/)(error);
      assert.match(error.message, /1–1000/);
      assert.match(error.message, /1–4 digits/);
      assert.match(error.message, /Received string/);
      return true;
    });
  }
});

test('reservation revalidation reports non-string attendees types and values before requesting permission', async t => {
  const { engine, w, task, prepare } = await fixture(t);
  const draft = await prepare(validFields());
  const artifact = w.artifacts.find(item => item.id === draft.id);
  const initialRequests = engine.ledger(w, 'Alice').list().requests.length;
  // Legacy or modified stored drafts are checked again at the action boundary,
  // in addition to the generic text-field checks during draft preparation.
  for (const [value, type] of [[8, 'number'], [null, 'null'], [['Alice', 'Bob'], 'array'], [{ count: 8 }, 'object']]) {
    artifact.fields.attendees = value;
    await assert.rejects(engine.tool(w.id, task.id, 'Alice', 'authorization_request', { action: 'reservation.submit', resourceId: draft.id, venueId: 'room-a' }), error => {
      reservationError('attendees', value, /positive-integer string/)(error);
      assert.ok(error.message.includes(`Received ${type}`));
      return true;
    });
  }
  assert.equal(engine.ledger(w, 'Alice').list().requests.length, initialRequests);
  assert.equal(w.reservations.length, 0);
});

test('title and agenda errors name the empty field while valid forms preserve their exact values', async t => {
  const { prepare } = await fixture(t);
  for (const field of ['title', 'agenda']) {
    for (const value of ['', '   ']) {
      await assert.rejects(prepare({ ...validFields(), [field]: value }), reservationError(field, value, /non-empty text/));
    }
  }
  for (const attendees of ['1', '0001', '1000']) {
    for (const time of ['15:00–15:30', '15:00-15:30']) {
      const fields = { ...validFields(), title: '  Keep this exact title  ', attendees, time, context: 'An additional text field remains permitted.' };
      const draft = await prepare(fields);
      assert.deepEqual(draft.fields, fields, 'Validation must not trim, rename or semantically normalize the reviewed form');
    }
  }
});
