'use strict';
/* 把生成的词典数据拼进 part4/part5（RAW_DICTS 模板），并保留旧 cn2en 的单字词条。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function tplContent(src, key) {
  const re = new RegExp('((?:^|\\n)' + key + ': `)([^`]*)(`)', 'm');
  const m = src.match(re);
  if (!m) throw new Error('template not found: ' + key);
  return m[2];
}

function replaceTpl(src, key, content) {
  const re = new RegExp('((?:^|\\n)' + key + ': `)[^`]*(`)', 'm');
  if (!re.test(src)) throw new Error('template not found: ' + key);
  // 函数式替换：避开字符串替换对 $ 序列的解释；内容相同（幂等重跑）时结果不变，属正常
  return src.replace(re, (m, p1, p2) => p1 + content + p2);
}

// 1) en2cn
const en2cn = fs.readFileSync(path.join(ROOT, 'tmp-dict-out', 'en2cn.txt'), 'utf8').trim();
let p4 = fs.readFileSync(path.join(ROOT, 'src', 'part4.html'), 'utf8');
p4 = replaceTpl(p4, 'en2cn', en2cn);
fs.writeFileSync(path.join(ROOT, 'src', 'part4.html'), p4, 'utf8');
console.log('part4 en2cn replaced, entries =', en2cn.split('\n').filter(Boolean).length);

// 2) cn2en：新数据 + 旧单字词条
let p5 = fs.readFileSync(path.join(ROOT, 'src', 'part5.html'), 'utf8');
const oldCn2en = tplContent(p5, 'cn2en');
const oldSingles = [];
for (const line of oldCn2en.split('\n')) {
  const i = line.indexOf('|');
  if (i > 0) {
    const w = line.slice(0, i).trim();
    const g = line.slice(i + 1).trim();
    if (w.length === 1 && g && !w.includes(' ')) oldSingles.push(w + '|' + g);
  }
}
const newCn2en = fs.readFileSync(path.join(ROOT, 'tmp-dict-out', 'cn2en.txt'), 'utf8').trim();
const seen = new Set(newCn2en.split('\n').map(l => l.split('|')[0]));
const merged = newCn2en.split('\n').filter(Boolean);
for (const line of oldSingles) {
  const w = line.split('|')[0];
  if (!seen.has(w)) { seen.add(w); merged.push(line); }
}
p5 = replaceTpl(p5, 'cn2en', merged.join('\n'));
fs.writeFileSync(path.join(ROOT, 'src', 'part5.html'), p5, 'utf8');
console.log('part5 cn2en replaced, entries =', merged.length, '(+', merged.length - newCn2en.split('\n').length, 'single chars from old)');
