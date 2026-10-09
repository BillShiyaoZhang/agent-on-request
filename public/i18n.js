import { messages as appMessages, patterns as appPatterns } from './locales/app.js';
import { messages as configMessages, patterns as configPatterns } from './locales/config.js';
import { messages as stateMessages, patterns as statePatterns } from './locales/states.js';
import { messages as commonMessages, patterns as commonPatterns } from './locales/common.js';
import { messages as hierarchyAppMessages, patterns as hierarchyAppPatterns } from './locales/hierarchy-app.js';
import { messages as hierarchyConditionsMessages, patterns as hierarchyConditionsPatterns } from './locales/hierarchy-conditions.js';
import { messages as hierarchyBobMessages, patterns as hierarchyBobPatterns } from './locales/hierarchy-bob.js';
import { messages as hierarchyModelMessages, patterns as hierarchyModelPatterns } from './locales/hierarchy-models.js';
import { messages as experienceParticipantMessages, patterns as experienceParticipantPatterns } from './locales/experience-participant.js';
import { messages as experienceOperatorMessages, patterns as experienceOperatorPatterns } from './locales/experience-operator.js';
import { messages as experienceUnderstandingMessages, patterns as experienceUnderstandingPatterns } from './locales/experience-understanding.js';
import { messages as experienceResearchMessages, patterns as experienceResearchPatterns } from './locales/experience-research.js';
import { messages as refinementMessages, patterns as refinementPatterns } from './locales/refinement.js';
import { messages as ontologyMessages, patterns as ontologyPatterns } from './locales/ontology.js';

export const LANGUAGE_KEY = 'agent-on-request.language';
const messages = { ...commonMessages, ...appMessages, ...configMessages, ...stateMessages, ...hierarchyAppMessages, ...hierarchyConditionsMessages, ...hierarchyBobMessages, ...hierarchyModelMessages, ...experienceParticipantMessages, ...experienceOperatorMessages, ...experienceUnderstandingMessages, ...experienceResearchMessages, ...refinementMessages, ...ontologyMessages };
const reverse = new Map();
for (const [en, zh] of Object.entries(messages)) if (!reverse.has(zh)) reverse.set(zh, en);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compileTemplate(source, target) {
  const names = [];
  let expression = '^', offset = 0;
  for (const match of source.matchAll(/\{([a-zA-Z]\w*)\}/g)) {
    expression += escapeRegex(source.slice(offset, match.index)) + '([\\s\\S]*?)';
    names.push(match[1]); offset = match.index + match[0].length;
  }
  expression += escapeRegex(source.slice(offset)) + '$';
  return { expression: new RegExp(expression), names, target, weight: source.replace(/\{\w+\}/g, '').length };
}
const templates = [...commonPatterns, ...appPatterns, ...configPatterns, ...statePatterns, ...hierarchyAppPatterns, ...hierarchyConditionsPatterns, ...hierarchyBobPatterns, ...hierarchyModelPatterns, ...experienceParticipantPatterns, ...experienceOperatorPatterns, ...experienceUnderstandingPatterns, ...experienceResearchPatterns, ...refinementPatterns, ...ontologyPatterns];
const compiled = {
  zh: templates.map(([en, zh]) => compileTemplate(en, zh)).sort((a, b) => b.weight - a.weight),
  en: templates.map(([en, zh]) => compileTemplate(zh, en)).sort((a, b) => b.weight - a.weight)
};

export function detectLanguage(saved, languages = []) {
  if (saved === 'zh' || saved === 'en') return saved;
  for (const language of languages) {
    const code = String(language).toLowerCase().split('-')[0];
    if (code === 'zh' || code === 'en') return code;
  }
  return 'zh';
}

