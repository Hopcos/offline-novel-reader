// Unit tests for the novel-reader's pure logic, run in Node with a VM context
// that mirrors the browser globals the code touches (no DOM needed for these paths).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

// ---- assemble JS from the build parts (skip part7/8: App + HTML tail) ----
const part2 = read('part2.html');
const js2 = part2.slice(part2.indexOf('<script type="module">') + '<script type="module">'.length);
const js = [
  js2,                 // utils, EventBus, storage adapters
  read('part3.html'),  // decode, splitChapters, worker, DataManager, DictionaryService
  read('part4.html'),  // en2cn data
  read('part5.html'),  // cn2en + idioms + chars data
  read('part6.html'),  // TTSManager(skip runtime), LineBreaker, ChapterPager, Reader(skip)
].join('\n');

// ---- browser-ish shims ----
const fakeCtx = {
  font: '',
  measureText(text) {
    // parse "Npx family" from this.font
    const size = /(\d+(?:\.\d+)?)px/.exec(this.font) ? parseFloat(/[0-9.]+px/.exec(this.font)[0]) : 16;
    let w = 0;
    for (const ch of text) {
      w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? size : (ch === ' ' ? size * 0.3 : size * 0.55);
    }
    return { width: w };
  },
};
fakeCtx.measureText = fakeCtx.measureText.bind(fakeCtx);

const noop = () => {};
const fakeClassList = () => ({ add: noop, remove: noop, toggle: noop, contains: () => false });
const fakeStyle = () => ({ width: '', setProperty: noop });
const fakeElRoot = () => ({
  getContext: () => fakeCtx,
  style: fakeStyle(), dataset: {}, classList: fakeClassList(),
  appendChild: noop, querySelectorAll: () => [], querySelector: () => fakeElRoot(),
  contains: () => false, addEventListener: noop,
  textContent: '', innerHTML: '', value: '',
});
const fakeEl = () => fakeElRoot();
global.localStorage = (() => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
})();

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextDecoder,
  document: { createElement: () => fakeEl(), querySelector: () => fakeElRoot(), querySelectorAll: () => [], addEventListener: noop, body: fakeElRoot() },
  window: null,
  localStorage: global.localStorage,
  navigator: {},
  structuredClone,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(js, sandbox, { filename: 'app-parts.js' });
// class/const/let 声明不挂到全局对象，需在 context 内显式导出后取用
vm.runInContext(`
  globalThis.__exports = {
    EventBus, DictionaryService, DataManager, LocalStorageAdapter,
    LineBreaker, ChapterPager, splitChapters, decodeTextBytes, fnv1a, WORKER_SCRIPT,
    I18N, I18N_LANGS,
  };
`, sandbox);
const X = sandbox.__exports;

// ============================= tests =============================
let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  => ' + detail : '')); }
}

