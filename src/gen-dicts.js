'use strict';
/* 词典数据生成器（一次性工具，数据来自开源词库）：
 *  - en2cn: ECDICT (skywind3000) 全量 CSV，按 oxford/collins/bnc/frq 词频取高频 5000 词
 *  - cn2en: CC-CEDICT (MDBG, CC BY-SA) 纯中文词头（1-3 字），取前 6000 条
 * 输出为 RAW_DICTS 模板内容（word|gloss 每行一条），由 splice 脚本写入 part4/part5。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, '..', 'tmp-dict-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sanitizeGloss(s, maxLen) {
  let g = String(s || '')
    .replace(/`/g, '')
    .replace(/\|/g, '，')
    .replace(/\\n/g, ';')            // ECDICT 用字面 \n 表示换行
    .replace(/\r/g, '')
    .replace(/\[[a-z\u4e00-\u9fff]{1,6}\]/g, ';') // 去掉 [计]/[化] 等学科标注
    .replace(/[;；]+/g, ';')
    .replace(/\s*;\s*(?=;|$)/g, ';')
    .replace(/^;|;$/g, '')
    .trim();
  // 去掉开头的词性前缀（n./vt./a./ad./phr. 等），保留语义主体，更紧凑
  g = g.replace(/^[a-z]{1,6}\.\s*/i, '');
  if (g.length > maxLen) g = g.slice(0, maxLen) + '…';
  return g;
}

/* ---------- 1. en2cn from ECDICT CSV ---------- */
const ECDICT_TOP_CHARS = []; // 全量中文释义中的高频汉字（常用字白名单，供 cn2en 选词用）
const CJK = /[\u4e00-\u9fff]/;
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

async function genEn2cn() {
  const csvPath = path.join(ROOT, '..', 'tmp-ecdict-x', 'package', 'assets', 'ecdict.csv');
  const rows = [];
  const charCount = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (first) { first = false; continue; } // header
    const word = (f[0] || '').trim();
    const translation = (f[3] || '').trim();
    if (!word || !translation) continue;
    if (!/^[a-zA-Z][a-zA-Z' -]*$/.test(word)) continue; // 纯英文词/短语
    if (word.length < 2) continue;
    if (/\d/.test(word)) continue;
    // 统计常用字：中文字符在全部英文词的中文释义中出现的次数
    if (translation) {
      for (const c of translation) {
        if (CJK.test(c)) charCount.set(c, (charCount.get(c) || 0) + 1);
      }
    }
    const collins = parseInt(f[5] || '0', 10) || 0;
    const oxford = (f[6] || '').trim() === '1' ? 1 : 0;
    const bnc = parseInt(f[8] || '0', 10) || 0;
    const frq = parseInt(f[9] || '0', 10) || 0;
    rows.push({ word, translation, collins, oxford, bnc: bnc || 999999, frq: frq || 999999 });
  }
  console.log('ECDICT candidate rows:', rows.length);
  // 高频汉字 top 1500 作为「常用字」白名单
  const top = [...charCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500);
  for (const [c] of top) ECDICT_TOP_CHARS.push(c);
  console.log('ECDICT top chars:', ECDICT_TOP_CHARS.length, 'e.g.', ECDICT_TOP_CHARS.slice(0, 20).join(''));
  // 排序：oxford 优先 → collins 星级 → bnc → frq
  rows.sort((a, b) =>
    (b.oxford - a.oxford) || (b.collins - a.collins) || (a.bnc - b.bnc) || (a.frq - b.frq) || a.word.localeCompare(b.word));
  const TOP = 5000;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (out.length >= TOP) break;
    if (seen.has(r.word)) continue;
    seen.add(r.word);
    const g = sanitizeGloss(r.translation, 110);
    if (!g) continue;
    out.push(r.word + '|' + g);
  }
  const file = path.join(OUT_DIR, 'en2cn.txt');
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  console.log('en2cn entries:', out.length, '->', file);
}