// Translate presentation strings only. Unknown content (including custom data
// and provider responses) stays verbatim; translations never enter API payloads.
export function translateText(value, language, depth = 0) {
  const text = String(value ?? '');
  if (!text.trim() || depth > 6) return text;
  const source = text.trim();
  const prefix = text.slice(0, text.indexOf(source));
  const suffix = text.slice(prefix.length + source.length);
  const exact = language === 'zh' ? (Object.hasOwn(messages, source) ? messages[source] : undefined) : reverse.get(source);
  if (exact !== undefined) return prefix + exact + suffix;
  if (/\$[\w.[\]-]*[:：] ?/.test(source)) {
    const result = source.replace(/(\$[\w.[\]-]*)[:：] ?([\s\S]*?)(?= \$[\w.[\]-]*[:：] ?|$)/g, (_, path, message) => path + (language === 'zh' ? '：' : ': ') + translateText(message, language, depth + 1));
    if (result !== source) return prefix + result + suffix;
  }
  for (const template of compiled[language] || []) {
    const match = template.expression.exec(source);
    if (!match) continue;
    const values = Object.fromEntries(template.names.map((name, index) => [name, translateText(match[index + 1], language, depth + 1)]));
    const result = template.target.replace(/\{([a-zA-Z]\w*)\}/g, (_, name) => values[name] ?? '');
    return prefix + result + suffix;
  }
  // Lists and validation diagnostics keep their delimiters and JSON paths.
  if (source.includes(' · ') || source.includes(', ')) {
    const result = source.split(/( · |, )/).map(part => /^( · |, )$/.test(part) ? part : translateText(part, language, depth + 1)).join('');
    if (result !== source) return prefix + result + suffix;
  }
  return text;
}

export function initLanguageSwitcher() {
  const button = document.getElementById('language-toggle');
  const buttonHome = button.parentElement;
  let saved;
  try { saved = localStorage.getItem(LANGUAGE_KEY); } catch { /* The switch still works without storage. */ }
  let language = detectLanguage(saved, navigator.languages || [navigator.language]);
  const texts = new WeakMap(), attributes = new WeakMap();
  const excluded = 'script,style,pre,code,textarea,input,[contenteditable],[data-i18n-ignore],[data-config-diff] td:not([colspan]),[data-model-diff] td:not([colspan]),[data-config-profile] option,[data-conditions-bundle] option';
  const translatedAttributes = ['aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'title', 'alt', 'data-label'];

  function localizeText(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) return;
    let record = texts.get(node);
    if (!record || node.data !== record.rendered) record = { source: node.data };
    // An option without a value uses its label as submitted data. Freeze its
    // original value before changing the visible label.
    const option = parent.closest('option');
    if (option && !option.hasAttribute('value')) option.setAttribute('value', option.value);
    record.rendered = translateText(record.source, language);
    texts.set(node, record);
    if (node.data !== record.rendered) node.data = record.rendered;
  }
  function localizeAttributes(element) {
    if (element.closest('script,style,[data-i18n-ignore]')) return;
    let records = attributes.get(element);
    if (!records) { records = new Map(); attributes.set(element, records); }
    for (const name of translatedAttributes) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name);
      let record = records.get(name);
      if (!record || value !== record.rendered) record = { source: value };
      record.rendered = translateText(record.source, language);
      records.set(name, record);
      if (value !== record.rendered) element.setAttribute(name, record.rendered);
    }
  }
  function localize(root) {
    if (root.nodeType === Node.TEXT_NODE) { localizeText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(excluded)) return;
    localizeAttributes(root);
    // Numeric constants also work in browsers that omit NodeFilter globals.
    const walker = document.createTreeWalker(root, 5);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE) localizeText(node);
      else localizeAttributes(node);
    }
  }
  function updateButton() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    button.textContent = language === 'zh' ? 'English' : '中文';
    button.setAttribute('aria-label', language === 'zh' ? '切换到英文' : 'Switch to Chinese');
    button.setAttribute('title', language === 'zh' ? '切换到英文' : 'Switch to Chinese');
    button.setAttribute('lang', language === 'zh' ? 'en' : 'zh-CN');
  }
  function placeButton() {
    // Keep the same single switch accessible while a modal makes the page inert.
    const dialog = document.querySelector('dialog[open]');
    const host = dialog?.querySelector('.dialog-header') || buttonHome;
    if (button.parentElement !== host) host.insertBefore(button, dialog ? host.lastElementChild : host.firstChild);
  }
  const observer = new MutationObserver(changes => {
    for (const change of changes) {
      if (change.type === 'childList') change.addedNodes.forEach(localize);
      else if (change.type === 'characterData') localizeText(change.target);
      else localizeAttributes(change.target);
    }
    placeButton();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...translatedAttributes, 'open'] });
  updateButton(); localize(document.body);
  button.addEventListener('click', () => {
    language = language === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* In-memory language selection remains available. */ }
    updateButton(); localize(document.body);
    document.dispatchEvent(new CustomEvent('languagechange', { detail: { language } }));
  });
  // A second open tab follows the selected preference without reloading.
  window.addEventListener('storage', event => {
    if (event.key !== LANGUAGE_KEY || !['en', 'zh'].includes(event.newValue) || event.newValue === language) return;
    language = event.newValue; updateButton(); localize(document.body);
  });
  return { getLanguage: () => language };
}
