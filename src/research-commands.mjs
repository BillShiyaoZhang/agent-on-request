import { requireThat } from './errors.mjs';

const SHARED_TASKS = ['schedule', 'select_presentation', 'prepare_discussion'];
const PRESETS = {
  schedule: '请和 Bob 约一次 30 分钟的学术讨论。',
  select_presentation: '请和 Bob 选择一场共同参加的报告。',
  prepare_discussion: '请和 Bob 筹备学术讨论。先准备一份未公开研究材料的分享方案交给我审阅，再根据实际获准交换的内容安排议程，最后把场地预约表单交给我决定是否提交。',
};

export const defaultResearchCommand = type => PRESETS[type] ?? '';

/** Routes the demo's bounded task vocabulary, preserving the authenticated
 * owner's full instruction for Alice's native run. It never grants permission.
 * Unknown native goals remain private research work instead of being sent to Bob.
 */
export function resolveResearchCommand(input, { nativeAvailable = false } = {}) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'RESEARCH_COMMAND', 'Provide a command object.');
  requireThat(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 4000,
    'RESEARCH_COMMAND', '请输入 1–4000 字的指令。 / Enter a command of 1–4000 characters.');
  const command = input.text.trim();
  const mode = input.mode ?? 'controlled';
  requireThat(['controlled', 'native'].includes(mode), 'RESEARCH_MODE', 'Choose Guided or Native Hermes.');
  requireThat(mode !== 'native' || nativeAvailable, 'RESEARCH_MODE', 'Native Hermes is not configured.', 409);
  let type = input.type ?? 'auto';
  requireThat(['auto', ...SHARED_TASKS, 'research_work'].includes(type), 'RESEARCH_TASK_TYPE', 'Choose a supported task.');
  if (type === 'auto') {
    const text = command.toLowerCase();
    const prepare = /筹备|准备.{0,16}(?:讨论|研讨)|议程|预约.{0,12}(?:场地|会议室)|(?:book|reserve).{0,24}(?:room|venue)|prepar(?:e|ing|ation).{0,24}(?:discussion|meeting)|agenda/.test(text);
    const presentation = /(?:选|挑|推荐|参加).{0,20}(?:报告|讲座)|(?:报告|讲座).{0,12}(?:选|共同参加)|(?:choose|select|pick|attend).{0,32}(?:talk|presentation|lecture)/.test(text);
    const schedule = /(?:约|安排|协调|共同|空闲|忙闲|时间).{0,24}(?:讨论|研讨|时间|日程)|(?:讨论|日程).{0,16}(?:时间|空闲)|(?:schedule|coordinate).{0,32}(?:discussion|meeting|time)|(?:find|shared|common).{0,24}(?:time|availability)|(?:meet|discuss).{0,24}(?:bob|alice)/.test(text);
    type = prepare ? 'prepare_discussion' : presentation && !schedule ? 'select_presentation' : schedule && !presentation ? 'schedule' : undefined;
    if (!type && mode === 'native') type = 'research_work';
    requireThat(type, 'RESEARCH_COMMAND_INTENT',
      '请选择「约讨论」「选报告」或「筹备讨论」来说明任务；自由研究指令需要 Native Hermes。 / Choose a scenario to clarify the task; open research commands need Native Hermes.', 422);
  }
  requireThat(type !== 'research_work' || mode === 'native', 'RESEARCH_MODE', 'Private research work needs Native Hermes.', 409);
  return { type, mode, command, ...(type === 'research_work' ? { goal: command } : {}) };
}
