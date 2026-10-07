export const SCENARIO_VERSION = 'synthetic-calendar-v1';
export const ALICE_CALENDAR = [
  { day: 'Tue', time: '10:00–10:30', status: 'Free', title: '', note: '' },
  { day: 'Tue', time: '14:00–15:00', status: 'Busy', title: 'Project review', note: 'Bring a draft' },
  { day: 'Wed', time: '11:00–11:30', status: 'Free', title: '', note: '' },
  { day: 'Wed', time: '16:00–17:00', status: 'Busy', title: 'Personal appointment', note: 'Fictional private note' },
  { day: 'Thu', time: '09:00–10:00', status: 'Busy', title: 'Budget planning', note: 'Prepare estimates' },
  { day: 'Thu', time: '15:00–15:30', status: 'Free', title: '', note: '' }
];
export const REPLAY_STEPS = [
  { stage: 'initial', text: 'Reference trace: the participant shares only Tuesday and Wednesday free times.', fields: ['day', 'time', 'status'], window: 'Tue–Wed' },
  { stage: 'additional', text: 'Reference trace: Bob finds no common time in the received scope and asks for more.', fields: [], window: null },
  { stage: 'additional', text: 'Reference trace: the participant adds Thursday free times, without titles or notes.', fields: ['day', 'time', 'status'], window: 'Thu' },
  { stage: 'waiting_admin', text: 'Reference trace: Bob requests permission from his owner to share a meeting brief.', fields: ['topic', 'agenda'], window: null },
  { stage: 'complete', text: 'Reference trace: the owner permits one topic-only sharing. The meeting is Thursday 15:00–15:30.', fields: ['topic'], window: null }
];
