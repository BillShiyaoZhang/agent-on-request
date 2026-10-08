import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, translateText } from '../public/i18n.js';

test('language follows the saved choice, then supported browser preferences', () => {
  assert.equal(detectLanguage('en', ['zh-CN']), 'en');
  assert.equal(detectLanguage(null, ['fr', 'zh-TW', 'en']), 'zh');
  assert.equal(detectLanguage('invalid', ['en-US']), 'en');
  assert.equal(detectLanguage(null, ['fr']), 'zh');
});

test('static and dynamic UI strings translate in both directions', () => {
  for (const text of ['Researcher sign in', 'Test saved Alice configuration', 'Draft edit 3', 'Both agents confirmed the fictional meeting: Thu 15:00–15:30.']) {
    const chinese = translateText(text, 'zh');
    assert.notEqual(chinese, text);
    assert.equal(translateText(chinese, 'en'), text);
  }
  assert.equal(translateText('  Researcher sign in\n', 'zh'), '  研究者登录\n');
  assert.equal(translateText('Mon, Tue, Wed', 'zh'), '周一, 周二, 周三');
});

test('Chinese source text is readable in English while unknown user content stays exact', () => {
  assert.equal(translateText('请先在管理员模型配置中保存 Token Plan 专用 Key。', 'en'), 'Save a Token Plan API key in the researcher model configuration first.');
  assert.equal(translateText('My private custom value <keep> 中文', 'en'), 'My private custom value <keep> 中文');
  assert.equal(translateText('My private custom value <keep> 中文', 'zh'), 'My private custom value <keep> 中文');
  for (const label of ['constructor', 'toString', '__proto__']) assert.equal(translateText(label, 'zh'), label);
  const disclosure = '本轮 Alice 使用 MiniMax-M3，Bob 使用 MiniMax-M3，模型服务地址为 https://api.minimax.cn/v1。Live 会把虚构日历发给 Alice 的模型；Bob 的模型只收到实际授权传送给 Bob 的日历投影，以及 Bob 自己的模拟信息。服务商可能按照其政策处理和保留输入；模型错误会明确显示。';
  const english = translateText(disclosure, 'en');
  assert.match(english, /^In this round, Alice uses MiniMax-M3/);
  assert.match(english, /https:\/\/api.minimax.cn\/v1/);
  assert.equal(translateText(english, 'zh'), disclosure);
});

test('joined validation messages translate without rewriting property paths', () => {
  const errors = '$.agents.Alice.temperature: Must be a number from 0 to 2. $.agents.Bob.retryLimit: Must be an integer from 0 to 3.';
  const translated = translateText(errors, 'zh');
  assert.match(translated, /\$\.agents\.Alice\.temperature：必须是/);
  assert.match(translated, /\$\.agents\.Bob\.retryLimit：必须是/);
  assert.equal(translateText(translated, 'en'), errors);
});
