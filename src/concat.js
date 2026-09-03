// Build script: concatenate _build/part*.html into index.html and extract the
// inline module script for a syntax check.
'use strict';
const fs = require('fs');
const path = require('path');

const buildDir = __dirname; // 本脚本位于 _build/ 目录内
const parts = [];
for (const p of ['part1', 'part2', 'part3', 'part4', 'part5', 'part6', 'part7', 'part8']) {
  parts.push(fs.readFileSync(path.join(buildDir, p + '.html'), 'utf8'));
}
const html = parts.join('\n');
const out = path.join(__dirname, '..', 'index.html'); // 输出到仓库根目录
fs.writeFileSync(out, html, 'utf8');
console.log('index.html bytes:', Buffer.byteLength(html));

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('NO MODULE SCRIPT FOUND');
  process.exit(1);
}
fs.writeFileSync(path.join(buildDir, 'check.js'), m[1], 'utf8');

// quick sanity greps
const forbidden = ['</script>', '<!--'];
for (const f of forbidden) {
  const idx = m[1].indexOf(f);
  if (idx >= 0) {
    console.error('FORBIDDEN SEQUENCE IN SCRIPT at', idx, JSON.stringify(f));
    process.exit(1);
  }
}
console.log('script bytes:', Buffer.byteLength(m[1]));
