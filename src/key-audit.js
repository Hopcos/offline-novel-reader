// i18n key audit: every data-i18n*/I18N.t(...) key must exist in BOTH zh and en tables.
// Evaluates the real language tables in a VM (exact key set), then scans all parts.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcDir = __dirname;
const read = f => fs.readFileSync(path.join(srcDir, f), 'utf8');

// 1) assemble script parts 1..7 (same sources concat.js uses), extract module JS
let all = '';
for (const p of ['part1', 'part2', 'part3', 'part4', 'part5', 'part6', 'part7', 'part8']) all += read(p + '.html') + '\n';
let script = all;
const m = all.match(/<script type="module">([\s\S]*?)<\/script>/);
script = m ? m[1] : script;

// 2) eval parts 2..6 in a VM to get the real I18N_LANGS (part7 boots on eval -> excluded)
const part2 = read('part2.html');
const js2 = part2.slice(part2.indexOf('<script type="module">') + '<script type="module">'.length);
const js = [js2, read('part3.html'), read('part4.html'), read('part5.html'), read('part6.html')].join('\n');
const noop = () => {};
const fakeEl = () => ({
  getContext: () => null, style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, querySelectorAll: () => [], querySelector: null, contains: () => false,
  addEventListener: noop, textContent: '', innerHTML: '', value: '',
});
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, structuredClone,
  document: { createElement: () => fakeEl(), querySelector: () => fakeEl(), querySelectorAll: () => [], addEventListener: noop, body: fakeEl(), getElementById: () => fakeEl() },
  navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(js, sb);
vm.runInContext('globalThis.__langs = I18N_LANGS;', sb);
const zh = new Set(Object.keys(sb.__langs.zh));
const en = new Set(Object.keys(sb.__langs.en));

// 3) collect used keys
const used = new Set();
for (const mm of all.matchAll(/data-i18n(?:-ph|-title|-html)?="([^"]+)"/g)) used.add(mm[1]);
for (const mm of script.matchAll(/I18N\.t\('([^']+)'/g)) {
  const k = mm[1];
  // dynamic like t('d_' + d.id) -> record base 'd_'
  const plus = k.indexOf("' + ");
  if (plus >= 0) { used.add(k.slice(0, plus)); continue; }
  used.add(k);
}
for (const mm of script.matchAll(/I18N\.t\("([^"]+)"/g)) used.add(mm[1]);
// 动态键 d_/d_hint_ + dict id（en2cn/cn2en/idioms/chars）展开为具体键
const DICT_IDS = ['en2cn', 'cn2en', 'zh', 'idioms', 'chars'];
for (const pre of ['d_', 'd_hint_']) {
  if (used.has(pre)) { used.delete(pre); DICT_IDS.forEach(id => used.add(pre + id)); }
}

const missingZh = [...used].filter(k => !zh.has(k));
const missingEn = [...used].filter(k => !en.has(k));
console.log('zh keys:', zh.size, '| en keys:', en.size, '| used keys:', used.size);
const diff = [...zh].filter(k => !en.has(k)).concat([...en].filter(k => !zh.has(k)));
if (diff.length) { console.error('zh/en tables differ:', diff.join(', ')); process.exit(1); }
if (missingZh.length || missingEn.length) {
  console.error('MISSING in zh:', missingZh.join(', '));
  console.error('MISSING in en:', missingEn.join(', '));
  process.exit(1);
}
console.log('ALL I18N KEYS RESOLVED (both languages, sets identical)');