(async () => {
  console.log('\n[1] splitChapters');
  {
    const s = X.splitChapters;
    const sample = [
      '第一章 风起', '他站在山巅，看云海翻涌。', '今天的风很大。', '',
      '第二章 雨来', '大雨倾盆而下。', '他转身离去。', '',
      '第三章 雪落', '雪落无声。', '终于到家了。', '',
    ].join('\n');
    const r = s(sample);
    check('splits into 3 chapters', r.chapters.length === 3, 'got ' + r.chapters.length);
    check('titles correct', r.chapters[0].title === '第一章 风起' && r.chapters[1].title === '第二章 雨来');
    check('paras kept', r.chapters[1].paras.length === 2 && r.chapters[1].paras[0] === '大雨倾盆而下。');
    const total = r.chapters.reduce((n, c) => n + c.chars, 0);
    check('totalChars consistent', r.totalChars === total && r.totalChars > 0, String(r.totalChars));

    const fallback = s('这是一段没有任何章节标记的文字。\n第二段。\n' + '第三段，风雨交加，电闪雷鸣。'.repeat(1600));
    check('fallback chunking works', fallback.chapters.length >= 2, 'got ' + fallback.chapters.length);
    check('fallback keeps boundaries', fallback.totalChars > 500);
    check('empty doc guarded', s('').chapters.length >= 1);
  }

  console.log('\n[2] decodeTextBytes');
  {
    const d = X.decodeTextBytes;
    const utf8 = d(new TextEncoder().encode('你好世界'));
    check('utf-8 decode', utf8.text === '你好世界', utf8.text);
    const gbk = d(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3])); // 你好 in GBK
    check('gbk decode', gbk.text === '你好' && gbk.encoding === 'gbk', gbk.text + ' / ' + gbk.encoding);
    const bom = d(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x62]));
    check('BOM stripped', bom.text === 'ab', JSON.stringify(bom.text));
  }

  console.log('\n[3] DictionaryService');
  {
    const bus = new X.EventBus();
    const dict = new X.DictionaryService(bus);
    await dict.init([]);
    const trCn = dict.translate('好好学习，天天向上');
    check('cn translate yields segments', trCn.segments.length >= 4, String(trCn.segments.length));
    check('cn translate has glosses', trCn.segments.some(s => s.gloss), JSON.stringify(trCn.segments.slice(0, 4)));
    const trEn = dict.translate('I look forward to this great day');
    check('en translate phrase match', trEn.glossText.includes('期待'), trEn.glossText);
    check('en translate unknown tracking', Array.isArray(trEn.unknown) && trEn.unknown.length === 0, JSON.stringify(trEn.unknown));
    const ex = dict.explain('一见钟情');
    check('idiom found in explain', ex && ex.idiom && ex.idiom.word === '一见钟情', JSON.stringify(ex && ex.idiom));
    const ex2 = dict.explain('这个人很厉害');
    check('word parse in explain', ex2.words.length >= 2, JSON.stringify(ex2.words));
    // 复现「成语」标签的全文滑动扫描（若把 i 改成 const 会在此抛错，防止回归）
    const scan = (text) => {
      const out = [];
      for (let i = 0; i < text.length; i++) {
        for (let L = 4; L >= 3; L--) {
          const w = text.slice(i, i + L);
          if (dict.maps.idioms.has(w)) { out.push(w); if (out.length > 40) break; }
        }
      }
      return out;
    };
    const found = scan('他这个人总是一见钟情，真是令人敬佩。');
    check('idiom tab scan finds idiom', found.includes('一见钟情'), JSON.stringify(found));
    // custom entry precedence
    await dict.addCustomEntry('幻辰诀', 'a legendary technique from my novel');
    const lk = dict.lookup('幻辰诀', 'cn2en');
    check('custom entry overrides', lk && lk.dict === '自定义', JSON.stringify(lk));
    await dict.removeCustomEntry('幻辰诀');
    check('custom entry removed', dict.lookup('幻辰诀', 'cn2en') === null);
    check('detectLang cn', X.DictionaryService.detectLang('中文测试') === 'cn');
    check('detectLang en', X.DictionaryService.detectLang('hello world') === 'en');
    // 翻译方向自动选择：中→英 / 英→中
    const pickDir = lang => (lang === 'cn' ? 'cn2en' : 'en2cn');
    check('translate auto direction cn', pickDir(X.DictionaryService.detectLang('你好世界')) === 'cn2en');
    check('translate auto direction en', pickDir(X.DictionaryService.detectLang('hello world')) === 'en2cn');
  }

  console.log('\n[4] LineBreaker + ChapterPager');
  {
    const breaker = new X.LineBreaker();
    const font = breaker.fontString(18, 'serif');
    const lines = await breaker.breakLines('今天天气很好，我们一起去爬山。'.repeat(60), 700, font, 18);
    check('lines produced', lines.length > 5, String(lines.length));
    let coverage = 0;
    for (const [s, e] of lines) { check('line order sane', e > s); coverage += e - s; }
    check('lines cover whole text', coverage === '今天天气很好，我们一起去爬山。'.length * 60, String(coverage));

    const pager = new X.ChapterPager({
      pageW: 700, pageH: 800, vPad: 20, fontSize: 18, lineHeight: 1.9,
      fontFamily: 'serif', breaker: new X.LineBreaker(),
    });
    const paras = [];
    for (let i = 0; i < 300; i++) paras.push('第' + i + '段。风雨交加，电闪雷鸣，他依然大步向前。'.repeat(2));
    const { pages, charCount, lineCount } = await pager.paginate(paras);
    const totalChars = paras.reduce((n, p) => n + p.length, 0);
    check('pager produces multiple pages', pages.length > 5, String(pages.length));
    let pageChars = 0;
    for (const pg of pages) {
      check('page lines within budget', pg.lines.length <= pager.maxLines, pg.lines.length + ' > ' + pager.maxLines);
      for (const ln of pg.lines) {
        check('line indices valid', ln.p >= 0 && ln.p < paras.length && ln.e > ln.s && ln.e <= paras[ln.p].length);
        pageChars += ln.e - ln.s;
      }
      check('page char range consistent', pg.endChar - pg.startChar === pg.lines.reduce((n, l) => n + (l.e - l.s), 0));
      check('pages ordered', pg.startChar >= 0);
    }
    check('pager covers all chars', pageChars === totalChars && charCount === totalChars,
      pageChars + ' vs ' + totalChars);
    check('lineCount sane', lineCount === pages.reduce((n, p) => n + p.lines.length, 0));
  }

  console.log('\n[5] DataManager CRUD + position + backup (localStorage adapter)');
  {
    const bus = new X.EventBus();
    const dm = new X.DataManager(new X.LocalStorageAdapter(), bus);
    dm._worker = {
      split: async text => {
        const r = X.splitChapters(text);
        return { chapters: r.chapters, totalChars: r.totalChars };
      },
    };
    const text = ['第一卷 启程', '第一章 少年', '少年握紧了剑。', '第二章 试炼', '他走进洞窟。'].join('\n');
    const r1 = await dm.importText({ title: '剑来', sourceName: 'a.txt', text });
    check('first import not duplicate', r1.duplicate === false);
    check('book meta saved', r1.book.chapterCount === 2 && r1.book.totalChars > 0, JSON.stringify(r1.book.chapterCount));
    const r2 = await dm.importText({ title: '剑来2', sourceName: 'b.txt', text });
    check('duplicate detected', r2.duplicate === true && r2.book.id === r1.book.id);
    await dm.replaceBook({ id: r1.book.id, title: '剑来·修订', sourceName: 'a.txt', text });
    const rep = await dm.getBook(r1.book.id);
    check('replaceBook updates title', rep.title === '剑来·修订');
    const pos = await dm.savePosition({ bookId: r1.book.id, chapterIndex: 1, pageIndex: 0, percent: 0.8, charOffset: 100 });
    const got = await dm.getPosition(r1.book.id);
    check('position persisted', got && got.chapterIndex === 1 && got.pageIndex === 0 && Math.abs(got.percent - 0.8) < 1e-9);
    const chs = await dm.loadChapters(r1.book.id);
    check('chapters stored', chs.length === 2 && chs[1].paras[0] === '他走进洞窟。', JSON.stringify(chs.map(c => c.title)));
    check('books list', (await dm.listBooks()).length === 1);

    // settings
    await dm.setSetting('theme', 'dark');
    check('settings round-trip', (await dm.getSetting('theme')) === 'dark');

    // export / overwrite import into a "fresh device"
    const exported = await dm.exportAll();
    global.localStorage.clear();
    const dm2 = new X.DataManager(new X.LocalStorageAdapter(), new X.EventBus());
    check('export contains book+chapters+position', exported.books.length === 1 && exported.chapters[0].items.length === 2 && exported.positions.length === 1);
    const rep2 = await dm2.importAll(exported, 'overwrite');
    check('overwrite import counts', rep2.books === 1 && rep2.chapters === 2 && rep2.positions === 1 && rep2.settings === 1, JSON.stringify(rep2));
    check('restored position', (await dm2.getPosition(r1.book.id)).chapterIndex === 1);
    // merge skips dupes
    const rep3 = await dm2.importAll(exported, 'merge');
    check('merge skips duplicates', rep3.skipped === (1 + 2 + 1 + 1), JSON.stringify(rep3));

    // book id stability
    check('bookId reproducible', X.DataManager.bookIdOf(text) === r1.book.id);
    check('fnv1a stable', X.fnv1a('abc') === X.fnv1a('abc') && X.fnv1a('abc') !== X.fnv1a('abd'));
  }

  console.log('\n[6] splitChapters 中文分卷正确性(worker 可序列化)');
  {
    // worker script must stay self-contained: it only uses splitChapters source
    const src = X.WORKER_SCRIPT;
    check('worker script embeds splitChapters', src.indexOf('function splitChapters') >= 0 && src.indexOf('self.onmessage') >= 0);
    check('worker script has no outer refs', src.indexOf('RAW_DICTS') < 0 && src.indexOf('progressUI') < 0);
  }

  console.log('\n[7] I18n 国际化');
  {
    const I = X.I18N;
    check('both languages present', !!X.I18N_LANGS.zh && !!X.I18N_LANGS.en);
    const zk = Object.keys(X.I18N_LANGS.zh).sort(), ek = Object.keys(X.I18N_LANGS.en).sort();
    check('zh/en key sets identical', JSON.stringify(zk) === JSON.stringify(ek),
      'zh ' + zk.length + ' vs en ' + ek.length + ' keys');
    I.lang = 'zh';
    check('zh t()', I.t('btnImport') === '⬆ 导入小说');
    I.lang = 'en';
    check('en t()', I.t('btnImport') === '⬆ Import');
    check('en params substitution', I.t('metaChap', { n: 12 }) === '12 ch');
    check('unknown key passthrough', I.t('__nope__') === '__nope__');
    I.lang = 'zh';
    check('zh params substitution', I.t('deletedMsg', { title: '剑来' }) === '已删除《剑来》');
    I.lang = 'en';
    check('fmt en K/M', I.fmt(12500) === '12.5K' && I.fmt(150000000) === '150M' && I.fmt(123) === '123', I.fmt(12500) + ' ' + I.fmt(150000000));
    I.lang = 'zh';
    check('fmt zh 万/亿', I.fmt(12500) === '1.3 万' && I.fmt(150000000) === '1.50 亿', I.fmt(12500) + ' ' + I.fmt(150000000));
    // fmtNum 顶层函数委托给 I18N.fmt（上下文内调用）
    check('fmtNum delegates to I18N.fmt', vm.runInContext('fmtNum(12500)', sandbox) === I.fmt(12500));
  }

  console.log(`\n===== RESULT: ${passes} passed, ${failures} failed =====`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