/* ---------- 2. cn2en from CC-CEDICT ---------- */
function parseCedictLine(line) {
  // 传统 简化 [拼音] /释义1/释义2/
  const sp = line.split(' ');
  if (sp.length < 3) return null;
  const simp = sp[1];
  if (!/^[\u4e00-\u9fff]+$/.test(simp)) return null;
  if (simp.length < 1 || simp.length > 3) return null;
  const defPart = line.slice(line.indexOf('['));
  const end = defPart.indexOf(']');
  if (end < 0) return null;
  const defs = defPart.slice(end + 1).split('/').map(s => s.trim()).filter(Boolean);
  const clean = defs
    .filter(d => !/^\(?surname/i.test(d) && !/^CL:/.test(d) && !/^u[\da-f]{4,}$/i.test(d) && !/^[0-9]/.test(d))
    .slice(0, 4);
  if (!clean.length) return null;
  return { simp, gloss: clean.join(';') };
}

async function genCn2en() {
  const gz = fs.readFileSync(path.join(ROOT, '..', 'tmp-cedict.txt.gz'));
  const raw = zlib.gunzipSync(gz).toString('utf8');
  const lines = raw.split('\n');
  console.log('CEDICT raw lines:', lines.length);
  const byLen = { 1: [], 2: [], 3: [] };
  const seen = new Set();
  const headCharCount = new Map();
  for (const line of lines) {
    if (!line.startsWith('#')) {
      const r = parseCedictLine(line);
      if (r && !seen.has(r.simp)) {
        seen.add(r.simp);
        byLen[r.simp.length].push(r);
        for (const c of r.simp) headCharCount.set(c, (headCharCount.get(c) || 0) + 1);
      }
    }
  }
  console.log('unique pure-Chinese 1-3 char heads:', byLen[1].length, byLen[2].length, byLen[3].length);
  // 常用字：CEDICT 词头字频 top 2000 + ECDICT 义频 top 1500
  const cedictTop = [...headCharCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2000).map(e => e[0]);
  console.log('CEDICT head top chars:', cedictTop.length, 'e.g.', cedictTop.slice(0, 24).join(''));
  // 选词质量：2 字词按「常用度」分层 ——
  //  tier1: 中文释义(zh) 词典已收录的常用词（优先保证）
  //  tier2: 每个字都是「汉字详解」里常见字的组合（图书馆/电脑/机会 这类核心词）
  //  tier3: 其余 2 字词补足数量上限
  const p5 = fs.readFileSync(path.join(ROOT, '..', 'src', 'part5.html'), 'utf8');
  const getTpl = (k, src) => {
    const m = src.match(new RegExp('((?:^|\\n)' + k + ': `)([^`]*)(`)', 'm'));
    return m ? m[2].split('\n').filter(Boolean) : [];
  };
  const charsSet = new Set(getTpl('chars', p5).map(l => l.split('|')[0].trim()).filter(Boolean));
  const zhSet = new Set(getTpl('zh', p5).map(l => l.split('|')[0].trim()).filter(Boolean));
  // 旧版手选 cn2en（git HEAD）包含大量日常词 → 词本身入 tier1，其用字并入常用字白名单
  let oldWords = new Set();
  let oldChars = new Set();
  try {
    const cp = require('child_process');
    const oldP5 = cp.execFileSync('git', ['show', 'HEAD:src/part5.html'], { cwd: path.join(ROOT, '..'), encoding: 'utf8' });
    for (const l of getTpl('cn2en', oldP5)) {
      const w = l.split('|')[0].trim();
      if (w && !w.includes(' ')) { oldWords.add(w); for (const c of w) oldChars.add(c); }
    }
  } catch (e) { console.warn('git HEAD part5 unavailable:', e.message); }
  const whitelist = new Set([...charsSet, ...oldChars, ...[...zhSet].flatMap(w => [...w]), ...ECDICT_TOP_CHARS, ...cedictTop]);
  const tiers = { 1: [], 2: [], 3: [] };
  const pushed = new Set();
  for (const r of byLen[2]) {
    if (pushed.has(r.simp)) continue;
    if (zhSet.has(r.simp) || oldWords.has(r.simp)) { tiers[1].push(r); pushed.add(r.simp); }
    else if ([...r.simp].every(c => whitelist.has(c))) { tiers[2].push(r); pushed.add(r.simp); }
    else tiers[3].push(r);
  }
  console.log('whitelist chars:', whitelist.size, '| tier sizes:', tiers[1].length, tiers[2].length, tiers[3].length);
  // 词频代理：以「双字中较不常用的那个字的词头字频」作为该词的常用度分数，
  // 使常见组合（老师/电脑/手机…）排在稀缺组合之前，避免 CEDICT 文件顺序偏差
  const score2 = r => Math.min(headCharCount.get(r.simp[0]) || 0, headCharCount.get(r.simp[1]) || 0);
  const CAP_TIER2 = 6500;
  const ordered2 = [
    ...tiers[1],
    ...tiers[2].sort((a, b) => score2(b) - score2(a) || 0),
    ...tiers[3].sort((a, b) => score2(b) - score2(a) || 0),
  ].slice(0, CAP_TIER2);
  // 三字常用词：zh 词典已收录的（图书馆/办公室/为什么…）优先，其余按三字最弱字频取 top 700
  const score3 = r => Math.min(...[...r.simp].map(c => headCharCount.get(c) || 0));
  const zh3 = byLen[3].filter(r => zhSet.has(r.simp));
  const other3 = byLen[3].filter(r => !zhSet.has(r.simp)).sort((a, b) => score3(b) - score3(a) || 0);
  const ordered3 = [...zh3, ...other3].slice(0, 900);
  const out = [];
  const used = new Set();
  for (const r of [...ordered2, ...ordered3]) {
    if (out.length >= 7400) break;
    if (used.has(r.simp)) continue;
    used.add(r.simp);
    out.push(r.simp + '|' + sanitizeGloss(r.gloss, 130));
  }
  const file = path.join(OUT_DIR, 'cn2en.txt');
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  console.log('cn2en entries:', out.length, '->', file);
}

(async () => {
  await genEn2cn();
  await genCn2en();
})();
