
'use strict';
/* ============================================================================
   离线小说阅读器 — 应用脚本（单文件模块化）
   架构分层（自底向上）:
     utils           通用工具 / EventBus(观察者)
     storage         StorageAdapter 接口 + IndexedDB / localStorage 两套实现（存储层）
     worker          Web Worker 线程池（多线程章节切分）
     data            DataManager（数据仓库: 书籍/章节/进度 CRUD）
     dict            词典服务（策略模式: 多词典可切换）
     tts             语音朗读服务（浏览器原生 SpeechSynthesis）
     reader          LineBreaker + Pager 分页排版引擎 + Reader 阅读控制器
     backup          备份导出 / 导入（迁移）
     app             App 门面（Facade）：组装以上模块 + 绑定 UI 事件
   ========================================================================== */

/* ---------- 0. 工具函数 utils ---------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** 数字简写（跟随界面语言：中文 万/亿，英文 K/M） */
function fmtNum(n) { return I18N.fmt(n); }

function nowStamp() { return new Date().toISOString(); }

/** 稳定性好的字符串 FNV-1a 哈希（用于生成书籍 ID，可复现，用于去重检测） */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/* ---------- Toast 通知（同一时间只保留一条，固定居中位置，避免多次叠加错位） ---------- */
function toast(msg, isErr = false, ms = 2600) {
  const host = $('#toasts');
  host.textContent = '';
  const box = document.createElement('div');
  box.className = 'toast' + (isErr ? ' err' : '');
  box.textContent = msg;
  host.appendChild(box);
  box._timer = setTimeout(() => box.remove(), ms);
}

/** 通用确认框 → Promise<boolean> */
function confirmDialog({ title = I18N.t('cfTitle'), message = '', okText = I18N.t('ok'), danger = false }) {
  return new Promise(resolve => {
    $('#cf-title').textContent = title;
    $('#cf-message').innerHTML = message;
    const ok = $('#cf-ok');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    const close = val => {
      $('#dlg-confirm').style.display = 'none';
      ok.onclick = null; $('#cf-cancel').onclick = null;
      $('#dlg-confirm').querySelectorAll('[data-close]').forEach(b => b.onclick = null);
      resolve(val);
    };
    ok.onclick = () => close(true);
    $('#cf-cancel').onclick = () => close(false);
    $('#dlg-confirm').querySelectorAll('[data-close]').forEach(b => b.onclick = () => close(false));
    $('#dlg-confirm').style.display = 'flex';
  });
}

/** 进度覆盖层：show 返回 {set(v), setSub(s), done()} */
function progressUI() {
  const wrap = $('#progress-overlay');
  const fill = $('#prog-fill'), pct = $('#prog-pct'), sub = $('#prog-sub'), title = $('#prog-title');
  return {
    show(t) {
      title.textContent = t; fill.style.width = '0%'; pct.textContent = '0%';
      sub.textContent = ''; wrap.classList.add('show');
    },
    set(v) {
      const p = Math.max(0, Math.min(100, Math.round(v * 100)));
      fill.style.width = p + '%'; pct.textContent = p + '%';
    },
    setSub(s) { sub.textContent = s; },
    done() { wrap.classList.remove('show'); },
  };
}

/** 弹窗开关通用绑定 */
function bindModal(modal, openBtn) {
  if (openBtn) openBtn.onclick = () => { modal.style.display = 'flex'; };
  modal.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => { modal.style.display = 'none'; };
  });
  modal.addEventListener('mousedown', e => {
    if (e.target === modal) modal.style.display = 'none';
  });
}

/* ---------- 0.5 国际化 I18n（中 / EN 界面切换，由 App 门面驱动） ----------
 *  用法: I18N.t(key, {param}) 取当前语言文案，{param} 做占位替换；
 *  I18N.applyStatic() 把 [data-i18n] / [data-i18n-ph] / [data-i18n-title] / [data-i18n-html]
 *  的静态文案一次性应用到 DOM（切换语言后重跑即可）。 */
const I18N_LANGS = {
  zh: {
    // 通用 / 标题
    appTitle: '离线小说阅读器',
    appName: '离线小说阅读器',
    untitled: '未命名小说',
    bookCover: '书',
    cancel: '取消',
    ok: '确定',
    // 顶栏
    btnImport: '⬆ 导入小说',
    btnImportBook: '⬆ 导入书籍',
    phOn: '已显示音标与词性',
    phOff: '已隐藏音标与词性',
    btnExport: '导出备份',
    btnImpBack: '导入备份',
    impTitle: '导入 .txt / .md 小说文件（可多选）',
    pasteTitle: '粘贴文本导入',
    exportTitle: '导出全部书籍与阅读进度为备份文件',
    impBackTitle: '从备份文件恢复书籍与阅读进度',
    settingsTitle: '阅读设置',
    helpTitle: '帮助',
    langSwitch: '切换界面语言（中 / EN）',
    phMore: '隐藏/显示\n音标与词性',
    langMore: '切换界面语言\n（中 / EN）',
    moreTitle: '更多功能',
    // 侧栏
    searchPh: '搜索书名 / 作者…',
    dbInit: '数据库…',
    workerInit: '线程:—',
    stDbIdb: 'IndexedDB 已连接',
    stDbLs: '兼容存储(localStorage)',
    workerReady: '后台就绪',
    workerMain: '主线程',
    stWorker: '线程: {m}',
    // 空状态欢迎页
    welcomeHtml: '<b>欢迎使用离线小说阅读器</b>',
    emptyHintHtml: '点击「<b>导入小说</b>」选择 <b>.txt / .md</b> 文件开始阅读（自动识别 UTF-8 / GBK 编码）。',
    emptyMigrateHtml: '换设备时：旧设备点「<b>导出备份</b>」，新设备打开本页后点「<b>导入备份</b>」即可恢复全部书籍与阅读位置。',
    emptyOfflineHtml: '完全离线运行：书籍、进度、词典全部保存在浏览器本地（IndexedDB）。',
    // 阅读工具栏
    tocTitle: '目录',
    chapPrevTitle: '上一章',
    chapNextTitle: '下一章',
    ttsPlayTitle: '从当前页开始朗读（朗读中再点停止）',
    ttsRateTitle: '朗读语速',
    ttsVoiceTitle: '发音人',
    pagePrevTitle: '上一页 (←)',
    pageNextTitle: '下一页 (→)',
    percentTitle: '全书进度',
    phTitle: '隐藏/显示音标与词性',
    noBook: '未打开书籍',
    stHint: '划选正文 → 翻译 / 朗读 · 键盘 ← → 翻页',
    stReading: '🔊 朗读中…',
    lastPage: '已是最后一页',
    firstPage: '已是第一页',
    lastChapter: '已是最后一章',
    firstChapter: '已是第一章',
    // 词典面板
    dictTitle: '📚 词典 · 翻译',
    dictInputPh: '输入或划选文字，回车查询…',
    dictGo: '查询',
    dictNeedQuery: '请输入要查询的文字',
    dictEmptyHtml: '在正文中划选文字，或在上方输入查询。<br>词典数据完全离线打包在本页面中。',
    d_en2cn: '英译中', d_hint_en2cn: '英语单词/短语 → 中文释义',
    d_cn2en: '中译英', d_hint_cn2en: '中文常用词 → 英语释义',
    d_zh: '中文释义', d_hint_zh: '常用中文词汇 → 中文释义',
    d_idioms: '成语', d_hint_idioms: '四字成语 / 惯用语释义',
    d_chars: '汉字', d_hint_chars: '常见汉字 → 简明释义',
    tagZh: '中文释义',
    dictZhEmpty: '中文释义仅适用于中文文本',
    dictZhNone: '暂未收录这些词的中文释义',
    dictZhTitle: '中文释义 · {hit} 个词',
    dictEnEmpty: '当前查询不是英文，请在「中译英」中查看。',
    dictEnTitle: '英 → 中（词典命中 {hit}/{total} 词）',
    dictUnknown: '未收录词',
    dictCnEmpty: '当前查询不是中文，请在「英译中」中查看。',
    dictCnTitle: '中 → 英（分词命中 {hit}/{total} 词）',
    dictNoIdiom: '未找到成语/惯用语。',
    dictIdiomTitle: '成语 / 惯用语（命中 {n} 条）',
    tagIdiom: '成语',
    charsCnOnly: '汉字详解仅支持中文。',
    charsTitle: '逐字详解（{hit}/{total} 字已收录）',
    tagChar: '汉字',
    charsMissing: '未收录字',
    // 划词
    selTranslate: '翻译',
    selSpeak: '朗读',
    selCopy: '复制',
    copied: '已复制',
    copyPrompt: '复制文本：',
    noTts: '当前浏览器不支持语音合成(SpeechSynthesis)',
    speakingSel: '正在朗读选中文字…',
    bookFinished: '全书朗读完成',
    // 粘贴导入
    pasteTitleH: '粘贴导入小说',
    pasteName: '书名',
    pasteNamePh: '必填',
    pasteBody: '正文（可粘贴大段文本，自动切分章节）',
    pasteTextPh: '把小说内容粘贴到这里…',
    pasteOk: '导入',
    pasteSource: '粘贴导入',
    needTitle: '请填写书名',
    needText: '正文不能为空',
    // 设置
    setTitle: '⚙ 阅读设置',
    setTheme: '主题', setFontSize: '字号', setLineHeight: '行距', setFont: '字体',
    setPageWidth: '页宽',
    setHitZone: '点击页面左右两侧边翻页',
    setIndent: '段落首行缩进两字符',
    setSelAction: '划词操作',
    setSelPopup: '弹出工具栏（翻译 / 朗读）',
    setSelAuto: '划词后自动打开词典翻译',
    setNote: '设置与阅读进度会自动保存到浏览器数据库；「导出备份」会包含全部书籍内容、进度与自定义词条。',
    doneBtn: '完成',
    theme_light: '浅色', theme_sepia: '羊皮纸', theme_dark: '深色', theme_green: '护眼绿',
    font_serif: '宋体系 (衬线)', font_kai: '楷体系', font_sans: '黑体系 (无衬线)',
    // 帮助
    helpHtml: '<h4>快速上手</h4>' +
      '<p>「导入小说」选择本地 .txt / .md 文件（支持多选、UTF-8 与 GBK 编码）；也可以「粘贴导入」。</p>' +
      '<p>书籍与阅读位置保存在浏览器 IndexedDB 中，自动持久化，刷新不丢失。</p>' +
      '<h4>换设备迁移</h4>' +
      '<p>旧设备：<b>导出备份</b> → 得到 backup.json；新设备：打开本页面 → <b>导入备份</b> → 全部书籍 + 进度恢复。</p>' +
      '<h4>划词 · 翻译</h4>' +
      '<p>在正文中划选文字，弹出工具栏：<b>翻译</b>（英↔中，右侧词典面板）、<b>朗读</b>（朗读选中片段）。全部离线完成。</p>' +
      '<h4>朗读</h4>' +
      '<p>使用浏览器原生语音合成；点击 ▶ 从当前页连续朗读，朗读到页尾自动翻页；可调节语速与发音人。</p>' +
      '<h4>快捷键与手势</h4>' +
      '<div class="key-row"><span><kbd>←</kbd> / <kbd>→</kbd> 或 <kbd>PageUp</kbd> / <kbd>PageDown</kbd></span><span>上一页 / 下一页</span></div>' +
      '<div class="key-row"><span><kbd>Home</kbd> / <kbd>End</kbd></span><span>章首 / 章末</span></div>' +
      '<div class="key-row"><span>移动端：左右滑动</span><span>翻页</span></div>' +
      '<div class="key-row"><span>「☰」按钮</span><span>打开 / 收起书库</span></div>' +
      '<div class="key-row"><span>长按 / 划选文字</span><span>翻译、朗读</span></div>' +
      '<h4>性能说明</h4>' +
      '<p>章节切分在后台 Web Worker 线程异步执行（多线程），主界面不卡顿；分页排版采用测量分页，翻页流畅。</p>',
    // 确认框 / 进度
    cfTitle: '确认',
    progDefault: '处理中…',
    // 书库
    metaChap: '{n} 章', metaChars: '{n} 字',
    metaRead: '读到 {p}%', metaUnread: '未开始',
    delBookTitle: '删除这本书',
    listEmptySearch: '没有匹配的书籍',
    listEmptyHtml: '书库为空<br>点击右上角「导入小说」开始',
    deleteTitle: '删除书籍',
    deleteMsgHtml: '确定删除《{title}》？<br><span class="muted-text">章节内容与阅读进度将一并删除，且无法撤销。</span>',
    deleteOk: '删除',
    deletedMsg: '已删除《{title}》',
    bookMissing: '书籍不存在',
    timeAgoJust: '刚刚',
    timeAgoMin: '{n} 分钟前',
    timeAgoHour: '{n} 小时前',
    timeAgoDay: '{n} 天前',
    // 导入
    noTxtFiles: '请选择 .txt 或 .md 文本文件',
    importing: '正在导入 ({a}/{b})',
    importFail: '导入「{name}」失败: {msg}',
    dupTitle: '检测到重复书籍',
    dupMsgHtml: '《{title}》已存在于书库（内容相同）。<br>重新导入将<b>更新章节内容并重置阅读进度</b>。是否继续？',
    dupOk: '重新导入',
    reimported: '已重新导入《{title}》',
    imported: '导入成功：《{title}》',
    // 数据层
    progSplit: '正在切分章节…',
    progWorker: '后台线程处理中',
    progOrganize: '整理章节…',
    progWrite: '正在写入数据库…',
    workerErr: 'Worker 异常: {msg}',
    // 自定义词条
    customTitleHtml: '自定义词条 <span class="muted-text" style="font-weight:400">（查询时优先命中）</span>',
    cdWordPh: '词 / 短语', cdGlossPh: '释义',
    cdAdd: '添加', cdDel: '删除',
    cdEmpty: '还没有自定义词条，例如给网络小说里的专有名词加注释。',
    cdFill: '请填写词条与释义',
    cdAdded: '已添加词条',
    // 备份
    progCollect: '正在收集数据…',
    progReadDb: '读取数据库',
    progPackJson: '正在打包 JSON',
    progOverwrite: '正在覆盖导入…',
    progMerge: '正在合并导入…',
    progBooks: '共 {n} 本书',
    errBackupJson: '备份文件不是有效的 JSON',
    errBackupSchema: '不是本阅读器生成的备份文件（schema 不匹配）',
    exportedMsg: '已导出备份 {name}<br>{books} 本书 · {chapters} 章 · 共 {chars} 字',
    exportFail: '导出备份失败: {msg}',
    importTitle: '导入备份',
    bkFileHtml: '备份文件：<b>{name}</b><br>',
    bkTimeHtml: '导出时间：{t}<br>',
    bkContainsHtml: '包含：<b>{books}</b> 本书、<b>{chapters}</b> 章、<b>{positions}</b> 条阅读进度<br><br>',
    bkCharsHtml: '总字数约 <b>{chars}</b><br><br>',
    bkMergeHtml: '<b>合并</b>：保留当前设备已有书籍，仅添加备份中不重复的内容与进度。<br>',
    bkOverwriteHtml: '<b>覆盖</b>：清空当前设备全部数据，完整恢复备份内容（推荐在新设备上使用）。',
    mergeOk: '合并导入',
    overwriteExtra: '覆盖导入（清空现有数据）',
    confirmOverwriteTitle: '确认覆盖',
    confirmOverwriteMsgHtml: '覆盖将<b>清空当前设备上所有书籍、进度与设置</b>，并恢复为备份中的内容。确定继续吗？',
    confirmOverwriteOk: '确认覆盖',
    importDone: '导入完成：新增 {books} 本 · {chapters} 章 · {positions} 条进度 · 跳过 {skipped} 项',
    importFail: '导入备份失败: {msg}',
    // 存储 / 异常
    noStorage: '浏览器无可用存储（IndexedDB/localStorage 均不可用），无法使用本应用',
    storageFull: 'localStorage 容量不足：{msg}（建议改用支持 IndexedDB 的浏览器）',
    runtimeError: '运行错误',
    errToast: '发生错误: {msg}',
    initFail: '初始化失败: {msg}',
    defaultVoice: '默认发音人',
  },
  en: {
    appTitle: 'Offline Novel Reader',
    appName: 'Offline Novel Reader',
    untitled: 'Untitled novel',
    bookCover: 'Book',
    cancel: 'Cancel',
    ok: 'OK',
    btnImport: '⬆ Import',
    btnImportBook: '⬆ Import books',
    phOn: 'Phonetic & POS shown',
    phOff: 'Phonetic & POS hidden',
    btnExport: 'Export backup',
    btnImpBack: 'Import backup',
    impTitle: 'Import .txt / .md novel files (multi-select)',
    pasteTitle: 'Paste text to import',
    exportTitle: 'Export all books & reading progress as a backup file',
    impBackTitle: 'Restore books & progress from a backup file',
    settingsTitle: 'Reader settings',
    helpTitle: 'Help',
    langSwitch: 'Switch UI language (English / 中文)',
    phMore: 'Show/hide\nphonetic & POS',
    langMore: 'Switch UI language\n(English / 中文)',
    moreTitle: 'More',
    searchPh: 'Search title / author…',
    dbInit: 'Database…',
    workerInit: 'Thread:—',
    stDbIdb: 'IndexedDB connected',
    stDbLs: 'Fallback storage (localStorage)',
    workerReady: 'worker ready',
    workerMain: 'main thread',
    stWorker: 'Thread: {m}',
    welcomeHtml: '<b>Welcome to the Offline Novel Reader</b>',
    emptyHintHtml: 'Click <b>Import</b> and choose <b>.txt / .md</b> files to start reading (UTF-8 / GBK auto-detected).',
    emptyMigrateHtml: 'Moving devices: click <b>Export backup</b> on the old device, then open this page on the new one and click <b>Import backup</b> to restore everything.',
    emptyOfflineHtml: 'Fully offline: books, progress and dictionaries all live in your browser (IndexedDB).',
    tocTitle: 'Table of contents',
    chapPrevTitle: 'Previous chapter',
    chapNextTitle: 'Next chapter',
    ttsPlayTitle: 'Read aloud from this page (tap again to stop)',
    ttsRateTitle: 'Reading speed',
    ttsVoiceTitle: 'Voice',
    pagePrevTitle: 'Previous page (←)',
    pageNextTitle: 'Next page (→)',
    percentTitle: 'Whole-book progress',
    phTitle: 'Show/hide phonetic & POS',
    noBook: 'No book open',
    stHint: 'Select text → translate / speak · ← → keys turn pages',
    stReading: '🔊 Reading…',
    lastPage: 'This is the last page',
    firstPage: 'This is the first page',
    lastChapter: 'This is the last chapter',
    firstChapter: 'This is the first chapter',
    dictTitle: '📚 Dictionary · Translate',
    dictInputPh: 'Type or select text, press Enter…',
    dictGo: 'Look up',
    dictNeedQuery: 'Please enter text to look up',
    dictEmptyHtml: 'Select text in the reader, or type a query above.<br>All dictionary data is bundled offline in this page.',
    d_en2cn: 'EN→CN', d_hint_en2cn: 'English words / phrases → Chinese',
    d_cn2en: 'CN→EN', d_hint_cn2en: 'Chinese words → English',
    d_zh: 'Chinese defs', d_hint_zh: 'Common Chinese words → Chinese definitions',
    d_idioms: 'Idioms', d_hint_idioms: '4-character idioms & set phrases',
    d_chars: 'Hanzi', d_hint_chars: 'Common Chinese characters, plain meanings',
    tagZh: '中文释义',
    dictZhEmpty: 'Chinese definitions work for Chinese text',
    dictZhNone: 'No Chinese definitions for these words yet',
    dictZhTitle: 'Chinese definitions · {hit} words',
    dictEnEmpty: 'This query is not English — see the CN→EN tab.',
    dictEnTitle: 'EN → CN ({hit}/{total} words found)',
    dictUnknown: 'Unknown words',
    dictCnEmpty: 'This query is not Chinese — see the EN→CN tab.',
    dictCnTitle: 'CN → EN ({hit}/{total} tokens found)',
    dictNoIdiom: 'No idioms found.',
    dictIdiomTitle: 'Idioms / set phrases ({n} found)',
    tagIdiom: 'idiom',
    charsCnOnly: 'Chinese-only: character lookup works for Chinese text.',
    charsTitle: 'Per-character detail ({hit}/{total} chars covered)',
    tagChar: 'char',
    charsMissing: 'Chars not covered',
    selTranslate: 'Translate',
    selSpeak: 'Speak',
    selCopy: 'Copy',
    copied: 'Copied',
    copyPrompt: 'Copy text: ',
    noTts: 'Speech synthesis is not supported in this browser',
    speakingSel: 'Reading selected text…',
    bookFinished: 'Finished reading the book',
    pasteTitleH: 'Paste-import a novel',
    pasteName: 'Title',
    pasteNamePh: 'required',
    pasteBody: 'Body (paste freely; chapters are split automatically)',
    pasteTextPh: 'Paste the novel text here…',
    pasteOk: 'Import',
    pasteSource: 'Pasted text',
    needTitle: 'Please enter a title',
    needText: 'The text must not be empty',
    setTitle: '⚙ Reader settings',
    setTheme: 'Theme', setFontSize: 'Font size', setLineHeight: 'Line height', setFont: 'Font',
    setPageWidth: 'Page width',
    setHitZone: 'Tap left/right edges of the page to turn pages',
    setIndent: 'Indent the first line of each paragraph',
    setSelAction: 'Selection action',
    setSelPopup: 'Show toolbar (translate / speak)',
    setSelAuto: 'Auto-open dictionary on selection',
    setNote: 'Settings & progress are saved to the browser database automatically; "Export backup" includes all books, progress and custom entries.',
    doneBtn: 'Done',
    theme_light: 'Light', theme_sepia: 'Sepia', theme_dark: 'Dark', theme_green: 'Green',
    font_serif: 'Serif (song)', font_kai: 'Kai', font_sans: 'Sans (hei)',
    helpHtml: '<h4>Quick start</h4>' +
      '<p>Click <b>Import</b> and pick local .txt / .md files (multi-select, UTF-8 & GBK supported); you can also <b>paste text</b>.</p>' +
      '<p>Books and reading positions are stored in the browser IndexedDB automatically and survive refreshes.</p>' +
      '<h4>Moving devices</h4>' +
      '<p>Old device: <b>Export backup</b> → get backup.json; new device: open this page → <b>Import backup</b> → all books + progress restored.</p>' +
      '<h4>Select · translate</h4>' +
      '<p>Select any text in the reader and a toolbar offers <b>Translate</b> (EN↔CN, dictionary panel on the right) and <b>Speak</b>. All offline.</p>' +
      '<h4>Text-to-speech</h4>' +
      '<p>Uses the browser native speech synthesis; click ▶ to read continuously from the current page with automatic page turns; adjust speed and voice.</p>' +
      '<h4>Shortcuts & gestures</h4>' +
      '<div class="key-row"><span><kbd>←</kbd> / <kbd>→</kbd> or <kbd>PageUp</kbd> / <kbd>PageDown</kbd></span><span>Previous / next page</span></div>' +
      '<div class="key-row"><span><kbd>Home</kbd> / <kbd>End</kbd></span><span>Chapter start / end</span></div>' +
      '<div class="key-row"><span>Mobile: swipe left / right</span><span>Turn pages</span></div>' +
      '<div class="key-row"><span>«☰» button</span><span>Open / close the library</span></div>' +
      '<div class="key-row"><span>Select text</span><span>Translate, speak</span></div>' +
      '<h4>Performance</h4>' +
      '<p>Chapter splitting runs asynchronously on a background Web Worker thread (multithreading), so the UI stays smooth; pagination is measured for fluid page turns.</p>',
    cfTitle: 'Confirm',
    progDefault: 'Working…',
    metaChap: '{n} ch', metaChars: '{n} chars',
    metaRead: 'Read {p}%', metaUnread: 'Not started',
    delBookTitle: 'Delete this book',
    listEmptySearch: 'No matching books',
    listEmptyHtml: 'The library is empty<br>Click "Import" in the top-right to start',
    deleteTitle: 'Delete book',
    deleteMsgHtml: 'Delete "{title}"?<br><span class="muted-text">Chapters and progress will be removed permanently. This cannot be undone.</span>',
    deleteOk: 'Delete',
    deletedMsg: 'Deleted "{title}"',
    bookMissing: 'Book not found',
    timeAgoJust: 'just now',
    timeAgoMin: '{n} min ago',
    timeAgoHour: '{n} h ago',
    timeAgoDay: '{n} d ago',
    noTxtFiles: 'Please choose .txt or .md text files',
    importing: 'Importing ({a}/{b})',
    importFail: 'Failed to import "{name}": {msg}',
    dupTitle: 'Duplicate book detected',
    dupMsgHtml: '"{title}" is already in your library (identical content).<br>Re-importing will <b>update the chapters and reset reading progress</b>. Continue?',
    dupOk: 'Re-import',
    reimported: 'Re-imported "{title}"',
    imported: 'Imported "{title}"',
    progSplit: 'Splitting chapters…',
    progWorker: 'Working in a background thread',
    progOrganize: 'Organizing chapters…',
    progWrite: 'Saving to database…',
    workerErr: 'Worker error: {msg}',
    customTitleHtml: 'Custom entries <span class="muted-text" style="font-weight:400">(matched first)</span>',
    cdWordPh: 'word / phrase', cdGlossPh: 'definition',
    cdAdd: 'Add', cdDel: 'Delete',
    cdEmpty: 'No custom entries yet — e.g. add notes for proper nouns in web novels.',
    cdFill: 'Please fill in word and definition',
    cdAdded: 'Entry added',
    progCollect: 'Collecting data…',
    progReadDb: 'Reading database',
    progPackJson: 'Packing JSON',
    progOverwrite: 'Overwriting…',
    progMerge: 'Merging…',
    progBooks: '{n} books total',
    errBackupJson: 'The backup file is not valid JSON',
    errBackupSchema: 'Not a backup from this reader (schema mismatch)',
    exportedMsg: 'Backup saved: {name}<br>{books} books · {chapters} chapters · {chars} chars total',
    exportFail: 'Export failed: {msg}',
    importTitle: 'Import backup',
    bkFileHtml: 'File: <b>{name}</b><br>',
    bkTimeHtml: 'Exported: {t}<br>',
    bkContainsHtml: 'Contains: <b>{books}</b> books, <b>{chapters}</b> chapters, <b>{positions}</b> positions<br><br>',
    bkCharsHtml: 'About <b>{chars}</b> chars total<br><br>',
    bkMergeHtml: '<b>Merge</b>: keep this device\'s books; only add non-duplicate content & progress.<br>',
    bkOverwriteHtml: '<b>Overwrite</b>: clear all local data and fully restore the backup (recommended on a new device).',
    mergeOk: 'Merge import',
    overwriteExtra: 'Overwrite (clear current data)',
    confirmOverwriteTitle: 'Confirm overwrite',
    confirmOverwriteMsgHtml: 'Overwriting will <b>clear all books, progress and settings</b> on this device and restore the backup content. Continue?',
    confirmOverwriteOk: 'Overwrite',
    importDone: 'Import done: {books} books · {chapters} chapters · {positions} positions · {skipped} skipped',
    importFail: 'Import failed: {msg}',
    noStorage: 'No usable storage in this browser (IndexedDB/localStorage unavailable) — the app cannot run',
    storageFull: 'localStorage quota exceeded: {msg} (consider a browser with IndexedDB)',
    runtimeError: 'Runtime error',
    errToast: 'Error: {msg}',
    initFail: 'Init failed: {msg}',
    defaultVoice: 'Default voice',
  },
};

const I18N = {
  lang: 'zh',
  /** 取当前语言文案；缺失时回退中文，再缺失返回 key 本身 */
  t(key, params) {
    const table = I18N_LANGS[this.lang] || I18N_LANGS.zh;
    let s = table[key];
    if (s === undefined) s = I18N_LANGS.zh[key] ?? key;
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.split('{' + k + '}').join(String(params[k]));
      }
    }
    return s;
  },
  /** 数字简写：中文 万/亿，英文 K/M */
  fmt(n) {
    if (n == null || isNaN(n)) return '0';
    const trimZero = s => (s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
    if (this.lang === 'en') {
      if (n >= 1e6) return trimZero((n / 1e6).toFixed(2)) + 'M';
      if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + 'K';
      return String(n);
    }
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return String(n);
  },
  /** 把静态文案应用到 DOM（data-i18n / data-i18n-ph / data-i18n-title / data-i18n-html） */
  applyStatic() {
    document.documentElement.lang = this.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = this.t('appTitle');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = this.t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = this.t(el.dataset.i18nPh);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = this.t(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = this.t(el.dataset.i18nHtml);
    // 语言切换按钮显示目标语言
    const btn = document.getElementById('btn-lang');
    if (btn) btn.textContent = this.lang === 'zh' ? '🌐 EN' : '🌐 中';
  },
};

/* ---------- 1. 事件总线 EventBus（观察者模式：模块间解耦） ---------- */
class EventBus {
  constructor() { this._map = new Map(); }
  on(event, fn) {
    if (!this._map.has(event)) this._map.set(event, []);
    this._map.get(event).push(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    const list = this._map.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(event, ...args) {
    const list = this._map.get(event);
    if (!list) return;
    for (const fn of [...list]) { try { fn(...args); } catch (e) { console.error('[EventBus]', event, e); } }
  }
}

/* ---------- 2. 存储层 Storage（抽象接口 + 两种实现） ----------
 *  接口: init / putBook / getBook / getAllBooks / deleteBook /
 *        putChapters / getChapters / deleteChapters /
 *        putPosition / getPosition / getSetting / setSetting /
 *        exportAll / importAll / clearAll
 *  默认实现: IndexedDB（浏览器原生数据库，容量大、异步）
 *  降级实现: localStorage（某些受限浏览器环境，容量小，会提示）
 */
class IndexedDBAdapter {
  constructor() { this.name = 'novel_reader_db'; this.version = 1; this.db = null; }
  get mode() { return 'indexeddb'; }

  init() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const req = indexedDB.open(this.name, this.version);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books'))     db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chapters'))   db.createObjectStore('chapters', { keyPath: ['bookId', 'index'] });
        if (!db.objectStoreNames.contains('positions'))  db.createObjectStore('positions', { keyPath: 'bookId' });
        if (!db.objectStoreNames.contains('settings'))   db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror    = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked  = () => reject(new Error('IndexedDB blocked by another tab'));
    });
  }
  _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  async putBook(book)    { await this._req(this._tx('books', 'readwrite').put(book)); }
  async getBook(id)      { return this._req(this._tx('books', 'readonly').get(id)); }
  async getAllBooks()    { return this._req(this._tx('books', 'readonly').getAll()); }
  async deleteBook(id) {
    const tx = this.db.transaction(['books', 'chapters', 'positions'], 'readwrite');
    tx.objectStore('books').delete(id);
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    tx.objectStore('chapters').delete(range);
    tx.objectStore('positions').delete(id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  }

  async putChapters(bookId, chapters) {
    const store = this._tx('chapters', 'readwrite');
    for (const ch of chapters) await this._req(store.put(ch));
  }
  async getChapters(bookId) {
    const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
    const all = await this._req(this._tx('chapters', 'readonly').getAll(range));
    all.sort((a, b) => a.index - b.index);
    return all;
  }

  async putPosition(pos)   { await this._req(this._tx('positions', 'readwrite').put(pos)); }
  async getPosition(id)    { return this._req(this._tx('positions', 'readonly').get(id)); }

  async getSetting(key) {
    const row = await this._req(this._tx('settings', 'readonly').get(key));
    return row ? row.value : undefined;
  }
  async setSetting(key, value) {
    await this._req(this._tx('settings', 'readwrite').put({ key, value, updatedAt: nowStamp() }));
  }

  async exportAll() {
    const books = await this._req(this._tx('books', 'readonly').getAll());
    const chapters = [];
    for (const b of books) chapters.push({ bookId: b.id, items: await this.getChapters(b.id) });
    const positions = await this._req(this._tx('positions', 'readonly').getAll());
    const settings  = await this._req(this._tx('settings', 'readonly').getAll());
    return { books, chapters, positions, settings };
  }

  async importAll(data, mode) {
    const report = { books: 0, chapters: 0, positions: 0, settings: 0, skipped: 0 };
    if (mode === 'overwrite') await this.clearAll();
    // merge 模式下 localIds = 导入前已存在的书籍；只有这些书的内容才需要「跳过保留本地」
    const localIds = mode === 'merge' ? new Set((await this.getAllBooks()).map(b => b.id)) : new Set();
    for (const bk of data.books || []) {
      if (mode === 'merge' && localIds.has(bk.id)) { report.skipped++; continue; }
      await this.putBook(bk); report.books++;
    }
    for (const cg of data.chapters || []) {
      if (mode === 'merge' && localIds.has(cg.bookId)) { report.skipped += (cg.items || []).length; continue; }
      for (const ch of cg.items || []) { await this._req(this._tx('chapters', 'readwrite').put(ch)); report.chapters++; }
    }
    for (const p of data.positions || []) {
      if (mode === 'merge' && localIds.has(p.bookId)) { report.skipped++; continue; }
      await this.putPosition(p); report.positions++;
    }
    for (const s of data.settings || []) {
      if (mode === 'merge' && await this.getSetting(s.key) !== undefined) { report.skipped++; continue; }
      await this.setSetting(s.key, s.value); report.settings++;
    }
    return report;
  }

  async clearAll() {
    for (const store of ['books', 'chapters', 'positions', 'settings']) {
      await this._req(this._tx(store, 'readwrite').clear());
    }
  }
}

class LocalStorageAdapter {
  constructor() {
    this.P = 'nr1';
    try { this._test(); } catch (e) { throw new Error('localStorage unavailable'); }
  }
  get mode() { return 'localstorage'; }
  _test() { localStorage.setItem(this.P + ':t', '1'); localStorage.removeItem(this.P + ':t'); }
  _get(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; } }
  _set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { throw new Error(I18N.t('storageFull', { msg: e.message })); }
  }
  async init() {}
  async putBook(book) {
    const list = this._get(this.P + ':books', []);
    const i = list.findIndex(b => b.id === book.id);
    if (i >= 0) list[i] = book; else list.push(book);
    this._set(this.P + ':books', list);
  }
  async getBook(id) { return this._get(this.P + ':books', []).find(b => b.id === id) || null; }
  async getAllBooks() { return this._get(this.P + ':books', []); }
  async deleteBook(id) {
    this._set(this.P + ':books', this._get(this.P + ':books', []).filter(b => b.id !== id));
    localStorage.removeItem(`${this.P}:ch:${id}`);
    localStorage.removeItem(`${this.P}:pos:${id}`);
  }
  async putChapters(bookId, chapters) {
    const existing = this._get(`${this.P}:ch:${bookId}`, []);
    const map = new Map(existing.map(c => [c.index, c]));
    for (const ch of chapters) map.set(ch.index, ch);
    this._set(`${this.P}:ch:${bookId}`, [...map.values()].sort((a, b) => a.index - b.index));
  }
  async getChapters(bookId) { return this._get(`${this.P}:ch:${bookId}`, []); }
  async putPosition(pos)    { this._set(`${this.P}:pos:${pos.bookId}`, pos); }
  async getPosition(id)     { return this._get(`${this.P}:pos:${id}`, null); }
  async getSetting(key)     { const all = this._get(this.P + ':settings', {}); return all[key]; }
  async setSetting(key, value) {
    const all = this._get(this.P + ':settings', {});
    all[key] = value; this._set(this.P + ':settings', all);
  }
  async exportAll() {
    const books = await this.getAllBooks();
    const chapters = [], positions = [];
    for (const b of books) {
      chapters.push({ bookId: b.id, items: await this.getChapters(b.id) });
      const p = await this.getPosition(b.id);
      if (p) positions.push(p);
    }
    const s = this._get(this.P + ':settings', {});
    return { books, chapters, positions, settings: Object.entries(s).map(([key, value]) => ({ key, value })) };
  }
  async importAll(data, mode) {
    const report = { books: 0, chapters: 0, positions: 0, settings: 0, skipped: 0 };
    const localIds = mode === 'merge' ? new Set((await this.getAllBooks()).map(b => b.id)) : new Set();
    if (mode === 'overwrite') {
      await this.clearAll();
    }
    for (const bk of data.books || []) {
      if (mode === 'merge' && localIds.has(bk.id)) { report.skipped++; continue; }
      await this.putBook(bk); report.books++;
    }
    for (const cg of data.chapters || []) {
      if (mode === 'merge' && localIds.has(cg.bookId)) { report.skipped += (cg.items || []).length; continue; }
      await this.putChapters(cg.bookId, cg.items || []); report.chapters += (cg.items || []).length;
    }
    for (const p of data.positions || []) {
      if (mode === 'merge' && localIds.has(p.bookId)) { report.skipped++; continue; }
      await this.putPosition(p); report.positions++;
    }
    for (const s of data.settings || []) {
      const all = this._get(this.P + ':settings', {});
      if (mode === 'merge' && all[s.key] !== undefined) { report.skipped++; continue; }
      all[s.key] = s.value; this._set(this.P + ':settings', all); report.settings++;
    }
    return report;
  }
  async clearAll() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.P + ':')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  }
}


/* ---------- 3. 文本编解码 ---------- */
/** 字节 → 文本：尝试 UTF-8(含BOM)，失败则 GBK，再失败则 Big5，最后 UTF-8 宽松模式 */
function decodeTextBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let offset = 0;
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) offset = 3;
  const slice = u8.subarray(offset);
  const tryDecode = (enc, fatal) => {
    try { return { text: new TextDecoder(enc, { fatal }).decode(slice), encoding: enc }; }
    catch { return null; }
  };
  for (const enc of ['utf-8', 'gbk', 'big5']) {
    const r = tryDecode(enc, true);
    if (r) return r;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), encoding: 'utf-8(宽松)' };
}

/* ---------- 4. 章节切分（纯函数，同时用于 Web Worker 与主线程降级） ---------- */
/**
 * 把整本小说文本切分为章节数组。
 * 规则: 优先按「第X章/卷/节」等标题行识别；标题行识别不足 2 个时，
 *       退化为按固定字数切块，保证任何文本都能阅读。
 * 返回: { chapters: [{index, title, paras: string[], chars}], totalChars }
 */
function splitChapters(text, opts = {}) {
  const targetChars = opts.targetChars || 4500;
  // 归一化换行 & 去掉 \r
  let t = text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
  const lines = t.split('\n');

  // --- 标题行识别 ---
  const titleRe = [
    /^\s*第\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*[章节卷回部集篇][^\n]{0,60}\s*$/,  // 第十二章 风云
    /^\s*(?:序\s*章|楔\s*子|前\s*言|引\s*子|题\s*记|尾\s*声|后\s*记|番\s*外|终\s*章|结\s*语)\s*$/, // 章节性段落
    /^\s*(?:chapter|volume|part|book)\s+[0-9]{1,5}\s*[.:：]?\s*[^\n]{0,60}$/i,                  // Chapter 12: ...
  ];
  const isTitle = (s) => titleRe.some(re => re.test(s));

  // 第一章的标题可能带后续内容（如「第一章 风起 洛城客栈中……」），只在确实无匹配时兜底
  const idx = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTitle(lines[i]) && lines[i].length <= 80) idx.push(i);
  }

  let chapters;
  if (idx.length >= 2) {
    // 主/卷目录中「第X章」跟正文分离的常见处理：标题行并入下一个正文段之前，跳过重复的空标题
    const starts = [...idx, lines.length];
    chapters = [];
    let title = null;
    let paras = [];
    for (let i = 0; i < lines.length; i++) {
      if (isTitle(lines[i]) && lines[i].length <= 80) {
        if (title !== null) chapters.push({ title, paras });
        title = lines[i].replace(/^\s+|\s+$/g, '');
        paras = [];
      } else {
        const s = lines[i].replace(/\s+/g, '').trim();
        if (s) paras.push(s);
      }
    }
    if (title !== null) chapters.push({ title, paras });
    if (chapters.length === 0) chapters = null; // 全空：退回按块切分
  }

  // --- 兜底：按段落块 → 按目标字数切块 ---
  if (!chapters) {
    const blocks = [];
    let cur = [];
    let curLen = 0;
    for (const line of lines) {
      const s = line.trim();
      if (!s) {
        if (cur.length) { blocks.push(cur); cur = []; curLen = 0; }
        continue;
      }
      cur.push(s);
      curLen += s.length;
      if (curLen >= targetChars) { blocks.push(cur); cur = []; curLen = 0; }
    }
    if (cur.length) blocks.push(cur);
    if (!blocks.length) blocks.push([]);
    let merged = [];
    for (const b of blocks) merged = merged.concat(b);
    if (merged.length === 0) merged = ['（空白文档：无内容）'];
    // 把段落聚成「节」；超长段落按字符切段，保证任意文本都能被分章
    chapters = [];
    let chunk = [];
    let len = 0;
    const flushChunk = () => {
      if (chunk.length) { chapters.push(chunk); chunk = []; len = 0; }
    };
    const addPara = (p) => {
      let rest = p;
      while (rest.length > targetChars) {
        const piece = rest.slice(0, targetChars);
        chunk.push(piece); len += piece.length;
        flushChunk();
        rest = rest.slice(targetChars);
      }
      chunk.push(rest); len += rest.length;
      if (len >= targetChars) flushChunk();
    };
    for (const p of merged) addPara(p);
    flushChunk();
    chapters = chapters.map((chunk, i) => ({
      title: `第 ${i + 1} 节`,
      paras: chunk,
    }));
  }

  // --- 过滤空章节 / 计算字数 ---
  chapters = chapters
    .filter(c => c.paras.length > 0)
    .map((c, i) => {
      const chars = c.paras.reduce((n, p) => n + p.length, 0);
      return { index: i, title: c.title || `第 ${i + 1} 节`, paras: c.paras, chars };
    });
  if (!chapters.length) {
    chapters = [{ index: 0, title: '正文', paras: ['（没有可显示的正文内容）'], chars: 0 }];
  }
  const totalChars = chapters.reduce((n, c) => n + c.chars, 0);
  return { chapters, totalChars };
}

/* ---------- 5. 后台 Worker（多线程） ---------- */
/*  优先把章节切分放到独立线程执行，主线程保持流畅；
 *  若 Worker 创建失败（受限环境），自动降级为在主线程同步执行（对应函数见上）。 */
const WORKER_SCRIPT = `'use strict';
${splitChapters.toString()}
self.onmessage = (e) => {
  const { id, text } = e.data || {};
  try {
    const r = splitChapters(text);
    self.postMessage({ id, ok: true, chapters: r.chapters, totalChars: r.totalChars });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};`;

class TextWorker {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }
  get available() { return !!this.worker; }

  static create() {
    const w = new TextWorker();
    try {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      w.worker = new Worker(url);
      URL.revokeObjectURL(url);
      w.worker.onmessage = (e) => {
        const { id, ok, error, ...rest } = e.data || {};
        const p = w.pending.get(id);
        if (!p) return;
        w.pending.delete(id);
        ok ? p.resolve(rest) : p.reject(new Error(error));
      };
      w.worker.onerror = (e) => {
        w.worker = null;
        for (const p of w.pending.values()) p.reject(new Error(I18N.t('workerErr', { msg: e.message })));
        w.pending.clear();
      };
    } catch (e) {
      console.warn('Web Worker 不可用，将使用主线程切分:', e);
      w.worker = null;
    }
    return w;
  }

  /** 切分文本；Worker 不可用时主线程执行（同为异步接口，调用方无感知） */
  split(text) {
    if (!this.worker) {
      // 分片让出主线程，避免大文件阻塞 UI（异步编程）
      return new Promise(resolve => {
        setTimeout(() => {
          const r = splitChapters(text);
          resolve({ chapters: r.chapters, totalChars: r.totalChars });
        }, 0);
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, text });
    });
  }
  destroy() { if (this.worker) { this.worker.terminate(); this.worker = null; } }
}

/* ---------- 6. 数据管理 DataManager（仓库模式：统一书籍/章节/进度/设置的读写） ---------- */
class DataManager {
  constructor(adapter, bus) {
    this.adapter = adapter;
    this.bus = bus;
    this._booksCache = null;
    this.requestId = 0;
  }
  get mode() { return this.adapter.mode; }

  /* ---- 书籍 ---- */
  async listBooks() {
    if (!this._booksCache) {
      const books = await this.adapter.getAllBooks();
      books.forEach(b => { if (!b.chapterChars) b.chapterChars = []; });
      this._booksCache = books;
    }
    return this._booksCache.slice().sort((a, b) => (b.lastReadAt || 0) > (a.lastReadAt || 0) ? 1 : -1);
  }
  async getBook(id) {
    const b = await this.adapter.getBook(id);
    if (b && !b.chapterChars) b.chapterChars = [];
    return b;
  }
  async saveBook(book) {
    if (this._booksCache) {
      const i = this._booksCache.findIndex(b => b.id === book.id);
      if (i >= 0) this._booksCache[i] = book; else this._booksCache.push(book);
    }
    await this.adapter.putBook(book);
    this.bus.emit('books:changed');
  }
  async deleteBook(id) {
    this._booksCache = null;
    await this.adapter.deleteBook(id);
    this.bus.emit('books:changed');
  }

  /* ---- 导入 ---- */
  /** 计算书籍 ID（内容哈希，可复现 → 相同文件识别为同一本书） */
  static bookIdOf(text) {
    const sample = (text.length > 2048 ? text.slice(0, 1024) + text.slice(text.length - 1024) : text) + ':' + text.length;
    return 'book_' + fnv1a(sample);
  }

  /**
   * 导入文本。返回 { duplicate, book }；duplicate 时 book 为已存在的旧书籍。
   */
  async importText({ title, sourceName, text }) {
    const id = DataManager.bookIdOf(text);
    const existing = await this.getBook(id);
    if (existing) {
      return { duplicate: true, book: existing };
    }
    const book = await this._splitAndSave(id, title, sourceName, text);
    return { duplicate: false, book };
  }

  /** 覆盖导入（去重确认后）：保留同一 id，重置阅读进度 */
  async replaceBook({ id, title, sourceName, text }) {
    const book = await this._splitAndSave(id, title, sourceName, text);
    await this.adapter.putPosition({ bookId: id, chapterIndex: 0, pageIndex: 0, percent: 0, charOffset: 0, updatedAt: nowStamp() });
    return book;
  }

  async _splitAndSave(id, title, sourceName, text) {
    const now = Date.now();
    const book = {
      id,
      title: title || sourceName || I18N.t('untitled'),
      sourceName: sourceName || '',
      encoding: '',
      size: text.length,
      importedAt: now,
      updatedAt: now,
      lastReadAt: 0,
      percent: 0,
      hash: DataManager.bookIdOf(text),
    };
    const progress = progressUI();
    progress.show(I18N.t('progSplit'));
    progress.setSub(I18N.t('progWorker'));
    progress.set(0.05);
    // 切分（Web Worker 线程 / 主线程降级）
    const { chapters, totalChars } = await this._worker.split(text);
    progress.setSub(I18N.t('progOrganize'));
    book.chapterCount = chapters.length;
    book.totalChars = totalChars;
    book.chapterChars = chapters.map(c => c.chars);
    book.chapterTitles = chapters.map(c => c.title);
    // 写入数据库（异步分批）
    progress.show(I18N.t('progWrite'));
    const list = chapters.map((c, i) => ({
      bookId: id, index: i, title: c.title, paras: c.paras, chars: c.chars,
    }));
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      await this.adapter.putChapters(id, batch);
      progress.set(0.1 + 0.85 * (Math.min(i + 200, list.length) / list.length));
    }
    book.updatedAt = Date.now();
    progress.set(0.97);
    await this.saveBook(book);
    progress.set(1);
    progress.done();
    return book;
  }

  /* ---- 章节 ---- */
  async loadChapters(bookId) {
    const chapters = await this.adapter.getChapters(bookId);
    return chapters;
  }

  /* ---- 阅读进度 ---- */
  async savePosition({ bookId, chapterIndex, pageIndex, percent, charOffset }) {
    const pos = { bookId, chapterIndex, pageIndex, percent, charOffset, updatedAt: nowStamp() };
    await this.adapter.putPosition(pos);
    const book = await this.getBook(bookId);
    if (book) {
      book.percent = percent;
      book.lastReadAt = Date.now();
      await this.saveBook(book);
    }
    return pos;
  }
  async getPosition(bookId) { return this.adapter.getPosition(bookId); }

  /* ---- 设置 ---- */
  async getSetting(key, def) { const v = await this.adapter.getSetting(key); return v === undefined ? def : v; }
  async setSetting(key, value) {
    await this.adapter.setSetting(key, value);
    this.bus.emit('settings:changed', { key, value });
  }

  /* ---- 备份 ---- */
  async exportAll() { return this.adapter.exportAll(); }
  async importAll(data, mode) { return this.adapter.importAll(data, mode); }
}

/* ---------- 7. 词典服务 DictionaryService（策略模式：多部离线词典可切换） ---------- */
/*  词典数据以「word|释义」文本行内嵌打包（见 dict-data 一节），运行时解析为 Map，
 *  支持: 英→中、中→英（含最大正向匹配分词）、成语解释、汉字逐字详解，
 *  以及用户自定义词条（持久化于设置中，查询优先级最高）。 */
class DictionaryService {
  constructor(bus) {
    this.bus = bus;
    this.maps = {};        // dictId -> Map<word, gloss>
    this.firstChars = {};  // dictId -> Set<首字符>（用于中文最大匹配加速）
    this.custom = [];      // 用户自定义词条 [{word, gloss}]
    this._inited = false;
  }

  /** 词典元信息（策略注册表） */
  static get DICTS() {
    return [
      { id: 'en2cn',  name: '英 译 中', hint: '英语单词/短语 → 中文释义' },
      { id: 'cn2en',  name: '中 译 英', hint: '中文常用词 → 英语释义' },
      { id: 'zh',     name: '中文释义', hint: '常用中文词汇 → 中文释义' },
      { id: 'idioms', name: '成语解释', hint: '四字成语 / 惯用语释义' },
      { id: 'chars',  name: '汉字详解', hint: '常见汉字 → 简明释义' },
    ];
  }

  async init(customEntries) {
    this.custom = customEntries || [];
    this._inited = true;
    for (const d of DictionaryService.DICTS) this._buildMap(d.id, RAW_DICTS[d.id]);
  }

  _buildMap(id, raw) {
    const map = new Map();
    const firsts = new Set();
    for (const line of raw.split('\n')) {
      const i = line.indexOf('|');
      if (i <= 0) continue;
      const word = line.slice(0, i).trim();
      const gloss = line.slice(i + 1).trim();
      if (!word || !gloss) continue;
      map.set(word, gloss);
      if (word.length <= 4) firsts.add(word[0]);
    }
    this.maps[id] = map;
    this.firstChars[id] = firsts;
  }

  /** 自定义词条（设置持久化） */
  customMap() {
    const m = new Map();
    for (const c of this.custom) { const g = String(c.gloss || '').trim(); if (c.word && g) m.set(String(c.word).trim(), g); }
    return m;
  }

  async addCustomEntry(word, gloss) {
    word = String(word).trim(); gloss = String(gloss).trim();
    if (!word || !gloss) return false;
    const i = this.custom.findIndex(c => c.word === word);
    if (i >= 0) this.custom[i] = { word, gloss }; else this.custom.push({ word, gloss });
    await this._emitCustom();
    return true;
  }
  async removeCustomEntry(word) {
    this.custom = this.custom.filter(c => c.word !== word);
    await this._emitCustom();
  }
  async _emitCustom() {
    this.bus.emit('dict:custom-changed', this.custom);
  }

  lookup(word, dictId) {
    const g = this.customMap().get(word);
    if (g) return { dict: '自定义', gloss: g };
    const gloss = this.maps[dictId] && this.maps[dictId].get(word);
    if (gloss) return { dict: dictId, gloss };
    return null;
  }

  /** 文本语言检测: 中文为主返回 'cn'，否则 'en' */
  static detectLang(text) {
    if (!text) return 'cn';
    let cjk = 0, total = 0;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      total++;
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjk++;
    }
    return total > 0 && cjk / total >= 0.35 ? 'cn' : 'en';
  }

  /** 英文分词: 提取 [A-Za-z']+ 单词序列（保留位置用于映射回原文） */
  static tokenizeEn(text) {
    const tokens = [];
    const re = /[A-Za-z'][A-Za-z']*/g;
    let m;
    while ((m = re.exec(text))) tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    // 合并为位置区间（含间隔），用于整句翻译
    return tokens;
  }

  /**
   * 翻译一段文本。
   * 中文: 最大正向匹配分词（词典优先 → 逐字兜底）。
   * 英文: 单词区序列，尝试最长 1-4 词短语匹配。
   * 返回 { lang, segments: [{txt, gloss|null, dict|null}], glossText, unknown }
   */
  translate(text) {
    text = text.replace(/\s+/g, ' ').trim();
    const lang = DictionaryService.detectLang(text);
    if (lang === 'en') return this._translateEn(text);
    return this._translateCn(text);
  }

  _translateCn(text) {
    const segs = [];
    // 分词词表 = cn2en + 中文释义(zh)；释义优先英译，无则用中文释义兜底
    const keyset = new Set([...this.maps.cn2en.keys(), ...this.maps.zh.keys()].filter(k => k.length <= 4));
    let i = 0;
    const N = text.length;
    while (i < N) {
      let hit = null;
      const maxLen = Math.min(4, N - i);
      for (let L = maxLen; L >= 1; L--) {
        const word = text.slice(i, i + L);
        if (keyset.has(word)) { hit = { word, dict: this.maps.cn2en.has(word) ? 'cn2en' : 'zh' }; break; }
      }
      if (hit) {
        const gloss = this.maps[hit.dict].get(hit.word);
        segs.push({ txt: hit.word, gloss, dict: hit.dict });
        i += hit.word.length;
      } else {
        const ch = text[i];
        const charGloss = this.maps.chars.get(ch);
        segs.push({ txt: ch, gloss: charGloss || null, dict: charGloss ? 'chars' : null });
        i += 1;
      }
    }
    return {
      lang: 'cn',
      segments: segs,
      glossText: segs.map(s => (s.gloss ? `${s.txt}(${s.gloss})` : s.txt)).join(' '),
      unknown: segs.filter(s => !s.gloss).map(s => s.txt),
    };
  }

  _translateEn(text) {
    const tokens = DictionaryService.tokenizeEn(text);
    const map = this.maps.en2cn;
    const segs = [];
    let li = 0;
    while (li < tokens.length) {
      let hit = null;
      // 尝试最长 4 词短语
      for (let L = Math.min(4, tokens.length - li); L >= 1; L--) {
        const phrase = tokens.slice(li, li + L).map(t => t.word).join(' ').toLowerCase();
        const g = this.customMap().get(phrase) || map.get(phrase);
        if (g) { hit = { phrase, gloss: g, len: L }; break; }
      }
      if (hit) {
        const raw = tokens.slice(li, li + hit.len);
        segs.push({
          txt: raw.map(t => t.word).join(' '),
          gloss: hit.gloss,
          dict: 'en2cn',
        });
        li += hit.len;
      } else {
        const t = tokens[li];
        const stem = this._stem(t.word.toLowerCase());
        const g = this.customMap().get(stem) || map.get(stem);
        segs.push({ txt: t.word, gloss: g || null, dict: g ? 'en2cn' : null });
        li += 1;
      }
    }
    return {
      lang: 'en',
      segments: segs,
      glossText: segs.map(s => (s.gloss ? `${s.txt} → ${s.gloss}` : s.txt)).join('；'),
      unknown: segs.filter(s => !s.gloss).map(s => s.txt),
    };
  }

  /** 简单词干还原（-s -es -ed -ing 型） */
  _stem(w) {
    if (w.length <= 4) return w;
    for (const suf of ['ing', 'es', 'ed', 's']) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length).replace(/ie$/, 'y').replace(/e$/, '');
    }
    return w;
  }

  /** 中文解释：成语 + 词语 + 逐字 + 未知字 */
  explain(text) {
    text = text.replace(/\s+/g, '').trim();
    if (!text) return null;
    const res = { idiom: null, words: [], chars: [], unknown: [] };
    // 成语 / 惯用语整条匹配
    if (this.maps.idioms.has(text)) res.idiom = { word: text, gloss: this.maps.idioms.get(text) };
    else if (text.length <= 12) {
      // 尝试在文本内找到最长成语
      let best = null;
      for (let i = 0; i < text.length; i++) {
        for (let L = Math.min(4, text.length - i); L >= 3; L--) {
          const w = text.slice(i, i + L);
          const g = this.maps.idioms.get(w);
          if (g) { best = { word: w, gloss: g, start: i }; break; }
        }
        if (best) break;
      }
      if (best) res.idiom = best;
    }
    // 词语最大匹配：cn2en + 中文释义(zh) 词表合并分词
    // 释义优先级：中文释义(zh) → 逐字中文释义(chars 拆分) → 英译兜底
    const keyset = new Set([...this.maps.cn2en.keys(), ...this.maps.zh.keys()].filter(k => k.length <= 4));
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (let L = Math.min(4, text.length - i); L >= 1; L--) {
        const w = text.slice(i, i + L);
        if (keyset.has(w)) {
          const zhg = this.maps.zh.get(w);
          if (zhg) { hit = { word: w, gloss: zhg, src: 'zh' }; break; }
          // 逐字中文释义兜底：取 chars 词典释义的中文部分
          const parts = [];
          for (const ch of w) {
            const cg = this.maps.chars.get(ch);
            if (cg) {
              const cn = cg.split(';').pop().trim();
              if (cn && cn !== ch) parts.push(ch + ':' + cn);
            }
          }
          hit = parts.length
            ? { word: w, gloss: parts.join('；'), src: 'chars' }
            : { word: w, gloss: this.maps.cn2en.get(w), src: 'cn2en' };
          break;
        }
      }
      if (hit) { res.words.push(hit); i += hit.word.length; }
      else { res.chars.push(text[i]); i += 1; }
    }
    for (const ch of [...new Set(res.chars)]) {
      if (!this.maps.chars.has(ch)) res.unknown.push(ch);
    }
    return res;
  }
}


/* ---------- 8. 内嵌离线词典数据（打包进 HTML，零网络依赖） ----------
 *  行格式: `word|释义1;释义2`
 *  英语→中文：常用英语词汇与短语（约 700 条，含常用短语）
 */
const RAW_DICTS = {
en2cn: `the|/ðә/art. 那
be|/bi:/v. 是, 表示, 在; 后端, 总线允许
of|/ɒv/prep. 的, 属于
and|/ænd/conj. 和, 与; 与
to|/tu:/prep. 到, 向, 趋于;向前
have|/hæv/vt. 有, 怀有, 拿, 进行;已经
it|/it/pron. 它; 信息论, 输入终端, 智能终端, 内捕获
he|/hi:/pron. 他;男孩, 男人, 雄性动物
for|/fɒ:/prep. 为, 因为, 至于;因为; DOS批处理命令:对一组参数重复执行指定的命令
not|/nɒt/adv. 不, 非, 未; 非
that|/ðæt/a. 那, 那个;以致, 因为;那;那么, 那样
you|/ju:/pron. 你, 你们
with|/wið/prep. 和...在一起, 以, 由于
on|/ɒn/prep. 在...之上;...上去;正起作用的; 打开
they|/ðei/pron. 他们, 它们
do|/du:/v. 做, 进行, 完成
by|/bai/prep. 被, 经, 由, 在...之旁;经过, 在近处
she|/ʃi:/pron. 她
at|/æt/prep. 在, 向, 对; 地址转换器, 异常传输, 自动订票
this|/θis/pron. 这, 本;这, 本;这么
but|/bʌt/prep. 除了;但是;仅仅
his|/hiz/pron. 他的; 组氨酸
we|/wi:/pron. 我们
from|/frɒm/prep. 从, 来自, 根据
which|/hwitʃ/pron. 哪一个, 那一个
or|/ɒ:/conj. 或, 或者; 或
say|/sei/vt. 说, 讲, 念, 说明, 指明;说, 讲;意见, 发言权
as|/æz/adv. 同样地, 例如;做为, 当作;当...之时, 以...的方式, 像...一样, 因为; 高级系统, 先进系统, 辅助存储器, 自治系统
would|/wud/aux. 将, 愿意
their|/ðєә/pron. 他们的
there|/ðєә/adv. 在那里
what|/hwɒt/pron. 什么;怎么, 多么;什么的;到什么程度
all|/ɒ:l/a. 所有的, 全部的, 一切的;全部, 全然;全部;全部
if|/if/conj. 如果, 是否, 无论何时, 假设, 即使;条件; DOS批处理命令:根据所测试的条件决定是否执行另一条命令
get|/get/vt. 得到, 获得, 变成, 使得, 收获, 接通, 抓住, 染上;到达, 成为, 变得;(网球等)救球, 生殖, 幼兽; 取得指令, 获取文件
her|/hә:/pron. 她的, 她
go|/gou/vi. 去, 走, 达到, 运转, 查阅, 消失, 结束, 放弃, 花费, 流传, 趋于, 打算, 剩下;以...打赌, 对付, 忍受, 出产, 为被捕者出(保释金);去, 尝试, 进行
who|/hu:/pron. 谁
one|/wʌn/n. 一(个);一, 任何人;一, 一个;一致的, 完整的
see|/si:/vt. 看见, 查看, 参观, 游览, 理解, 知道, 同意;看, 观看, 注意, 知道, 考虑;主教的职位
time|/taim/n. 时间, 时侯, 时机, 时期, 期限, 次数, 节拍, 暂停, 规定时间;测定...的时间, 记录...的时间, 计时, 定时;时间的, 记时的, 定时的, 定期的, 分期的; DOS内部命令:用于显示或设定系统的时间
some|/sʌm/pron. 一些, 一部分, 若干;大约;一些的, 少许的, 某一的
when|/hwen/conj. 当...的时候;何时, 什么时候;什么时侯;时间
could|/kud/aux. 可以, 能
year|/jiә/n. 年, 年度, 年龄; 年度
into|/'intu:/prep. 进入...之内, 朝..., 深入...之中, 成为...状况
its|/its/pron. 它的
then|/ðen/adv. 然后, 当时;然后, 当时;那时
my|/mai/pron. 我的; 迈尔(热容单位)
out|/aut/a. 外面的, 熄灭的, 结束的;在外, 熄灭, 出现;出自, 离去, 向
about|/ә'baut/prep. 在...周围, 大约, 有关, 关于;大约, 四处, 在附近, 周围
think|/θiŋk/vt. 想, 考虑, 想起, 想像, 打算, 认为;思考, 料想;想法;思想的
come|/kʌm/vi. 过来, 来, 到达, 出现, 开始;喂
your|/juә/pron. 你的, 你们的
now|/nau/adv. 现在, 刚才, 目前;现在;现在的;由于
no|/nәu/n. 不, 拒绝, 否决票;没有, 不是, 绝非;不
other|/'ʌðә/a. 其他的, 另外的, 从前的;其他的, 他人, 另外一个
only|/'әunli/a. 唯一的, 仅有的, 最佳的;只有, 仅仅, 只能;但是, 不过
give|/giv/n. 弹性, 适应性;给, 授予, 供给, 产生, 发表, 付出, 献出, 让出;捐赠, 支持不住, 让步
good|/gud/n. 善行, 好处, 利益;好的, 优良的, 上等的, 愉快的, 有益的, 好心的, 慈善的, 虔诚的
more|/mɒ:/n. 更多;多的, 程度较大的, 更大的;多, 更多, 进一步; DOS外部命令:显示满屏后自动暂停, 并显示:"--More--", 按任意键继续
people|/'pi:pl/n. 人, 人民, 民族, 平民;使住满人, 居住于
also|/'ɒ:lsәu/adv. 也, 并且, 同样地
any|/'eni/a. 任何的;任何
first|/fә:st/adv. 首先, 第一, 优先;第一的;第一;开始, 第一
very|/'veri/a. 真正的, 恰好的, 十足的, 特有的;非常, 完全
new|/nju:/a. 新的, 陌生的, 最近的, 不熟悉的; 新发现的, 新的, 重新开始的
look|/luk/n. 一看, 神色, 样子, 面容;看, 注意, 朝着, 显得;打量, 看上去与...一样, 以眼色(或脸色)显示, 期待
should|/ʃud/aux. 应该, 将要
way|/wei/n. 路, 路线, 路途, 方法, 道路, 情形, 规模, 习惯, 行业, 方面;远远地, 非常
like|/laik/a. 相似的, 同样的;喜欢, 愿意, 想;喜欢, 希望;爱好, 同样的人(或物);象, 如同;可能
than|/ðæn/conj. 比, 除...外;比
how|/hau/adv. 如何, 怎样, 多少, 多么;方式
man|/mæn/n. 男人, 人类, 人;为...配备人手, 操纵, 使振奋; 城域网, 手册
find|/faind/vt. 发现, 感到, 找到, 认为, 得到;裁决;发现; 查找;DOS外部命令:在指定的文件或从键盘输入的文本行中;寻找指定的字符串, 将符合条件的行或行数输出到标准输出设备上
our|/'auә/pron. 我们的
want|/wɒnt/n. 需要的东西, 缺乏, 贫困, 需要;要, 希望, 应该, 缺少;生活困苦, 需要, 缺少
day|/dei/n. 天, 日子, 白天, 工作日; 日(一昼夜), 昼, 白天
after|/'ɑ:ftә/prep. 在...之后, 由于;在...之后;后来
between|/bi'twi:n/prep. 在...之间
many|/'meni/n. 多数, 多数人;许多的;许多
because|/bi'kɒ:z/conj. 因为
back|/bæk/a. 后面的;使后退, 支持;倒退, 背靠;向后地;背部, 后面
thing|/θiŋ/n. 事物, 东西, 物, 用品, 事, 事件, 情况, 行为, 特征
tell|/tel/vt. 告诉, 说, 吩咐, 断定, 知道;讲述, 泄密, 告发, 表明
such|/sʌtʃ/a. 如此的, 这样的
through|/θru:/adv. 穿越, 从头至尾, 到底, 因为;经过, 穿过;对穿的, 直达的, 完结的
over|/'әuvә/adv. 结束, 越过, 从头到尾;在...之上, 遍于...之上, 越过;上面的;越过
must|/mʌst/n. 必须, 未发酵葡萄汁, 绝对必要的事物;必须
still|/stil/n. 蒸馏室, 寂静, 剧照;蒸馏, (使)平静, (使)静止;静止的, 不动的, 静寂的, 不起泡的, 静物摄影的;仍然, 更, 静止地;然而, 但是
child|/tʃaild/n. 孩子, 产物, 追随者; 儿童
too|/tu:/adv. 也, 非常, 太
put|/put/vt. 放, 摆, 安置, 移动, 发射, 投掷, 写上, 表达, 使从事, 使受到, 驱使, 赋予;出发, 航行, 发芽;掷, 股票出售权, 笨蛋;固定不动的; 发送文件
here|/hiә/adv. 在这里, 此时, 这里;这里
own|/әun/n. 自己的;自己的, 嫡亲的, 同胞的;拥有, 支配, 自认, 承认, 顺从于;承认, 供认
oh|/әu/interj. (表示惊讶、恐怖、赞叹)哦
become|/bi'kʌm/vi. 变成, 变得;适合
Mr|先生; 存储器回收程序, 多重请求
government|/'gʌvәnmәnt/n. 政府, 内阁; 政府, 政治, 政体
work|/wә:k/n. 工作, 劳动, 职业, 行为, 功, 作品, 成果, 产品, 工程;工作, 劳动, 做, 运转, 起作用, 被加工;使工作, 使转动, 开动, 使用, 经营, 使逐渐变得, 造成
old|/әuld/n. 以前, 往昔;老的, 旧的, 古老的, 年长的, 老练的
leave|/li:v/n. 许可, 告别, 请假, 休假;离开, 剩下, 遗忘, 委托, 丢弃;出发, 离开, 生叶
life|/laif/n. 生活, 生命, 人生, 世事, 生物, 寿命, 一生, 生命力, 灵魂, 无期徒刑; 生活, 生存, 生命, 寿命
great|/greit/a. 大的, 非常的, 主要的, 重大的, 崇高的, 伟大的;顺利地, 得意地;全部, 大人物, 大师
woman|/'wumәn/n. 女人, 妇女, 女仆;女用的, 女性的, 妇女的;贬称...为女人, 使成女人腔
where|/hwєә/adv. 在哪里;哪里;地点
need|/ni:d/n. 需要, 必须, 缺乏;需要, 必需;贫困, 有必要;需要
seem|/si:m/vi. 象是, 似乎
feel|/fi:l/vt. 感觉, 觉得, 触摸, 以为;有知觉, 摸索, 同情;感觉, 觉得, 触摸
system|/'sistәm/n. 系统, 体系, 制度, 方式, 秩序, 分类原则; 系统;体制;体系
same|/seim/a. 相同的, 同样的;相同的人(或事物);同样地
ask|/ɑ:sk/vi. 问, 要求;问, 要求, 邀请, 需要
group|/gru:p/n. 团体, 组, 团, 群;聚合, 成群; 创建组;组, 用户组
number|/'nʌmbә/n. 数, 数字, 数目, 号码;数, 计算, 共计;计算, 报数; 数字
yes|/jes/adv. 是;是, 同意;同意
however|/hau'evә/adv. 然而, 无论如何, 究竟怎样;然而, 可是
world|/wә:ld/n. 世界, 地球, 宇宙, 万物, 世人, 人间, 领域, 世事, 世故, 社会生活, 大量; 世界, 地球, 世人
show|/ʃәu/n. 显示, 表现, 展览, 卖弄, 炫耀, 外观, 演出, 洋相;表示, 显示, 展现, 陈列, 演出, 表明, 指出, 带领;露面, 显现, 演出; 显示
house|/haus/n. 房子, 住宅, 机构, 议院, 家族, 家庭;给...房子住, 收藏;住, 躲藏
area|/'єәriә/n. 区域, 面积, 范围, 空地; 区域
another|/ә'nʌðә/a. 另外的, 再一的, 不同的;又一个, 另一个, 类似的另一个
company|/'kʌmpәni/n. 公司, 友伴, 交往, 连队, 朋友, 一群;陪伴;交往
high|/hai/n. 高度, 高处;高的, 高级的, 主要的, 高尚的, 高原的, 高音的, 昂贵的, 傲慢的;高度地, 奢侈地
most|/mәust/n. 最多, 最大;大多数的, 几乎全部的, 最多的;最, 最多, 极其
problem|/'prɒblәm/n. 问题, 难题;成问题的, 难处理的
against|/ә'geinst/prep. 反对, 对着, 倚靠
again|/ә'gein/adv. 再一次, 又, 到原处
never|/'nevә/adv. 从不, 决不, 不曾; 永不, 决不, 从来没有
under|/'ʌndә/prep. 在...之下, 低于;下面的, 从属的;在下面
try|/trai/n. 尝试, 试验, 审理, 审判;试, 尝试, 试验, 考验, 审问, 提炼;尝试, 试图
service|/'sә:vis/n. 服务, 贡献, 雇佣, 公职, 服役, 功劳, 仪式, 送达, 行政部门;保养, 维修;武装部队的, 服务性的, 仆人的, 耐用的; 服务, 业务
call|/kɒ:l/n. 呼叫, 访问, 打电话, 号召, 召集, 要求;呼叫, 召集, 打电话;叫喊, 访问, 叫牌; 调用;呼叫;DOS内部命令:在批处理文件中调用另一个批处理文件
much|/mʌtʃ/n. 大量, 许多, 重要的事;很多的, 重要的;多, 甚, 几乎
school|/sku:l/n. 学校, 鱼群, 门派, 学派;教育, 训练, 培养;成群地游
party|/'pɑ:ti/n. 宴会, 党, 政党, 团体, 当事人, 聚会;举办聚会
something|/'sʌmθiŋ/pron. 某事, 某物
small|/smɒ:l/a. 小的, 少的, 小型的, 低微的, 小气的, 细微的;些微地;狭小部分
why|/hwai/adv. 为什么;原因, 理由
each|/i:tʃ/a. 每个, 每一;每个;每个, 个人, 各自
keep|/ki:p/n. 生计, 维持, 保持;保持, 保存, 遵守, 看守, 整理, 维持, 履行, 经营, 拘留, 记帐;保持, 继续不断
provide|/prә'vaid/vt. 提供, 供应, 规定, 预备;作准备, 抚养, 规定
off|/ɒf/a. 关着的, 不再生效的, 处于...境况的, 休假的, 空闲的;走开, ...掉, ...下, 休息, 出发, 隔断;离开, 脱落, 不在从事......, 在...之外;离开, 滚开;杀死;关闭状态; 关闭, 清屏命令
country|/'kʌntri/n. 国家, 乡村, 地区, 故乡;乡下的, 农村的; DOS外部命令:用于设定国家代码, 包括日期时间及货币格式
point|/pɒint/n. 点, 小数点, 标点, 地点, 要点, 特点, 尖端, 分数, 得分, 穴位;弄尖, 强调, 指出, 加标点于, 瞄准;指, 指向, 表明
different|/'difәrәnt/a. 不同的; 差动, 微分的, 差速器
really|/'riәli/adv. 实际上, 真实地, 实在
week|/wi:k/n. 星期, 周
large|/lɑ:dʒ/a. 大的, 大量的, 宽大的, 广博的;大大地, 夸大地
member|/'membә/n. 成员, 会员; │肢, 肢体
turn|/tә:n/n. 转弯, 转动, 旋转, 翻转, 一圈, 顺次, 改动, 变化, 性格, 特色, 形状, 转折;使旋转, 转弯, 转动, 使转向, 驱赶, 阻挡, 兑换, 改写, 使作对, 绕过, 使流通;转动, 转弯, 转向, 翻转, 回转, 改变, 转身, 变成, 变质, 晕…
always|/'ɒ:lweiz/adv. 总是, 始终
follow|/'fɒlәu/vt. 跟随, 沿行, 遵循, 追求;跟随, 接着;跟随, 追随
end|/end/n. 结束, 终点, 目标, 末端, 梢, 死亡, 残余;结束, 终结, 终止; 端;结束
without|/wi'ðaut/prep. 没有, 不, 在...之外;在外面, 户外;外面, 外部
few|/fju:/a. 很少的, 不多的, 少数的;少数
within|/wi'ðin/n. 内部, 里头;在内部, 在内心里;在...之内
local|/'lәukәl/a. 地方性的, 当地的, 局部的, 乡土的, 本地的;当地居民, 本地新闻, 局部; 本地的;局部
during|/'djuәriŋ/prep. 在...的时候
begin|/bi'gin/v. 开始; 开始
state|/steit/n. 州, 状态, 情形, 国家, 政府, 领土, 国务, 社会地位;国家的, 正式的, 礼仪用的, 州的;说明, 陈述, 规定; 状态
bring|/briŋ/vt. 带来, 产生, 促使, 提出;生产
word|/wә:d/n. 话, 消息, 词, 诺言, 命令;用言辞表达; 字
although|/ɒ:l'ðou/conj. 虽然, 尽管
before|/bi'fɒ:/prep. 在...之前;在...之前;在前
next|/'nekst/n. 下一个;下一个的, 其次的, 贴近的;然后, 下次, 次于; 近邻干扰
family|/'fæmәli/n. 家庭, 家人, 族;家庭的
fact|/fækt/n. 事实, 真实性, 真相, 细节, 论据
social|/'sәuʃәl/a. 社会的, 群居的, 社交的;联欢会
help|/help/n. 帮忙, 帮助者, 补救办法, 有益的东西;帮助, 帮忙, 接济, 治疗, 款待;有用, 救命, 招待; 帮助, 帮助程序;DOS外部命令: DOS命令的电子文件帮助程序
start|/stɑ:t/n. 惊起, 出发, 开端, 起点, 吃惊, 有利条件;开始, 出发, 启动, 跳起, 吃惊, 出现, 松动, 脱落, 起价, 参赛;使惊起, 开动, 发动, 启动, 开始, 创办, 提议, 使松动, 使脱落, 起用; 起始
quite|/kwait/adv. 相当, 完全, 十分
run|/rʌn/n. 跑, 赛跑, 奔跑, 奔跑的路程, 趋向, 流出, 运转时间, 连续;跑, 奔跑, 跑步, 赛跑, 竞赛, 行驶, 运转, 进行, 蔓延;使跑, 参赛, 追究, 驾驶, 开动, 管理, 经营, 使流出, 运行;熔化的, 融化的, 浇铸的;run的过去式和过去分词;…
head|/hed/n. 头, 头脑, 领袖, 脑袋, 最前的部分;为首, 朝向, 前进, 用头顶;朝特定方向行进, (作物)结穗;头的, 在顶端的, 主要的; 磁头;冲头
every|/'evri/a. 每一, 所有的
write|/rait/vt. 书写, 著述, 写, 写满, 写信给;写, 写字, 写信, 写作, 作曲; 书写器
side|/said/n. 旁边, 侧, 方面, 胁, 侧边, 血统;旁的, 侧的, 次要的;同意, 支持;支持, 赞助
month|/mʌnθ/n. 月; 月
business|/'biznis/n. 生意, 事情, 业务, 商业, 商行, 职责; 企业, 商业, 营业
night|/nait/n. 夜, 夜晚, 晚上, 黑暗, 夜晚的工作; 夜, 黑夜, 黑暗
important|/im'pɒ:tәnt/a. 重要的, 有地位的, 大量的, 显要的, 自负的; 要点
eye|/ai/n. 眼睛, 视力, 看;看, 注视
move|/mu:v/n. 移动, 迁居, 步骤;移动, 开动, 感动, 搬(家);移动, 离开, 运行, 迁移, 摇动, 搬家, 交往, 进展, 脱手; 移动;传送;DOS外部命令:移动文件, 它可将文件移动到指定的地方
question|/'kwestʃәn/n. 问题, 询问;询问, 审问, 怀疑; 询问
information|/.infә'meiʃәn/n. 消息, 知识, 通知, 情报, 信息, 问讯处, 起诉; 信息
play|/plei/n. 游戏, 游玩, 玩笑, 运动, 比赛, 赌博, 跳动, 表演, 剧本;玩, 游戏, 假装, 开玩笑, 比赛, 扮演, 演奏, 演戏, 传摇曳, (使)跳动; 播放
power|/'pauә/n. 力, 体力, 力量, 势力, 动力, 权力, 强国, 乘方, 强度, 幂, 功率;使...有力量, 供以动力, 激励; 乘幂;DOS外部命令:能控制许多电池电源计算机上的电源管理特性
change|/tʃeindʒ/n. 变化, 找回的零钱, 找头, 更换;改变, 更换, 兑换
pay|/pei/n. 薪资, 付款, 补偿;支付, 付清, 补偿, 偿还, 对...有利, 为...涂防水物;付款, 付出代价, 偿还, 得到报应, 获得好处
young|/jʌŋ/a. 年轻的, 无经验的, 朝气蓬勃的;青年们, 幼小动物, 崽
both|/bәuθ/a. 两者的;两者都;两者
often|/'ɒ:fn/adv. 时常, 常常
interest|/'intrist/n. 兴趣, 嗜好, 利息, 利益, 爱好, 趣味, 势力;使感兴趣, 与...有关系
national|/'næʃәnәl/a. 国家的, 国立的, 全国性的, 民族的; 全国性的, 国家的, 国民的
money|/'mʌni/n. 金钱, 一笔款, 财富, 货币, 金额; 货币, 金钱, 财产
development|/di'velәpmәnt/n. 发展; 展开
book|/buk/n. 书, 书籍, 帐簿, 名册, 工作簿;登记, 预订; 工作簿
water|/'wɒ:tә/n. 水, 雨水, 海水, 水位, 水面, 流水;给...浇水, 供以水, 注入水, 使湿;流泪, 流口水, 加水;水的, 水上的, 水生的, 含水的
away|/ә'wei/adv. 离去
hear|/hiә/vt. 听到, 倾听, 听说, 审理;听见, 听
room|/ru:m/n. 房间, 空位, 场所;住宿, 居住;留宿
level|/'levl/n. 水平, 水准, 平地;同高的, 平坦的, 齐平的, 水平的;弄平, 夷平, 使同等, 瞄准, 对准;变平, 拉平; 级别
second|/'sekәnd/n. 秒, 瞬间, 第二名, 支持者, 助手;第二的, 其次的, 次要的, 附加的, 辅助的;第二;当...助手, 支持
early|/'ә:li/a. 早的, 早熟的;很早, 初
include|/in'klu:d/vt. 包括, 把...算入, 包住; DOS内部命令:在CONFIG.SYS文件的一个配置块中包含另一配置块的内容
car|/kɑ:/n. 汽车, 客车; 车
perhaps|/pә'hæps/adv. 也许, 大概
policy|/'pɒlisi/n. 政策, 方针, 策略, 保险单; 凭单, 保险单
council|/'kaunsәl/n. 会议, 委员会; 委员会
believe|/bi'li:v/v. 相信
market|/'mɑ:kit/n. 市场, 交易, 集市, 推销地区, 行情, 市面, 销路;在市场上交易, 使上市, 销售;在市场上买卖
already|/ɒ:l'redi/adv. 已经, 早已
possible|/'pɒsәbl/a. 可能的, 潜在的, 合适的;可能性, 可能的事物
allow|/ә'lau/vt. 允许, 同意给予, 承认;容许, 猜想; 允许命令
nothing|/'nʌθiŋ/n. 无, 不关紧要之事, 零;毫不, 决不;什么也没有, 无
meet|/mi:t/n. 会, 集会;适宜的, 合适的;遇见, 引见, 认识, 满足, 对付;相遇, 接触
big|/big/a. 大的, 重要的;大量地
yet|/jet/adv. 还, 尚, 仍然, 已经, 然而;然而
effect|/i'fekt/n. 结果, 影响, 效果, 印象;实行, 引起, 完成; 效果
result|/ri'zʌlt/n. 结果, 成绩, 答案;产生, 结果, 致使; 结果
whether|/'hweðә/conj. 是否, 不论;两个中的哪一个
idea|/ai'diә/n. 主意, 办法, 理想, 思想, 概念, 意见; 观念, 思想
study|/'stʌdi/n. 学习, 研究, 学科, 论文, 求学, 书房, 试作;学习, 读书, 研究, 考虑, 计划;学习, 思索
name|/neim/n. 名字, 名称, 姓名, 名义, 名誉, 文件名;命名, 称呼, 任命, 提名, 列举;姓名的, 据以取名的; 名称, 文件名, 姓名
job|/dʒɒb/n. 工作, 零活, 职业, 事情;做零工, 打杂, 做股票经纪, 假公济私;代客买卖, 批发, 承包, 欺骗; 作业
stand|/stænd/n. 站立, 站住, 停顿, 讲台, 看台, 立场, 法院证人席;站, 立, 坐落, 停滞, 位于, 坚持, 维持原状;忍受, 使站立, 抵挡
body|/'bɒdi/n. 身体, 人, 尸体, 主要部分, 团体;赋以形体; 体
happen|/'hæpәn/vi. 发生, 发生, 恰巧
report|/ri'pɒ:t/n. 报告, 报道, 传说, 案情报告, 爆炸声, 成绩单;报告, 汇报, 转述, 报道, 揭发, 使报到;报告, 写报道, 报到; 报告
line|/lain/n. 列, 线, 绳, 电线, 线路, 路线, 航线, 作业线, 界线, 战线, 外形, 排, 家系;排成一行, 顺...排列, 划线于, 加衬里, 使有线条, 使起皱纹;排队; 线路
law|/lɒ:/n. 法律, 法则, 定律, 法律的制约, 法学, 司法界, 诉讼;起诉
later|/'leitә/adv. 以后, 随后
almost|/'ɒ:lmәust/adv. 几乎, 差不多
friend|/frend/n. 朋友, 支持者, 赞助者; 朋友, 友人, 赞助者
face|/feis/n. 脸, 面容, 正面, 外观;面对, 朝, 正视, 面临;朝, 向; 现场可改变的控制元件
carry|/'kæri/n. 进位, 射程, 运载;携带, 运送, 支持, 传送, 包含;被携带, 能达到; 进位;进位数
road|/rәud/n. 路, 道路, 公路, 途径, 方法; 公路, 道路, 行车道
authority|/ɒ:'θɒriti/n. 权力, 当权者, 当局, 权威, 专家; 代理权, 授权, 权威
himself|/him'self/pron. 他自己, 他亲自
far|/fɑ:/a. 远的, 久远的, 遥远的;甚远地, 很, 到很深的程度, 到很远的距离
together|/tә'geðә/adv. 一起, 共同, 彼此
talk|/tɒ:k/n. 谈话, 交谈, 会谈, 讲话, 演讲, 空谈, 谣言, 方言, 语言;讲话, 演讲, 说话, 谈话, 交流, 闲聊, 说闲话;讲, 说, 讨论, 谈论; 对话类, 聊天
appear|/ә'piә/vi. 出现, 显得, 来到; 出庭, 到案, 出现
little|/'litl/n. 一点点, 少许, 一会儿, 短时间;小的, 很少的, 幼小的, 琐碎的, 短暂的, 矮小的;很少, 稍微, 完全不
political|/pә'litikl/a. 政治的, 政治上的, 政党的, 从事政治的; 政治的, 政治上的, 党派政治的
minister|/'ministә/n. 部长, 牧师, 公使;服侍, 救助, 主持宗教仪式
able|/'eibl/a. 能干的, 能够的
produce|/prә'dju:s/n. 生产品, 物产, 后代;产生, 生产, 提出, 出示;生产, 制造
rate|/reit/n. 比率, 率, 速度, 价格, 费用, 等级;估价, 认为, 鉴定等级, 责骂;被评价, 责骂
late|/leit/a. 迟的, 晚的, 已故的;很晚, 很迟, 晚
hour|/auә/n. 小时, 钟头, 时间, ...点钟, 课时
door|/dɒ:/n. 门
general|/'dʒenәrәl/n. 一般, 将军, 大体;全面的, 大体的, 总的, 一般的, 普遍的;常规; 常规
sit|/sit/vi. 坐, 就座, 坐落;使就座, 骑;坐, 衣服合身
office|/'ɒfis/n. 办公室, 部, 公职, 职责; 办公室
war|/wɒ:/n. 战争, 战争状态, 战术, 军事, 冲突, 斗争, 竞争;进行战争, 作战, 打仗, 战斗;战争的, 战时用的
since|/sins/prep. 自...以后, 自...以来;自那时以后;既然, 自...以后, 自...以来
mother|/'mʌðә/n. 母亲, 修女院长;产生, 照看, 收养
offer|/'ɒfә/n. 给予(物), 出价, 提议, 意图, 报价;提供, 出价, 奉献, 试图, 使出现, 演出;出现, 献祭, 提议, 求婚
person|/'pә:sn/n. 人, 人身, 人称; 人, 法人, 人身
full|/ful/n. 全部, 完整;充满的, 完全的, 丰富的, 完美的, 丰满的, 详尽的;完全地, 整整, 十分;把(衣服等)缝得宽松, 漂洗; 完整
reason|/'ri:zn/n. 理由, 原因, 理智, 道理, 前提, 理性;说服, 推论, 辩论;推论, 劝说, 思考
view|/vju:/n. 视野, 风景, 见解, 视力, 观看, 视图, 指望, 意图, 印象;看, 考虑, 视察, 查看, 估量; 视图
consider|/kәn'sidŋ/v. 考虑, 思考, 认为
expect|/iks'pekt/vt. 预期, 盼望, 期待
suggest|/sәg'dʒest/vt. 提议, 建议, 促成, 暗示, 启发, 使人想起; 建议, 提出, 提议
anything|/'eniθiŋ/pron. 任何事
term|/tә:m/n. 术语, 专有名词, 期限, 学期, 任期, 条件, 价钱, 关系, 地位, 项, 界石;称, 呼; 检索词;项
towards|/tә'wɔ:dz/prep. 向, 对于, 为了
low|/lәu/n. 低点, 低价, 低, 牛叫声;低的, 消沉的, 低等的, 浅的, 卑贱的;低下地, 谦卑地, 低;牛叫
public|/'pʌblik/n. 公众, 民众;公众的, 公共的, 公立的, 公用的
let|/let/vt. 让, 假设, 出租, 排放, 妨碍;出租, 被承包;出租屋, 障碍
read|/ri:d/v. 读, 阅读, 理解;有学问的;读取, 阅读; 读取
continue|/kәn'tinju:/vi. 继续, 延续, 延长;使继续, 使延长
figure|/'figә/n. 数字, 价格, 图形, 形状;描绘, 表示, 演算, 认为;计算, 出现, 估计
society|/sә'saiәti/n. 社会;社交界;交往;社团
centre|/'sentә/n. 中心, 中心点, 中锋;中央的, 位在正中的;集中, 定中心;居中
police|/pә'li:s/n. 警察, 警察当局, 治安;维持治安, 管辖
lose|/lu:z/vt. 遗失, 损失, 丢失, 使失去, 错过, 浪费, 迷失, 使迷路, 输去, 使沉溺于;受损失, 失败
add|/æd/vt. 增加, 添加, 附带说明, 计算...总和;做加法, 积累而成, 增添; 加法
fall|/fɒ:l/n. 落下, 瀑布, 采伐量, 下降, 落差, 降低, 堕落, 秋天;倒下, 落下, 来临, 失守, 阵亡, 下跌, 减弱, 倾斜, 垮台, 轮到, 变成, 降低;秋天的
probably|/'prɒbәbli/adv. 大概, 或许
available|/ә'veilәbl/a. 可利用的, 可获得的, 有效的; 有效的, 可得的
community|/kә'mju:niti/n. 社区, 公众, 共有, 共同体; 公众, 共有, 社会
price|/prais/n. 价格, 代价, 价值;定...的价格
control|/kәn'trәul/n. 控制, 管理, 克制, 控制器, 操纵装置;控制, 操纵, 抑制; 控制;控制器
action|/'ækʃәn/n. 行动, 活动, 动作, 作用, 战斗, 行为, 诉讼;对...起诉; 方式
issue|/'isju/n. 发行, 问题, 后果, 流出, 出口, 争端;发行, 流出, 造成...结果, 传下;使流出, 放出, 发行, 发布, 发给
cost|/kɒst/n. 代价, 价值, 费用;花费;使失去, 值, 使花费
process|/'prɒses/n. 程序, 进行, 过程;加工, 使...接受处理, 对...处置, 对...起诉;经加工的, 有特殊光效的; 进程
remain|/ri'mein/vi. 保持, 逗留, 剩余; 停留, 居住, 继续
position|/pә'ziʃәn/n. 位置, 地位, 身分, 形势, 姿势, 立场, 职位, 状态, 阵地;安置, 决定...的位置; 位置
remember|/ri'membә/vt. 记得, 回忆起, 记住, 铭记, 纪念;记得
course|/kɒ:s/n. 课程, 路线, 过程, 一道菜, 道路;追, (使)跑
bad|/bæd/a. 坏的;坏;坏地
today|/tә'dei/n. 今天, 当今, 现在;今天, 当今
buy|/bai/vt. 买, 获得;买;购买, 买得的东西
speak|/spi:k/vi. 说, 说话, 演说, 发言;说, 讲, 说出
education|/.edju'keiʃәn/n. 教育, 训练, 教育学; 教育, 训练
actually|/'æktʃuәli/adv. 事实上, 竟然, 如今, 现在
ever|/'evә/adv. 曾经, 究竟, 永远
research|/ri'sә:tʃ/n. 研究, 调查, 考察;研究, 调查
stop|/stɒp/n. 停止, 车站, 逗留, 填塞, 障碍, (风琴的)音栓;停止, 被塞住;塞住, 堵塞, 阻止, 击落, 停止, 终止, 断绝
programme|/'prәugræm/n. 节目, 节目单, 程序, 纲要, 大纲, 计划;规划, 拟...计划;安排节目, 编程序
moment|/'mәumәnt/n. 片刻, 瞬间, 重要, 阶段, 力矩; 片刻, 瞬间, 时机, 因素, 矩
girl|/gә:l/n. 女孩, 少女, 女佣
age|/eidʒ/n. 年龄, 老年, 成年, 寿命, 时代, 时期;变老, 成熟
father|/'fɑ:ðә/n. 父亲, 祖先, 长辈, 神父, 创始者;当...的父亲, 保护, 创作, 发明, 培养
send|/send/vt. 发送, 使进入, 寄, 派遣, 发射, 使陷于;寄信, 派人, 播送;(船的)上升运动; 发送
value|/'vælju:/n. 价值, 价格, 购买力, 评价, 估价, 计算结果;评价, 估价, 重视; 计算结果
force|/fɒ:s/n. 力量, 武力, 势力, 影响力, 军队, 力, 效力;强迫, 强夺, 推动, 提高; 人工转移;强制
matter|/'mætә/n. 事件, 物质, 原因, 素材, 实体, 重要;有关系
act|/ækt/n. 行动, 行为, 幕, 法案;行动, 表演, 假装, 见效, 表现, 担当;扮演, 装作; 先进通信技术, 先进计算机工艺, 自动代码翻译技术
receive|/ri'si:v/vt. 收到, 接到, 得到, 接待, 迎接, 承受;收到, 会客; 接收
health|/'helθ/n. 健康, 卫生, 蓬勃, 健康状态; 健康
decide|/di'said/v. 决定, 判决
main|/mein/n. 主要部分, 干线, 体力, 力量, 主群组;主要的, 重要的, 全力的; 主群组
though|/ðәu/adv. 然而, 可是;虽然, 纵然
enough|/i'nʌf/n. 充足, 够, 很多;充足的, 足够;足够;够了
less|/les/n. 较少, 较小;少的, 小的;较少, 较小, 较差; 最低成本估算与调度法
street|/stri:t/n. 街道, 马路, 街区;街道的
decision|/di'siʒәn/n. 决定, 决心, 决断; 判定
until|/әn'til/prep. 直到, 在...以前;直到...时, 在...以前
industry|/'indәstri/n. 勤劳, 工业, 企业, 产业, 有组织的劳动; 工业, 实业
sure|/ʃuә/a. 确信, 必然的, 必定的;当然, 确实地, 无疑地
class|/klɑ:s/n. 班级, 阶级, 种类, 课;分类; 类别;类;种类;类程
win|/win/vt. 赢得, 打胜, 成功;获胜, 达到, 影响;胜利, 赢, 收益
several|/'sevәrәl/a. 几个的, 一些的, 各自的;几个
clear|/kliә/a. 清楚的, 明确的, 澄清的;清晰地;澄清, 清除障碍;放晴, 变清澈;空隙; 清除
understand|/.ʌndә'stænd/vt. 理解, 了解, 领会, 听说, 懂;懂得, 认为
major|/'meidʒә/n. 主修课, 成年人, 陆军少校;主要的, 较多的, 大部分的, 成年的, 严重的;主修; 主要, 主要刻度
themselves|/ðәm'selvz/pron. 他们自己, 她们自己, 它们自己
paper|/'peipә/n. 纸, 文件, 文章, 报纸, 证券, 证件;用纸糊, 贴壁纸于, 用纸包装;贴壁纸;纸做的, 纸上的
itself|/it'self/pron. 它本身, 它自己
around|/ә'raund/prep. 包围, 在...周围, 四处;兜着圈子, 在附近, 到处
describe|/di'skraib/vt. 描述, 描绘, 画
condition|/kәn'diʃәn/n. 情况, 条件;使健康, 以...为条件, 决定, 使适应; 条件
develop|/di'velәp/vt. 发展, 使发达, 进步, 洗印, 显影;发展, 生长
agree|/ә'gri:/vi. 同意, 赞成, 应允, 适合;承认, 认定, 同意
economic|/.i:kә'nɒmik/a. 经济上的, 实用的, 节省的; 经济的
open|/'әupәn/n. 公开, 户外, 空旷;开着的, 开放的, 开阔的, 营业着的, 公开的, 悬而未决的;打开, 公开, 开放;展开, 开始, 展现; 打开指令;打开语句
reach|/ri:tʃ/n. 伸出, 延伸, 区域, 范围, 流域, 岬;到达, 达到, 伸出, 延伸, 影响;达到, 延伸, 伸出手, 传到
century|/'sentʃuri/n. 世纪, 百年
build|/bild/v. 建立, 建筑;构造, 体格
including|包含, 包括; 包括, 算入
sense|/sens/n. 感应, 感觉, 感官, 意识, 观念, 情理, 知觉, 理智;感觉, 觉察, 检测; 阅读;检测
among|/ә'mʌŋ/prep. 在...之中
building|/'bildiŋ/n. 建筑物, 建筑; 营造, 建筑, 建筑物
sort|/sɒ:t/n. 种类, 方式, 品质, 态度, 举止;分类, 排序, 挑选;交往, 协调; 排序;DOS外部命令:从标准输入设备接收数据, 整个数据输入完后;对它以行为单位进行排序, 然后在标准输出设备上输出
likely|/'laikli/a. 有可能的, 合适的, 前途有望的;或许, 可能
staff|/stɑ:f/n. 全体人员, 工作班子, 棍棒, 杆, 拐杖, 支柱, 权杖;职员的, 雇员的, 参谋的;为...配备人员
spend|/spend/vt. 花费, 浪费, 度过, 消耗, 消磨;花费, 用尽
real|/'riәl/a. 真的, 真实的, 实际的, 实在的, 不动(产)的, 实数的;实数, 现实;真正地
black|/blæk/n. 黑色, 黑颜料;黑色的
team|/ti:m/n. 队, 组;把马(牛)套在同一辆车上, 把...编成一组;驾驶卡车, 协作
return|/ri'tә:n/n. 回来, 返回, 来回票, 归还, 报答, 利润率, 报告书;返回的, 回程的, 报答的, 反向的, 重现的, 复原的;返回, 归还, 回来;归还, 还, 回报, 产生, 反射, 报告, 申报, 退回; 返回
draw|/drɒ:/vi. 拉, 拖, 拔剑;拖拉, 挨近, 领取, 打成平局, 引导, 抽签决定, 画, 描写, 制订, 草拟, 吸引;拉, 拖, 拔出, 抽签, 平局; 翻牌, 绘图
experience|/ik'spiәriәns/n. 经历, 经验, 体验;经历, 经验, 体验
student|/'stju:dnt/n. 学生, 研究者, 学者
town|/taun/n. 城镇, 市, 镇; 城镇, 城市, 闹市
Mrs|太太
international|/.intә'næʃәnәl/a. 国际的;国别设定; 国别设定
either|/'i:ðә/a. (两者之中)任一的, (两者之中)各一的;(两者之中)任一;或, 要么
special|/'speʃәl/n. 专辑, 专车, 号外, 特别的东西, 负有特别任务的人员;特别的, 专门的, 特殊的, 额外的, 附加的, 特别亲密的
difficult|/'difikәlt/a. 困难的
plan|/plæn/n. 计划, 方案, 策略, 方法, 进度表, 程序表, 平面图, 设计图, 轮廓, 示意图;计划, 设计, 意欲;订计划
die|/dai/vi. 死亡, 消逝, 平息, 熄灭, 漠然, 渴望;死;骰子, 冲模
hope|/hәup/n. 希望, 信心, 期待;希望, 期望, 信赖
morning|/'mɒ:niŋ/n. 早晨, 早上, 初期
department|/di'pɑ:tmәnt/n. 部门, 系, 机关; 部, 科
across|/ә'krɒs/prep. 越过, 穿过, 与...相交叉, 在...的对面;交叉, 到另一边, 在对面, 成十字
create|/kri:'eit/vt. 创造, 建造, 引起, 任命
committee|/kә'miti/n. 委员会; 委员会
product|/'prɒdʌkt/n. 产品, 结果, 乘积; 生产物
whole|/hәul/n. 全部, 全体, 整体, 完全之体系;所有的, 完整的, 完全的, 纯粹的
letter|/'letә/n. 信, 字母, 证书, 字面意义, 铅字, 学问, 出租人;写字母于, 在...上刻字母, 用字母标明;写印刷体字; 字母
ground|/graund/n. 土地, 战场, 场地, 地面, 范围;土地的, 地面上的;放在地上, 使搁浅, 打基础, 给...以训练;搁浅, 落地, 根据, 基于;磨过的;grind的过去式和过去分词
meeting|/'mi:tiŋ/n. 会议, 会面; 会议, 会谈, 集会
walk|/wɒ:k/n. 走, 散步, 步行, 行走的路程, 竞走, 散步场所;走路, 步行, 处世;走过, 遛, 使走, 护送...走
foot|/fut/n. 脚, 步调, 英尺, 底部, 末尾, 步兵;走在...上, 给...换底, 支付;跳舞, 步行, 总计
rather|/'ræðә/adv. 宁可, 稍微, 相当
sell|/sel/vt. 卖, 背叛, 销售, 出卖;卖, 销售;卖, 推销术, 失望
boy|/bɒi/n. 男孩; 男孩, 少年, 儿子
wait|/weit/n. 等待, 等候;等候, 期待, 延缓, 伺候, 推迟;等, 等候, 耽搁, 伺候用餐; 等待
game|/geim/n. 比赛, 玩耍, 比分, 得胜, 比赛规则, 策略, 游戏, 野味;赌博;勇敢的, 有胆量的, 关于野味的, 跛的; 博弈;对策
food|/fu:d/n. 食物, 养料; 食物, 食品
union|/'ju:njәn/n. 联盟, 联合, 结合, 工会; 联合;联管节;活接头
role|/rәul/n. 角色, 职责, 任务; 作用, 功用
half|/hɑ:f/n. 一半, 半场, 不完全;一半的, 不完全的, 部分的, 半场的;一半地, 部分地, 在某种程度上地, 几乎
else|/els/a. 别的, 其他的;另外, 否则, 不然
land|/lænd/n. 陆地, 地面, 地界, 地产, 国土, 土地;登陆, 登岸, 到达;使上岸, 使登陆, 使到达; 连接盘;焊盘
event|/i'vent/n. 事件, 结果, 事情的进程, 竞赛项目; 事件
white|/hwait/n. 白色, 洁白, 眼白, 白种人, 蛋白;白色的, 纯洁的, 白种的, 苍白的, 空白的, 幸运的
cause|/kɒ:z/n. 原因, 目标;引起, 使产生, 使遭受
art|/ɑ:t/n. 艺术, 人文科学, 技术, 巧妙, 诡计, 美术; 实际保持时间, 特许权和资源表, 平均检索时间, 平均运行时间
pass|/pæs/n. 经过, 要隘, 途径, 通行, 护照, 及格;经过, 越过, 通过, 批准, 度过, 传递, 忽略;经过, 变化, 流通, 及格, 宣判, 终止, 消逝, 被忽略, 不叫牌, 传递; 遍
support|/sә'pɒ:t/n. 支持, 支撑, 援助, 供养, 支撑物;支援, 支撑, 帮助, 支持, 忍受, 供养, 证实; 后援;支持
stage|/steidʒ/n. 阶段, 舞台, 场所, 戏剧, 站, 驿站, 级, 层, 脚手架;上演, 表演, 筹划;适于上演, 乘驿车旅行
trade|/treid/n. 贸易, 商业, 交易, 生意, 职业, 顾客, 信风;进行交易, 做买卖, 经商, 对换, 购物;用...进行交换
accept|/әk'sept/vt. 接受, 承认, 同意, 相信, 赞成, 承担, 承兑, 采纳, 接纳, 容忍;同意
behind|/bi'haind/adv. 在后地;在...背后
arm|/ɑ:m/n. 手臂, 袖子, 狭长港湾, 武器;武装, 装备;武装起来; 异步应答方式;自动货品销路管理
club|/klʌb/n. 俱乐部, 木棍, 球棒;用棍棒打, 缴纳;联合起来;俱乐部的
parent|/'perәnt/n. 父母, 父母亲, 根源; 父亲, 母亲, 根源
history|/'histәri/n. 历史, 过去, 经历, 发展过程, 历史学, 过去的事, 历史记录; 历史记录
free|/fri:/a. 自由的, 享受政治权力的, 允许的, 免费的, 丰富的;释放, 解放, 使自由;自由地, 免费
account|/ә'kaunt/n. 报告, 解释, 估价, 理由, 利润, 算账, 帐目;报帐, 解释, 导致, 报偿, 占, 杀死;认为; 帐户, 帐号
whose|/hu:z/pron. 谁的
easy|/'i:zi/a. 容易的, 缓缓的, 舒适的, 从容的, 宽容的, 流畅的, 随便的, 自在的, 疲软的;容易地, 慢慢地
situation|/.sitju'eiʃәn/n. 情形, 境遇, 位置; 情境, 处境
ago|/ә'gәu/adv. 以前
care|/kєә/n. 小心, 照料, 忧虑;关心, 介意;在意, 喜欢
strong|/strɒŋ/a. 强壮的, 坚固的, 坚强的, 强烈的, 有力的, 优良的;强劲地, 有力地, 猛烈地
record|/ri'kɒ:d/n. 记录, 履历, 档案, 审判记录, 最高纪录, 唱片;记录, 记载, 标明, 将...录音;记录, 录音, 可被录音;创纪录的; 录制, 记录
raise|/reiz/n. 上升, 高地, 增高;升起, 举起, 唤起, 提高, 使出现, 使复活, 提出, 筹集, 饲养
example|/ig'zæmpl/n. 例子, 样本, 实例; 实例
yesterday|/'jestәdi/n. 昨天;昨天
base|/beis/n. 底部, 垒, 基础, 基地;以...作基础;卑鄙的, 低劣的; 基准
break|/breik/n. 休息, 中断, 破裂处, 绝交, 破晓, 突变;打破, 弄破, 弄坏, 破坏, 违反, 打断, 削弱, 放弃;破碎, 决裂, 破晓, 突变, 变弱, 暂停;分隔符; 分隔符;中断;DOS内部命令:设定扫描中断按键的时机
learn|/lә:n/vt. 学习;认识到;得知
central|/'sentrәl/a. 中央的, 重要的; 中央的, 中心的, 中枢的
increase|/in'kri:s/n. 增加, 增进, 利益;增加, 加大;增加, 繁殖
grow|/grәu/vt. 种植, 使长满;生长, 变成, 发展
cover|/'kʌvә/n. 盖子, 封面, 藉口;覆盖, 掩饰, 保护, 掩护, 包括;覆盖
air|/єә/n. 空气, 旋律, 态度;晾, 使通风, 夸耀
university|/.ju:ni'vә:siti/n. 大学
wife|/waif/n. 妻子, 太太, 夫人; 妻子, 已婚妇女
claim|/kleim/n. 要求, 要求权, 断言, 权利;要求, 认领, 主张;提出要求, 主张, 断言
sir|/sә:/n. 先生, 阁下
everything|/'evriθiŋ/pron. 每件事物, 所有事物
rule|/ru:l/n. 规则, 统治, 控制, 支配, 规律, 标准, 章程, 破折号, 铅线;规定, 统治, 管理, 控制, 支配, 裁决;统治, 管辖, 裁定; 规则, 水线
cut|/kʌt/n. 切口, 割伤, 降低, 切, 割, 砍, 削, 伤口, 削减, 缩短, 删节, 通路;经切割的, 缩减的;切, 割, 减少, 刺痛, 开辟, 雕刻, 删节, 缩短, 停止, 排斥, 切断, 关, 显出;切, 割, 砍, 刺痛, 相交, 抄近路, 剪辑; 剪切
story|/'stɒ:ri/n. 故事, 小说, 传奇, 描述, 阅历, 经历, 层
worker|/'wә:kә/n. 工人, 劳动者; 工人, 劳工, 劳动者
tax|/tæks/n. 税, 税款, 重负, 会费;课以税, 使负重荷, 斥责
pound|/paund/n. 磅, 英镑, 重击, 鱼塘, 拘留所, 兽栏;强烈打击, 捣烂, 监禁, 关入栏内;连续重击, 苦干
once|/wʌns/adv. 一次, 曾经, 一旦;一旦, 一经;一次;从前的
stay|/stei/n. 停留, 逗留, 制止, 延缓, 停止, 支柱, 支撑物, 支索;制止, 延缓, 坚持, 支持, 支撑, 用支索固定;停留, 逗留, 暂停, 坚持, 中止
human|/'hju:mәn/n. 人, 人类;人类的, 似人类的, 人性的, 有同情心的
officer|/'ɒfisә/n. 军官, 主管, 官员, 公务员;指挥
hospital|/'hɒspitәl/n. 医院; 医院
single|/'siŋgl/a. 单身的, 单程的, 单一的, 个别的, 孤独的, 专一的;一个, 单打, 单程票;选出;击出一垒打; 单精度型
hard|/hɑ:d/a. 坚硬的, 硬的, 难的, 艰苦的, 困难的, 坚固的, 猛烈的, 艰难的, 结实的, 确实的;坚硬地, 努力地, 辛苦地, 接近地, 猛烈地, 牢固地
wall|/wɒ:l/n. 墙, 墙壁, 垣, 内壁, 分界物, 屏障;墙的;给...建墙, 禁闭, 用墙围住; 背景墙
join|/dʒɒin/vi. 参加, 结合, 加入;连接, 结合, 参加, 加入;连接, 结合, 接合点; 连接;汇合指令
herself|/hә:'self/pron. 她自己, 她亲自
bit|/bit/n. 少量, 马嚼子, 辅币;给马上嚼子, 控制;bite的过去式和过去分词; 比特, 二进制数位, 机内测试
former|/'fɒ:mә/a. 从前的, 前者的;起形成作用的人(或物), 模型, 样板
president|/'prezidәnt/n. 总统, 总裁, 董事长, (学院)院长, (大学)校长, 主管人, 主持人; 总经理, 董事长, 总裁
seek|/si:k/vt. 寻求, 寻找, 探索, 追求, 搜索, 请求;寻找, 搜索; 查找
son|/sʌn/n. 儿子, 女婿, 子孙; 儿子, 女婿, 养子
wide|/waid/a. 宽的, 广阔的, 普遍的, 宽阔的, 广泛的, 一般的;广阔地, 遍及各处地, 广泛地;大千世界
financial|/fai'nænʃәl/a. 财政的, 金融的; 财政的, 金融的, 财务的
director|/di'rektә/n. 主管, 导演, 董事; 寻向偶极子;指挥仪
leader|/'li:dә/n. 领导者, 社论, 指挥, 领袖, 领唱者, 前导字符; 前导字符
firm|/fә:m/n. 公司, 商号;坚定的, 坚强的, 牢固的, 结实的, 坚硬的, 坚挺的, 严格的, 确定的;使牢固, 使坚定;变稳固, 变坚实;稳固地
us|/ʌs/pron. 我们; 美国
soon|/su:n/adv. 不久, 早, 快, 宁可
fail|/feil/vi. 失败, 缺乏, 中断, 衰退, 失灵;忘记, 使...失望, 缺乏, 不及格;不及格
chance|/tʃæns. tʃɑ:ns/n. 机会, 意外, 可能性;偶然发生;冒险
operation|/.ɒpә'reiʃәn/n. 操作, 动作, 手术, 运算, 作用, 业务; 运算
share|/ʃєә/n. 部分, 参与, 一份, 参股, 份额;均分, 分担, 分享, 分配, 共有;分享; 共享;DOS外部命令:在网络或多工系统中提供文件共享;文件锁定及检测磁盘更动和对超过32MB硬盘分区的支持
test|/test/n. 测试, 试验, 化验, 检验, 考验, 甲壳;测试, 试验, 化验;接受测验, 进行测试
recent|/'ri:snt/a. 最近的, 近代的, 最新的; 最近的, 新进的
security|/si'kjuriti/n. 安全, 安全性, 防护物, 保安, 可靠性, 担保人, 抵押品, 保证金; 安全性, 保密性, 安全检查程序
kill|/kil/n. 杀, 杀戮, 小河;杀, 破坏, 消灭, 使终止, 抵消, 否决;杀死; 删除
election|/i'lekʃәn/n. 选举, 当选, 选择权; 选举, 当选
future|/'fju:tʃә/n. 未来, 将来;将来的, 未来的
drive|/draiv/n. 驾车, 快车道, 推进力, 驱动, 动力, 击球, 驱动器;开车, 驱使, 推动, 驾驶;开车, 猛击, 飞跑; 驱动器
colour|/'kʌlә/n. 颜色, 面色, 颜料, 外貌;把...涂上颜色, 粉饰, 使脸红, 歪曲;变色
rise|/raiz/n. 上升, 增加, 上涨, 高地, 升高, 出现;升起, 起身, 起立, 上升, 上涨, 增长, 高耸, 起义, 浮现;使飞起
page|/peidʒ/n. 页, 记录, 事件, 专栏, 男侍;标明...的页数, 翻...的书页, 分页排版, 呼叫, 侍候;翻书页, 侍侯; 页;页面
music|/'mju:zik/n. 音乐, 乐曲
love|/lʌv/n. 爱, 恋爱, 爱情, 爱好, 性爱;爱, 爱好, 爱慕;爱
charge|/tʃɑ:dʒ/n. 指控, 费用, 冲锋, 电荷, 炸药, 主管, 被托管人, 命令;控诉, 加罪于, 使充满, 使充电, 使承担;冲锋, 要价, 收费
design|/di'zain/n. 设计, 图样, 方案, 企图;设计, 计划
pressure|/'preʃә/n. 压, 榨, 按, 强制, 压力, 压迫, 压强;迫使, 使增压, 密封
plant|/plænt. plɑ:nt/n. 植物, 作物, 工厂, 树枝, 生长, 设施, 成套设备;种植, 栽培, 播种, 培养, 安置, 殖民于, 使位于;种植
news|/nju:z/n. 新闻, 消息, 报导; 新闻, 消息, 新闻报导
further|/'fә:ðә/a. 更远的, 此外的, 更多的;促进, 增进, 助长;更进一步地, 更远地, 此外
better|/'betә/a. 较好的;比较好
thought|/θɒ:t/n. 想法, 思想, 思维, 关心, 挂念;think的过去式和过去分词
list|/list/n. 目录, 名单, 明细表, 布条, 条纹, 列表, 序列, 数据清单;列出, 列于表上, 记入名单内, 装布条;列于表上; 列表, 序列, 数据清单
step|/step/n. 步骤, 步, 步幅, 脚步声, 踏级, 步伐, 短距离, 步态, 手段, 等级;踏, 以步测量, 跨步, 使成阶梯状;跨步, 轻快地走, 跳舞, 踩, 踏上, 行走; 步骤
demand|/di'mɑ:nd/n. 要求, 需求, 需要;要求, 查询
labour|/'leibә/n. 劳动, 努力, 工作, 劳工, 分娩;劳动, 努力, 苦干;详细分析, 使厌烦
near|/niә/a. 近的, 近亲的, 近似的;接近, 亲近;靠近, 近似于;接近, 走近
capital|/'kæpitәl/n. 首都, 大写字母, 资本;首都的, 重要的
player|/'pleiә/n. 竞赛者, 上场队员, 游戏者, 演员; 交易者
film|/film/n. 软片, 薄膜, 胶卷, 电影;覆以薄膜, 拍摄;生薄膜, 拍电影
attempt|/ә'tempt/n. 尝试, 企图;尝试, 企图
effort|/'efәt/n. 努力, 成就
cup|/kʌp/n. 杯子, 茶杯, 优胜杯;使成杯状, 为...拔火罐
current|/'kʌrәnt/n. 涌流, 趋势, 流;流通的, 现在的, 当前的, 流行的; 当前的
thank|/θæŋk/n. 谢意, 感谢;谢谢, 感谢
top|/tɒp/n. 顶部, 顶端, 极点, 上面, 上部, 顶篷, 最高地位, 首位, 陀螺;最高的, 顶上的, 头等的;盖, 加以顶, 高达, 超越;结束, 达到顶点, 高出; TOP协议
final|/'fainl/n. 期末考试, 结局, 决赛;最后的, 终极的, 决定性的
east|/i:st/n. 东方, 东;东方的, 向东的;向东方, 朝东方
west|/west/n. 西方, 西部;西方的, 向西的;向西, 自西方, 在西方
announce|/ә'nauns/vt. 宣布, 声称, 显示, 预告;当报幕员, 宣布参加竞选
red|/red/a. 红的, 红色的, 红肿的, 流血的;红色, 红颜料, 赤字; 简化, 减少
serious|/'siәriәs/a. 严肃的, 认真的, 重要的, 严重的; 严重的
answer|/'ɑ:nsә/n. 答案, 回答, 回报, 答辩;回答, 反驳, 适应, 响应, 符合;回答, 答应, 负责, 符合, 成功; 用户问题及答案新闻组
economy|/i'kɒnәmi/n. 经济, 理财, 节约; 经济, 整体
army|/'ɑ:mi/n. 军队, 陆军
along|/ә'lɒŋ/adv. 平行地, 向前;沿着
brother|/'brʌðә/n. 兄弟
total|/'tәutl/a. 全体的, 总的, 全然的;计算...的总和, 共计为;合计;总数, 全体, 合计;统统
season|/'si:zn/n. 季节, 时节, 当令期, 时期;给...调味, 使成熟, 使老练, 缓和;变干燥
concern|/kәn'sә:n/n. 关心, 忧虑;与...有关, 使担心, 使挂念
save|/seiv/n. 救球;解救, 挽救, 储蓄, 保存, 节省, 保留;挽救, 节省, 救球;除...之外; 保存
fund|/fʌnd/n. 基金, 资金, 存款, 财源, 贮藏;提供资金, 积累
outside|/'aut'said/n. 外面, 外表, 外界;外面的, 外表的, 外界的;外面, 外表, 外界
visit|/'vizit/n. 拜访, 访问, 游览, 视察;拜访, 访问, 参观, 视察, 降临;访问, 参观, 闲谈
daughter|/'dɒ:tә/n. 女儿;女儿的
conference|/'kɒnfәrәns/n. 会议; 会议, 讨论会, 协商会
oil|/ɒil/n. 油, 石油, 油画颜料;涂油于, 使融化成油状, 加油于;加燃油, 融化
attack|/ә'tæk/n. 攻击, 抨击;攻击, 抨击, 动手干;攻击
fight|/fait/n. 打架, 争吵, 斗志;对抗, 打架
military|/'militәri/n. 军队;军事的, 军人的, 适于战争的
hit|/hit/n. 打击, 打, 冲撞, 讽刺;打, 打击, 碰撞, 打中, 袭击, 偶然碰上;打, 打中, 打击, 碰撞, 偶然碰上; 击中;找到;瞬时打扰
sign|/sain/n. 符号, 招牌, 征兆, 正负号, 手势;签名, 打手势表达;签名; 正负号;符号;符号字符
campaign|/kæm'pein/n. 战役, 运动, 竞选运动;参加运动, 作战
direct|/di'rekt/a. 直接的, 坦白的;指示, 指挥, 命令, 导演;指导, 指挥;直接地
press|/pres/n. 压, 揿, 按, 人群, 印刷机, 压力, 出版社, 记者, 报刊, 新闻舆论, 紧迫;压, 压榨, 紧抱, 逼迫, 推进, 强迫征募, 催逼;压, 重压, 催促, 拥挤, 奋力前进, 受压
drug|/drʌg/n. 药, 麻药, 麻醉药;吸毒;使服麻醉药, 使麻木
operate|/'ɒpәreit/v. 操作, 运转, 动手术, 活动
green|/gri:n/n. 绿色, 绿色颜料;绿色的, 未成熟的, 新鲜的, 青春的, 无经验的, 脸色发青的
complete|/kәm'pli:t/a. 完全的, 十足的, 完成的;完成, 完工, 使圆满
star|/stɑ:/n. 星, 恒星, 星形物, 运气, 明星;以星状物装饰, 用星号标, 使成为明星;变成明星
independent|/.indi'pendәnt/n. 独立自主者, 无党派者;独立的, 有主见的, 不须依赖的, 不受约束的
laugh|/lɑ:f/n. 笑, 笑声;笑, 大笑;以笑表示
sister|/'sistә/n. 姐妹, 姐, 妹, 护士, 修女;姐妹般对待
fear|/fiә/n. 恐怖, 害怕, 担心;害怕, 恐惧, 为...担心, 敬畏
stock|/stɒk/n. 树干, 祖先, 血统, 原料, 备料, 库存, 牲畜, 股票, 股份, 保留剧目;存货的, 常备的, 平凡的, 普通的, 股票的, 保留剧目的, 繁殖用的;装把手于, 进货, 备有, 放牧;出新芽, 备货, 囤积
blue|/blu:/n. 蓝色;蓝色的, 下流的, 忧郁的;染成蓝色;变蓝
radio|/'reidiәu/n. 无线电, 收音机, 无线电报, 无线电广播, 无线电台;用无线电发送
aid|/eid/n. 帮助, 外援, 助手;援助, 帮助, 有助于;帮助; 自动内部诊断
match|/mætʃ/n. 比赛, 火柴, 对手;使相配, 使比赛, 与...竞争;结婚, 相配; 比较
fly|/flai/n. 苍蝇, 两翼昆虫, 飞行;飞, 飞翔, 飘扬, 逃走;飞, 飞越, 使飘扬, 逃出;敏捷的
race|/reis/n. 种族, 人种, 赛跑, 比赛, 急流, 人类, 同道, 姜根;赛跑, 竞赛, 疾走;与...赛跑, 使疾走, 使猛转; 竞争;追赶;欧州高级通信研究开发计划
past|/pɑ:st/n. 过去, 昔时, 往事, 早年经历, 过去时;过去的, 结束的, 卸任的, 过去时的;越过, 晚于, 超越, 超出...的可能性(能力、范围等);pass的过去分词
peace|/pi:s/n. 和平, 和约, 治安, 和睦, 安宁, 静寂;安静下来, 不作声
sale|/seil/n. 出售, 卖, 拍卖, 销售额, 廉价出售; 卖, 出售;销售(货)
nation|/'neiʃәn/n. 国家, 民族; 民族, 国家
front|/frʌnt/n. 前面, 开头, 前线, 阵线, 态度;面对, 朝向, 对抗;朝向
official|/ә'fiʃәl/n. 官员, 公务员, 职员;公务的, 官方的, 正式的
beat|/bi:t/n. 心跳(声), 打, 敲打声, 拍子;打, 拍打, 打败;疲乏的, 颓废的;beat的过去式; 拍;节拍
vote|/vәut/n. 投票, 选举, 选票, 表决, 选举权, 得票数;投票, 选举;投票选举, 投票决定, 公认, 使投票
release|/ri'li:s/n. 释放, 发泄, 豁免, 发行, 释放证书;释放, 解除, 放松, 豁免, 免除, 发布, 放弃, 让与;发布; 版本, 发布
chief|/tʃi:f/n. 领袖, 酋长, 长官, 主要部分;主要的, 首位的
middle|/'midl/n. 中央, 中间, 腰部;中央的, 中庸的, 中间的
quick|/kwik/a. 快的, 迅速的, 敏捷的, 灵敏的, 急速的;快;新长出的肉, 要害, 核心, 感觉敏锐部位
twice|/twais/adv. 两次, 两倍
working|/'wә:kiŋ/n. 工作, 运转, 劳动;工作的, 劳动的, 经营的, 抽搐的, 运转的
surprise|/sә'praiz/n. 惊奇, 奇袭, 诧异;使惊奇, 撞见, 奇袭
grey|/grei/n. 灰色;灰色的, 阴沉的;(使)成灰色
least|/li:st/n. 最少, 最小, 最小限度;最少的, 最小的;最小, 最少
brown|/braun/n. 褐色;褐色的;(使)变褐色
dollar|/'dɒlә/n. 美元, 元(加、澳等国货币单位); 纯经济的, 美元, 元
host|/hәust/n. 主人, 旅馆老板, 节目主持人;当主人招待, 作...节目主持人; 主机, 宿主机
bite|/bait/n. 咬, 一口;咬, 刺痛, 穿透
MS|美国微软公司; 主存储器, 制造系统, 毫秒, 微软公司
me|/mi:/pron. 我
them|/ðem/pron. 他们, 她们, 它们
him|/him/pron. 他
according to|根据, 按照;取决于;据…所说
of course|当然
will|/wil/n. 意志, 决心, 意愿, 意向, 干劲, 遗嘱;用意志的力量驱使, 决意, 愿意, 立遗嘱;下决心, 愿意;将, 愿意, 必须
may|/mei/n. 五月;愿能, 可以, 愿意
use|/ju:s/n. 使用, 习惯, 使用价值, 用法, 使用权;使用, 利用, 运用, 耗费;惯常
hand|/hænd/n. 手, 爪, 指针, 掌握, 协助, 人手, 手艺, 手迹, 支配, 插手;交给, 支持, 搀扶
while|/hwail/n. 一会儿, (一段)时间;当...的时候, 虽然;消磨
hold|/hәuld/n. 把握, 把持力, 柄, 控制, 掌握, 监禁;保存, 握住, 拿住, 占据, 持有, 拥有;支持, 持续, 有效;保留; 保留
require|/ri'kwaiә/vt. 需要, 命令, 要求; 需要, 要求, 命令
period|/'piәriәd/n. 时期, 节段, 节, 句点, 学时, 周期;当时特有的, 过去某段时期的;就是这话, 就是这么回事
city|/'siti/n. 城市, 市; 都市, 城市, 市
type|/taip/n. 类型, 样式, 典型, 榜样, 标志, 符号, 型, 式;打字;作为代表, 测定类型, 用打字机打; 类型;键入;DOS内部命令:在屏幕上显示指定文件的内容
subject|/'sʌbdʒekt/n. 科目, 主题, 臣民, 主语, 题目, (事物的)经受者, 学科, 受治疗者, 原因, 理由;服从的, 易患...的, 隶属的, 受支配的;在...条件下;使隶属, 使受到; 主题, 主体
order|/'ɒ:dә/n. 次序, 规则, 命令;命令, 定货;整理, 命令, 定购;顺序, 阶数; 顺序, 阶数
patient|/'peiʃәnt/n. 病人, 承受者;忍耐的, 容忍的, 有耐性的, 坚忍的
church|/tʃә:tʃ/n. 教堂, 礼拜, 教会;使人接受宗教仪式;教堂的
upon|/ә'pɒn/prep. 在...之上, 迫近, 紧接着
therefore|/'ðєәfɒ:/adv. 因此, 所以
section|/'sekʃәn/n. 区段, 部分, 区域, 节, 截面, 处, 科, 区, 扇区;把...分段, 把...切片;被切成片; 扇区
table|/'teibl/n. 桌子, 餐桌, 工作台, 铭文, 表格, 表, 高原, 平地层;搁置, 嵌合, 制表, 把...列入议事日程; 表格, 模拟运算表
activity|/æk'tiviti/n. 活动, 行动, 活跃, 活力; 活动
death|/deθ/n. 死亡; 死亡
involve|/in'vɒlv/vt. 包括, 使陷于, 潜心于, 包围; 累及, 牵涉, 包含
particular|/pә'tikjulә/n. 一项(或条、点), 个别项目, 详细说明;特别的, 独有的, 挑剔的, 详尽的
language|/'læŋgwidʒ/n. 语言, 文字, 措辞; 语言
particularly|/pә'tikjjlәli/adv. 特别, 格外, 尤其, 详细地, 细致地
management|/'mænidʒmәnt/n. 经营, 支配, 管理; 管理处
practice|/'præktis/n. 实践, 练习, 实行, 惯例, 习惯, 开业;实践, 实行, 练习, 实习, 业务
evidence|/'evidәns/n. 根据, 证据, 迹象; 证据, 凭证
shall|/ʃæl/aux. 将
sometimes|/'sʌmtaimz/adv. 有时, 时常, 往往
thus|/ðʌs/adv. 如此, 因此, 到如此程度; 乳香
range|/'reindʒ/n. 排, 行, 山脉, 范围, 行列, 射程;排列, 归类于, 使并列, 放牧;平行, 延伸, 漫游; 量程;范围;域;距离
voice|/vɒis/n. 声音, 嗓音, 嗓子, 愿望, 发言权, 表达, 喉舌, 语态;表达, 吐露, 调音
God|/^ɔd/n. 上帝, 神像, 偶像;使神化
field|/fi:ld/n. 领域, 田地, 场地, 战场, 场, 域;使...晒在场上, 使上场;田间的, 野生的, 野外的, 田赛的; 域, 字段
material|/mә'tiәriәl/n. 材料, 物资, 素材, 布料, 资料;物质的, 肉体的, 重要的
manager|/'mænidʒә/n. 经理, 管理员, 管理器; 管理器
project|/'prɒdʒekt/n. 计划, 设计, 事业;计划, 设计, 投掷, 发射, 使凸出, 放映;凸出
window|/'windәu/n. 窗户, 窗子, 窗口;给...开窗; 窗口
explain|/ik'splein/v. 解释, 说明
apply|/ә'plai/vt. 涂, 应用;申请, 适用
usually|/'ju:ʒuәli/adv. 通常, 大抵
difference|/'difәrәns/n. 不同, 差异; 差分
relationship|/ri'leiʃәnʃip/n. 关系, 关联; 关系
indeed|/in'di:d/adv. 的确, 实在, 真正地, 甚至
quality|/'kwɒlәti/n. 品质, 特性, 才能, 质量;优质的; 品质
certainly|/'sә:tәnli/adv. 确定地
similar|/'similә/a. 相似的, 类似的;相似的东西
true|/tru:/a. 真实的, 正确的, 忠诚的, 可靠的, 纯粹的, 正式的;真实, 准确;真实地, 准确地
model|/'mɒdәl/n. 模型, 模范, 模特儿;模范的, 作模型用的;做模型, 做模特儿;使模仿, 塑造; 模型
data|/'deitә/pl. 资料, 数据; 数据;DOS内部命令:用于显示或设定系统的日期
nature|/'neitʃә/n. 自然, 大自然, 本性, 性格, 性质; 自然, 大自然;本性, 性能
necessary|/'nesisәri/a. 必要的;必然的;必需的
structure|/'strʌktʃә/n. 结构, 构造, 建筑物;构成, 组织
contain|/kәn'tein/vt. 包含, 容纳, 控制;自制
unit|/'ju:nit/n. 单位, 分队, 部队, 单元, 部件, 装置;单位的, 单元的; 单元常数;部件
method|/'meθәd/n. 方法, 办法, 条理, 秩序;;法
bed|/bed/n. 床, 睡眠处, 河床, 底座, 路基, 一层;提供宿处, 栽种, 安装;睡, 形成坚实的一层
movement|/'mu:vmәnt/n. 运动, 动作, 运转, 移动, 倾向, 变化, 活动, 乐章; 运动
detail|/'di:teil/n. 细节, 详情;详述, 选派;画详图; 详细数据
reduce|/ri'dju:s/vt. 减少, 分解, 降低, 使衰退, 把...分解, 把...归纳;减少, 减肥, 缩小; 缩小
simply|/'simpli/adv. 简单地, 只是, 简直, 简朴地, 坦白地
especially|/i'speʃәli/adv. 尤其, 特别, 格外
date|/deit/n. 日期, 约会, 枣椰树;约会, 定日期;注明日期, 过时
personal|/'pә:snl/a. 私人的, 涉及隐私的, 有人性的, 人称的, 亲自的, 身体的; 人的;个人的, 自身的
establish|/i'stæbliʃ/vt. 建立, 确立, 制定;移植生长
computer|/kәm'pju:tә/n. 电脑, 电子计算机; 计算机
private|/'praivit/a. 私人的, 秘密的, 私立的, 隐蔽的;士兵, 隐士, 阴部; 私人的
approach|/ә'prәutʃ/n. 接近, 入门;接近, 近似, 找...商量;靠近
amount|/ә'maunt/n. 总数, 总额;总计, 等同
wish|/wiʃ/n. 希望, 愿望, 祝愿, 命令, 请求;愿, 想要, 希望, 祝愿;希望
scheme|/ski:m/n. 方案, 计划, 组合, 系统, 图解, 诡计, 阴谋;计划, 设计, 图谋, 策划
award|/ә'wɒ:d/n. 奖品, 裁定, 判决;授予, 给予
achieve|/ә'tʃi:v/vt. 完成, 达到;如愿以偿
chapter|/'tʃæptә/n. 章, 篇, 重要章节; 章;段
choose|/tʃu:z/vt. 选择, 宁愿, 欲;作出选择, 愿意; 选取
theory|/'θiәri/n. 理论, 学说, 原理, 意见, 推测; 理论
property|/'prɒpәti/n. 财产, 所有权, 性质, 属性; 属性
poor|/puә. pɒ:/a. 贫穷的, 贫乏的, 不幸的, 可怜的, 拙劣的, 卑鄙的; 低劣的, 不良的
south|/sauθ/n. 南方, 南;南的, 向南的;在南方;转向南方
production|/prә'dʌkʃәn/n. 制造, 生产, 产物; 产生, 生成
board|/bɒ:d/n. 木板, 甲板, 膳食, 会议桌;乘船, 供膳食, 用板覆盖;搭伙; 板
king|/kiŋ/n. 国王, 君主;使...成为君主;君临, 统治
opportunity|/.ɒpә'tju:niti/n. 机会, 时机
lord|/lɒ:d/n. 统治者, 阁下, 上帝;称王, 作威作福;使成贵族
agreement|/ә'gri:mәnt/n. 同意, 合约, 协议; 契约, 协议, 协定
simple|/'simpl/a. 简单的, 普通的, 朴素的, 单纯的, 绝对的, 初级的, 原始的, 迟钝的;出身低微者, 傻子
serve|/sә:v/vt. 可作...用, 服务, 经历, 招待, 供应, 送交, 对待;服务, 服役, 侍应, 适合, 有用, 开球;发球, 轮到发球
picture|/'piktʃә/n. 图画, 照片, 景色, 美丽如画的人(或物), 化身, 生动的描述, 想像, 形象思维;画, 拍摄, 用图说明, 描写, 想像; 图象;形象;字形
contract|/'kɒntrækt/n. 合约, 婚约, 契约;使皱缩, 使缩短, 感染, 订约, 缔结;皱缩, 订约, 收缩
source|/sɒ:s/n. 来源, 水源, 根源, 原始资料, 源; 来源, 源程序
occur|/ә'kә:/vi. 发生, 被想到, 存在
various|/'vєәriәs/a. 不同的, 各种的, 多方面的, 许多的, 个别的, 杂色的; 不同的, 种种的, 各式各样的
represent|/.repri'zent/vt. 表现, 表示, 描绘, 讲述, 代表, 象征, 回忆, 再赠送, 再上演;提出异议
site|/sait/n. 位置, 场所, 地点;给...择址
shop|/ʃɒp/n. 商店, 工厂, 车间;购物, 到处寻找;选购
loss|/lɒs/n. 损失, 遗失, 失败, 输, 错过, 伤亡; 损失;损耗
evening|/'i:vniŋ/n. 傍晚, 晚间, 末期
animal|/'ænimәl/n. 动物; 动物
standard|/'stændәd/n. 标准, 规格, 旗, 军旗, 本位;标准的, 合规格的; 标准
heart|/hɑ:t/n. 心, 心脏, 中心, 内心, 感情, 精神, 心情, 宝贝儿;鼓励
purpose|/'pә:pәs/n. 目的, 意向, 决心, 用途, 效果, 论题;意欲, 企图, 计划
benefit|/'benifit/n. 利益;有益于;受益
discuss|/dis'kʌs/vt. 讨论, 论述; 讨论, 辩论
anyone|/'eniwʌn/pron. 任何人
doctor|/'dɒktә/n. 医生, 博士;授以博士学位, 诊断, 修改;行医
factor|/'fæktә/n. 因素, 因数, 系数, 基因, 代理人; 因式
hair|/hєә/n. 头发, 毛发, 些微; 毛, 发
prove|/pru:v/vt. 证明, 查验, 检验, 勘探, 显示;证明是
wrong|/rɒŋ/a. 错误的, 不正当的, 失常的;错误地
wear|/wєә/n. 穿着, 戴, 使用, 耗损, 服装, 耐久性;穿着, 戴, 留(须、发等), 呈现, 磨损, 磨成, 耗损, 使疲乏, 消磨;磨损, 变旧, 耐久, 渐变, 渐渐消失
argue|/'ɑ:gju/vi. 提出理由, 争论, 辩论;主张, 辩论, 证明, 说服
pattern|/'pætәn/n. 模范, 典型, 式样, 样品, 图案, 格调, 模式;模仿, 仿造, 以图案装饰;形成图案; 模式, 图案
piece|/pi:s/n. 块, 片, 篇, 碎片, 部分, 部件, 标准量;修补, 修理, 拼合, 接线头;吃零食
tree|/tri:/n. 树, 木料, 树状物;把...赶上树; 树;DOS外部命令:显示指定磁盘驱动器的目录结构
catch|/kætʃ/n. 捕捉, 陷阱, 捕捉之物, 抓, 拉手;捕捉, 赶上, 感染, 听清楚;抓住, 燃着
royal|/'rɒiәl/n. 王室, 皇族;王室的, 皇家的, 盛大的, 庄严的
population|/.pɒpju'leiʃәn/n. 人口, 人口数; 群体;总体
April|/'eiprәl/n. 四月
enjoy|/in'dʒɒi/vt. 享受, 喜欢, 欣赏; 享受, 享有, 获得某种利益
despite|/di'spait/n. 轻视, 憎恨;虽然, 尽管
performance|/pә'fɒ:mәns/n. 施行, 工作情况, 成绩, 行为, 表现, 演出; 绩效, 性能
knowledge|/'nɒlidʒ/n. 知识, 学问, 认识, 知道
June|/dʒu:n/n. 六月
basis|/'beisis/n. 基础, 主要成分; 基底
size|/saiz/n. 大小, 尺寸, 规模, 尺码, 能力, 浆料;上浆, 依大小排列;可比拟;一定大小的, 一定尺寸的
introduce|/.intrә'dju:s/vt. 介绍, 引入, 采用, 输入; 引进, 输入, 介绍
series|/'siәri:z/n. 串联, 序列, 连续, 系列, 丛书, 套, 级数, 组; 系列
garden|/'gɑ:dn/n. 花园, 果园, 菜园;栽培花木;造园;花园的, 普通的
eat|/i:t/v. 吃, 腐蚀
environment|/in'vairәnmәnt/n. 环境, 外界, 围绕; 环境
rest|/rest/n. 休息, 睡眠, 安息, 稍息, 静止, 支架, 休息处, 其余者, 剩余部分;休息, 睡, 长眠, 安心, 静止, 停止, 安置, 依赖;使休息, 使支撑, 把...寄托于
success|/sәk'ses/n. 成功, 成就, 胜利
enter|/'entә/vt. 进入, 参加, 开始, 输入, 回车;进去, 参加; 输入, 回车
arrive|/ә'raiv/vi. 到达, 抵达
natural|/'nætʃәrәl/n. 白痴;自然的, 自然界的, 本能的, 天然的, 物质的, 正常的, 原始的, 自然数的
ensure|/in'ʃuә/vt. 确定, 保证, 担保, 保护; 确保, 确定
region|/'ri:dʒәn/n. 区域, 地带, 地区, 领域, 范围, 区; 区, 区域
attention|/ә'tenʃәn/n. 注意, 注意力; 引起注意信号
space|/speis/n. 位置, 空间, 距离, 太空, 空白, 间隔, (期刊等的)篇幅;隔开, 分隔;留间隔; 空白, 空格校验
statement|/'steitmәnt/n. 陈述, 指令, 声明; 程序语句;语句
pull|/pul/vt. 拉, 拖, 拔, 牵, 撕开, 吸引;拉, 拖, 拔, 有吸引力;拉, 拖, 拔, 拉力, 牵引力, 划船, 吸引
relation|/ri'leiʃәn/n. 关系, 联系, 叙述, 故事, 家属, 亲戚; 关系
sea|/si:/n. 海, 海洋, 海浪, 大量; 海, 海洋
principle|/'prinsipl/n. 原则, 原理, 主义; 原理
choice|/tʃɒis/n. 选择, 精选品, 选择权;精选的, 挑三拣四的, 上等的; DOS内部命令:在批处理文件中;该命令用于提示用户作出选择, 决定批处理文件的流程
couple|/'kʌpl/n. 对, 夫妇, 数个;使成双, 连接, 使成婚, 把...联系起来;结合, 成婚
hotel|/hәu'tel/n. 旅馆, 客栈
above|/ә'bʌv/prep. 在上方, 超出;在上面;上述的, 上面的
forward|/'fɒ:wәd/a. 向前的, 早的, 迅速的, 在前的, 进步的;促进...的生长, 转寄, 运送;向前地; 前推, 转信
village|/'vilidʒ/n. 村庄;乡村的, 村庄的
station|/'steiʃәn/n. 车站, 站, 局, 驻地, 位置, 身分, 地位;安置, 配置, 驻扎; 站
individual|/.indi'vidʒuәl/n. 人, 个人, 个体;个别的, 个人的, 独特的
feature|/'fi:tʃә/n. 面孔的一部分(如眼、口等), 特征, 容貌, 特色, 特写;是...的特色, 特写, 放映;起重要作用; 特性
association|/ә.sәuʃә'eiʃәn/n. 协会; 关联
income|/'inkʌm/n. 收入, 收益, 流入; 收益
following|/'fɒlәuiŋ/n. 下列各项, 部下, 追随者;下列的, 其次的
nice|/nais/a. 美好的, 和蔼的, 正派的, 做得好的, 精密的, 细微的, 挑剔的, 谨慎的
manage|/'mænidʒ/vi. 处理;管理, 控制, 维持, 达成, 经营, 运用
everyone|/'evriwʌn/pron. 每个人, 人人; 系统中的一个组名
affect|/ә'fekt/vt. 影响, 感动, 假装, 模仿, 爱好, 倾向于;自觉感情
technology|/tek'nɒlәdʒi/n. 技术, 工业技术, 术语; 技术学, 工艺学
identify|/ai'dentifai/vt. 识别, 认为...等同于, 确定, 使参与;一致, 认同
please|/pli:z/adv. 请;使高兴, 合...的心意, 取悦;使人满意, 讨好, 愿意, 敬请
whatever|/hwɒt'evә/pron. 无论什么
difficulty|/'difikәlti/n. 困难, 难点
machine|/mә'ʃi:n/n. 机器, 机械装置, 机构, 自动售货机, 机械般工作的人;以机器制造
modern|/'mɒdәn/n. 现代人, 有思想的人;现代的, 时髦的
degree|/di'gri:/n. 程度, 度数, 学位, 度; 度, 程度
legal|/'li:gәl/a. 法律的, 法定的, 合法的; 法定权利;法律(上)的, 合法的
energy|/'enәdʒi/n. 精力, 精神, 活力, 能量; 能;能量
treatment|/'tri:tmәnt/n. 治疗, 待遇, 处理; 疗法, 治疗;处理
cell|/sel/n. 单元, 细胞, 电池; 单元
growth|/grәuθ/n. 生长, 栽培, 增长; 等比级数
finally|/'fainәli/adv. 最后, 终于
mile|/mail/n. 英里, 很大距离; 英里, 哩
lady|/'leidi/n. 淑女, 夫人, 女士, 贵妇
whom|/hu:m/pron. 谁
happy|/'hæpi/a. 快乐的, 幸福的, 愉快的, 恰当的
task|/tɑ:sk/n. 工作, 任务, 作业, 困难的工作;派给...工作, 使辛劳; 任务
risk|/risk/n. 冒险, 危险, 保险额;冒...的危险, 冒险干
function|/'fʌŋkʃәn/n. 官能, 职务, 功能, 函数;活动, 运行, 行使职责; 功能, 函数
county|/'kaunti/n. 县, 郡
resource|/ri'sɒ:s/n. 资源, 财力, 办法, 策略, 急智, 消遣; 资源
behaviour|/bi'heivjә/n. 行为, 举止; 特性, 性能, 特点, 行为, 动作, 状态
defence|/di'fens/n. 防卫, 防卫设备; (诉讼程序中的)辩护
style|/stail/n. 风格, 时尚, 文体, 风度, 字体, 类型;称呼, (根据新款式)设计, 使合潮流;风格, 样式; 风格, 样式
floor|/flɒ:/n. 地板, 楼层, 底部, 底价;铺地板, 打倒;地面, 地板, 基底; 基底
science|/'saiәns/n. 科学, 学科, 学问, 自然科学; 科学
feeling|/'fi:liŋ/n. 摸, 触觉, 知觉, 感觉, 情绪, 同情;有同情心的, 有感觉的, 仁慈的, 动人的
response|/ri'spɒns/n. 反应, 回答, 响应; 应答
note|/nәut/n. 笔记, 记录, 注解, 票据, 符号, 显要, 注重, 便笺, 照会;记录, 注解, 注意
skill|/'skil/n. 技术, 技巧, 技能, 熟练, 熟练工人; 技能
college|/'kɒlidʒ/n. 学院, 大学, 学会
horse|/hɒ:s/n. 马, 骑兵, 脚架;骑马, 取笑;使骑马, 系马于
myself|/mai'self/pron. 我自己, 我亲自, 我独自
character|/'kærәktә/n. 个性, 字符, 人物, 性质, 品格, 资格; 字符
nor|/nɒ:/conj. 也不, 也没有; 或非
normal|/'nɒ:ml/n. 常态, 标准, 正常, 普通;正常的, 正规的, 标准的, 师范的, 正态的; 标准, 普通
indicate|/'indikeit/vt. 显示, 象征, 指示, 指出; 指示
forget|/fә'get/vt. 忘记, 忽略, 忘;忘记
wonder|/'wʌndә/n. 奇迹, 惊奇, 惊愕;惊奇, 想知道;惊讶, 怀疑
investment|/in'vestmәnt/n. 投资; 包埋料, 围模料, 包埋法, 围模法
dog|/dɒg/n. 狗, 坏蛋;跟踪, 尾随
suffer|/'sʌfә/vt. 遭受, 经历, 忍受;受痛苦, 受损害
recently|/'ri:sntli/adv. 最近
previous|/'pri:viәs/a. 早先的, 前面的, 过急的; 以前的, 生前的, 前述的
maintain|/mein'tein/vt. 维持, 维修, 保持, 坚持, 供养, 主张; 维修
husband|/'hʌzbәnd/n. 丈夫, 管理人, 节俭的人;节俭, 使成丈夫, 持有
publish|/'pʌbliʃ/vt. 出版, 发行, 公开, 发表, 宣传, 公布;出版, 发行
responsibility|/ri.spɒnsә'biliti/n. 责任, 职责, 负担, 可靠性; 职责
argument|/'ɑ:gjumәnt/n. 争论, 论证, 论据, 自变量; 参数
anyway|/'eniwei/adv. 无论如何, 至少
avoid|/ә'vɒid/vt. 避免, 防止, 撤消; 避免, 回避, 躲开
bill|/bil/n. 帐单, 清单, 钞票, 鸟嘴, 广告, 法案, 票据;开帐单, (用招贴)宣布
express|/ik'spres/n. 快车, 快递, 专使;明确的, 丝毫不差的, 专门的, 快的;表达, 表示, 表露
suppose|/sә'pәuz/vt. 推想, 假设, 以为, 想像, 假定;料想
significant|/sig'nifikәnt/a. 重要的, 有效的, 有含义的, 暗示的, 值得注意的
finish|/'finiʃ/n. 完成, 结束, 末道漆, 磨光, 完美;完成, 结束, 用完, 毁掉;结束; 完成
element|/'elimәnt/n. 元件, 元素, 要素; 部分;成分;单元;码元;元件;元素;单元
glass|/glɑ:s/n. 玻璃, 玻璃杯, 透镜;装玻璃于, 反射, 反映;成玻璃状
determine|/di'tә:min/v. 决定, 决心
duty|/'dju:ti/n. 责任, 关税, 职务, 尊敬; 职责
July|/dʒu:'lai/n. 七月
tend|/tend/vi. 走向, 有某种的倾向, 易于, 照顾, 注意;照料, 护理
listen|/'lisn/vi. 听, 倾听, 听从;听, 倾听
leg|/leg/n. 腿, 假腿, 路程;走, 跑
park|/pɑ:k/n. 公园, 停车处;停车, 置于;停车
suddenly|/'sʌdәnli/adv. 突然, 意外, 忽然, 迅速, 即席作成, 即刻, 急速
title|/'taitl/n. 头衔, 名称, 标题, 书名, 扉页, 权利, 资格, 冠军, 字幕;授予头衔, 加标题于; 标题
treat|/tri:t/n. 宴请, 款待;视为, 对待, 论述, 治疗, 款待;讨论, 谈判, 作东
summer|/'sʌmә/n. 夏季, 全盛时期;避暑, 过夏天; 加法器
throughout|/θru:'aut/adv. 到处, 贯穿全部地, 自始至终;遍及, 在各处; 吞吐量
discussion|/dis'kʌʃәn/n. 讨论
generally|/'dʒenәrәli/adv. 通常, 逐渐地, 普遍地
aspect|/'æspekt/n. 外观, 方面, 面貌, 方向; 方面, 局面;外观
industrial|/in'dʌstriәl/a. 工业的, 供工业用的, 工业高度发展的, 产业的;工业工人, 工业股票
chairman|/'tʃєәmәn/n. 主席, 会长; 主席
nearly|/'niәli/adv. 几乎, 密切地
remove|/ri'mu:v/vt. 移动, 调动, 除去, 迁移, 开除, 移交;迁移, 移动, 搬家;班级, 升级, 移动, 搬家, 间距; 删除
throw|/θrәu/vt. 投, 掷, 抛, 发射, 摔下, 匆匆穿上(或脱下), 抛弃, 摆脱;丢, 掷, 抛;投掷, 掷骰子, 冒险
baby|/'beibi/n. 婴孩; 婴儿
sorry|/'sɒri/a. 难过的, 悲哀的, 遗憾的
box|/bɒks/n. 盒子, 箱, 方框, 一巴掌;装...入盒中, 装箱, 打耳光;拳击; 方框
exist|/ig'zist/vi. 存在, 生存, 发生
river|/'rivә/n. 河, 江; 河流, 江河, 内河
dead|/ded/a. 死的, 不活泼的, 麻木的, 熄灭的;死者;完全地, 直接地
customer|/'kʌstәmә/n. 消费者; 顾客
institution|/.insti'tju:ʃәn/n. 机构, 惯例, 制度; 机关, 机构, 设施
encourage|/in'kʌridʒ/vt. 鼓励, 支持, 激励; 怂恿, 煽动, 助长
specific|/spi'sifik/n. 特效药, 特性;特殊的, 明确的, 具有特效的, 特定地, 具体地
profit|/'prɒfit/n. 利润, 赢利, 利益;有益, 获利, 赚钱;有益于
reflect|/ri'flekt/vt. 反射, 反映, 招致, 深思;被反射, 映出, 深思, 考虑, 指责
assume|/ә'sju:m/vt. 假定, 承担, 呈现;装腔作势, 僭越
admit|/әd'mit/vt. 承认, 接受, 允许进入, 容许;开向, 容许, 承认
stone|/stәun/n. 石头, 宝石, 果核, 纪念碑, 结石;投扔石子, 铺石头;石的, 石制的, 完全的
measure|/'meʒә/n. 尺寸, 量度器, 量度标准, 测量, 量具, 程度, 范围, 限度, 分寸, 措施, 方法;测量, 测度, 估量, 权衡, 调节, 拿(自己或自己的力量等)作较量;度量
division|/di'viʒәn/n. 分, 分开, 除法, 部门(如部、处、系等), 师; 部分
smile|/smail/n. 微笑, 喜色, 笑容;微笑, 觉得好笑;微笑着表示
prepare|/pri'pєә/vt. 准备, 筹备, 使在思想上有准备, 制造, 调制;预备
replace|/ri'pleis/vt. 代替, 替换, 放回, 归还; 替换;DOS外部命令:取代或更新文件
commission|/kә'miʃәn/n. 委任状, 任官令, 所委职责, 佣金, 犯, 委托, 所托之事;委任, 委托制作, 使服役
proposal|/prә'pәuzl/n. 提议, 计划, 求婚; 提案, 申请, 投标
fill|/fil/vt. 装满, 填充, 弥漫, 供给, 满足, 供应;充满, 变得沉重;满足, 装满, 充分, 填方;填充;填充; 填充
unless|/.ʌn'les/conj. 除非;除...之外
mention|/'menʃәn/n. 提到, 言及, 陈述;提到, 提及
improve|/im'pru:v/vt. 改良, 提高...的价值, 改善, 利用;变得更好, 增加
image|/'imidʒ/n. 影像, 肖像, 想象, 图像, 形象, 翻版;作...的像, 反映, 想象, 象征;图像; 图象
obviously|/'ɔbviәsli/adv. 显而易见地, 明显地
sector|/'sektә/n. 扇形, 部门, 部分, 函数尺, 象限仪, 段, 区段;把...分成扇形; 扇面;扇区;段;区段
direction|/di'rekʃәn/n. 方向, 指导, 趋势; 方向;流向
basic|/'beisik/n. 基本原理, 要素, 基本规律;基本的, 碱性的;(计算机)BASIC语言
seat|/si:t/n. 座, 座位, 位子, 席位, 所在地;使坐下, 使就座, 为...设座于, 使就职;安装在底座上
successful|/sәk'sesful/a. 成功的, 一帆风顺的, 顺利的; 成功的
intend|/in'tend/vt. 计划, 打算, 意思是; 想要, 打算, 意旨
original|/ә'ridʒәnl/a. 最初的, 原始的, 有创意的;原物, 原作
miss|/mis/n. 失误, 避免, 失败, 小姐;未得到, 未达到, 未听到, 未觉察, 逃脱, 遗漏, 错过, 思念;失败, 击不中
attitude|/'ætitju:d/n. 态度, 看法, 姿势; 体态, 姿势, 态度
aware|/ә'wєә/a. 知道的, 有觉悟的
discover|/dis'kʌvә/vt. 发现, 找到, 暴露;发现
drop|/drɒp/n. 滴, 微量, 落下, 空投;放下, 掉下, 下降;使滴下, 放下, 丢失, 遗漏; 投入, 投入点, 接入点, 分接点
push|/puʃ/n. 推, 推动, 奋斗, 攻击, 进取心;推, 推动, 使伸出, 推行, 逼迫, 增加;推, 推进, 增加, 努力争取
goal|/gәul/n. 目标, 终点, 得分, 球门, 守门员;攻门, 射门得分
disease|/di'zi:z/n. 疾病, 弊病;;病
yourself|/juә'self/pron. 你自己
refuse|/ri'fju:z/vt. 拒绝, 谢绝;拒绝;废物;扔掉的, 无用的
prevent|/pri'vent/v. 预防, 防止, 阻止, 妨碍
popular|/'pɒpjulә/a. 通俗的, 流行的, 受欢迎的, 大众的, 人民的, 普及的; 大众的, 通俗的, 普及的
October|/ɒk'tәubә/n. 十月
affair|/ә'fєә/n. 事件, 事务, 恋爱事件
appeal|/ә'pi:l/n. 恳求, 诉请, 上诉, 吸引力;呼吁, 诉请, 要求, 上诉, 有吸引力;将...上诉
heavy|/'hevi/a. 重的, 巨大的, 沉重的, 笨重的, 过度的;沉重地;重物, 严肃角色
beyond|/bi'jɒnd/prep. 超过, 在那一边, 迟于;在远处;更远处
regard|/ri'gɑ:d/n. 关心, 注意, 尊敬, 关系, 问候;视为, 注意, 考虑, 和...有关, 看待;注视, 注意
ability|/ә'biliti/n. 能力, 才干; 能力, 才能
professional|/prә'feʃәnl/n. 专业人才;专业的, 职业的
holiday|/'hɒlәdi/n. 假日, 假期, 节日;度假
technique|/tek'ni:k/n. 技巧, 技术, 方法; 工艺方法;技巧
item|/'aitәm/n. 项目, 条款, 一则, 项; 项
version|/'vә:ʒәn/n. 一种描述, 版本, 译文; 版本
fish|/fiʃ/n. 鱼, 鱼肉, 鱼类, 接合板;钓, 钓鱼, 查出, 用接合板连接;捕鱼, 钓鱼, 用钩捞取, 摸索寻找
maybe|/'meibi:/adv. 也许, 大概;可能性
lay|/lei/vt. 放置, 产, 铺设, 布置, 提出, 平息;下蛋, 打赌;位置, 层, 隐藏处;世俗的, 外行的;lie的过去式
teach|/ti:tʃ/vt. 教, 讲授, 教导, 教育;教书, 教学, 可以教
advice|/әd'vais/n. 忠告, 劝告, 意见, 报道, 通知; 通知书, 通知, 建议
September|/sep'tembә/n. 九月
dark|/dɑ:k/n. 黑暗, 夜, 黄昏, 模糊;黑暗的, 暗的, 深色的, 隐密的, 模糊的, 无知的
reveal|/ri'vi:l/vt. 露出, 显示, 透露, 揭露, 泄露, (神)启示;窗侧, 门侧
advantage|/әd'vɑ:ntidʒ/n. 优点, 便利, 好处, 优势;有助于
surface|/'sә:fis/n. 面, 表面, 水面, 外表, 平面;表面的, 外观的, 肤浅的, 水面上的;使成平面, 使浮出水面;浮出水面, 呈现, 在地面上工作
cold|/kәuld/n. 感冒, 寒冷;寒冷的, 冷淡的, 冷静的;完全地
immediately|/i'mi:diәtli/adv. 直接地, 立刻, 立即
worth|/wә:θ/n. 价值, 财产;值...的, 值得的
ready|/'redi/n. 预备好的状态, 现款;准备好的, 备用的, 可以使用的;预先, 迅速;使准备好
variety|/vә'raiәti/n. 多样, 种类, 变种, 杂耍; 变种
television|/'teli.viʒәn/n. 电视; 电视
memory|/'memәri/n. 记忆, 记忆力, 回忆, 纪念, 存储;内存; 存储器, 内存, 查看内存实用程序
blood|/blʌd/n. 血, 血统, 流血, 气质, 生命;使出血, 用血涂
island|/'ailәnd/n. 岛, 岛屿, 孤立地区, 安全岛;使成岛状, 孤立
culture|/'kʌltʃә/n. 文化, 修养, 耕种;耕种, 培养
January|/'dʒænjuәri/n. 一月
useful|/'ju:sful/a. 有用的, 有益的; 有用的, 有效的
depend|/di'pend/vi. 靠, 视...而定, 信赖
Sunday|/'sʌndi/n. 星期日;星期日的, 业余的;度星期日
majority|/mә'dʒɒriti/n. 多数, 大半; 多数逻辑
competition|/.kɒmpi'tiʃәn/n. 竞争, 竞赛; 竞争, 竞销, 比赛
bar|/bɑ:/n. 条, 棒, 酒吧, 栅, 障碍物;禁止, 阻挡, 妨碍; 棒形图
parliament|/'pɑ:lәmәnt/n. 国会, 议会; 会议, 国会, 议院
goods|/guds/n. 货物; 货物, 商品, 动产
check|/tʃek/n. 检查, 支票, 阻止物, 寄物牌, 象棋中将军;检查, 阻止, 核对, 寄存, 托运;逐项相符, 开支票; 复选
trouble|/'trʌbl/n. 烦恼, 麻烦, 困难, 动乱, 故障;困扰, 麻烦, 使烦恼, 折磨;烦恼, 费心
traditional|/trә'diʃәnl/a. 传统的, 惯例的; 传统的, 惯例的
effective|/i'fektiv/a. 有效的, 有力的, 实际的;有生力量
payment|/'peimәnt/n. 付款, 支付的款项(或实物), 偿还, 报应, 惩罚; 支付, 缴纳, 支付款额
mouth|/mauθ/n. 嘴, 口, 口腔, 口状物;装腔作势说话, 做鬼脸;说出, 做作地说
facility|/fә'siliti/n. 容易, 灵巧, 设备; 设施;设备;装备
survey|/sә'vei/n. 纵览, 视察, 测量, 俯瞰, 调查;审视, 视察, 俯瞰, 通盘考虑;测量土地
extend|/ik'stend/v. 扩充, 延伸, 伸展, 扩大; 扩展
deep|/di:p/a. 深的;深入地;深渊, 深处
earth|/ә:θ/n. 地球, 泥土, 世界, 尘世;埋入土中, 赶入洞内;躲入洞内
article|/'ɑ:tikl/n. 文章, 冠词, 物品, 物件, 条款, 契约; 信件
object|/'ɒbdʒekt/n. 物体, 目标, 目的, 对象, 宾语, 客体;反对, 抱反感;提出...来反对; 对象
chair|/tʃєә/n. 椅子, 显要的席位, 主席;使入座, 使就任要职
possibility|/.pɒsә'biliti/n. 可能性, 可能的事; 可能性, 可能发生的事, 不确定权
means|/mi:nz/n. 方法, 手段, 工具, 财产, 收入; 方法, 手段, 工具;意谓
notice|/'nәutis/n. 注意, 布告, 通知, 预告, 短评;注意, 通知, 评论, 提及, 关注;注意
card|/kɑ:d/n. 卡片, 纸牌, 节目单, 明信片, 梳棉机;备置卡片, 记于卡片上, 梳理; 卡片, 卡
agency|/'eidʒәnsi/n. 代理机构, 经销商, 中介; 办事处
collection|/kә'lekʃәn/n. 收集, 采集, (一批)收藏品, 募捐; 收集;收集品, 标本
considerable|/kәn'sidәrәbl/a. 相当的, 可观的, 重要的
physical|/'fizikl/a. 身体的, 物质的, 自然的, 物理学的, 好色的;体格检查
supply|/sә'plai/n. 补给, 供给, 供应品;补给, 供给, 提供, 补充;替代
examine|/ig'zæmin/v. 检查, 调查, 考试
document|/'dɒkjumәnt/n. 文件, 公文, 文档;证明, 为...引证; 文档
responsible|/ri'spɒnsәbl/a. 有责任的, 负责的, 责任重大的; 应负责任的, 有责任的, 能履行责任的
hot|/hɒt/a. 热的, 热心的, 辣的, 热情的, 激动的, 猛烈的, 紧迫的;热, 紧迫地
weight|/weit/n. 重, 重量, 体重, 砝码, 重大, 影响, 力量;加重量于, 压迫, 使加权, 称重量; 粗细
career|/kә'riә/n. 事业, 生涯, 成功; 职业, 专业, 履历
solution|/sә'lu:ʃәn/n. 解决, 解答, 溶液; 溶液
November|/nәu'vembә/n. 十一月
December|/di'sembә/n. 十二月
influence|/'influәns/n. 影响力, 权力, 势力;影响, 改变
budget|/'bʌdʒit/n. 预算;编预算;编入预算, 安排;廉价的
opinion|/ә'pinjәn/n. 意见, 评价, 主张; 意见
medical|/'medikl/n. 医生, 体格检查;医学的, 内科的, 药的
hang|/hæŋ/n. 悬挂, 诀窍, 意义;悬挂, 附着, 装饰, 垂下, 踌躇, 绞死, 使悬而未决;悬着, 垂下, 被绞死, 悬而不决
rock|/rɒk/n. 岩石, 岩礁, 石头, 基石, 暗礁, 摇动, 摇滚乐;摇摆, 摇动, 使摇晃, 使动摇;摇, 摇动
district|/'distrikt/n. 区域, 地方; 地区, 地段
bird|/bә:d/n. 鸟, 羽毛球;打鸟
damage|/'dæmidʒ/n. 损害, 伤害;损害
tomorrow|/tә'mɒ:rәu/n. 明天, 未来;明天, 未来地
shake|/ʃeik/n. 摇动, 震动;摇动, 动摇, 使震动, 挥舞;震动, 发抖, 动摇
organization|/.ɒ:gәnai'zeiʃәn/n. 组织, 结构, 团体, 体制; 组织, 机构, 机化(血栓或坏死组织)
extra|/'ekstrә/n. 额外的事物, 另外的收费;额外的, 特别的;额外地, 特别地, 非常地
edge|/edʒ/n. 边缘, 尖锐, 刀刃, 优势;使锐利, 挤进, 镶边;缓缓移动
exchange|/iks'tʃeindʒ/n. 交换, (电话)交换局, 交换机, 汇兑, 交易所;交换, 交易, 兑换; 交换;电话局
quarter|/'kwɒ:tә/n. 四分之一, 一刻钟, 季度, 地区;四等分, 肢解;驻扎, 住宿
option|/'ɒpʃәn/n. 选择权, 挑选, 选项; 选项
opposition|/.ɒpә'ziʃәn/n. 反对, 敌对, 相反, 在野党; 对生, 对向, 反抗, 反对症
eventually|/i'ventʃuәli/adv. 最后, 终于
occasion|/ә'keiʒәn/n. 场合, 时机, 机会, 诱因, 理由;惹起, 引起
highly|/'haili/adv. 非常, 非常赞许地; 大大地
executive|/ig'zekjutiv/n. 执行部门, 执行委员会, 执行者, 经理主管人员;执行的, 善于执行的, 善于经营的; 执行程序
target|/'tɑ:git/n. 目标, 靶子, 指标;对准, 订指标
attend|/ә'tend/vt. 参加, 照料, 伴随;专心于, 照顾, 服侍, 出席
network|/'netwә:k/n. 网络, 广播网, 网状物; 网络
lack|/læk/n. 缺乏, 无, 不足;缺乏, 短少, 不足, 需要;缺乏
corner|/'kɒ:nә/n. 角落, 转角, 窘境;迫至一隅, 垄断, 使陷入绝境;相交成角, 垄断; 边角
sex|/seks/n. 性别, 性欲;区别...的性别, 引起...的性欲
finger|/'fiŋgә/n. 手指, 指状物, (手套的)手指部分, 指针;用手指拨弄, 伸出; 网络命令
slightly|/'slaitli/adv. 些微地, 苗条地
scene|/si:n/n. 场, 情景, 镜头, 发生地点, 道具, 布景, 景色; 现场
gain|/gein/n. 增益, 获得, 利润, 收获, 增加;得到, 增进, 赚到;获利, 增加; 增益
fully|/'fuli/adv. 十分地, 完全地, 充分地
scale|/skeil/n. 刻度, 衡量, 比例, 比例尺, 数值范围, 等级, 规模, 天平, 秤, 鳞, 积垢;依比例决定, 攀登, 测量, 绘制, 刮鳞, 使生垢, 过秤;剥落, 生水垢, 重量为, 攀登, 衡量; 刻度
equipment|/i'kwipmәnt/n. 装备, 设备, 才能; 设备;装备;装置
afternoon|/'ɑ:ftә'nu:n/n. 午后, 下午
speech|/spi:tʃ/n. 演讲, 说话, 谈话, 言语, 引语, 民族语言; 言语, 语言
message|/'mesidʒ/n. 消息, 通讯, 讯息, 教训, 预言, 广告词;通知;通报, 报告, 报信; 报文;消息;信息
ball|/bɒ:l/n. 球, 舞会, 球状物;捏成球形
sport|/spɒ:t/n. 运动, 游戏, 娱乐, 消遣, 玩笑;运动的, 户外穿戴的;游戏, 参加体育运动, 戏弄, 产生变种;炫耀, 使产生变种
kitchen|/'kitʃin/n. 厨房, 全套炊具; 厨房
crime|/kraim/n. 犯罪, 罪行, 罪恶; 犯罪, 罪, 罪恶
male|/meil/n. 男人, 雄性动物;男性的, 雄性的, 有力的
strategy|/'strætidʒi/n. 战略, 策略; 战略, 策略
review|/ri'vju:/n. 检讨, 复习, 回顾, 检阅, 评论;温习, 检讨, 评论, 再检察, 复审;复习功课, 写评论
employee|/.emplɒi'i:/n. 职员, 员工, 受雇人员; 职工;雇员
interested|/'intristid/a. 感兴趣的; 有利害关系的, 有股份的, 偏私的
travel|/'trævl/n. 旅行, 游历, 行进;旅行, 行进, 移动, 被传播;旅行, 通过, 使移动
otherwise|/'ʌðәwaiz/adv. 否则, 不同地, 别的方式
hardly|/'hɑ:dli/adv. 刚刚, 几乎不, 勉强是
below|/bi'lәu/prep. 在下面;在下面
status|/'steitәs/n. 状态, 情形, 地位, 要人身份; 状态
perform|/pә'fɒ:m/vt. 进行, 履行, 完成, 执行, 表演;行动, 工作, 执行, 演出
tea|/ti:/n. 茶, 茶叶; 茶, 茶剂, 浸剂
partner|/'pɑ:tnә/n. 合伙人, 股东, 伙伴, 伴侣;与...合伙, 组成一对;做伙伴, 当助手
band|/bænd/n. 带子, 队, 乐队;联合, 结合; 频带;波段;区
failure|/'feiljә/n. 失败, 失败者, 不足, 缺乏, 破产; 故障;失效
reader|/'ri:dә/n. 读者, 读物, 文选, 校对人, 讲师; 阅读程序;阅读器
shoulder|/'ʃәuldә/n. 肩, 肩膀, 衣肩;肩负, 负担, 担任;用肩推挤
fair|/fєә/n. 展览会, 市集, 美好的事物;公平的, 按规则进行的, 不好不坏的, 晴朗的, 美丽的;公平地, 正面地, 有教养地, 清楚地;转晴
protect|/prә'tekt/vt. 防卫, 保护, 警戒; 庇护, 保护, 警戒
truth|/tru:θ/n. 事实, 实情; 真实, 真相, 事实
owner|/'әunә/n. 拥有者, 物主, 所有人; 所有者, 物主, 业主
marriage|/'mæridʒ/n. 婚姻, 结婚, 婚礼, 合并; 婚姻, 结婚
essential|/i'senʃәl/n. 要素, 要点, 本质;必要的, 重要的, 本质的; 本质冒险
confirm|/kәn'fә:m/vt. 证实, 确定, 批准, 使巩固; 确认
adopt|/ә'dɒpt/vt. 采用, 正式通过, 收养, 接受; 采取
civil|/'sivәl/a. 市民的, 公民的, 有礼貌的; 公民的, 国民的, 民用的
Saturday|/'sætәdi/n. 星期六
trust|/trʌst/n. 信任, 信赖, 相信, 受托, 职责, 信心, 托拉斯;信托的, 托拉斯的;信赖, 信任, 相信, 盼望, 赊卖给;相信, 信赖, 依靠; 委托, 信任
beautiful|/'bju:tiful/a. 美丽的
newspaper|/'nju:z.peipә/n. 报纸
safety|/'seifti/n. 安全, 保险, 平安, 保安设备;保护, 防护
trial|/'traiәl/n. 审判, 试验, 艰苦, 麻烦事, 考验;审讯的, 试验性的
farm|/fɑ:m/n. 农场, 农田;耕种;种田
sentence|/'sentәns/n. 句子, 命题, 宣判;宣判, 判决; 句子
file|/fail/n. 档案, 公文箱, 文件夹, 文件, 卷宗, 锉刀;列队行进, 用锉刀做;归档, 申请, 锉, 琢磨; 文件
obvious|/'ɒbviәs/a. 明显的, 明白的, 显然的, 平淡无奇的
length|/leŋθ/n. 长度, 长, 期间, 一段; 记录长度;块长;字长
copy|/'kɒpi/n. 副本, 摹仿, 一册;复印, 抄袭, 复制; 副本;复制;DOS内部命令:复制文件;将几个文件合并成一个文件, 以及将文件传至外设或在设备之间传送
balance|/'bælәns/n. 平衡, 差额;平衡, 相等;称, 权衡, 比较, 使平衡, 结算, 抵消
wind|/wind/n. 风, 气息, 气味, 呼吸, 风声, 趋势, 空谈, 卷绕, 弯曲;使通风, 嗅出, 使喘气, 吹号角, 上发条, 缠绕, 包, 绞起, 吊起, 使弯曲, 使迂回;嗅出猎物, 吹响号角, 卷曲, 蜿蜒, 迂回, 缠绕
league|/li:g/n. 同盟, 联盟, 盟约;组联盟, (使)加盟
none|/nʌn/adv. 一点也不, 毫不;没有人, 无一物, 并无一个;没有的
doubt|/daut/n. 怀疑, 疑惑;怀疑, 不信
pain|/pein/n. 痛苦, 疼痛, 辛苦;使痛苦, 痛苦;作痛, 疼
train|/trein/n. 火车, 列车, 行列, 长队, 一连串的后果, 顺序;训练, 教育, 对准;受训练, 锻炼
February|/'februәri/n. 二月
spirit|/'spirit/n. 精神, 心灵, 灵魂, 态度, 志气, 人格, 情绪, 心情, 烈酒;诱拐, 鼓励, 鼓舞
studio|/'stju:diәu/n. 工作室, 画室, 演播室, 电影制片厂
environmental|/in.vaiәrәn'mentәl/a. 周围的, 环境的; 环境的, 环保的
strength|/streŋθ/n. 力量, 实力, 强度, 浓度, 人数, 抵抗力; 强度
contact|/'kɒntækt/n. 联系, 交际, 熟人, 接触;接触, 联系;使接触
imagine|/i'mædʒin/vt. 想像, 设想, 猜测;想像起来
positive|/'pɒzitiv/a. 肯定的, 积极的, 有把握的; 正的, 阳性的
shape|/ʃeip/n. 形状, 形态, 外形, 形式, 身材;定形, 使成形, 塑造, 计划, 使符合;成形, 形成, 成长; 形状
transport|/træns'pɒ:t/n. 运输, 运输工具, 激动, 狂喜, 流放犯;传送, 运输, 流放; 传送
cash|/kæʃ/n. 现金;兑现
gas|/gæs/n. 气体, 汽油, 瓦斯; 气体;煤气;瓦斯;毒气
museum|/mju:'ziәm/n. 博物馆
debate|/di'beit/n. 辩论, 讨论;争论, 辩论
reform|/ri'fɒ:m/n. 改革, 改正, 改造;改革, 改过, 革新, 重整;革新, 改过
pair|/pєә/n. 一双, 一对, 一副;(使)成对
agent|/'eidʒәnt/n. 代理商, 政府代表, 动原, 媒介; 代理程序
annual|/'ænjuәl/n. 年刊, 年报;每年的, 一年一次的, 全年的, 一年生的
marry|/'mæri/vt. 与...结婚, 娶, 嫁;结婚
artist|/'ɑ:tist/n. 艺术家, 画家
presence|/'prezns/n. 出席, 面前, 存在, 仪态, 风度; 出现
protection|/prә'tekʃәn/n. 保护, 防卫, 贸易保护制度; 保护
nuclear|/'nju:kliә/a. 核子的, 原子能的, 核的, 中心的; 核的
collect|/kә'lekt/v. 收集, 聚集, 集中, 搜集;由收到者付款的;由收到者付款地
queen|/'kwi:n/n. 王后, 女王;立为女王;做女王
master|/'mɑ:stә. 'mæstә/n. 主人, 硕士, 大师, 母机;主人的, 主要的;征服, 控制, 精通
candidate|/'kændideit/n. 候选人, 投考者; 候选, 候补者
rich|/ri:tʃ/a. 富裕的, 富饶的, 浓厚的, 贵重的
huge|/hju:dʒ/a. 极大的, 巨大的, 无限的
exercise|/'eksәsaiz/n. 行使, 执行, 运动, 练习, 作业;运用, 练习, 运动;练习, 锻炼
commercial|/kә'mә:ʃәl/a. 商业的, 商用的, 商品化的;商业广告节目
adult|/'ædʌlt/n. 成人, 成虫;成年的, 成熟的
august|/ɒ:'gʌst. 'ɒ:gәst/n. 八月;威严的, 令人敬畏的
apparently|/ә'pærәntli/adv. 表面上, 清楚地, 显然地
safe|/seif/n. 保险箱, 冷藏室;安全的, 可靠的, 平安的, 稳健的, 有把握的
speed|/spi:d/n. 速率, 速度, 迅速;加速, 超速, 快进;快速传送, 促进, 使加速; 中央处理机速度设置程序
route|/ru:t/n. 路径, 途径, 路线;确定路线, 按规定路线发送; 传递, 路由设定程序
emerge|/i'mә:dʒ/vi. 浮现, 形成, 出现, (事实)显露
regional|/'ri:dʒәnәl/a. 地方的, 地域性的; 区的, 部位的
mark|/mɑ:k/n. 标志, 分数, 马克, 痕迹, 斑点, 靶子, 刻度, 记号, 符号, 戳记, 标准, 起跑线;做标记于, 留意, 打分数, 表明, 标志, 记录;作记号, 记得分; 标志;标记;传号
separate|/'sepәreit/n. 独立件, 抽印本;分开的, 各别的, 单独的, 分隔的;分开, 隔开, 分居;使分离, 使分开, 区分, 使分居
shoot|/ʃu:t/n. 射击, 狩猎, 芽, 射伤, 发射, 发芽, 急流, 推力, 摄影, 急送, 滑运道, 浪费;射击, 射中, 损毁, 拍摄, 喷出, 投射, 挥出, 飞速行进, 挥霍, 给...注射;射出, 射击, 发出, 拍电影, 射门, 发芽
deny|/di'nai/v. 否认, 拒绝
aim|/eim/n. 目标, 瞄准, 击中目标的能力;对准目标, 致力, 打算;瞄准; 医学文摘索引, 存取隔离机构, 高级信息管理程序, 先进接口模块;应用接口模块, 医学人工智能, 相联索引法, 异步接口模块;自动化信息管理, 自动化综合制造, 自动化库存管理
credit|/'kredit/n. 信用, 信任, 荣誉, 贷款, 学分;归功于, 赞颂, 信任, 相信; 信用量
impact|/'impækt/n. 冲击, 冲突, 影响, 效果;挤入, 撞击, 压紧, 对...发生影响
danger|/'deindʒә/n. 危险, 威胁; 危险, 危险物, 危机
progress|/'prәugres/n. 进步, 发展, 前进;进步, 进行
key|/ki:/n. 钥匙, 键, 解答, 关键, 要害, 基调, 线索, 答案, 暗礁;调音, 锁上, 提供线索;使用钥匙; 键, 密钥
track|/træk/n. 轨迹, 足迹, 径迹, 小道, 轨道, 磁轨, 途径;循路而行, 追踪, 通过, 用纤拉;追踪, 留下足迹, 沿轨道运行; 跟踪
reaction|/ri'ækʃәn/n. 反应, 反作用, 反动; 反应
flower|/'flauә/n. 花, 开花植物, 精华, 盛时;开花, 发育, 旺盛, 成熟;用花装饰, 使开花
video|/'vidiәu/n. 影像, 电视;图像的, 电视的
instead|/in'sted/adv. 作为替代, 反而
distance|/'distәns/n. 距离, 远方, 遥远; 位距
regular|/'regjulә/a. 规则的, 常例的, 有秩序的, 整齐的, 等边的, 定期的, 经常的, 合格的, 常备军的;正规军, 正式队员;经常地;正常体; 正常体
link|/liŋk/n. 环, 连结物, 链接, 火把;连结, 联合, 挽住;连接起来; 连接, 链路
gold|/gәuld/n. 黄金, 钱财, 金块, 金色, 宝贵;金的, 似金的, 金色的, 金制的
comment|/'kɒment/n. 注解, 批评, 评论, 备注;评论, 注解; 备注
due|/dju:/n. 应得的东西, 应付款;到期的, 应得的, 应付的, 约定的
drink|/driŋk/n. 饮料, 酒;喝, 喝酒
politics|/'pɒlitiks/n. 政治, 政治学, 政见, 政治活动; 政治, 政治学, 政纲
reply|/ri'plai/n. 答复, 回答, 答辩;答复, 回答, 回击, 反响, 答辩;回答; 答复
justice|/'dʒʌstis/n. 正义, 公平, 公正, 正确, 司法, 审判
skin|/skin/n. 皮肤, 皮;剥皮, 在...植皮;长皮, 愈合, 蜕皮
bag|/bæg/n. 袋子, 袋状物;使膨大, 装袋, 猎获
strike|/straik/n. 罢工, 打击, 殴打;打, 撞击, 冲击, 侵袭, 取消, 结算, 打掉, 罢工, 刺透, 使生根, 遇见;打, 打击, 抓, 罢工, 搏动, 触礁, 敲, 响, 穿透, 打动
settle|/'setl/n. 有背长椅;决定, 整理, 安放, 使定居, 使平静, 支付, 安排, 解决, 结算;停留, 下陷, 沉淀, 澄清, 安下心来, 结清, 定居, 安家
ignore|/ig'nɒ:/vt. 不理睬, 忽视, 驳回, 忽略; 忽略
alone|/ә'lәun/a. 孤独的, 单独的, 独自的;独自地
sight|/sait/n. 景观, 视力, 眼界, 阅读, 见解, 意见;看见, 瞄准;瞄准, 观看;即席的, 见票即付的
reality|/ri'æliti/n. 实在, 事实, 实体, 逼真; 现实, 实在存在的事物, 实在性
inside|/'in'said/n. 内部, 内脏, 内幕;内部的, 秘密的, 户内的;在里面;在...之内
boat|/bәut/n. 船;乘船;以船运
wine|/wain/n. 葡萄酒, 果酒, 暗红色;(请)喝酒
prison|/'prizn/n. 监狱, 监禁, 拘留所;监禁
propose|/prә'pәuz/vt. 计划, 打算, 建议, 提议, 求(婚);打算, 求婚
possibly|/'pɒsәbli/adv. 可能, 也许
respond|/ri'spɒnd/vt. 以...回答;回答, 响应, 回报, 有反应, 承担责任
clothes|/klәuðz/n. 衣服
active|/'æktiv/a. 活跃的, 起作用的, 积极的, 有效的, 主动的, 活性的, 现行的, 现役的;主动语态, 积极分子
weekend|/'wi:kend/n. 周末, 周末休假
vehicle|/'vi:ikl/n. 交通工具, 车辆, 传播媒介; 载体;运载体;漆料
debt|/det/n. 债务, 罪过; 借款, 欠款, 债务
somebody|/'sʌmbɒdi/n. 了不起的人, 大人物;有人, 某人
largely|/'lɑ:dʒli/adv. 大量地, 很多地, 大半地
arrange|/ә'reindʒ/v. 安排, 排列, 达成协议; 重排
survive|/sә'vaiv/vt. 比...活得长, 生存, 生还, 幸免于;活下来, 幸存
powerful|/'pauәful/a. 有力的, 有权力的, 强大的; 强力的
telephone|/'telifәun/n. 电话, 电话机;打电话
hole|/hәul/n. 孔, 洞, 穴, 漏洞;挖洞, 掘坑;进洞, 凿洞
battle|/'bætl/n. 战役;战斗
farmer|/'fɑ:mә/n. 农夫, 农场主; 农民, 农场主, 承包者
injury|/'indʒәri/n. 伤害, 侮辱; 伤, 损伤
expert|/'ekspә:t/n. 专家, 行家;老练的, 内行的, 专门的; 高级
package|/'pækidʒ/n. 包裹, 套装软件, 包, 包装用物, 程序包;包装, 打包;一揽子的; 包, 软件包, 包装
colleague|/'kɒli:g/n. 同事, 同僚
complex|/kәm'pleks/n. 综合体, 情结, 络合物;复杂的, 组合的
impossible|/im'pɒsәbl/a. 不可能的, 难以置信的, 令人无法忍受的
confidence|/'kɒnfidәns/n. 信心; 可靠
mainly|/'meinli/adv. 主要地, 大抵
generation|/.dʒenә'reiʃәn/n. 一代, 一世, 产生; 生殖, 世代
lift|/lift/n. 举起, 帮助, 昂扬, 电梯;升高, 提高, 鼓舞, 清偿, 空运, 举起, 剽窃;升起, 消散, 耸立
phone|/fәun/n. 电话, 受话器, 耳机;打电话给;打电话
insurance|/in'ʃurәns/n. 保险, 保险业, 保险费; 保险
painting|/'peintiŋ/n. 画, 绘画, 油漆; 涂漆
warm|/wɒ:m/a. 暖和的, 暖的, 温暖的, 热烈的, 兴奋的, 激烈的, 多情的, 色情的;使温暖, 弄热, 使兴奋, 使充满仇恨;变暖和, 变温暖, 取暖, 激动, 同情, 爱好;暖, 保暖物
ship|/ʃip/n. 船, 舰;以船运送, 装船, 运送;上船, 乘船
plus|/plʌs/prep. 加上, 加, 外加;正的, 附加的;正号, 加号, 附加额, 正数, 增益; 正差
volume|/'vɒljum/n. 册, 卷, 体积, 容量, 大量, 许多, 份量, 音量;成团卷起;把...收集成卷;大量的; 卷
judge|/dʒʌdʒ/n. 法官, 裁判员, 审判官, 鉴定人;审理, 鉴定, 判断, 判决, 裁定;下判断, 作评价
threat|/θret/n. 恐吓, 恶兆, 威胁; 威胁
conflict|/'kɒnflikt/n. 战斗, 冲突, 矛盾, 争执;争执, 战斗, 冲突, 抵触; 冲突
fresh|/freʃ/a. 新鲜的, 新奇的, 另外的, 淡的, 精神饱满的, 冒失的;最新地, 刚刚;开始, 泛滥
yard|/jɑ:d/n. 码, 庭院, 工场; 堆置场
victim|/'viktim/n. 受害人, 牺牲者, 牺牲品; 受害人, 被害人, 遭难者
touch|/tʌtʃ/n. 触觉, 碰, 触, 机灵, 轻触, 格调, 少许, 缺点, 弹力;接触, 触摸, 触及, 使接触, 达到, 涉及, 影响到, 使轻度受害, 感动;触摸, 接近, 涉及, 提到
entry|/'entri/n. 登录, 条目, 进入, 入口, 报关; 登录项, 输入项, 条目
engine|/'endʒin/n. 引擎, 发动机, 机车;安装发动机于
stuff|/stʌf/n. 原料, 要素, 东西, 材料, 素质, 织品, 废物, 废话;装填;狼吞虎咽
cabinet|/'kæbinit/n. 橱柜, 内阁;内阁的, 细木工做的; 机柜
domestic|/dәu'mestik/a. 家庭的, 国内的, 驯养的; 家庭的, 家用的
author|/'ɒ:θә/n. 作家, 作家的著作, 创始人; 作者, 著作人, 本人
sexual|/'sekʃuәl/a. 性的, 性别的; 性的;性欲的
tonight|/tә'nait/n. 今晚, 今夜;今晚, 今夜
prefer|/pri'fә:/vt. 宁可, 较喜欢, 提出; 给予优先权, 优先偿还, 提出
extremely|/ik'stri:mli/adv. 极端地, 非常地
cheap|/tʃi:p/a. 便宜的, 不值钱的, 可鄙的;便宜地
threaten|/'θretn/vt. 恐吓, 威胁, 预示...的凶兆;威胁, 恫吓, 可能来临
relief|/ri'li:f/n. 减轻, 解除, 救济, 安慰, 调剂, 浮雕, 换班, (地势的)起伏; 缓减, 减轻, 浮雕(绘画中)
commit|/kә'mit/vt. 委托(托付), 犯罪, 指派...作战, 使承担义务; 犯, 做, 把...交托给
grant|/grænt/n. 授予, 授予物, 允许;允许, 承认, 授与; 授权命令
strange|/streindʒ/a. 奇怪的, 陌生的, 生疏的, 不熟悉的, 不可思议的, 外行的, 外地的, 异乡的
repeat|/ri'pi:t/n. 重复, 反复;重做, 重复, 复述, 使再现, 复制;重复; 重复
mountain|/'mauntin/n. 山, 山脉, 大堆
song|/sɒŋ/n. 歌, 曲, 鸣声, 歌唱, 歌曲, 诗歌
sleep|/sli:p/n. 睡眠, 静止, 昏迷, 麻木, 长眠, 冬眠;睡觉, 睡眠, 静止;睡
insist|/in'sist/v. 坚持, 坚决主张, 强调
feed|/fi:d/n. 饲料, 一餐, 饲养;喂, 饲养, 放牧, 靠...为生;吃东西, 用餐, 流入; 送纸
wood|/wud/n. 木材, 木制品;植林于, 给...添加木柴;收集木材
excellent|/'ekslәnt/a. 优良的, 杰出的, 出色的
tour|/tuә/n. 旅游, 观光旅行, 任期;旅行, 周游, 巡回;周游, 观光, 游历, 使巡回演出
interview|/'intәvju:/n. 面谈, 访问, 接见, 面试;接见, 对...进行面谈(试)
dinner|/'dinә/n. 晚餐, 正餐, 宴会
football|/'futbɒ:l/n. 足球, 橄榄球
launch|/lɒ:ntʃ/n. 下水, 汽艇, 发射;使下水, 发射, 发动;起飞, 下水, 投入, 开始
consumer|/kәn'sju:mә/n. 消费者; 消费者, 用户
promote|/prәu'mәut/vt. 促进, 晋升, 创办, 推销; 促进, 推广, 推销
bridge|/bridʒ/n. 桥, 舰桥, 桥梁, 桥牌;架桥于, 跨越; 桥, 网桥, 桥接器
appearance|/ә'piәrәns/n. 出现, 露面, 外观, 外表, 出版; 外观, 版面
soft|/sɒft/a. 软的, 温和的, 柔和的, 柔滑的, 温柔的, 软弱的, 坡度小的, 笨的, 纸币的;柔软的东西, 笨人, 纸币;柔软地, 温和地
quiet|/'kwaiәt/n. 安静, 闲适, 平静;安静的, 静止的, 寂静的, 朴素的, 从容的, 暗中的;平静下来;使平静, 使平息, 使安心, 安慰
potential|/pә'tenʃәl/n. 潜在性, 可能性, 潜力, 潜能, 势, 位;有潜力的, 可能的, 潜在的
limit|/'limit/n. 界限, 边界, 限度, 极限, 限制;限制, 限定
session|/'seʃәn/n. 期间, 开庭期, 会议, 学期; 会话, 对话, 会晤, 通用任务程序
religious|/ri'lidʒәs/a. 宗教性的, 虔诚的, 宗教上的, 严谨的;修道士, 出家人
housing|/'hausiŋ/n. 遮盖, 住房供给, 居留(处), 房屋, 装饰; 外壳
flat|/flæt/a. 平坦的, 单调的, 无力的, 浅的, 萧条的, 干脆的, 无聊的;平直地, 断然地;扁平物, 平面, 平地, 平原, 平板车;(使)变平
increasingly|/in'kri:siŋli/adv. 逐渐地, 渐增地
TV|电视; 电视, 转移向量
proper|/'prɒpә/a. 适当的, 固有的, 高尚的, 专属的;完全地, 彻底地
deliver|/di'livә/vt. 递送, 陈述, 释放, 发表, 引渡, 投递, 交付; 交运
famous|/'feimәs/a. 出名的, 极好的
broad|/brɒ:d/a. 宽广的, 辽阔的, 广大的, 显著的;宽阔地;宽阔部分
audience|/'ɒ:diәns/n. 听众, 观众, 读者; 听讼, 观众, 听众
theatre|戏院, 电影院, 剧场, 全体观众, 戏剧, 戏剧效果, 阶梯式讲堂, 场所
prince|/prins/n. 王子, 亲王, 国君, 贵族, 诸侯, 有权势的大人物
crisis|/'kraisis/n. 危机, 危险期, 紧要关头; 危象;骤退, 临界, 极期
loan|/lәun/n. 贷款, 借出;借, 供应货款, 借给
representative|/.repri'zentәtiv/n. 代表, 众议员, 典型;描写的, 表现的, 代理的, 代表的, 代议制的, 典型的
usual|/'ju:ʒuәl/a. 平常的, 通常的
respect|/ri'spekt/n. 尊敬, 尊重, 问候;尊敬, 注意, 遵守
attract|/ә'trækt/vt. 吸引, 诱惑;有吸引力
promise|/'prɒmis/n. 诺言, 约定的事情, 有指望;允诺, 约定, 预示;允诺, 有前途, 有指望
magazine|/.mægә'zi:n/n. 杂志, 仓库, 弹盒, 胶卷盒; 卡片箱, 介质装卸程序
freedom|/'fri:dәm/n. 自由, 坦率, 特权; 自由, 自主, 免除
formal|/'fɒ:mәl/a. 正式的, 形式的, 礼仪的, 拘于礼节的, 拘谨的;正式的社交活动
writing|/'raitiŋ/n. 书写, 著作, 笔迹, 作品; 书写
reject|/ri'dʒekt/n. 被拒之人, 被弃之物, 不合格品, 次品;拒绝, 抵制, 否决, 驳回, 丢弃, 呕出
flight|/flait/n. 飞行, 射程, 逃走, 飞跃, 飞机航程, 班机, 迁徙, 飞逝;迁徙;射击(飞禽), 为(箭)装上羽毛, 使惊飞
joint|/dʒɒint/n. 连接处, 接合, 关节;共同的, 联合的, 连接的, 合办的;连接, 接合, 使有接头;贴合, 长节
rain|/rein/n. 雨, 下雨, 雨天;下雨;使大量落下
Conservative|/kәn'sә:vәtiv/a. 保守的, 守旧的, 有保存力的; 防腐剂;保存剂
invite|/in'vait/vt. 邀请, 请求, 引起, 招致;邀请
spring|/spriŋ/n. 春天, 弹簧, 跳跃, 弹性, 活力, 泉, 源泉;春天的;跳, 弹跳, 涌出, 生长, 裂开, 高耸;使跳起, 使爆炸, 突然提出
ahead|/ә'hed/a. 领先的, 预先的, 向前的;领先, 预先, 向前, 胜于, 在前面, 在将来
factory|/'fæktәri/n. 工厂, 产生地, 代理店; 工厂, 代理店, 商行在国外的代理处
challenge|/'tʃælindʒ/n. 挑战, 盘问;向...挑战, 要求, 怀疑;挑战, 对(证据等)表示异议
youth|/ju:θ/n. 年轻, 青年时代, 青年们, 青春; 青年, 青年时期, 青春时期
sing|/siŋ/vi. 唱, 唱歌, 演唱, 鸣, 啼;唱, 歌颂;嗖嗖声
warn|/wɒ:n/vt. 警告, 提醒, 通知;发出警告
dream|/dri:m/n. 梦, 空想, 愿望;做梦, 想象, 梦想
victory|/'viktәri/n. 胜利, 战胜, 克服
finance|/fai'næns/n. 财政, 财务;供给...经费, 负担经费;筹措资金
impose|/im'pәuz/vt. 征(税), 把...强加于, 以...欺骗;利用, 欺骗, 施加影响
cry|/krai/n. 叫声, 哭声, 大叫;哭, 叫, 喊;叫喊, 大声说, 哭出
destroy|/di'strɒi/vt. 破坏, 毁坏, 消灭
address|/ә'dres/n. 住址, 演说, 举止, 灵巧, 求爱;发表(演说或讲话), 对付, 写地址; 地址, 寻址
bright|/brait/a. 明亮的, 聪明的, 鲜明的, 欢快的;明亮地, 欢快地
average|/'ævәridʒ/n. 平均, 平均数, 一般水平, 海损;平均的, 中等的, 平常的;算出...平均数, 平均做, 均分, 使平衡;平均为, 呈中间色
nobody|/'nәubɒdi/n. 小人物, 无名小卒;无人, 没有人
egg|/eg/n. 蛋, 卵;挑唆, 煽动, 调蛋黄
declare|/di'klєә/v. 宣布, 声明, 申报, 断言
worry|/'wʌri/n. 担心, 烦恼, 忧虑, 苦恼, 撕咬;使烦恼, 使焦虑, 使苦恼, 困扰, 折磨, 撕咬;烦恼, 担心, 撕咬
aircraft|/'єәkræft/n. 航空器, 飞机; 航空器
decade|/'dekeid/n. 十年, 十
immediate|/i'mi:diәt/a. 立即的, 直接的, 接近的; 直接的, 立即的
divide|/di'vaid/vi. 分开, 分配, 分裂;分, 分开, 分裂, 除;分配, 分水岭; 除
equal|/'i:kwәl/n. 对手, 匹敌, 同辈;相等的, 平等的, 胜任的, 合适的, 平静的, 不相上下的;等于, 比得上; 等长度编码
leading|/'li:diŋ/n. 领导, 指挥, 神示, 铅板;领导的, 主要的, 在前的
bottom|/'bɒtәm/n. 底部;底部的;给...装底, 查明真相;到达底部, 建立基础
weapon|/'wepәn/n. 武器, 兵器;武装
murder|/'mә:dә/n. 谋杀;谋杀, 损毁, 破坏;犯杀人罪
tape|/teip/n. 带子, 录音带, 磁带, 窄带, 卷尺;以带子绑起, 测量, 录音; 带
female|/'fi:meil/n. 女性, 女人, 雌性动物;女性的, 女子的
overall|/'әuvәrɒ:l/a. 全部的, 全体的, 从头至尾的, 一切在内的;从头到尾, 总的说来;罩衫, 工作服
recognize|/'rekәgnaiz/vt. 认出, 认可, 承认, 公认, 识别, 赏识;承认, 具结
kid|/kid/n. 小山羊, 小山羊肉, 小孩, 欺骗;小山羊皮制的;哄骗, 嘲弄
spread|/spred/n. 传播, 散布, 伸展;双唇展开的, 伸展的;展开, 铺开, 传播, 推广, 伸出, 涂, 敷, 延伸;展开, 扩大, 传开, 延伸; 展开
handle|/hændl/n. 柄, 把手, 把柄, 柄状物, 手感;触摸, 运用, 买卖, 处理, 操作;搬运, 易于操纵;句柄; 句柄
expensive|/ik'spensiv/a. 贵的, 奢华的, 费用浩大的, 乱化钱的; 高价的, 昂贵的, 浪费的
recommend|/.rekә'mend/vt. 推荐, 介绍, 劝告, 使受欢迎, 托付; 建议, 推荐
correct|/kә'rekt/a. 正确的, 合适的;改正, 订正
store|/stɒ:/n. 商店, 贮藏, 仓库, 备用品, 存储器;储存, 贮藏, 供给;贮藏;贮藏的, 现成的; 存储器操作;存储
bottle|/'bɒtl/n. 瓶子, 酒瓶;装瓶, 抑制, 围困
wave|/weiv/n. 波, 波浪, 波动, 起伏, 高潮, 潮涌, 挥手致意, (气压)突变;波动, 飘动, 挥手示意, 起伏;使波动, 使飘扬, 挥舞, 使成波浪形
criticism|/'kritisizm/n. 批评, 评论, 非难; 批判, 批评, 评论
eastern|/'i:stәn/n. 东方人, 东正教徒;东方的, 向东的, 自东的
transfer|/træns'fә:/n. 迁移, 移动, 传递, 转让, 转移, 过户, 汇兑, 换车;使转移, 调转, 调任, 改变, 传递, 转让;转移, 转学, 转职, 换车; 传送
straight|/streit/n. 直线, 直;直的, 笔直的, 正直的, 直接的, 连续的, 整齐的;直接地, 立即, 不断地
realize|/'riәlaiz/vt. 了解, 实现, 使显得逼真, 变卖;变卖
dangerous|/'deindʒәrәs/a. 危险的; 危险的, 危害的
weather|/'weðә/n. 天气, 气象, 处境;迎风的;使受风吹雨打, 侵蚀, 使风化, 经受住;风化, 受侵蚀, 经受风雨
photograph|/'fәutәgrɑ:f/n. 相片, 照片, 逼真的描绘;照相, 摄影
lunch|/lʌntʃ/n. 午餐
critical|/'kritikәl/a. 批评的, 决定性的, 危险的, 临界的; 危象的;临界的, 极期的
channel|/'tʃænәl/n. 海峡, 航道, 频道;引导, 在...上挖沟, 形成河道; 信道, 通道
fee|/fi:/n. 费用, 小费, 封地, 所有权;付费给
absolutely|/'æbsәlu:tli/adv. 完全地, 绝对地, 确确实实地
Friday|/'fraidi/n. 星期五
waste|/weist/n. 浪费, 废物, 损耗, 消耗, 荒地, 垃圾, 地面风化物;废弃的, 荒芜的, 多余的;浪费, 消耗, 使荒芜;浪费, 消耗, 变消瘦
desire|/di'zaiә/n. 欲望, 要求;想要, 请求;渴望
institute|/'institju:t/n. 学会, 学院, 协会;创立, 开始, 制定, 任命
unlikely|/.ʌn'laikli/a. 不太可能的
recall|/ri'kɒ:l/n. 回忆, 召回, 撤消;回想, 回忆, 召回, 撤消, 使恢复; 检索
double|/'dʌbl/n. 两倍;两倍的, 双重的;使加倍;加倍, 代替, 快步走; 双精度型
block|/blɒk/n. 街区, 木块, 石块, 块;阻塞, 封锁, 使成块状; 块, 数据块
brain|/brein/n. 脑;打碎脑部
guide|/gaid/n. 引导者, 导游, 指南, 路标;指导, 支配, 管理, 带领, 操纵;任向导; 辅助线
welcome|/'welkәm/n. 欢迎, 欢迎词;受欢迎的, 可随意的, 可喜的;欢迎, 接待;欢迎
screen|/skri:n/n. 幕, 银幕, 屏风, 掩蔽物, 屏蔽, 筛子;掩蔽, 放映, 拍摄, 掩护, 筛, 甄别;拍电影; 筛选;屏幕
guest|/gest/n. 客人, 来宾, 旅客; 客体
secure|/si'kjuә/a. 无虑的, 安心的, 安全的, 可靠的, 保险的;固定, 获得, 保证, 使安全, 掩护, 招致;停止操作, 船抛锚
program|/'prәugræm/n. 节目, 节目单, 程序, 纲要, 大纲, 计划;规划, 拟...计划;安排节目, 编程序; 程序
slow|/slәu/a. 慢的, 缓慢的, 迟缓的, 迟钝的, 冷漠的, 落后的;慢地, 迟缓地;(使)慢下来
trip|/trip/n. 旅行, 绊倒, 摔倒, 失足, 差错, 旅程;使跌倒, 使犯错, 使失败;轻快地走, 绊倒, 失误, 犯错, 结巴, 旅行, 远足
dry|/drai/a. 干的, 无酒的, 枯燥无味的, 干燥的;把...弄干;变干;干, 干涸
dress|/dres/n. 服装, 覆盖物;穿着;给...穿衣, 整理
violence|/'vaiәlәns/n. 猛烈, 暴力, 暴虐, 暴行; 暴行, 暴力, 暴乱
Monday|/'mʌndi/n. 星期一
captain|/'kæptin/n. 船长, 指挥官, 海军上校, 首领;率领, 指挥
display|/dis'plei/n. 显示, 陈列, 炫耀, 显示器;陈列, 显示, 表现, 夸示; 显示器;显示
scientist|/'saiәntist/n. 科学家; 科学家
perfect|/'pә:fikt/n. 完成时;完美的, 完好的, 理想的, 熟练的, 精确的, 完成式的;使完美, 修改, 使精通, 改善, 使熟练
crowd|/kraud/n. 群众, 一伙人;拥挤, 挤满, 挤进
search|/sә:tʃ/n. 搜寻, 查究;搜寻, 搜查, 探求, 调查, 搜索; 搜索, 路径检索程序
escape|/i'skeip/n. 逃亡, 避难设备, 逃跑;逃脱, 避开, 溜走;逃避, 避免, 被...忘掉
wild|/waild/n. 荒野, 荒地;野性的, 野蛮的, 野生的, 失控的, 任性的, 杂乱的, 轻率的, 狂热的, 疯狂的;狂暴地, 失控地
heat|/hi:t/n. 热, 热度, 体温, 高潮;加热, 激昂, 加剧;把...加热, 使激动
daily|/'deili/a. 每日的, 日常的;每日地, 日常地;日报
southern|/'sʌðәn/n. 南方人, 男风;向南方的, 来自南方的
gun|/gʌn/n. 枪; 枪
investigate|/in'vestigeit/v. 调查, 审查
professor|/prә'fesә/n. 教授
ministry|/'ministri/n. 部, 内阁, 服务; 部
neither|/'naiðә/adv. 皆不, 两个都不;(两者)都不的;两者都不;既非, 既不
spot|/spɒt/n. 污点, 地点, 斑点, 点, 娱乐场所, 处境, 少量;当场的, 现场的, 现货买卖的, 现金交易的, 抽样的;点缀, 玷污, 认出, 准确定...的位, 用灯光照射;玷污, (从空中)侦察敌方目标
prospect|/'prɒspekt/n. 景色, 展望;勘探, 勘察;勘探, 有前途
narrow|/'nærәu/n. 狭窄部分, 隘路;狭窄的, 仔细的, 有限的, 勉强的, 狭隘的, 手紧的;变窄;使变狭窄
earn|/ә:n/vt. 赚得, 获得, 博得; 欧州科学研究网
soldier|/'sәuldʒә/n. 军人, 士兵, 兵蚁;从军, 尽职, 偷懒, 磨洋工
succeed|/sәk'si:d/vi. 成功, 继承, 继续;继承, 接替
North|/nɒ:θ/n. 北方, 北;北的, 北方的;向北方, 在北方
prepared|/pri'pєәd/a. 准备好的, 特制的
mistake|/mis'teik/n. 错误, 误会;犯错, 误认;误解, 弄错; 错误
alternative|/ɒ:l'tә:nәtiv/n. 两者择一, 供替代的选择;两者择一的, 供选择的; 选择对象
burn|/bә:n/vt. 烧, 烧毁, 烧伤;燃烧, 发热, 烧毁;烧伤, 烙印
wing|/wiŋ/n. 翅膀, 翼, 机翼, 派别;给...装上翼, 飞过, 使飞, 空运, 增加...速度;飞行
flow|/flәu/n. 流程, 流动, 流量, 洋溢, 泛滥, 涨潮;流动, 流泄, 畅流, 川流不息, 飘扬, 涌出;使流动, 淹没, 流出
approve|/ә'pru:v/vt. 赞同, 核准, 为...提供证据;赞许
careful|/'kєәful/a. 小心的, 谨慎的
gather|/'gæðә/n. 集合, 聚集;聚集, 集合, 渐增;使聚集, 搜集, 积聚
clean|/kli:n/a. 干净的, 清白的, 简洁的;清洁地, 完全地;清理, 使干净, 出空;被搞干净;打扫
pretty|/'priti/a. 漂亮的, 优美的, 机灵的, 狡猾的, 恰当的;相当, 颇
jump|/dʒʌmp/n. 跳跃, 跳动, 暴涨, 惊跳;跳跃, 跃过, 突升, 使跳跃;跳跃, 跳, 跳动, 暴涨; 转移, 跳转
incident|/'insidәnt/n. 事件, 事变, 小事;附带的, 易于发生的, 外来的, 入射的
border|/'bɒ:dә/n. 边缘, 边境, 边界, 花坛;在...上镶边, 接近;接界, 近似; 边框
winner|/'winә/n. 胜利者, 优胜者; 取胜者
conduct|/'kɔndʌkt, -dәkt/n. 行为, 举动, 指导;为人, 指挥, 管理, 实施;领导, 传导, 指挥
elect|/i'lekt/n. 当选人, 被选的人;被选的, 选出的;选举, 选择;作选择
ride|/raid/n. 骑马, 乘坐, 乘车, 搭便车;骑, 乘坐, 压迫, 控制;骑马, 乘车, 漂游
square|/skwєә/n. 正方形, 街区, 广场, 平方, 直角尺;正方形的, 正直的, 公正的, 平方的, 方正的, 结清的;成直角地, 对准地;一致, 符合, 结清;使成方形, 使平方自乘, 调正, 结清, 使一致
fruit|/fru:t/n. 水果, 果类, 结果; 果实, 种实
slip|/slip/n. 滑, 滑行, 事故, 溜, 差错, 滑台, 下降, 插条, 后裔, 板条, 瘦长的年轻人;滑动, 滑倒, 失足, 溜走, 滑落, 犯错, 变坏;使滑动, 滑过, 摆脱, 闪开, 塞入, 从...取接枝;滑动的, 滑移的, 活络的, 有活结的; 串行线接口协议
restaurant|/'restәrɒŋ/n. 餐馆, 饭店
score|/skɒ:/n. 得分, 抓痕, 二十个, 刻痕, 帐目, 乐谱, 起跑线, 终点线, 大量;刻划, 划线, 获得, 评价, 把...记下;刻痕, 记分, 得分; 得分
request|/ri'kwest/n. 请求, 需要, 申请书;请求, 要求, 邀请; 请求
estimate|/'estimeit/n. 估计, 判断;估计, 评价, 判断;估计
circle|/'sә:kl/n. 圆周, 社交圈, 循环, 范围;围着, 环绕;盘旋, 循环
fast|/fɑ:st/a. 快速的, 紧的;很快地, 紧紧地, 彻底地;绝食, 斋戒;绝食, 斋戒
shot|/ʃɒt/n. 发射, 炮弹, 射击, 射手, 投篮, 射门, 子弹, 射程, 拍摄, 注射;装弹, 使成颗粒状;杂色的, 交织着的, 渗透的, 点焊的, 破旧的;shoot的过去式和过去分词
grand|/grænd/a. 庄重的, 壮观的, 显赫的, 重大的, 最高的, 雄伟的, 宏大的, 豪华的, 傲慢的; 重大的, 主要的, 伟大的
fashion|/'fæʃәn/n. 流行, 风尚, 时样;形成, 造, 作
coast|/kәust/n. 海岸, 滑坡;沿海岸而行
roll|/rәul/n. 卷, 滚动, 名单, 案卷, 压路机;滚, 滚动, 飘流, 起伏, 卷, 绕;使滚动, 卷, 绕
mass|/mæs/n. 块, 大多数, 质量, 大量, 群众, 弥撒;群众的, 大规模的, 整个的;使集合, 集中;聚集
desk|/desk/n. 书桌, 办公桌, 工作台
brief|/bri:f/n. 摘要, 简报;简短的, 短暂的;对...作简报, 摘要, 节录
wonderful|/'wʌndәful/a. 令人惊奇的, 奇妙的, 极好的
entire|/in'taiә/n. 整个, 全部;全体的, 完全的, 全部的
advance|/әd'vɑ:ns/n. 前进, 进展, 行过的路程;前进, 进展, 提高, 上涨;使前进, 促进, 提出, 提高, 使提前, 预付;前面的, 预先的
ticket|/'tikit/n. 票, 券, 车票, 标签, 入场券, 证明书;加标签于, 为...购票
meanwhile|/'mi:nhwail/n. 其时, 其间;同时, 于此时
accuse|/ә'kju:z/vt. 指责, 控告, 归咎于;指责, 控告
motor|/'mәutә/n. 马达, 发动机, 原动力, 汽车;马达的, 发动机的, 汽车的, 发动的;推动, 以汽车载运;乘汽车, 驾车
fan|/fæn/n. 风扇, 迷, 狂热者, 爱好者;煽动, 刺激, 吹拂;飘动, 成扇形散开
constant|/'kɒnstәnt/n. 常数, 恒量;不变的, 一定的, 时常的; 常量;常数;恒值
ideal|/ai'diәl/n. 理想, 典范, 观念, 思想, 最后目标;理想的, 完美的, 空想的, 观念的, 唯心论的
focus|/'fәukәs/n. 焦点, 焦距;聚焦, 注视;使聚焦, 调焦, 集中; 焦点
withdraw|/wið'drɒ:/vt. 撤回, 取回, 撤消, 使撤退, 拉开, 移开;撤退, 离开
severe|/si'viә/a. 严格的, 尖锐的, 严肃的, 严重的, 严厉的, 朴素的; 严厉的, 苛刻的, 严重的
citizen|/'sitizn/n. 市民, 公民; 公民, 国民, 市民
terrible|/'terәbl/a. 可怕的, 令人恐惧的, 极坏的
hurt|/hә:t/n. 伤害, 创伤, 损害;伤害, (使)伤心, 危害, 刺痛
prisoner|/'priznә/n. 囚犯, 犯人, 战俘; 犯人, 囚犯, 扣押犯
fuel|/'fjuәl/n. 燃料, 木炭;加燃料, 供燃料;得到燃料
cancer|/'kænsә/n. 癌, 恶性肿瘤; 癌
editor|/'editә/n. 编者, 编辑, 主笔, 编辑器, 编辑装置; 编辑器
ill|/il/n. 疾病, 坏事, 罪恶, 灾难;生病的, 邪恶的, 不吉利的, 敌意的, 不良的, 不顺利的;有害地, 不幸地, 几乎不
lawyer|/'lɒ:jә/n. 律师; 律师
diet|/'daiәt/n. 日常饮食, 议会;照规定饮食;忌食
Wednesday|/'wenzdi/n. 星期三
surround|/sә'raund/vt. 包围, 环绕, 围绕;围绕物
weak|/wi:k/a. 不牢固的, 弱的, 虚弱的, 软弱的, 无力的, 无权力的, (论据等)不充分的; 疲软的
occupy|/'ɒkjupai/vt. 占领, 占(时间、空间等), 住进, 担任, 使从事, 使全神贯注; 占领, 占据, 占有
shock|/ʃɒk/n. 震动, 冲突, 震惊, 冲击, 突击, 禾束堆, 休克, 长毛狗;使震动, 使休克, 使受电击, 震惊得;震动, 吓人;蓬乱浓密的
plane|/plein/n. 平面, 扁平物, 机翼, 飞机, 水准, 地位;平的, 平面的;将...刨平, 刨平, 掠过水面;翱翔, 乘飞机旅行, 刨掉
odd|/ɒd/a. 奇数的, 古怪的, 剩余的, 零散的, 各种各样的, 少量的;奇特的事物, 怪人; 奇数, 奇校验, 光数据数字转换器
complain|/kәm'plein/v. 抱怨, 抗议, 控诉
sharp|/ʃɑ:p/n. 半升音调, 利刃, 骗子;锋利的, 明显的, 敏锐的, 急剧的, 尖刻的, 严厉的, 刺耳的, 精明的;锐利地, 急速地
quote|/kwәut/n. 引用;引述, 举证, 报(价);引用
paint|/peint/n. 油漆, 颜料, 绘画作品, 涂漆;油漆, 绘, 画, 描绘, 装饰, 点缀;绘画, 涂漆
dominate|/'dɒmineit/v. 支配, 占优势
blame|/bleim/n. 过失, 责备;责备, 归咎于
struggle|/'strʌgl/n. 斗争, 努力, 奋斗;努力, 奋斗, 挣扎
politician|/.pɒli'tiʃәn/n. 政客, 政治家, 从事党派政治的人; 政客, 政治家
resident|/'rezidәnt/n. 居民, 常驻程序, 居住者, 留鸟;居留的, 定居的
criminal|/'kriminәl/n. 罪犯, 犯人, 刑事;犯了罪的, 刑事的, 有罪的
thinking|/'θiŋkiŋ/n. 思考, 思想;思考的, 有理性的
taste|/teist/n. 味道, 品味, 味觉, 感受, 体验, 爱好, 审美, 少量;尝, 察觉...的味道, 体会;品尝, 察觉味道, 有某种味道
camp|/kæmp/n. 露营, 帐篷;露营, 扎营;使扎营
emergency|/i'mә:dʒәnsi/n. 紧急状况, 紧急事件, 紧急需要; 紧急情况
stress|/stres/n. 压力, 紧迫, 强调, 重音, 重点, 应力;加压力于, 着重, 重读
dismiss|/dis'mis/vt. 解散, 开除, 解职;解散; 解散
minority|/mai'nɒriti/n. 少数, 未成年, 少数民族;少数的, 属于少数派的
novel|/'nɒvl/n. 小说, 长篇故事;新奇的, 异常的
tie|/tai/n. 带子, 线, 鞋带, 领带, 领结, 关系, 束缚, 平局, 不分胜负;系, 打结, 扎, 约束, 与...成平局;结合, 打结, 不分胜负
suit|/sju:t. su:t/n. 套装, 诉讼, 请求, 起诉, 套, 组;适合, 使适应;合适, 相称
prize|/praiz/n. 奖赏, 奖金, 奖品, 战利品, 捕获;得奖的;珍视, 估价, 捕获, 撬, 撬动
defend|/di'fend/vt. 防护, 辩护, 防卫; 作...的辩护律师, 辩护, 为...答辩
arrest|/ә'rest/n. 逮捕, 监禁;拘捕, 抑制, 吸引, 阻止
except|/ik'sept/vt. 除, 除外;反对;除了...之外, 若不是, 除非;只是
suspect|/sә'spekt/n. 被怀疑者, 嫌疑犯;令人怀疑的, 不可信的, 可疑的;怀疑, 猜想
mix|/miks/n. 混合物, 混乱, 糊涂;使混合, 弄混, 使结合, 混淆;相混合, 交往, 参与
tough|/tʌf/n. 恶棍;强硬的, 艰苦的, 坚固的, 坚韧的, 粗暴的, 咬不动的
ice|/ais/n. 冰, 冰淇淋, 糖衣, 冷若冰霜, 矜持, 贿赂;使结冰, 冰镇, 覆以糖衣;结冰
decline|/di'klain/n. 衰退, 跌落, 下降;使降低, 婉谢;下降, 衰落, 偏斜
governor|/'gʌvәnә/n. (美)州长, (英)总督, 统治者, 管理者, 理事; 节制器, 调节器
guess|/ges/n. 猜测, 臆测;猜测, 臆测
boss|/bɒs/n. 老板, 上司, 岩瘤, 浮雕, 母牛;指挥, 控制, 浮雕
protest|/prә'test/n. 抗议, 反对, 抗议书, 断言;反对, 抗议, 断言
export|/ik'spɒ:t/n. 输出品, 输出;输出, 出口;输出物资; 导出
willing|/'wiliŋ/a. 乐意的, 自愿的, 甘愿的
dramatic|/drә'mætik/a. 戏剧性的, 生动的
camera|/'kæmәrә/n. 照相机, 摄影机, 密谈室, 暗箱; 摄影
guard|/gɑ:d/n. 守卫者, 警戒, 护卫队, 防护装置;保卫, 看守, 当心;防止, 警惕, 警卫, 看守
purchase|/'pә:tʃәs/n. 购买, 购买品, 紧握, 绞辘;购买, 赢得, 努力取得, 用滑轮起(锚等)
Thursday|/'θә:zdi/n. 星期四
urge|/ә:dʒ/n. 冲动, 推动力, 迫切的要求;驱策, 力劝, 竭力主张, 推动;强烈要求
bomb|/bɒm/n. 炸弹;轰炸, 投弹于;失败
federal|/'fedәrәl/a. 联邦的, 联合的, 同盟的; 联邦的, 联邦制的, 联盟的
cast|/kɑ:st. kæst/n. 演员阵容, 投掷, 铸件, 预测, 特性;投, 掷, 抛, 脱落, 铸, 使弯曲, 计算;投, 计算, 浇铸成型
cook|/kuk/n. 厨子, 厨师;烹调, 煮饭, 加热;在煮着
dance|/dæns. dɑ:ns/n. 跳舞, 舞蹈, 舞会;跳舞
coach|/kәutʃ/n. 四轮大马车, 教练;训练, 指导;坐马车旅行, 作指导
Tuesday|/'tju:zdi/n. 星期二
abuse|/ә'bju:s.ә'bju:z/n. 滥用, 虐待, 恶习, 辱骂;滥用, 辱骂, 虐待
armed|/ɑ:md/a. 有扶手的, 武装的, 有防卫器官的; 武装的, 持械的, "F带武器的
bid|/bid/n. 出价;命令, 吩咐, 请求, 表示, 宣布, 投标
dozen|/'dʌzn/n. 打, 十二个;一打的
sad|/sæd/a. 忧愁的, 悲哀的
secret|/'si:krit/n. 秘密, 机密, 秘诀, 秘方;秘密的, 极机密的, 隐蔽的, 暗中的, 神秘的, 偏僻的
festival|/'festәvәl/a. 节日的, 喜庆的, 快乐的;节日, 庆祝, 欢宴
rapid|/'ræpid/a. 迅速的, 飞快的, 急促的, 陡的;急流
kick|/kik/n. 踢, 反冲, 后座力, 凹底;踢, 反抗, 反冲;踢, 反冲
guy|/gai/n. 家伙, 支索;用支索撑住, 取笑, 嘲弄;逃跑
print|/print/n. 打印, 版, 印刷物, 痕迹, 印刷业, 印刷字体, 图片, 印花布, 印章;打印, 印刷, 铭记, 留印记于, 用印刷体写; DOS外部命令:在打印机上打印文件, 可一边打印文件一边执行其他工作
instance|/'instәns/n. 建议, 情况, 例子, 场合;引以为例, 举例说明
reserve|/ri'zә:v/n. 储备品, 贮量, 后备军, 自然保护区, 保留, 拘谨, 节制, 储备金;保留, 保存, 预订, 延期, 推迟
cool|/ku:l/n. 凉爽, 凉爽的空气;凉爽的, 冷淡的, 冷静的;冷却, 平息;使冷却, 使平静
fun|/fʌn/n. 乐趣, 玩笑, 娱乐;开玩笑;供娱乐用的
organize|/'ɒ:gәnaiz/vt. 组织, 有机化, 给予生机;组织起来
pack|/pæk/n. 包裹, 一伙, 一副, 背包, 包装;包装, 捆扎, 塞满, 压紧, 挑选;包装货物, 挤, 群集, 被包装; 压缩
guarantee|/.gærәn'ti:/n. 担保, 抵押品, 保证书;保证, 担保
favourite|/'feivәrit/n. 喜欢的事物;喜爱的, 宠爱的
delay|/di'lei/n. 耽搁, 迟滞;耽搁, 延迟; 延迟, 延时
edition|/i'diʃәn/n. 版本, 版, 翻版
airport|/'єәpɒ:t/n. 飞机场; 航空站, 机场
chemical|/'kemikl/n. 化学药品;化学的, 化学上用的
defeat|/di'fi:t/n. 败北, 失败;击败, 使落空
aunt|/ɑ:nt/n. 阿姨, 姨妈, 舅妈, 姑妈, 伯母
split|/split/n. 劈开, 裂片, 裂缝, 分裂, 派系, 派别, 柳条;劈开的;分离, 分开, 裂开, 被劈开;劈开, 切开, 使分裂, 使分离; 拆分
seed|/si:d/n. 种子, 籽, 萌芽, 子孙, 精液;在...播种, 催...发育, 脱...籽;结实, 播种
journalist|/'dʒә:nәlist/n. 新闻记者, 从事新闻杂志业的人
found|/faund/vt. 建立, 创立, 铸造;find的过去式和过去分词
stable|/'steibl/n. 马房, 牛棚;稳定的, 安定的, 坚固的, 坚定的;赶入马房;被关在马厩
princess|/'prinsis/n. 公主, 王妃, 女巨头
schedule|/'skedʒuәl/n. 时间表, 一览表, 计划表, 议事日程;预定, 编制目录, 制...表, 安排
smoke|/smәuk/n. 烟, 雾气, 烟熏剂, 抽烟, 烟色;吸烟, 冒烟, 弥漫;以烟熏, 抽烟而导致...
import|/im'pɒ:t/n. 进口货, 进口, 输入, 含义, 重要性;输入, 引入, 进口, 含...的意思, 重要;有关系; 引入
favour|/'feivә/n. 好感, 偏爱, 喜爱, 相信, 庇护, 赞同, 支持, 信赖, 善行, 恩惠, 徽章, 礼物;赞成, 帮助, 支持, 喜爱, 偏袒, 关切, 赐与, 给与, 有利于, 有助于, 像, 体恤
ban|/bæn/n. 禁令;禁止, 取缔
addition|/ә'diʃәn/n. 加法, 增加的人(或物); 加法
fat|/fæt/n. 脂肪, 脂油, 肥肉;肥的, 胖的, 油腻的;文件分配表; 文件分配表
movie|/'mu:vi/n. 电影
fellow|/'felәu/n. 男人, 朋友, 同事;同伴的, 同事的, 同道的
classic|/'klæsik/n. 古典作品, 杰作, 大艺术家;第一流的, 最优秀的, 古典的
cousin|/'kʌzәn/n. 堂兄弟姊妹, 表兄弟姊妹; 同辈表亲或堂亲
rival|/'raivl/n. 对手, 竞争者;竞争的
collapse|/kә'læps/n. 崩溃, 倒塌, 虚脱;倒塌, 崩溃, 瓦解;使倒塌, 折叠; 折叠
frequent|/'fri:kwәnt/a. 时常发生的, 频繁的, 快速的;时常来访, 常常聚集, 常与...交往
ally|/'ælai. ә'lai/n. 同盟者, 同盟国, 助手;使联盟, 使联合, 使有关系;结盟
crash|/kræʃ/n. 哗啦声, 猛撞, 崩溃, 粗布;撞碎, 破碎, (使)...坠毁;速成的; 崩溃
running|/'rʌniŋ/n. 赛跑, 流出, 运转;流动的, 跑着的, 连续的
exact|/ig'zækt/a. 精确的, 准确的, 精密的;强求, 急需
wound|/wu:nd/n. 创伤, 伤口, 伤疤, 伤害, 痛苦;伤害, 损害, 使受伤;打伤, 伤害;wind的过去式和过去分词
media|/'mi:diә/n. 媒体; 媒质
all right|好, 顺利, 良好的, 正确的
latest|/'leitist/a. 最近的
no one|/nəu wʌn/n. 没有人
make|/meik/vt. 制造, 安排, 创造, 构成, 使得, 产生, 造成, 整理, 布置, 引起, 到达, 进行;开始, 前进, 增大, 被制造, 被处理;制造, 构造, 性情
so|/sәu/adv. 如此, 如是, 如...那样;所以, 因此;这样
know|/nәu/v. 知道, 了解, 认识, 确信
part|/pɑ:t/n. 部分, 局部, 零件, 要素, 等分, 职责, 角色, 部位;分开, 分离, 断绝, 区别, 分配;分开, 断裂, 分手;部分的, 局部的;部分地, 有些
set|/set/n. 日落, 同伙, 组合, 集合, 装置;放, 安置, 放置, 设定, 使凝结, 点燃, 确定, 点缀, 使就位, 树立, 分配, 调整;日落, 凝固, 定型, 搁住, 结果, 适合;决心的, 规定的, 故意的, 持久的, 固定的, 老套的, 准备好的; 设置;DOS…
form|/fɒ:m/n. 形状, 形体, 类型, 方式, 表格, 形式;形成, 排列, (使)组成;表单; 表单
right|/rait/n. 权利, 右边, 正义, 右派, 公正;正确的, 对的, 恰当的, 正常的, 正直的, 正面的, 右方的;正确地, 以有利结果, 一直, 直接, 向右;扶直, 整理, 纠正, 伸冤, 使昭雪;恢复平衡; 右, 权利
live|/liv.laiv/a. 活的, 生动的, 精力充沛的, 实况转播的;活, 生存, 居住;过着, 度过, 经历;实况地
mind|/maind/n. 思想, 愿望, 智力, 记忆, 心理, 情绪, 理智, 主意, 心意;介意, 注意, 留心;注意, 留意, 专心于, 照看, 介意
certain|/'sә:tәn/a. 确定的, 某一个的, 必然的; 确凿的, 无疑的, 可靠的
lie|/lai/n. 谎言, 假象, 位置;躺着, 说谎, 位于, 展现, 存在, 停泊;谎骗
watch|/wɒtʃ/n. 观察, 手表, 看守, 守护, 监视, 值班人;看, 注视, 照顾, 看守, 守护, 监视;观看, 注视, 守侯
light|/lait/n. 光, 光亮, 灯, 日光, 发光体, 光源, 杰出人物, 火花, 眼光;轻的, 少量的, 轻微的, 轻快的, 轻浮的, 明亮的, 淡色的, 容易的;点燃, 照亮;点着, 变亮, 突降, 偶然碰到;轻地
deal|/di:l/n. 交易, 协定, 数量, 买卖, 松木板;处理, 应付, 做生意;分配, 发牌, 给予; 发牌
application|/.æpli'keiʃәn/n. 应用, 申请, 志愿书, 应用程序; 应用, 应用程序
secretary|/'sekrәtәri/n. 秘书, 书记, 大臣; 秘书
concerned|/kәn'sә:nd/a. 关心的, 有关的, 参与的, 担心的
close|/klәuz/n. 结束, 完结;靠近的, 亲近的, 亲密的, 严密的, 关闭的, 狭窄的, 秘密的;关, 结束, 使靠近, 封闭, 使接近;关闭, 结束, 靠近;接近地, 紧密地; 关闭
fine|/fain/n. 罚款, 罚金, 晴天, 精细;好的, 晴朗的, 健康的, 细小的, 精细的;罚款, 精炼, 澄清;变清, 变细;很好; 精细
pick|/pik/n. 精选, 选择, 掘, 精华, 牙签, 鹤嘴锄;摘, 掘, 凿, 挖, 挑选; 拾取
march|/mɑ:tʃ/n. 三月, 进行, 行军, 步伐, 长途跋涉, 进行曲, 边界;进军, 前进, 交界;使行军, 使行进
analysis|/ә'nælәsis/n. 分析; 分析机;分析员;分析;分析程序
relate|/ri'leit/vt. 讲, 叙述, 使互相关联;有关, 符合, 相处得好
compare|/kәm'pєә/vt. 比较, 比喻, 对照;相比;比较; 比较
obtain|/әb'tein/vt. 获得, 达到;流行, 得到公认
hall|/hɒ:l/n. 门厅, 走廊, 会堂
user|/'ju:zә/n. 使用者; 用户
united|/ju:'naitid/a. 联合的, 团结的, 一致的, 和睦的; 联合的, 统一的, 一致的
appropriate|/ә'prәupriәt/a. 适当的; 适当的, 拨出, 占用
procedure|/prә'si:dʒә/n. 程序, 过程, 手续; 规程;过程
circumstance|/'sә:kәmstәns/n. 环境, 状况, 事件
client|/'klaiәnt/n. 客户, 顾客, 委托人; 客户, 客户机, 客户机程序
exactly|/i^'zæktli/adv. 确切地, 精确地, 恰好, 完全地, 确实, 恰恰正是, 确实如此
employment|/im'plɒimәnt/n. 雇用, 职业, 工作; 职业, 雇用, 职工招请
medium|/'mi:diәm/n. 媒体, 方法, 媒介;半生熟的, 中间的; 媒体, 中
pupil|/'pju:pl/n. 学生, 门生, 未成年人, 瞳孔; 瞳孔
library|/'laibrәri/n. 图书馆, 藏书, 库; 库
extent|/ik'stent/n. 范围, 程度, 区域; 范围
enable|/i'neibl/vt. 使能够; 允许, 使能, 打开
speaker|/'spi:kә/n. 说话人, 讲演者, 发言人, 喇叭, 扬声器; 扬声器
access|/'ækses/n. 通路, 入口, 接近, 进入, 使用权, 发作;访问, 存取, 接近, 使用; 访问, 存取
text|/tekst/n. 文本, 正文, 课文, 主题, 圣经文句, 乐谱; 电文;文本;正文
easily|/'i:zili/adv. 容易地, 轻易地, 流利地
reference|/'refәrәns/n. 参考, 索引, 参照;给...加上参考资料;引用;引用; 引用
context|/'kɒntekst/n. 上下文, 背景, 来龙去脉;上下文; 上下文
interesting|/'intristiŋ/a. 有趣的
communication|/kә.mju:ni'keiʃәn/n. 交流, 交通, 通讯; 通信
arise|/ә'raiz/vi. 站立, 出现, 起来
left|/left/a. 左边的, 左倾的, 左侧的, 左派的;在左面;左, 左面, 左派;leave的过去式和过去分词
define|/di'fain/vt. 定义, 规定, 使明确; 定义
software|/'sɒftwєә/n. 软件; 软设备
requirement|/ri'kwaiәmәnt/n. 需求, 必要条件, 要求; 要求;合同要求
arrangement|/ә'reindʒmәnt/n. 排列, 整齐, 安排; 排列
railway|/'reilwei/n. 铁路, 轨道; 铁路
concept|/'kɒnsept/n. 观念, 概念; 概念
forest|/'fɒrist/n. 森林, 林区;植树于
mum|/mʌm/n. 菊花, 沉默;沉默的;演哑剧;别说话
hill|/hil/n. 小山, 丘陵, 小土堆;作成土堆, 堆成小丘
expression|/ik'spreʃәn/n. 表达, 表现, 词语, 措辞; 表达式
primary|/'praimәri/n. 最主要者, 原色;主要的, 初期的, 根本的, 原始的, 首要的, 基本的; 初等量;主要的;一次的
branch|/bræntʃ/n. 树枝, 支店, 支流, 分部;分支, 出枝;分割, 用枝状叶脉刺绣花纹装饰; 分支, 目录分支
accident|/'æksidәnt/n. 意外事件, 机遇, 事故, 次要方面; 意外事故;事故
stare|/stєә/vi. 注视, 凝视, 瞪视, 显眼;盯;凝视
normally|/'nɒ:mәli/adv. 正规地, 合规则, 正常地
associate|/ә'sәuʃieit/n. 同伴, 伙伴, 关联的事物;使联合, 使发生联系;交往; 关联
meaning|/'mi:niŋ/n. 意义, 含义, 目的, 意图;意味深长的
employ|/im'plɒi/n. 雇用;雇用, 使用, 使从事于
consequence|/'kɒnsikwәns/n. 结果, 重要性; 结果, 后果, 推断
relevant|/'relivәnt/a. 有关联的, 有关系的, 适当的, 相应的; 有关的, 相关的
beginning|/bi'giniŋ/n. 开始
proportion|/prә'pɒ:ʃәn/n. 比例, 比率, 均衡, 部分, 面积;使成比例, 使均衡
latter|/'lætә/a. 后者的, 较后的, 近来的
practical|/'præktikl/a. 实际的, 现实的, 实用性的; 事实上的, 实际上的, 接近...的
understanding|/.ʌndә'stændiŋ/n. 理解, 谅解; 协商, 协议, 谅解
path|/pɑ:θ/n. 路径, 小路, 道路, 途径, 路线, 轨道; 路径;DOS内部命令:设定DOS读取程序的路径
appoint|/ә'pɒint/vt. 任命, 指定, 下令; 派, 派任, 任命
merely|/'miәli/adv. 只
conclusion|/kәn'klu:ʒәn/n. 结论, 结尾, 推论; 缔结, 结论, 推论
observe|/әb'zә:v/vt. 觉察到, 遵守, 注意到, 庆祝;注意, 评论
belief|/bi'li:f/n. 信念, 相信, 信仰
winter|/'wintә/n. 冬季, 萧条期, 衰退期;冬天的;使度过冬天;过冬
ring|/riŋ/n. 环, 环形物, 拳击场, 戒指, 角逐, 小集团, 铃声, 钟声, 声调;包围, 套住, 按铃, 敲钟;成环形, 响, 鸣, 按铃, 敲钟, 回响
dad|/dæd/n. 爸爸, 爹爹
employer|/im'plɒiә/n. 雇主, 老板; 雇主, 业主
objective|/әb'dʒektiv/n. 目的, 目标, 宗旨, 宾格, 实物;客观的, 如实的, 无偏见的, 宾格的
nevertheless|/.nevәðә'les/adv. 然而, 虽然如此;然而
concentrate|/'kɒnsәntreit/n. 浓缩, 精选;集中, 专心
sample|/'sæmpl/n. 样品, 范例, 样本;抽样, 尝试; 示例, 字样
visitor|/'vizitә/n. 参观者, 游客, 访客; 视察人, 检视人, 检查员
somewhere|/'sʌmhwєә/adv. 到某处, 在某处
manner|/'mænә/n. 样子, 礼貌, 风格; 方式, 方法, 样式
entirely|/in'taiәli/adv. 完全, 全然, 一概
background|/'bækgraund/n. 背景, 背景资料; 背景, 后台
previously|/'pri:vju:sli/adv. 先, 先前, 以前, 前, (非正式)过早, 过急, 在前, 在...以前, 在先; 先前地
ordinary|/'ɒ:dinәri/a. 平常的, 普通的, 平凡的;平常的人(或事)
demonstrate|/'demәnstreit/vt. 示范, 证明;示威
technical|/'teknikl/a. 技术上的, 专门的, 工业的, 严格根据法律的; 技巧
actual|/'æktʃuәl/a. 真实的, 实际的, 现行的; 实际死亡率
bus|/bʌs/n. 公共汽车; 总线;汇流条;母线
regulation|/.regju'leiʃәn/n. 规则, 管理, 调整; 调整;规章;规则;调节
coffee|/'kɒfi/n. 咖啡, 咖啡色; 咖啡, 咖啡豆
wage|/weidʒ/n. 工资, 报应, 报偿;开展, 进行;进行
acquire|/ә'kwaiә/vt. 获得, 学到; 目标锁定
fairly|/'fєәli/adv. 美观地, 公平地, 相当地, 清楚地
meal|/mi:l/n. 一餐, 膳食, 粗粉;进餐
tradition|/trә'diʃәn/n. 传说, 传统, 交付; 传统, 惯例, 移交
internal|/in'tә:nәl/a. 内在的, 国内的; 内的, 内部的
category|/'kætigәri/n. 种类, 类项; 分类
traffic|/'træfik/n. 交通, 通行, 运输, 交通量, 贸易, 交易, 交往, 通信量;交易, 做买卖;用...作交换; 通信量, 传输量
exhibition|/.eksi'biʃәn/n. 表现, 展览会, 展览品; 投药, 展览, 展出
sheet|/ʃi:t/n. 床单, 张, 纸张, 印刷品, 裹尸布, 薄片;盖上被单, 遍布;大片落下;片状的, 成薄片的; 工作表
improvement|/im'pru:vmәnt/n. 进步, 改善, 利用; 改善, 好转, 进步
description|/di'skripʃәn/n. 描述, 说明, 种类; 说明书(物品), 品名种类, 货物名称
construction|/kәn'strʌkʃәn/n. 建筑, 构造, 建筑物; 施工
discipline|/'disiplin/n. 训练, 纪律;训练, 惩罚
contrast|/kәn'træst/n. 差别, 对比, 对照物;使对比;成对照; 反差;对比度
lip|/lip/n. 唇, 口缘, 唇状构造;以嘴唇碰, 轻轻说出;口头上的; 大型互连网信息包
gentleman|/'dʒentlmәn/n. 绅士, 先生
distribution|/.distrә'bju:ʃәn/n. 分配; 分布
retain|/ri'tein/vt. 保持, 保有, 留住, 记得, 付定金聘请; 保留, 留存
conversation|/.kɒnvә'seiʃәn/n. 会话, 说话, 交谈; 交谈, 社交, 性交
code|/kәud/n. 代码, 密码, 法规, 法典;把...编码; 代码
cultural|/'kʌltʃәrәl/a. 文化的, 教养的, 修养的; 培养的
unable|/ʌn'eibl/a. 不能的, 不会的; 无能力的, 无资格的, 没有办法的
belong|/bi'lɒŋ/vi. 属于, 合适
limited|/'limitid/a. 有限制的, 有限的, 有限责任的;特别快车
contribute|/kәn'tribju:t/vt. 有助于, 捐助, 投稿;出力, 捐献, 投稿
hide|/haid/n. 兽皮, 迹象, 躲藏处;藏, 隐瞒, 遮避, 剥...的皮, 隐藏;躲藏; 隐藏
pension|/'penʃәn/n. 养老金, 退休金, 津贴, 年金, 抚恤金, 膳宿学校, 膳宿费;发给退休金, 用津贴拉拢
explanation|/.eksplә'neiʃәn/n. 解释, 说明, 辩解, 表明; 解释, 注释, 说明
plate|/pleit/n. 碟, 盘子, 盆中物, 金属板, 图版, 金银餐具, 印版, 金属牌(照);镀金, 电镀, 用金属板固定, 给...装钢板, 为...制印版
lovely|/'lʌvli/a. 可爱的, 有趣的
capacity|/kә'pæsiti/n. 容量, 能力, 才能, 资格; 容量
vary|/'vєәri/vt. 改变, 使多样化;变化, 有不同, 违反
selection|/si'lekʃәn/n. 选择, 选文, 精选品; 选择, 淘汰
surely|/'ʃuәli/adv. 的确地, 安全地; 保证, 保证人, 保证金
rural|/'ruәrәl/a. 乡下的, 田园的, 乡村风味的; 农村的, 乡村的, 有关农业的
intention|/in'tenʃәn/n. 意图, 目的, 含义; 愈合, 意向
whereas|/hwєәr'æz/conj. 然而, 鉴于; 考虑到, 鉴于, 就...而论
initial|/i'niʃәl/n. 字首, 首字母;开始的, 最初的, 字首的;用姓名的首字母签名
examination|/ig.zæmi'neiʃәn/n. 考试, 测验, 审查; 检查, 诊察
definition|/.defi'niʃәn/n. 定义, 精确度, 清晰度; 清晰度;清晰度
onto|/'ɒntu:/prep. 在...之上
substantial|/sәb'stænʃәl/n. 重要材料(或事物), 有实际价值的东西;实质上的, 物质的, 有内容的, 结实的
output|/'autput/n. 输出, 产品, 产量; 输出
suitable|/'sju:tәbl/a. 适当的, 相配的; 合适的, 适宜的, 适当的
stick|/stik/n. 棍, 棒, 刺, 枯枝, 茎, 条状物;插进, 刺入, 钉住, 伸出, 粘贴, 停止;粘住, 停留, 坚持, 陷住, 伸出
reasonable|/'ri:znәbl/a. 合理的, 明理的, 适当的; 合理的, 公道的, 正当的
offence|/ә'fens/n. 犯罪, 冒犯, 违反, 罪过, 过错, 攻击; 犯法, 罪过, 过错
reduction|/ri'dʌkʃәn/n. 减少, 缩影, 变化; 还原
detailed|/'di:teild/a. 详细的, 复杂的; 详细的, 详尽的
appointment|/ә'pɒintmәnt/n. 约会, 委任的职位, 委派; 任命, 派, 指定
afraid|/ә'freid/a. 害怕的, 恐怕的, 遗憾的
concentration|/.kɒnsәn'treiʃәn/n. 集中, 专心; 浓度;浓缩
neck|/nek/n. 脖子, 衣领, 颈;拥抱, 拥吻, 收缩;割颈
bedroom|/'bedrum/n. 卧室
combine|/kәm'bain/v. (使)联合, (使)结合;(企业的)联合, 联合收割机
sufficient|/sә'fiʃәnt/a. 充分的, 足够的; 充分的, 足够的
absence|/'æbsәns/n. 缺席, 缺乏, 没有; 失神
teaching|/'ti:tʃiŋ/n. 教学, 学说, 教导
birth|/bә:θ/n. 出生, 起源; 生产, 分娩
shout|/ʃaut/n. 呼喊, 喊声;呼喊, 喊叫, 嚷;高喊
error|/'erә/n. 错误, 过失, 失误, 误差; 错误
acid|/'æsid/n. 酸, 酸类物质, 尖刻, 迷幻药;酸的, 酸性的, 尖刻的, 敏锐的; 自动文档互参与索引生成程序
ear|/iә/n. 耳朵, 倾听, 听觉, 穗;抽穗
scientific|/.saiәn'tifik/a. 科学的, 系统的, 符合科学规律的; 科学记数法
whilst|/wailst/conj. 当...的时候, 和...同时, 虽然, 只要, 然而, 而, 尽管
pleasure|/'pleʒә/n. 快乐, 愉快, 令人高兴的事, 娱乐, 希望;(使)高兴
select|/si'lekt/a. 挑选出来的, 极好的;选择, 挑选;被挑选者, 精萃; 选定
mental|/'mentl/a. 心智的, 精神病的, 心理的, 颏的;精神病患者
temperature|/'temprәtʃә/n. 温度, 发烧, 热度; 温度
beside|/bi'said/prep. 在旁边
implication|/.impli'keiʃәn/n. 牵连, 含义, 暗示; 推断, 含蓄之意, 暗示
recognition|/.rekәg'niʃәn/n. 赞誉, 认得, 识别, 承认, 认可, 认识; 认识
seriously|/'siәriәsli/adv. 严肃地, 认真地, 严重地
familiar|/fә'miljә/a. 熟悉的, 常见的, 亲密的;熟友, 常客
partly|/'pɑ:tli/adv. 部分地, 在一定程度上
elsewhere|/'elshwєә/adv. 在别处
necessarily|/'nesisәrili/adv. 必然地, 必须地, 必要地
household|/'haushәuld/n. 一家人, 家庭, 家族, 王室;家庭的, 家常的, 王室的
climb|/klaim/v. 攀登, 上升, 爬;攀登, 爬升
nurse|/nә:s/n. 护士, 保姆, 奶妈;看护, 照顾, 培养;喂奶, 看护病人
experiment|/ik'sperimәnt/n. 实验, 试验, 实验仪器;实验, 尝试
silence|/'sailәns/n. 沉默, 无声, 静寂, 湮没, 无声息;使缄默;安静
publication|/.pʌbli'keiʃәn/n. 出版物, 出版, 公布; 发布
journey|/'dʒә:ni/n. 旅程, 旅行, 行程;旅行;游历
disappear|/.disә'piә/vi. 消失, 不见
tiny|/'taini/a. 很少的, 微小的
noise|/nɒiz/n. 噪音, 杂音, 响声, 喧闹;谣传;喧闹; 噪声
metal|/'metәl/n. 金属, 金属制品, 合金, 本质, 质料;金属制的;以金属覆盖
connection|/kә'nekʃәn/n. 连接, 关系, 前后关系; 连接
thin|/θin/a. 薄的, 细的, 瘦的, 稀疏的, 稀薄的, 淡的, 弱的, 空洞的;使变薄, 使变细, 使稀少, 使淡;变薄, 变细, 变少, 变淡;薄地, 稀疏地, 微弱地;细小部分
sum|/sʌm/n. 总数, 总和, 金额, 概要, 顶点;总计, 概括;合计; 系统实用程序和维护
sky|/skai/n. 天空, 天色, 天堂;击向空中, 挂在高处;高涨
imply|/im'plai/vt. 暗示, 意味; 隐含
illustrate|/'ilәstreit/vt. 举例说明, 作图解, 阐明;举例说明
pool|/pu:l/n. 池, 水塘, 石油层, 联营;合伙经营, 共享, 采掘, 汇聚成;汇合成塘, 淤积, 联营
map|/mæp/n. 地图, 天体图, 映像;映射, 绘制...地图, 计划; 实用程序, 映射, 制造自动化协议
phase|/feiz/n. 时期, 局面, 方面, 位相, 相, 阶段;使调整相位, 使定相, 使一致, 逐步执行, 实行; 阶段
conclude|/kәn'klu:d/vt. 结束, 作结论, 推断;结束, 推断
initiative|/i'niʃiәtiv/n. 主动行动, 首创精神, 主动权;自发的, 起始的
historical|/hi'stɒrikәl/a. 历史的, 史实的, 历史上的; 历史性的
remind|/ri'maind/vt. 提醒, 使想起
reading|/'ri:diŋ/n. 阅读, 知识, 读物;阅读的
theme|/θi:m/n. 主题, 话题, 题目
location|/lәu'keiʃәn/n. 位置, 场所, 特定区域; 位置
gate|/geit/n. 门, 牌楼, 大门, 通道, 闸;装门于; 门;栅
instrument|/'instrumәnt/n. 工具, 手段, 仪器; 仪器
cat|/kæt/n. 猫, 恶妇;呕吐;计算机辅助教育, 计算机辅助测试, 计算机辅助翻译, 计算机辅助排版; 计算机辅助教学, 计算机辅助翻译, 计算机辅助排字, 计算机辅助测试
generate|/'dʒenәreit/vt. 产生, 发生, 导致; 产生
emphasis|/'emfәsis/n. 强调, 加强, 重点, 强语气
afford|/ә'fɒ:d/vt. 买得起, 足以, 给予
inform|/in'fɒ:m/vt. 通知, 使了解, 使充满;提供资料, 告发
advise|/әd'vaiz/vt. 劝告, 给...出主意, 通知, 建议;提意见, 商量
priority|/prai'ɒriti/n. 优先权, 优先; 优先级
opening|/'әupәniŋ/n. 开始, 口子, 穴, 揭幕;开始的
combination|/.kɒmbi'neiʃәn/n. 组合, 合并, 联合; 组合图
empty|/'empti/a. 空的, 空虚的, 空腹的, 空洞的;空的东西, 空车;倒空, 使变空, 使排出;流空; 空
faith|/feiθ/n. 信心, 信任, 忠实, 保证; 信任, 信仰, 信念
tool|/tu:l/n. 工具, 机床, 傀儡;用工具加工;使用工具
married|/'mærid/a. 已婚的, 婚姻的; 结了婚的, 有配偶的, 夫妇的
upper|/'ʌpә/a. 上面的, 较高的, 上级的, 上院的, 穿在外面的, 北部的, 地表的, 后期的;鞋帮, 上齿
tooth|/tu:θ/n. 牙齿, 齿状物, 爱好;装以齿, 将...切成齿状;啮合
hell|/hel/n. 地狱, 邪恶势力, 苦境, 阴间, 毁坏, 训斥;狂饮, 飞驰
urban|/'ә:bәn/a. 都市的, 住在都市的, 习惯于都市的; 城市的, 都市的, 市区的
busy|/'bizi/a. 忙碌的, 热闹的, 没空的;使忙;忙碌; 忙;忙碌
tall|/tɒ:l/a. 高的, 长的, 夸大的;夸大地
lane|/lein/n. 小路, 巷, 弄, 单行道
crown|/kraun/n. 王冠, 王权, 顶点;使成王, 加冕, 居...之顶
coal|/kәul/n. 煤, 木炭;加煤
castle|/'kæsl. 'kɑ:sl/n. 城堡, 象棋中的车;置于城堡中, 盘踞于
literature|/'litәrәtʃә/n. 文学, 文艺, 著作; 广告, 商品介绍等文学
motion|/'mәuʃәn/n. 移动, 手势, 动作, 意向, 请求, 提议;打手势
breath|/breθ/n. 呼吸, 气息, 瞬间; 呼气, 呵气, 口气, 呼吸
apparent|/ә'pærәnt/a. 清晰可见的, 显然的, 表面上的; 外在的
membership|/'membәʃip/n. 会员的资格, 全体会员, 会员数目; 会员资格, 成员资格, 会籍
suggestion|/sә'dʒestʃәn/n. 提议, 意见; 暗示
persuade|/pә'sweid/vt. 劝, 使相信, 恳求, 敦促, 说服;劝服, 被说服
cope|/kәup/vi. 竞争, 应付;长袍
attractive|/ә'træktiv/a. 吸引人的, 有魅力的; 有吸引力的, 有迷惑力的
passage|/'pæsidʒ/n. 通道, 通过, 移居, 航行, 一段, 走廊;通过, 经过, 航行, 横渡, 争吵;(使)马以斜横步前进, 使传代
pocket|/'pɒkit/n. 口袋, 钱袋, 钱, 容器;装...在口袋里, 隐藏, 抑制, 私吞, 搁置, 击...入袋;袖珍的, 小型的, 压缩的, 金钱上的
moral|/'mɒrәl/n. 道德, 品行, 寓意;道德的, 品性端正的, 精神上的
shut|/ʃʌʃ/n. 关闭;关上, 闭起, 幽禁, 合拢, 轧住;关上, 停止营业
index|/'indeks/n. 索引, 指针, 指数, 指标;编入索引中, 指出;做索引; 下标;附标;变址;索引;编索引
valley|/'væli/n. 山谷, 溪谷, 流域, 凹地; 谷
vital|/'vaitl/a. 生命的, 重要的, 充满活力的, 生死攸关的, 致命的; 生命的, 生活的, 生活上必需的, 紧要的
recover|/ri'kʌvә/vt. 重新获得, 恢复, 复原, 拯救;痊愈, 复原, 胜诉; 恢复
thick|/θik/a. 厚的, 粗壮的, 浓的, 迟钝的, 浑浊的, 多雾的, 过分的, 口齿不清的;厚地, 密地, 浓浓地;最浓处, 最厚处, 最密集处; 暗, 粗线
specialist|/'speiʃәlist/n. 专门医师, 专家;专业的, 专家的
characteristic|/.kærәktә'ristik/n. 特性, 特征, 特色;特性的, 特有的, 有特色的; 阶;指数
lake|/leik/n. 湖, 池, 色淀;(使)血球溶解
tone|/tәun/n. 音调, 音质, 语调, 语气, 色调, 气氛, 状况, 思想状态;给...定色调, 增强, 使...的声调和谐, 定音调;颜色调和; 双音频
engineering|/.endʒi'niәriŋ/n. 工程学, 工程, 操纵; 机器;机器学
pub|/pʌb/n. 酒馆, 客栈
religion|/ri'lidʒәn/n. 宗教, 信仰; 宗教, 宗教信仰, 信仰
blow|/blәu/n. 吹, 打击, 殴打, 花开;吹, 风吹, 吹响, 开花
leaf|/li:f/n. 叶, 树叶, 花瓣, 页;生叶, 翻书页;在...上长叶, 翻...的页
foundation|/faun'deiʃәn/n. 基础, 根据, 建立; 地基
device|/di'vais/n. 装置, 设计, 策略, 发明物, 设备; 设备;DOS内部命令:该命令要求DOS安装一个设备驱动程序
rare|/rєә/a. 稀罕的, 罕有的, 珍奇的, 稀薄的, 半熟的, 非常好的;非常
chain|/tʃein/n. 链, 枷锁, 束缚;用铁练锁住, 束缚, 囚禁
elderly|/'eldәli/a. 过了中年的, 稍老的
hate|/heit/n. 憎恨, 恨, 厌恶;憎恨, 憎恶;仇恨
ancient|/'einʃәnt/a. 古代的, 古老的, 年老的, 旧的
impression|/im'preʃәn/n. 印象, 意念, 盖印, 印记, 印数, 底色, 效果; 压迹, 印模, 印象, 影响
neighbour|/'neibә/n. 邻居, 邻接的东西, 邻国, 邻座, 邻人, 世人;邻接的, 邻近的;vt. 邻近, 与...结邻, 邻接
capable|/'keipәbl/a. 有能力的, 能的, 能干的
attach|/ә'tætʃ/vt. 附上, 使依附, 使附属, 使喜爱, 系, 缚;附属, 归属, 联系在一起; 挂接服务器命令, 关联, 挂接, 附加
typical|/'tipikl/a. 典型的, 象征性的; 典型的
wash|/wɒʃ/n. 洗, 洗涤, 冲洗, 洗的衣服, 冲积物, 洼地;洗, 洗涤, 洗清, 用水冲洗, 流过, 弄湿, 粉刷, 镀金属薄层于;洗涤, 洗澡, 被冲蚀, 漂浮
atmosphere|/'ætmәsfiә/n. 大气, 空气, 气氛; 大气;大气压
revolution|/.revә'lu:ʃәn/n. 革命, 大变革, 旋转, 转数, 循环; 回转
panel|/'pænl/n. 嵌板, 仪表板, 专题讨论小组, 全体陪审员;嵌镶板
enemy|/'enimi/n. 敌人, 仇敌, 敌军;敌人的
tear|/tiә. tєә/n. 泪滴, 眼泪, 撕, 扯, 裂缝, 激怒, 飞奔;流泪, 撕破, 赶快, 飞奔, 被撕破;撕裂, 戳破, 拉掉, 撕掉, 使分裂, 使精神不安, 折磨
lean|/li:n/n. 瘦肉, 倾斜, 倾斜度;瘦的, 贫乏的, 歉收的;倚靠, 倾斜, 依赖;使倾斜
iron|/'aiәn/n. 铁, 熨斗, 铁器, 坚强, 烙铁, 镣铐;烫平, 熨, 用铁包;烫平
servant|/'sә:vәnt/n. 仆人, 有用物, 公务员, 雇员; 受雇人, 服务者, 公务员
roof|/ru:f/n. 屋顶, 室顶;给...盖屋顶, 遮蔽
milk|/milk/n. 奶, 乳状物;挤乳, 榨取;产乳
explore|/ik'splɒ:/v. 探险, 探测, 探究
shoe|/ʃu:/n. 鞋, 靴, 外胎;给...穿鞋, 为马钉蹄铁
nose|/nәuz/n. 鼻子, 突出部分, 嗅觉;嗅到, 探出, 用鼻子触;闻, 嗅, 探听, 告密
engineer|/.endʒi'niә/n. 工程师, 工兵;设计, 监造, 精明地处理, 策划
beneath|/bi'ni:θ/prep. 在...下方;在...下方
steal|/sti:l/vt. 剽窃;偷偷地做;偷窃;vi. 窃取;偷偷地行动;偷垒;n. ;偷窃;便宜货;偷垒;断球
soil|/sɒil/n. 土壤, 土地, 国家, 国土, 温床, 污物, 粪便, 水池;弄脏, 污辱;变脏
tank|/tæŋk/n. 槽, 箱, 柜, 罐, 池塘, 储水池, 坦克;储于箱中
origin|/'ɒridʒin/n. 起源, 起因, 出身, 开端; 原点;起始地址;信件来源的相关数据
beach|/bi:tʃ/n. 海滩
accompany|/ә'kʌmpәni/vt. 陪伴, 伴随, 补充, 为...伴奏;伴奏, 伴唱
unfortunately|/ʌn'fɔ:tjjnәtli/adv. 恐怕, 不幸的是
warning|/'wɒ:niŋ/n. 警告, 预告, 预兆, 通知; 警告, 警戒, 预告;警告的, 注意的
minor|/'mainә/n. 未成年人, 副修科目;较小的, 二流的, 未成年的;副修; 次要
height|/hait/n. 高度, 海拔, 高地, 顶点; 高度
gift|/gift/n. 礼物, 赠予, 天才;赋予
pleased|/pli:zd/a. 高兴的, 喜欢的, 满足的
expense|/ik'spens/n. 费用, 代价, 开支, 损失; 费用, 开支, 将支出转为费用
vision|/'viʒәn/n. 视觉, 眼光, 视力, 幻想;梦见, 想象, 显示
stretch|/stretʃ/n. 伸展, 张开, 连绵, 一段路, 一段时间;可伸缩的, 弹性的;伸展, 张开, 曲解, 使过度伸展;伸展, 延伸; 伸展
bone|/bәun/n. 骨头, 骨, 骨制品;剔骨;专心致志
palace|/'pælis/n. 宫, 宫殿, 华丽大厦
vast|/vɑ:st/a. 巨大的, 广大的, 非常的, 大量的
academic|/.ækә'demik/a. 学院的, 学术的, 不切实际的;大学生, 大学教师, 学者, 学会会员
funny|/'fʌni/a. 好笑的, 有趣的, 滑稽的;滑稽人物
convention|/kәn'venʃәn/n. 大会, 协定, 惯例, 约定; 约定
trend|/trend/n. 趋势, 倾向, 走向;倾向, 转向; 趋势
living|/'liviŋ/n. 生活, 生计, 生存;活的, 逼真的, 现存的
afterwards|/'ɑ:ftәwәdz/adv. 然后, 后来
switch|/switʃ/n. 开关, 电闸, 转换, 软枝, 鞭子, 道岔;转变, 切换, 摆动, 转换, 使转轨;转换, 变换, 摆动; 开关;翻转;转移
lesson|/'lesn/n. 课, 课业, 教训
fix|/fiks/vt. 使固定, 修理, 准备, 安装, 凝视, 牢记, 确定, 整理;固定, 注视, 确定;困境, 方位, 维修, 贿赂
knock|/nɒk/n. 敲, 敲打, 敲门;敲击, 互撞, 攻击
justify|/'dʒʌstifai/vt. 替...辩护, 证明;证明合法; 段落重排, 两端对齐
signal|/'signl/n. 信号, 暗号, 近因, 导火线;向...作信号, 标志, 用信号通知;发信号;作为信号的, 显著的; 信号
rail|/reil/n. 横杆, 围栏, 栏杆, 铁轨, 扶手, 秧鸡;以横木围栏, 给...铺铁轨;责骂, 抱怨
somewhat|/'sʌmhwɒt/n. 某物, 几分;多少, 几分
comparison|/kәm'pærisn/n. 比较, 对照, 比喻; 比较, 对比
expectation|/.ekspek'teiʃәn/n. 期待, 指望, 展望; 期望值
pursue|/pә'sju:/vt. 追赶, 追踪, 追随, 追求, 实行, 继续, 从事;追赶, 继续
plenty|/'plenti/n. 充分, 很多, 丰富;很多的, 足够的, 丰富的
knee|/ni:/n. 膝, 膝盖;膝行, 用膝盖碰
gap|/gæp/n. 缝隙, 缺口, 间断, 间距, 通用汇编程序;打开缺口, 造成缝隙;豁开; 通用汇编程序, 图形应用程序, 间距
appreciate|/ә'pri:ʃieit/vt. 赏识, 鉴别, 为...而感激, 领会, 欣赏;增值, 涨价
root|/ru:t/n. 根, 根本, 根源, 基础, 底部;使扎根, 使固定, 根除, 肃清, 搜出, 用鼻拱;生根, 固定, 源于, 用鼻拱土, 寻找, 捧场, 支持
permanent|/'pә:mәnәnt/a. 永久的, 不变的, 固定的, 持久的;烫发; 永久的
ourselves|/.auә'selvz/pron. 我们自己
originally|/ә'ridʒәnli/adv. 本来, 原来, 最初, 就起源而论, 独创地
complaint|/kәm'pleint/n. 诉苦, 抱怨, 控诉; 陈诉;病
plastic|/'plæstik/n. 塑料, 可塑体, 可塑性物质;塑料的, 塑造的, 有可塑性的, 造型的, 易受影响的, 有创造力的
passenger|/'pæsindʒә/n. 乘客, 旅客; 乘客, 旅客
grass|/græs/n. 草, 草原, 牧场; 草, 禾本
via|/vaiә/prep. 经由, 经过, 通过; 病毒灭活剂
somehow|/'sʌmhau/adv. 不知何故
shadow|/'ʃædәu/n. 阴影, 荫, 影子, 影像, 阴暗, 幽灵, 少许, 隐蔽处, 庇护;遮蔽, 使朦胧, 预示, 尾随;渐变, 变阴暗; 阴影
column|/'kɒlәm/n. 专栏, 圆柱, 纵队, 列, 柱形物; 列, 柱形图
charity|/'tʃæriti/n. 慈悲, 博爱, 慈善团体, 施舍; 宽大, 宽恕, 慈善机关
crucial|/'kru:ʃәl/a. 决定性的, 重要的, 严厉的; 十字形的;决断的, 定局的
inner|/'inә/a. 内部的, 内心的;内部
negative|/'negәtiv/n. 否定, 否定语, 负数, 底片;否定的, 消极的, 负的, 阴性的;负数, 负值; 负数, 负值
manufacturer|/.mænju'fæktʃәrә/n. 制造业者, 厂商; 制造人, 制造商, 制造厂
breakfast|/'brekfәst/n. 早餐
permit|/pә'mit/n. 许可证, 许可, 执照, 通行证;允许, 容许, 可能, 使放手做;容许, 给以机会, 提供可能
fundamental|/.fʌndә'mentәl/n. 基本原理, 原则, 基波;基本的, 重要的, 原音的
virtually|/'vә:tʃuәli/adv. 事实上
perfectly|/'pә:fiktli/adv. 完全地, 无瑕疵地, 完整地
massive|/'mæsiv/a. 大而重的, 宽大的, 宏伟的; 大块的, 整块的, 大量的
engage|/in'geidʒ/vi. 答应, 从事, 交战;使忙碌, 雇佣, 预定, 使从事于, 使参加
sick|/sik/n. 病人;不舒服, 有病的, 恶心的, 厌恶的, 渴望的, 病态的;呕吐, 追击, 使(狗)去攻击
exception|/ik'sepʃәn/n. 例外, 除外, 异议; 例外;异常
beauty|/'bju:ti/n. 美, 美人
licence|/'laisns/n. 执照, 许可证, 特许;许可, 特许, 认可
abandon|/ә'bændәn/vt. 放弃, 抛弃, 遗弃, 使屈从, 沉溺, 放纵;放任, 无拘束, 狂热
construct|/kәn'strʌkt/vt. 构造, 建造, 对...进行构思, 作图;构成物
identity|/ai'dentiti/n. 身份, 相同, 一致, 特性, 恒等式; (打)标记, 标识
inquiry|/in'kwaiәri/n. 质询, 探索, 调查, 询盘; 询问;查询
contemporary|/kәn'tempәrәri/n. 同时代的人;同时代的, 属于同一时期的
fault|/fɒ:lt/n. 过错, 故障, 毛病;挑剔;产生断层, 弄错; 故障
badly|/'bædli/adv. 严重地, 恶劣地, 极度地
alive|/ә'laiv/a. 活着的, 活泼的, 敏感的, 热闹的
phrase|/freiz/n. 惯用语, 词组, 成语, 措词, 乐句;用短语表达, 把(乐曲)分成短句; 短语
quantity|/'kwɒntәti/n. 量, 数量, 总量; 数量;量
angry|/'æŋgri/a. 生气的, 愤怒的
pilot|/'pailәt/n. 飞行员, 领航员, 航船者, 导向器, 驾驶仪, 向导, 领导人;领航, 驾驶, 引导, 试用;引导的, 控制的, 试点的; 引导
mirror|/'mirә/n. 镜子, 写真, 典范;反映, 映出
unknown|/.ʌn'nәun/a. 不知道的, 未知的, 陌生的;未知物, 未知数
naturally|/'nætʃәrәli/adv. 自然地, 以自然力, 天生地
proceed|/prәu'si:d/vi. 继续进行, 进行, 开始, 发出, 起诉; 所得, 收入, 收益
unique|/ju:'ni:k/a. 独一无二的, 独特的, 稀罕的
preparation|/.prepә'reiʃәn/n. 准备, 预备, 预习; 制剂
tension|/'tenʃәn/n. 紧张, 不安, 拉紧, 张力, 压力, 电压;拉紧, 使紧张
assistance|/ә'sistәns/n. 协助, 援助; 援助, 帮助
metre|/'mi:tә/n. 公尺, 格律, 韵律; 米, 公尺
acknowledge|/әk'nɒlidʒ/vt. 承认, 告知收悉, 答谢, 报偿; 承认, 答谢, 收到的通知
moreover|/mɒ:'әuvә/adv. 而且, 此外
enormous|/i'nɒ:mәs/a. 巨大的, 庞大的
alter|/'ɒ:ltә/v. 改变
rarely|/'rєәli/adv. 很少地, 罕有地
expand|/ik'spænd/vt. 使膨胀, 详述, 扩张;张开, 发展;展开;展开; 展开;DOS外部命令:将原始DOS磁盘上的压缩文件解压缩并拷贝到硬盘上
guilty|/'gilti/a. 犯罪的, 有过失的, 自觉有错的, 心虚的; 有罪的, 犯罪的, 自觉有罪的
tower|/'tauә/n. 塔, 高楼, 堡垒;高耸, 翱翔
bother|/'bɒðә/vt. 烦扰, 迷惑;烦恼, 操心;麻烦, 纠纷, 讨厌的人
yours|/juәz/pron. 你的(东西), 你们的(东西)
lucky|/'lʌki/a. 幸运的, 吉祥的, 好运的, 侥幸的
coat|/kәut/n. 外套;外面覆盖, 给...穿外套
involvement|/in'vɔlvmәnt/n. 卷入, 牵连, 包含, 困窘; 财政困难, 经济上的困窘
partnership|/'pɑ:tnәʃip/n. 合伙, 合股, 合作关系; 合伙(合作)关系, 全体合伙人
pollution|/pә'lu:ʃәn/n. 污染, 玷污; 污染
unusual|/.ʌn'ju:ʒu:l/a. 不寻常的, 罕见的, 与众不同的
anywhere|/'enihwєә/adv. 无论何处
inch|/intʃ/n. 英寸, 身高, 小岛;慢慢前进, 慢慢移动;使缓慢地移动
depth|/depθ/n. 深度, 深处, 深奥; 深度
frame|/freim/n. 框, 结构, 体格;构成, 设计, 制定, 使适合, 陷害; 框架, 图文框, 帧
assist|/ә'sist/n. 帮助, 协助;帮助, 促进;协助, 参加
port|/pɒ:t/n. 港口, 埠, 舱门, 避风港, 左舷, 炮眼, 姿势, 意义;左转舵, 持(枪);左转舵; 端口, 移植
command|/kә'mɑ:nd/n. 命令, 指挥, 控制, 部队, 司令部;命令, 指挥, 控制; 命令;指令;DOS外部命令:启动新的命令处理器
dear|/'diә/n. 亲爱的人;亲爱的, 昂贵的, 严重的, 急迫的;啊;深爱地, 高价地
delivery|/di'livәri/n. 递送, 交付, 分娩, 交货, 引渡; 交货额
string|/striŋ/n. 线, 细绳, 一串, 字符串;串起, 成串, 收紧, 缚, 扎;成一串; 字符串, 串
yellow|/'jelәu/n. 黄色;黄色的
resolve|/ri'zɒlv/vi. 决定, 分解, 决心;使分解, 解析, 解决, 消除, 决心;决定之事, 决心, 坚决
wheel|/hwi:l/n. 轮子, 车轮, 轮, 方向盘, 旋转, 机构, 重要人物;使旋转, 转动, 使转向;旋转, 转弯, 盘旋
boot|/bu:t/n. 长靴, 踢, 解雇, 效用;使穿靴, 踢, 解雇, 有用; 引导, 自举
wake|/weik/vt. 叫醒, 激发;醒来, 醒着, 觉醒, 活跃起来;守侯, 守夜, 尾迹, 痕迹
poem|/'pәuim/n. 诗, 诗般美的事物
extensive|/ik'stensiv/a. 广的, 广泛的, 多方面的; 广大的, 扩大的
glad|/glæd/a. 高兴的, 喜欢的, 情愿的
remaining|剩余的
net|/net/n. 网, 网状物, 罗网, 净利, 净价;净的, 最终的;用网捕, 撒网, 净赚, 得到;编网; 网络, 网络分析程序
unlike|/.ʌn'laik/a. 不像的, 不同的;不像, 和...不同
comfortable|/'kʌmfәtәbl/a. 舒服的, 轻松的;盖被
efficient|/i'fiʃәnt/a. 有效率的, 能干的
healthy|/'helθi/a. 健康的, 有益健康的, 卫生的; 健康的
cycle|/'saikl/n. 周期, 循环, 自行车, 一段时间, 整套;循环, 轮转, 骑自行车;使循环, 使轮转; 环路;周期;循环
reckon|/'rekәn/vt. 计算, 总计, 估计, 认为, 猜想;数, 计算, 估计, 依赖, 料想
hat|/hæt/n. 帽子;给...戴帽子
tired|/taiәd/a. 疲累的, 疲乏的, 厌倦的
profession|/prә'feʃәn/n. 职业, 表白, 声明; 工种;职业
load|/lәud/n. 负荷, 担子, 重担, 装载量, 负载, 工作量, 加载;装载, 装填, 使担负;装货, 上客, 装料; 加载, 装入程序
chest|/tʃest/n. 胸, 胸部, 衣柜, 箱子; 胸, 胸廓
restore|/ri'stɒ:/vt. 回复, 恢复, 归还, 修补, 修复;还原;还原; 还原;DOS外部命令:从备份盘中取回文件
approval|/ә'pru:vl/n. 赞成, 批准; 核准
cottage|/'kɒtidʒ/n. 小屋, 茅舍
mostly|/'mәustli/adv. 大概, 大部分, 主要; 大部份
reputation|/.repju'teiʃәn/n. 名誉, 名声, 声望; 名声, 名誉, 公认证据
valuable|/'væljuәbl/a. 有价值的, 贵重的, 宝贵的, 可估价的; 有价值的, 可估价的, 贵重的
slight|/slait/n. 轻蔑, 怠慢;轻微的, 纤细的, 脆弱的, 苗条的;轻视, 忽略, 怠慢
habit|/'hæbit/n. 习惯, 嗜好, 习性;使穿衣
friendly|/'frendli/a. 友好的, 亲切的, 互助的;友善地, 温和地
abroad|/ә'brɒ:d/adv. 往国外, 到室外, 到处;往国外的, 在室外的, 广泛四散的
silver|/'silvә/n. 银, 银币, 银器;银的, 银制的, 银器的;镀银;变银白色
convert|/kәn'vә:t/n. 皈依者, 改变宗教信仰者;使改变信仰, 转换, 兑换, 倒置;皈依; 转换
layer|/'leiә/n. 层, 产卵鸡, 放置者;分层堆积, 压植; 层
countryside|/'kʌntrisaid/n. 乡下地方, 乡下居民
sudden|/'sʌdn/n. 突然, 忽然;突然的, 意外的, 快速的
empire|/'empaiә/n. 帝国, 帝权
autumn|/'ɒ:tәm/n. 秋天, 成熟期
conventional|/kәn'venʃәnl/a. 传统的, 习惯的, 约定的; 惯例的, 常规的, 传统的
relative|/'relәtiv/n. 亲戚, 关系词;有关系的, 相对的, 比较的
landscape|/'lændskeip/n. 风景, 山水, 风景画;从事景观美化;美化...景观; 横向
shortly|/'ʃɒ:tli/adv. 不久, 简短, 唐突地
solve|/sɒlv/vt. 解决, 付给, 溶解;求解;求解; 求解
keen|/ki:n/a. 锋利的, 敏锐的, 强烈的, 敏捷的, 热心的, 渴望的;挽歌, 痛哭;唱挽歌, 痛哭
arrival|/ә'raivl/n. 到达, 抵达, 到达者; 到达, 到达物
steel|/sti:l/n. 钢, 钢制品, 钢铁, 坚硬, 坚固;钢的, 钢制的, 钢铁业的, 坚强的;使坚强, 钢化, 使冷酷
meat|/mi:t/n. 肉, 餐, 食物; 肉类
worried|/'wʌrid/a. 担心的, 闷闷不乐的
specifically|/spi'sifikli/adv. 特定地, 明确地, 按特性
self|/self/n. 自己, 自我, 本性, 本质, 私心, 本人;使近亲繁殖, 使自花授精;自花授精;同一的
preserve|/pri'zә:v/vt. 保护, 保持, 保存, 维持, 腌, 禁猎;加工食品, 禁猎;加工成的食品, 禁猎地, 保护区, 防护物
predict|/pri'dikt/v. 预知, 预言, 预报
initially|/i'niʃәli/adv. 最初, 开头
illness|/'ilnis/n. 疾病, 恶意; 病
soul|/sәul/n. 灵魂, 心灵, 精神, 精髓, 人, 化身, 典型, 鬼魂;黑人的
bread|/bred/n. 面包, 生计, 食物;裹以面包屑
sugar|/'ʃugә/n. 糖, 糖块, 甜言蜜语;加糖于, 使甜蜜, 粉饰, 美化;制成糖
electricity|/.ilek'trisiti/n. 电, 电流, 电学, 热情, 电力供应; 电学;电
silent|/'sailәnt/a. 沉默的, 安静的, 无声的, 静止的; 静止的, 无症状的
beer|/biә/n. 啤酒; 啤酒
uncle|/ʌŋkl/n. 叔父, 伯父, 姨丈
temporary|/'tempәrәri/a. 暂时的, 临时的;临时工, 临时雇员; 临时
drama|/'drɑ:mә/n. 戏剧, 戏剧艺术
cake|/keik/n. 蛋糕, 块, 饼;使结块, 加块状物于;结块
wealth|/welθ/n. 财富, 资源, 财产, 丰富, 富裕, 大量; 财富
resistance|/ri'zistәns/n. 抵抗力, 反抗, 耐力, 阻力, 电阻; 抵抗;抗性;阻力;抗药性;电阻
peak|/pi:k/n. 山峰, 巅, 山顶, 顶点, 尖峰, 帽舌;最高的, 最大值的;到达最高点, 消瘦, 变憔悴, 逐渐缩小;使竖起, 使达到最高点
muscle|/'mʌsl/n. 肌肉, 臂力; 肌
pale|/peil/n. 栅栏, 界线, 范围;苍白的, 暗淡的, 无力的;变苍白, 变暗, 失色;使变苍白, 使失色, 用栅栏围
laboratory|/'læbrәtәri/n. 实验室, 研究室, 化工厂; 实验室, 检验室, 化验室
hello|/hә'lәu/interj. 喂, 嘿
shift|/ʃift/n. 变化, 移动, 轮班, 手段, 应急办法, 移位;替换, 转移, 改变, 推卸, 变速;转换, 移动, 转变, 推托, 变速; DOS内部命令:该命令可将批处理参数向左移动一个位置
owe|/әu/vt. 亏欠, 负...债, 归功于, 怀有, 应给予, 感恩;欠钱
mood|/mu:d/n. 心情, 气氛, 生气, 基调; 心境
personality|/.pә:sә'næliti/n. 个性, 人格, (团体、地方、国家)特有特性, 名人; 人格;个性
invest|/in'vest/vt. 投资, 花费, 笼罩, 授予;投资, 利用
bay|/bei/n. 海湾, 狗吠声, 月桂;吠, 使走投无路;吠
pour|/pɒ:/n. 流出, 倾泻, 骤雨;倒, 灌, 注, 倾泻, 诉说, 倾吐;倾泻, 蜂涌而来, 下大雨
lock|/lɒk/n. 锁, 刹车, 水闸, 一缕头发;锁, 锁上, 拘禁, 隐藏, (用锁等)拴住, 刹住;锁住, (齿轮等)啮合, (船)过闸
cloud|/klaud/n. 云, 阴暗, 烟雾, 疑团;以云遮敝, 笼罩, 使黯然;乌云密布, 阴沉
zone|/zәun/n. 地带, 带, 地区;环绕, 使分成地带;分成区; 卡片顶部的三行区;区;区域
wet|/wet/n. 湿气, 潮湿, 水分, 雨天;湿的, 潮的, 搞错的, 下雨的, 反对禁酒的;变湿;使...湿
angle|/'æŋgl/n. 角, 角度, 角落;钓鱼, 谋取, 博取, 斜向移动, 转变角度;使转动角度, 在...钓鱼, 获取
philosophy|/fi'lɒsәfi/n. 哲学, 人生观, 哲学思想, 哲理, 基本原理, 见解, 达观, 沉着
competitive|/kәm'petitiv/a. 竞争的; 竞争的
false|/fɒ:ls/a. 错误的, 虚伪的, 假的, 不老实的;不准确地, 欺诈地
sensitive|/'sensitiv/a. 敏感的, 易感的, 灵敏的, 感光的; 敏感的, 灵敏的, 感度高的
retire|/ri'taiә/n. 隐居;引退, 退役, 退休, 退去, 撤退, 退却;使...撤退, 辞退
aside|/ә'said/n. 小声说的话, 旁白;在一边, 离开, 另外
tendency|/'tendәnsi/n. 趋向, 倾向; 趋向, 趋势
sweet|/swi:t/n. 甜蜜, 糖果, 情人;甜的, 芳香的, 悦耳的, 漂亮的, 和蔼的, 不咸的, 灵活的, 轻快的
fixed|/fikst/a. 固定的, 不变的; 固定的, 确定的, 不变的
CORE|/kɒ:/n. 核心, 果心, 要点;挖...的核; 内核, 核心网
chamber|/'tʃeimbә/n. 室, 房间, 枪膛;装(弹药), 把...关在室内;室内的
honour|/'ɒnә/n. 荣誉, 头衔, 信用, 尊敬, 名誉, 阁下, 勋章;尊敬, 授予荣誉, 承兑, 实践
deposit|/di'pɒzit/n. 存款, 定金, 堆积物;存放, 堆积;沉淀
rent|/rent/n. 租金, 房租, 出租物, 裂缝, 破裂处, 分裂;租用, 租出;出租;分裂的, 破裂的;rend的过去式和过去分词
pure|/pjuә/a. 纯的, 纯净的, 纯洁的, 清白的, 完美的, 无瑕的, 抽象的; 的, 纯净的
acceptable|/әk'septәbl/a. 可接受的, 合意的, 可忍受的
emotional|/i'mәuʃәnәl/a. 情绪的, 情感的; 情绪的
actor|/'æktә/n. 男演员, 行动者; 作用物, 反应物
wedding|/'wediŋ/n. 婚礼, 结婚, 结婚周年纪念日, 结合; 结婚, 婚礼, 结婚纪念日
cigarette|/.sigә'ret/n. 香烟, 纸烟
chip|/tʃip/n. 屑片, 薄片, 碎片;削, 切, 削成碎片, 使摔倒, 凿;削下屑片; 孔屑;组件;晶片;芯片
adequate|/'ædikwәt/a. 适当的, 足够的; 胜任的, 适当的, 充分的
essentially|/i'senʃәli/adv. 本质上, 本来
jacket|/'dʒækit/n. 夹克, 外套, 护套;给...穿夹克, 给...装护套
shirt|/ʃә:t/n. 衬衫, 内衣, 汗衫
kiss|/kis/n. 吻;吻;接吻
global|/'glәubl/a. 通用的, 全球的, 球形的, 综合的, 普遍的; 共用
resist|/ri'zist/v. 抵抗, 耐得住, 抵制, 反抗;防染材料
solid|/'sɒlid/n. 固体;坚硬的, 稳固的, 固体的, 实心的, 纯质的, 立体的, 立方的; 原色
apart|/ә'pɑ:t/adv. 成零碎, 成距离, 分别地, 分离着;分离的
absolute|/'æbsәlu:t/a. 绝对的, 专制的, 完全的, 独立的;绝对事物
routine|/ru:'ti:n/n. 常规, 日常工作, 惯例, 例行公事;日常的, 常规的; 例程
rough|/rʌf/n. 粗糙的东西, 毛坯, 未加工品, 梗概, 草图, 暴徒, 艰难;粗糙的, 粗暴的, 蓬乱的, 草率的, 大致的, 简陋的, 暴风雨的, 艰难的;使粗糙, 使不平, 使蓬乱, 粗制, 草拟, 粗暴对待, 对...动粗;变粗糙;粗糙地, 粗暴地
remarkable|/ri'mɑ:kәbl/a. 不平常的, 值得注意的, 显著的
precisely|/pri'saisli/adv. 精确地, 明确地, 刻板地, 拘泥地, 正好, 恰恰, 对, 正是如此, 确实如此, 不错
tourist|/'tuәrist/n. 观光客, 旅行者;旅游的
mixture|/'mikstʃә/n. 混合, 混淆, 混合物; 混合物
maximum|/'mæksimәn/n. 极点, 最大量, 极大;最高的, 最大的, 最大极限的; 最大值
furniture|/'fәnitʃә/n. 家具, 帆具
brilliant|/'briljәnt/a. 光辉的, 灿烂的, 有才气的; 亮的
register|/'redʒistә/n. 寄存器, 记录, 登记簿, 注册;记录, 注册, 提示, 表达, 把...挂号;登记, 注册, 挂号; 寄存器
monitor|/'mɒnitә/n. 监督器, 级长, 监听员, 班长, 监视器, 告诫物;监视, 监听, 监督; 监视器, 监视程序;监视
substance|/'sʌbstәns/n. 物质, 实质, 主旨, 资产, 本质, 牢固; 物质
breathe|/bri:ð/vi. 呼吸, 生存, 低语;呼吸, 使喘息, 发散, 低声说
retirement|/ri'taiәmәnt/n. 退休, 隐居, 撤退; 退休, 退股, (固定资产)报废
recording|/ri'kɒ:diŋ/a. 记录的, 记录用的;录音
pipe|/paip/n. 管, 导管, 输送管, 管状器官, 声带, 尖细的声音, 烟斗, 笛, 管乐器;以管输送, 吹哨子, 吹奏, 尖声唱;吹笛, 尖叫, 吹长哨发令; 管道
mere|/miә/n. 小湖, 池塘;仅仅的, 只不过的
celebrate|/'selibreit/v. 庆祝, 祝贺, 举行
intelligence|/in'telidʒәns/n. 智力, 情报, 信息; 智力
bend|/bend/vi. 变弯曲, 屈服;使弯曲, 使屈服;弯曲
apple|/'æpl/n. 苹果, 家伙; 苹果
throat|/θrәut/n. 咽喉, 喉咙, 嗓音;用喉音说, 开沟于
wooden|/'wudn/a. 木制的, 呆笨的, 木然的
discovery|/dis'kʌvәri/n. 发现, 被发现的事物; 要求告知, 发现, 发觉
emotion|/i'mәuʃәn/n. 情绪, 激动, 强烈的情感; 情绪, 情感
pace|/peis/n. 速度, 步调, 步法;踱步, 缓慢走;用步测, 踱步于
overcome|/.әuvә'kʌm/vt. 战胜, 克服, 胜过;得胜
behave|/bi'heiv/vi. 举止端正, 行为规矩;检点(自己的)行为, 使表现好
rank|/ræŋk/n. 等级, 排, 横列, 队伍, 阶级;茂密丛生的, 恶臭的, 十足的, 粗俗的;排列, 归类于, 把...分等;列为, 列队;秩; 秩
disaster|/di'zɑ:stә/n. 灾祸, 不幸, 彻底失败
stream|/stri:m/n. 水流, 小河, 流出, 趋势, 人潮;流出, 流动, 展开;流, 涌, 飘扬; 流
permission|/pә'miʃәn/n. 许可, 允许; 许可, 认可
electric|/i'lektik/a. 电的, 导电的, 电动的; 电的
sand|/sænd/n. 沙, 沙子, 沙滩, 光阴, 生涯;撒沙, 以沙掩盖
knife|/naif/n. 小刀, 匕首;切割, 伤害, 切, 戳;劈开, 穿过
witness|/'witnis/n. 证人, 目击者, 证据, 证词;目击, 作证, 证明, 表明;作证人, 作为证据
medicine|/'medisin/n. 药, 医学, 内科;给...用药
hero|/'hiәrәu/n. 英雄, 超越常人者, 男主角
swing|/swiŋ/n. 摇摆, 振幅, 音律, 节奏, 涨落, 秋千, 旋转, 行动自由;摇摆, 悬挂, 旋转, 大摇大摆地走, 转向;挥舞, 使旋转, 使转向, 悬挂, 吊运;旋转的, 悬挂的, 强节奏爵士音乐的
hearing|/'hiәriŋ/n. 听, 听觉, 听讯; 听, 听觉
mail|/meil/n. 邮件, 邮政, 邮递, 盔甲;邮寄, 给...穿盔甲; 邮件
birthday|/'bә:θdei/n. 生日
anger|/'æŋgә/n. 忿怒;激怒, 使发怒;发怒
platform|/'plætfɒ:m/n. 站台, 月台, 讲台, 论坛, 平台; 平台
curtain|/'kә:tәn/n. 帐, 幕, 窗帘;装帘子于, 遮蔽
electronic|/.ilek'trɒnik/a. 电子的; 电子工业协会接口
infection|/in'fekʃәn/n. 传染, 影响, 传染病; 传染, 感染
presumably|/pri'zu:mәbli/adv. 推测上, 大概
genuine|/'dʒenjuin/a. 真正的, 真实的, 诚恳的; 真性的
extreme|/ik'stri:m/n. 极端, 末端;极端的, 尽头的, 极度的, 偏激的
rush|/rʌʃ/n. 匆促, 冲进, 急流, 灯心草;冲, 奔, 闯, 赶紧, 匆促行事, 涌现;使冲, 匆忙地做, 突袭, 飞跃, 用灯心草做;紧急的
priest|/pri:st/n. 祭司, 牧师, 神父, 神质人员, 僧侣, 泰斗
joke|/dʒәuk/n. 笑话, 玩笑, 笑柄;开玩笑, 取笑, 作弄
relax|/ri'læks/vi. 放松, 松懈, 松弛, 变从容, 休息, 休养;使松弛, 缓和, 使松懈, 使休息
salt|/sɒ:lt/n. 盐, 风趣, 刺激;含盐的, 咸的, 风趣的, 辛辣的;加盐于, 用盐腌
drag|/dræg/n. 拖, 拖累;拖累, 拖拉, 沉重缓慢地走, 拖动; 拖动
exciting|/ik'saitiŋ/a. 令人兴奋的, 刺激的; 激磁
clock|/klɒk/n. 时钟, 计时器, (袜子上的)绣花边花;绣花样, 记时, 记录;记录时间; 时钟
written|/'ritn/a. 书面的, 写成文字的;write的过去分词
cream|/kri:m/n. 乳酪, 奶油, 面霜; 乳油, 乳皮;乳膏, 霜
bath|/bæθ.bɑ:θ/n. 沐浴, 浴室; 浴
advanced|/әd'vɑ:nst/a. 在前的, 高级的, 先进的, 年老的; 预付的, 预支的, 垫付的
stupid|/'stju:pid/a. 愚蠢的, 麻木的
oppose|/ә'pәuz/vt. 反对, 以...对抗, 抗争;反对
pause|/pɒ:z/n. 暂停, 中止, 停顿, 间歇, 踌躇, 休止符;暂停, 中止, 停顿, 踌躇; DOS内部命令:暂时停止批处理文件的执行
whenever|/hwen'evә/conj. 每当;不论何时, 每逢
opposite|/'ɒpәzit/a. 相对的, 相反的, 对面的;对面;对立面
altogether|/.ɒ:ltә'geðә/adv. 完全地, 总而言之
truly|/'tru:li/adv. 真实地, 不假
expose|/ik'spәuz/vt. 使暴露, 使曝光, 揭穿, 陈列; 暴露, 露置
everywhere|/'evrihwєә/adv. 各处, 到处
proud|/praud/a. 骄傲的, 自大的, 自豪的, 辉煌的, 壮丽的
confident|/'kɒnfidәnt/a. 有信心的, 有把握的
remark|/ri'mɑ:k/n. 评论, 注意;评论, 注意;评论, 谈论; 注释
compete|/kәm'pi:t/vi. 竞争, 对抗
sink|/siŋk/n. 藏垢的场所, 沟渠, 污水槽;下沉, 沉没, 下陷, 减弱, 衰退, 消沉, 堕落, 渗透;使低落, 使下沉, 陷于, 投入(资金等), 挖掘
lecture|/'lektʃә/n. 演讲, 谴责, 讲稿;演讲, 训诫, 说教;讲演
definitely|/'definitli/adv. 明确无疑地, 清楚地
mad|/mæd/a. 疯狂的, 发疯的, 生气的, 愚蠢的, 狂欢的;狂怒
fishing|/'fiʃiŋ/n. 钓鱼, 鱼业;钓鱼的
mount|/maunt/n. 乘骑用马, 框, 衬纸, 山;乘马, 爬上, 增长;爬上, 使上马, 装上, 装裱, 安放, 制作...的标本, 设置, 上演; 安装
luck|/lʌk/n. 运气, 幸运, 好运, 侥幸;靠好运成功
formula|/'fɒ:mjulә/n. 客套语, 公式, 准则; 公式
install|/in'stɒ:l/vt. 安装, 安置, 使就职; 安装, 安装程序;DOS内部命令:安装常驻程序
tail|/teil/n. 尾部, 后部, 辫子, 随员, 特务, 燕尾服, 踪迹, 限定继承(权);在后面的, 从后面而来的, 限定继承的, 尾部的, 后部的;为...装尾, 附于其后, 尾随, 使搭牢, 跟踪, 监视;跟踪, 船尾搁浅
anxiety|/æŋ'zaiәti/n. 焦虑, 忧虑, 令人焦虑的事; 焦虑
whisper|/'hwispә/n. 耳语, 密谈, 谣传, 沙沙声;耳语, 密谈, 沙沙地响;低声说
fortune|/'fɒ:tʃәn/n. 财富, 运气, 兴隆, 大量财产, 好运, 命运; 命运, 财产, 大量财产
deserve|/di'zә:v/vt. 该得到, 值得;应得报答
barrier|/'bæriә/n. 障碍, 栅栏; 势垒;阻片;阻挡层
anxious|/'æŋʃәs/a. 忧虑的, 发愁的, 渴望的
tip|/tip/n. 顶, 尖端, 梢, 末端, 倾斜, 垃圾场, 小费, 轻击, 指点, 秘密消息;装顶端, 使倾斜, 使翻倒, 泄露, 告诫, 暗示, 给...小费, 轻击;倾斜, 翻倒, 倾覆, 踮脚走, 给小费; 终端接口处理器, 提示, 技巧
nervous|/'nә:vәs/a. 神经紧张的, 不安的, 神经的; 神经的;神经质的, 神经过敏的
conscious|/'kɒnʃәs/a. 有意识的, 知觉的, 觉察的; 有意识的, 清醒的
tackle|/'tækl/n. 工具, 复滑车, 滑车, 装备, 扭倒;固定, 处理, 抓住;扭倒
symbol|/'simbl/n. 符号, 象征, 代号, 信条; 符号;码元
sweep|/swi:p/n. 扫除, 打扫, 肃清, 视野, 范围, 全胜;扫除, 掸去, 猛拉, 扫荡, 肃清, 冲走, 刮起, 环视, 掠过, 扫射;扫, 打扫, 袭击, 席卷, 扫视, 掠过
satisfied|/'sætisfaiәd/a. 感到满意的
borrow|/'bɒrәu/vt. 借, 借入, 借用;借; 借位;借位数
climate|/'klaimit/n. 气候, 社会趋势, 气候区; 气候
moon|/mu:n/n. 月亮, 月球, 月光;闲荡;虚度
basically|/'beisikli/adv. 基本上, 主要地
heaven|/'hevn/n. 天堂, 上帝, 天空
bury|/'beri/vt. 埋葬, 埋藏
smell|/smel/n. 味道, 气味, 嗅觉, 嗅, 臭味, 气息;闻, 探出, 察觉, 发出...的气味;嗅, 散发气味, 发臭
pitch|/pitʃ/n. 程度, 坡度, 顶点, 前倾, 倾斜, 投掷, 音高, 螺距, 节距, 摊位, 树脂, 沥青;投, 掷, 向前倾跌, 扎营, 竭力推销, 为...定调, 定位于, 用沥青涂;搭帐篷, 投掷, 向前跌, 猛然摔倒, 坠落, 倾斜; 孔距
alcohol|/'ælkәhɒl/n. 酒精, 酒; 醇;乙醇;酒精
crop|/krɒp/n. 农作物, 产量, 平头;收割, 修剪, 种植;收获; 裁剪
capture|/'kæptʃә/n. 抓取, 战利品, 捕获之物;抓取, 获得, 迷住; 截获命令
awful|/'ɒ:ful/a. 可怕的, 庄严的, 虔敬的
stomach|/'stʌmәk/n. 胃, 食欲, 欲望, 肚子;吃下, 忍受
opponent|/ә'pәunәnt/n. 对手, 敌手, 反对者;敌对的, 反对的, 对面的
snow|/snәu/n. 雪, 积雪, 下雪, 雪花形干扰;下雪, 似雪般落下;使雪白, 用雪覆盖, 使像雪般落下
enthusiasm|/in'θju:ziæzәm/n. 巨大的热情, 热心
cease|/si:s/n. 停止;停止, 终了
impressive|/im'presiv/a. 给人深刻印象的, 威严的
honest|/'ɒnist/a. 诚实的, 坦直的, 可靠的
smooth|/smu:ð/a. 平滑的, 平稳的, 流畅的, 和蔼的, 安祥的, 圆滑的, 调匀的, 无毛的;使光滑, 烫平, 使平和, 消除;变平滑, 变平静;一块平地, 平滑部分
remote|/ri'mәut/a. 遥远的, 偏僻的, 疏远的, 微少的; 远程, 远程访问实用程序
qualify|/'kwɒlifai/vi. 取得资格, 有资格;使有资格, 使合格, 限定, 限制, 准予
shell|/ʃel/n. 贝壳, 壳, 外形, 炮弹;去壳, 脱落, 炮轰;剥落, 脱壳; 外壳;DOS内部命令:指定命令行处理程序
tube|/tju:b/n. 管, 软管, 隧道;把...装管, 使通过管子; 管子
transform|/træns'fɒ:m/vt. 使转换, 改变, 改造, 使...变形;改变, 转化, 变换; 变换
pink|/piŋk/n. 粉红色, 石竹花, 化身, 典范, 头面人物, 极度;粉红的, 石竹科的, 比较激进的, 脸色发红的, 精致的, 有点下流的;刺, 扎, 刺痛, 射伤, 使面红耳赤, 使变粉红色;变粉红色
holy|/'hәuli/a. 神圣的, 圣洁的, 至善的;神圣的东西
slide|/slaid/n. 滑, 滑道, 山崩, 雪崩, 幻灯片;使滑动, 偷偷放入;滑动, 滑落, 不知不觉陷入, 偷偷地走
bowl|/bәul/n. 碗, 木球, 大酒杯;滚木球, 快而稳地行驶
dish|/diʃ/n. 盘子, 碟, 菜肴; 皿, 碟
outstanding|/.aut'stændiŋ/a. 杰出的, 突出的, 未偿付的, 未决定的; 未解决的, 未偿付
minimum|/'minimәm/a. 最小的, 最低的;最小值; 最小值
cheese|/tʃi:z/n. 乳酪; 干酪
related|/ri'leitid/a. 讲述的, 叙述的;有关系的, 有关联的
complicated|/'kɒmplikeitid/a. 复杂的; 并发的
alongside|/ә'lɒŋ'said/adv. 在旁边, 靠拢着;在...旁边, 与...在一起
accurate|/'ækjurәt/a. 正确的, 精确的; 准确的, 精确的
pose|/pәuz/n. 姿势, 姿态, 装模作样, 伪装;摆姿势, 装模作样, 假装;使摆好姿势, 提出, 造成
lend|/lend/vt. 借, 贷款给, 增添, 提供, 出租;贷款
proof|/pru:f/n. 证据, 证明, 试验, 检验, 考验;不能透入的, 证明用的, 防...的, 耐...的;检验, 试验, 校对, 使不被穿透; 审稿
wire|/'waiә/n. 电线, 电报, 电信, 铁丝网, 金属丝;用金属丝捆扎, 拍电报;打电报
strain|/strein/n. 紧张, 拉紧, 张力, 过劳, 扭伤, 血缘, 种, 族, 气质, 曲调, 旋律, 口吻;使劳累, 拉紧, 过分使用, 扭伤, 滥用, 曲解, 滤;尽力, 努力, 紧拉, 弯曲, 被滤出
salary|/'sælәri/n. 薪水;给...加薪
steam|/sti:m/n. 蒸汽, 精力;蒸汽的;蒸发, 行驶, 发怒;蒸, 煮, 散发
extraordinary|/ik'strɒ:dәnәri/a. 非常的, 特别的, 非凡的; 非常的, 特别的, 临时的
visible|/'vizәbl/a. 看得见的, 明显的, 显然的;可见物
plain|/plein/n. 平原, 草原, 朴实无华的东西, 无格式;简单的, 明白的, 平常的, 不好看的, 朴素的, 清晰的, 普通的, 平坦的, 十足的;清楚地, 显然地; 无格式
shopping|/'ʃɒpiŋ/n. 买东西, 购物; 购物, 买东西
label|/'leibl/n. 标签, 称号, 商标, 标志;贴标签于, 标注; 标志;标注;DOS外部命令:用于建立改变或删除磁盘卷标号
lover|/'lʌvә/n. 爱人, 爱好者
tunnel|/'tʌnl/n. 隧道, 地下道;挖隧道;掘隧道于
musical|/'mju:zikl/n. 音乐片, 音乐舞台剧;音乐的, 声音美妙的, 喜爱音乐的
poetry|/'pәuitri/n. 诗, 韵文, 诗歌艺术
grab|/græb/n. 抓握, 掠夺, 强占, 东方沿岸帆船;抓取, 抢去;攫取, 捕获, 霸占
gentle|/'dʒentl/a. 温和的, 文雅的
scream|/skri:m/n. 尖叫声;尖叫, 大笑, 尖啸, 令人震惊;尖叫着说, 大叫大嚷着要求
pot|/pɒt/n. 盆, 罐, 壶, 坩埚, 奖杯;装入盆中, 在锅中煮, 随手射击;随手射击
ultimately|/'ʌltimәtli/adv. 最后, 最终; 最后, 终究, 总之
breast|/brest/n. 胸部, 乳房, 胸怀;以胸对着, 面对
tight|/tait/a. 紧的, 密封的, 吝啬的, 严厉的;紧紧地
violent|/'vaiәlәnt/a. 暴力的, 猛烈的, 激烈的, 极端的, 凶暴的
sensible|/'sensәbl/a. 有感觉的, 敏感的, 明智的; 可感觉的
dig|/dig/vt. 挖, 翻土, 发掘;挖掘;挖掘; 数字, 数位
adjust|/ә'dʒʌst/vt. 调整, 使适应于, 校准;适应于, 被调节, 相互熟悉而适应
mystery|/'mistәri/n. 秘密, 神秘, 奥秘
vegetable|/'vedʒәtәbl/n. 蔬菜, 植物, 无精打采之人;蔬菜的, 植物的
reward|/ri'wɒ:d/n. 报酬, 酬谢, 赏金;奖赏, 酬谢, 给...应有报应
junior|/'dʒu:njә/n. 年少者, 地位较低者, 大学三年级学生;年少的, 下级的, 后进的
bathroom|/'bɑ:θru:m/n. 浴室, 厕所
grade|/greid/n. 等级, 年级, 阶段, 成绩, 程度, 坡度, 斜坡;分等, 分级, 评分;属于某等级, 逐渐变化
consult|/kәn'sʌlt/vi. 商讨, 商量, 协商, 会诊;向...请教, 查阅, 考虑
comfort|/'kʌmfәt/n. 舒适, 安慰, 安慰者;安慰
imagination|/i.mædʒi'neiʃәn/n. 想像, 听觉, 想像力; 想像
bell|/bel/n. 铃, 钟; 响铃命令
draft|/dræft. drɑ:ft/n. 气流, 草稿, 汇票, 草案;起草, 征兵; 草稿
till|/til/prep. 直到, 在...以前, 迄;直到...为止;耕种;放钱的抽屉, 备用现金, 冰碛
inevitable|/in'evitәbl/a. 不可避免的, 必然的; 不可避免的, 无法规避的, 必然的
outline|/'autlain/n. 大纲, 轮廓, 概要;描画轮廓, 描述要点;大纲, 分级, 轮廓; 大纲, 分级, 轮廓
highlight|/'hailait/n. 加亮区, 精彩场面;加亮, 使显著, 以强光照射, 突出; 突出
personally|/'pә:sәnli/adv. 亲自地, 个别地, 当面, 就本人而言, 针对个人地
trace|/treis/n. 痕迹, 踪迹, 微量, 迹线, 缰绳;追踪, 回溯, 描绘;追溯, 沿路走
newly|/'nju:li/adv. 重新, 最近
belt|/belt/n. 带子, 地带; 带, 腰带, 束带, 地带, 区
storm|/stɒ:m/n. 暴风雨, 骚动, 风波, 风暴, 猛攻;起风, 猛冲, 怒吼;猛攻
rid|/rid/vt. 免除, 以...清除, 使获自由, 使摆脱; 免除, 清除, 摆脱
dirty|/'dә:ti/a. 肮脏的, 卑鄙的;弄脏;变脏
assistant|/ә'sistәnt/n. 助手, 助理, 助教;有帮助的, 辅助的, 助理的
sail|/seil/n. 帆, 篷, 帆船, 航程, 帆状物;航行, 启航, 张帆而行;航行于, 驾船
pride|/praid/n. 骄傲, 自尊心, 自豪, 精华, 勇气;以...自豪
pleasant|/'pleznt/a. 愉快的, 可爱的, 活泼的, 亲切的
joy|/dʒɒi/n. 欢喜, 乐事, 高兴;使快乐, 令人高兴;欢喜
twin|/twin/n. 双胞胎中一人, 一对非常相像的人(或物)中的一个;双胞胎的, 成对的, 孪生的;生双胞胎, 成对;怀(双胞胎), 使成对
entitle|/in'taitl/vt. 给...权利, 取名为, 给予名称, 叫做; 给...权利, 使有资格, 称呼
venture|/'ventʃә/n. 冒险, 风险;敢于, 冒...的危险;冒险
encounter|/in'kauntә/n. 相会, 相遇, 遭遇;遇见, 邂逅, 会战;偶然相遇
universe|/'ju:nivә:s/n. 宇宙, 星系, (思想等)范围
steady|/'stedi/a. 稳定的, 不动摇的, 沉着的, 稳固的, 坚定的, 经常的;使稳定, 使坚定;变为沉着, 稳固
react|/ri'ækt/vi. 起反应, 起作用, 反攻; 应答, 发生反应
loose|/lu:s/n. 发射, 放任, 放纵;宽松的, 松的, 宽的, 不牢固的, 散漫的, 自由的, 不精确的;释放, 放枪, 开船;变松, 开火;松散地
blind|/blaind/n. 蒙蔽物, 窗帘;盲目的, 瞎的, 不加思考的;使失明, 蒙蔽, 遮暗;盲目地
dust|/dʌst/n. 灰尘, 尘埃, 粉末, 花粉, 土, 骚乱;拂去灰尘, 撒, 弄成粉末;拂去灰尘, 化为粉末
diary|/'daiәri/n. 日记; 日记簿
desperate|/'despәrәt/a. 不顾一切的, 危急的, 令人绝望的, 极渴望的
horror|/'hɒrә/n. 惊骇, 恐怖, 惨状; 恐怖, 恐惧
delighted|/di'laitid/a. 高兴的, 快乐的
repair|/ri'pєә/n. 修理, 补救, 修复;修理, 修补, 补救, 恢复, 补偿;修理, 修补, 补救, 恢复, 去, 常去, 集合
concert|/'kɒnsәt/n. 音乐会, 和声, 一致;协力, 协调;协力; 美国北卡罗来纳州Internet网
cow|/kau/n. 母牛, 母兽;威胁
Pole|/pәul/n. 波兰人, 极点, 磁极, 电极, 杆, 竿, 相反的极端;用竿支撑;撑篙
cap|/kæp/n. 盖子, 帽子;戴帽子, 覆盖, 胜过;脱帽致意; 调用程序分析, 容量, 代码分析程序, 计算机辅助生产, 计算机辅助印刷
chart|/tʃɑ:t/n. 图表, 海图;制成图表; 图表
leather|/'leðә/n. 皮革, 皮制品, 马镫的皮带;覆以皮革, 鞭苔, 抽打;皮革的, 皮制的
button|/'bʌtәn/n. 钮扣, 按钮;扣住;钉钮扣于, 扣紧; 按钮
raw|/rɒ:/n. 擦伤处, 半成品;生的, 未加工的, 生疏的, 不成熟的, 阴冷的, 刺痛的, 擦掉皮的;擦伤; 写后读
lost|/lɒst/a. 失去的, 遗失的, 迷惑的;lose的过去式和过去分词
ultimate|/'ʌltimit/n. 终极, 根本, 顶点, 基本原则;终极的, 根本的, 极限的, 最远的, 最后的, 最大的
publicity|/pʌb'lisiti/n. 名声, 宣传, 公开场合; 宣传, 广告
alarm|/ә'lɑ:m/n. 惊恐, 警报, 警钟;使惊恐, 警告; 报警信号
nerve|/nә:v/n. 精神, 勇气, 叶脉, 神经;鼓起勇气
communicate|/kә'mju:nikeit/vt. 显露, 传达, 感染;通讯
stir|/stә:/n. 骚动, 轰动, 搅动, 监狱;移动, 摇动, 激起, 惹起, 搅拌;走动, 传播, 搅拌
burst|/bә:st/n. 破裂, 突发, 爆发;爆裂, 突发, 充满; 二进制位组;字符组;脉冲串
potato|/pә'teitәu/n. 马铃薯
ocean|/'әuʃәn/n. 海洋, 广阔, 许多, 一大片; 海洋, 海
traveller|/'trævlә/n. 旅行者; 旅行商
pen|/pen/n. 钢笔, 笔, 笔调, 笔杆子, 作家, 围栏, 栅栏, 禽畜;写, 关入栏中, 囚禁;动笔, 写作
craft|/kræft/n. 技艺, 手艺, 诡计;精心制作
clever|/'klevә/a. 聪明的, 精明的
van|/væn/n. 货车, 篷车, 先锋, 前驱, 前卫;用货车搬运; 增值网
chicken|/'tʃikin/n. 小鸡, 鸡肉
cable|/'keibl/n. 电缆, 海底电报, 缆, 索;打海底电报;发海底电报, 缚住; 电缆
swim|/swim/n. 游泳, 漂浮, 潮流, 眩晕;游泳, 游, 漂浮, 浸, 覆盖, 充溢, 大量拥有, 旋转, 眩晕;游过, 使浮起
govern|/'gʌvәn/v. 统治, 支配, 管理
equivalent|/i'kwivәlәnt/n. 同等物, 等价物, 相等物;相等的, 相当的, 同意义的; 等价的
mate|/meit/n. 配偶, 对手, 助手, (象棋)将死;使配对, 使一致, 结伴, (象棋)将死;成配偶, 紧密配合
wise|/waiz/a. 明智的, 慎虑的, 聪明的, 博学的, 狡猾的, 机灵的;知道;教导, 告诉, 劝导;方法, 方式; 教育信息系统
weigh|/wei/vt. 称...重量, 衡量, 把...压弯, 考虑, 权衡, 起锚;称分量, 有意义, 重压, 起锚;过秤, 称分量
sympathy|/'simpәθi/n. 同情, 赞同, 怜悯, 慰问, 吊唁; 交感;, 同感;, 感应, 同情
strip|/strip/n. 长条, 条状, 带, 脱衣舞;脱衣, 被剥去, 剥夺, 拆卸;脱衣服
strict|/strikt/a. 严厉的, 绝对的, 详尽的, 严格的, 精确的; 严格的, 精确的, 绝对的
friendship|/'frendʃip/n. 友谊, 友爱, 友善
ease|/i:z/n. 安乐, 安逸, 悠闲;使安乐, 使安心, 减轻, 放松;减轻, 放松, 灵活地移动
bitter|/'bitә/a. 苦的, 痛苦的, 怀恨的;刺骨;(使)变苦
plot|/plɒt/n. 小块土地, 地区图, 图, 阴谋, 情节;划分, 绘图, 密谋;密谋, 策划; 绘制
illegal|/i'li:gәl/a. 违法的, 不合规定的; 非法的, 犯规的
confront|/kәn'frʌnt/vt. 使面对, 对抗, 遭遇, 使对质, 比较; 对证, 使对质, 比较
nowhere|/'nәuhwєә/adv. 无处, 到处都无
planet|/'plænit/n. 行星, 命运星辰, 杰出的人, 重大影响的事
wrap|/ræp/n. 外套, 围巾, 包裹物, 限制, 约束, 秘密, 换行;包装, 卷, 缠绕, 包, 裹, 覆盖, 遮蔽, 隐藏, 掩护;缠绕, 穿外衣, 包起来; 换行
chocolate|/'tʃɒkәlit/n. 巧克力;巧克力制的
discount|/'diskaunt/n. 折扣, 贴现率;打折扣;贴现
bound|/baund/n. 跃, 回跳, 范围, 边界;受约束的, 装有封面的, 有义务的, 关联的, 被束缚的, 准备去...的, 便秘的;跳跃, 弹起;使跳, 限制, 形成...的疆界;bind过去式和过去分词; 装订的
reverse|/ri'vә:s/n. 相反, 背面, 倒退, 挫折, 失败;反面的, 相反的, 反向的, 颠倒的;使颠倒, 使逆转, 使倒退, 使反向;倒退, 反向, 倒转, 反转; 反转
invitation|/.invi'teiʃәn/n. 邀请, 请柬, 引诱; 邀请, 招待, 吸引
generous|/'dʒenәrәs/a. 慷慨的, 有雅量的, 大量的, 丰富的
trick|/trik/n. 诡计, 欺诈, 谋略, 恶作剧, 习惯, 决窍;愚弄, 欺骗, 装饰;哄骗, 戏弄;有决窍的, 特技的, 欺诈的, 漂亮的, 靠不住的
excuse|/ik'skju:z/vt. 原谅, 申辩, 做为...的托辞;致歉, 理由, 饶恕, 借口
cancel|/'kænsәl/n. 取消, 撤消, 盖销(邮票);取消, 删去, 抵销, 盖销;相互抵销; 作废
automatic|/.ɒ:tә'mætik/n. 自动手枪, 自动机械;自动的, 机械的, 必然的, 无意识的
ambition|/æm'biʃәn/n. 野心, 志向
weekly|/'wi:kli/n. 周刊, 周报;每周的, 一周一次的, 周刊的;每周, 一周一次
entertainment|/.entә'teinmәnt/n. 娱乐, 款待, 娱乐表演
harm|/hɑ:m/n. 伤害, 害处;伤害, 损害
resort|/ri'zɒ:t/n. 度假胜地, 手段, 凭借, 常去之地;诉诸, 常去
convince|/kәn'vins/vt. 说服, 使相信; 使确信, 使信服, 使人认识错误
shade|/ʃeid/n. 荫, 阴暗, 遮光物, 灯罩, 帘, 浓淡, 微量, 底纹;渐变;使阴暗, 使渐变, 遮蔽, 微减; 底纹
loud|/laud/a. 大声的, 不断的, 喧吵的;高声地, 大声地
dare|/dєә/n. 挑战, 挑动, 大胆;敢, 胆敢
mayor|/'mєә/n. 市长; 市长
suspicion|/sә'spiʃәn/n. 怀疑, 觉察, 嫌疑; 怀疑, 疑心, 嫌疑
prompt|/prɒmpt/n. 激励, 提示, 提醒物, 提词, 付款期限;迅速的, 敏捷的, 立刻的, 提词员的;激励, 鼓动, 提示;准时地; 提示符;DOS内部命令:设定DOS命令行的提示符
humour|/'hju:mә/n. 幽默, 诙谐, 情绪, 体液;使满足, 迁就
cotton|/'kɒtn/n. 棉花;和谐, 有好感, 理解
grain|/grein/n. 谷粒, 颗粒, 谷类, 纹理, 本质;(使)成谷粒
pop|/pɒp/n. 砰然声, 枪击, 含气饮料, 流行音乐, 通俗艺术;流行的, 热门的, 通俗的;使发出爆裂声, 开枪打, 突然伸出;发出爆裂声, 射击, 突然出现, 瞪大;突然, 砰地; 出现点, 邮局协议
pile|/pail/n. 堆, 大堆, 大厦, 建筑群, 电池, 大量, 桥桩, 软毛, 痔疮;堆起, 堆积, 积累, 挤, 猛烈攻击;堆于, 累积, 堆叠, 打桩于, 用桩支撑
spiritual|/'spiritʃuәl/a. 精神上的, 神圣的, 崇高的, 高尚的, 鬼的, 招魂术的;有关教会的事
bet|/bet/n. 打赌, 赌注;打赌
urgent|/'ә:dʒәnt/a. 紧急的, 急迫的, 催逼的; 紧急的, 急迫的
pregnant|/'pregnәnt/a. 怀孕的, 充满的, 思想丰富的, 成果丰硕的; 妊娠的, 有孕的
admire|/әd'maiә/vt. 赞美, 钦佩, 爱慕;称赞, 惊奇
explosion|/ik'splәuʒәn/n. 爆发, 激增, 爆炸(声); 爆炸
tap|/'tæp/n. 轻打, 水龙头;轻打, 轻敲, 敲打出, 选择, 装上嘴子, 使流出, 开发, 分接, 向...乞讨;轻叩, 轻拍, 啪塔啪塔地走; 接头
curious|/'kjuәriәs/a. 好奇的, 求知的, 古怪的
fence|/fens/n. 围墙, 栅栏, 买卖赃物的人, 剑术;用篱笆围住, 练习剑术, 防护;击剑, 搪塞
interior|/in'tiәriә/n. 内部, 内政;内部的, 心灵的, 内地的, 内政的
ceremony|/'serimәni/n. 典礼, 仪式, 礼节; 典礼, 仪式
cinema|/'sinәmә/n. 电影院, 电影
nearby|/'niәbai/a. 附近的, 近旁的;在附近, 近旁地;在...附近
publishing|/'pʌbliʃiŋ/n. 出版, 刊印, 发行
unexpected|/.ʌnik'spektid/a. 料想不到的, 突然的, 意外的; 不能预料的, 意外的
disappointed|/.disә'pɒintid/a. 失望的
clothing|/'klәuðiŋ/n. 衣服
trap|/træp/n. 圈套, 陷阱, 诡计, 存水弯;设圈套, 设陷阱;诱捕, 诱骗, 抓住, 使受限制; 俘获;陷井
navy|/'neivi/n. 海军, 海军人员, 海军军力, 烟蒂
chase|/tʃeis/n. 追求, 狩猎, 追逐;追捕, 追逐, 雕刻, 在...上镶嵌宝石;追赶, 奔跑
celebration|/.seli'breiʃәn/n. 庆祝, 庆典
spell|/spel/n. 符咒, 魅力, 轮值, 轮班, 工作时间, 一次发作;拼写, 拼成, 琢磨, 理解, 招致, 轮换, 迷住;轮换, 拼字
brand|/brænd/n. 商标, 牌子, 烙印;打烙印于
squeeze|/skwi:z/n. 紧握, 挤, 榨, 榨取, 佣金;紧握, 挤, 榨取;压榨, 榨
gear|/giә/n. 齿轮, 工具;以齿轮连起, 开动, 使适应, 安排;连接上, 适合
delight|/di'lait/n. 高兴, 愉快;使高兴, 乐于;感到高兴(或愉快、快乐)
butter|/'bʌtә/n. 奶油, 黄油;涂黄油于
toy|/tɒi/n. 玩具, 小玩艺儿, 小型的东西, 消遣;供玩耍的, 作为玩具的;玩弄, 戏弄, 调情
brush|/brʌʃ/n. 刷子, 毛笔, 争吵;刷;擦过, 掠过; 电刷
rhythm|/'riðәm/n. 旋律, 节奏, 韵律, 匀称, 张弛节律; 节律
innocent|/'inәsәnt/a. 无罪的, 不懂事的, 无知的;天真的人, 笨蛋
desert|/'dezәt. di'sә:t/n. 沙漠, 应得的赏罚, 功劳;沙漠的, 不毛的;放弃, 遗弃, 擅离;逃掉
romantic|/rәu'mæntik/a. 浪漫的, 风流的, 传奇性的, 夸大的, 空想的, 浪漫派的
mess|/mes/n. 食堂, 伙食, 用膳, 一份食品, 混乱, 乱七八糟, 困境;将...弄糟, 妨碍, 使紊乱, 使就餐;陷入困境, 搞乱, 用膳
anniversary|/æni'vә:sәri/n. 周年纪念
hire|/haiә/n. 租金, 租用, 雇用;雇请, 出租;受雇
counter|/'kauntә/n. 计算器, 计算者, 柜台, 筹码;反方向的, 相反的;反方向地, 相反地; 计数器;计数字
rumour|/'ru:mә/n. 谣言, 传闻;谣传
mixed|/mikst/a. 混合的, 形形色色的, 弄糊涂的; 混合的
float|/flәut/n. 漂流物, 浮舟, 漂浮, 浮萍, 彩车;浮动, 飘动, 散播, 摇摆, 动摇, 浮动;使漂浮, 容纳, 淹没, 发行, 实行; 浮动
flag|/flæg/n. 标志, 旗标, 旗子, 信号旗, 菖蒲;悬旗, 打旗号, 铺石板;无力地下垂; 标志;属性标记命令
uniform|/'ju:nifɒ:m/n. 制服;统一的, 一律的, 始终如一的
superior|/sju:'piәriә/n. 长者, 占优势的人, 上级;上级的, 出众的, 高傲的
freeze|/fri:z/vi. 冻结, 冷冻, 僵硬, 楞住;使结冰, 使冻住, 使呆住;结冰, 凝固; 冻结
businessman|/'biznismæn/n. 商人, 实业家, 工商业家
singer|/'siŋә/n. 歌手
virus|/'vaiәrәs/n. 病毒, 滤过性病毒, 毒害; 病毒
emphasize|/'emfәsaiz/vt. 强调, 加强语气, 着重
spare|/spєә/n. 剩余, 备用品, 备件, 备用零件, 备用轮胎;多余的, 备用的, 空闲的, 节约的, 瘦的;节约, 省掉, 宽恕;节约, 省用, 剩下, 饶恕, 赦免
coloured|/'kʌlәd/a. 有色的, 有...色的, 经过渲染的, 有色彩的, 伪装的, 有色人种的, 混血种的;有色人种的人, 混血人; 着色的
stroke|/strәuk/n. 笔划, 打, 中风, 抚, 摩, 冲程;划尾桨, 抚, 摩, 划去; 笔划
intelligent|/in'telidʒәnt/a. 聪明的, 智能的, 了解的
unhappy|/.ʌn'hæpi/a. 不快乐的, 不幸的, 不适当的
unfair|/.ʌn'fєә/a. 不公平的, 不正直的, 不正当的; 不正直的, 不公平的, 偏颇的
continent|/'kɒntinәnt/n. 大陆, 洲;自制的
grave|/greiv/n. 墓穴, 坟墓, 终结, 死亡;庄重的, 严肃的, 重大的, 低沉的;雕刻
truck|/trʌk/n. 卡车, 货车, 对...进行交易, 来往, 实物工资, (供应市场的)蔬菜, 废物, 废话;对...进行交易, 交往, 以卡车运输;驾驶卡车, 以物易物
midnight|/'midnait/n. 午夜, 子夜, 半夜;午夜的, 半夜的
painful|/'peinful/a. 痛苦的, 困难的, 令人烦恼的; 疼痛的
courage|/'kʌridʒ/n. 勇气, 胆量
aggressive|/ә'gresiv/a. 侵略的, 挑畔的, 进取的; 侵略的, 爱挑衅的, 行为过火的
amazing|/ә'meiziŋ/a. 令人惊异的
shame|/ʃeim/n. 羞耻, 羞愧, 耻辱;使羞愧, 侮辱
twist|/twist/n. 一扭, 扭曲, 曲折, 歪曲, 螺旋状, 新手法;拧, 扭, 捻, 编织, 使扭转, 缠绕, 盘绕, 歪曲, 使转动, 使苦恼, 使混乱, 使旋转;转向, 弯曲, 缠绕, 扭动, 呈螺旋形
hip|/hip/n. 臀部, 蔷薇果, 忧郁;熟悉内情的;使忧郁, 给(屋顶)造屋脊;喝彩声
pet|/pet/n. 宠物, 受宠爱的人, 宠坏的孩子, 不悦, 生气;宠爱的, 表示亲昵的, 养着观赏的, 特别珍爱的, 格外的;宠爱, 溺爱, 抚摸;拥抱, 爱抚, 生气, 发脾气
musician|/mju:'ziʃәn/n. 音乐家, 乐师, 作曲家
apartment|/ә'pɑ:tmәnt/n. 房间, 公寓
breed|/bri:d/n. 种类, 品种;养育, 引起, 饲养, 繁殖
juice|/dʒu:s/n. 汁, 活力, 体液;挤出汁来, 加汁
tune|/tju:n/n. 歌曲, 主旋律, 心情, 声调, 和谐, 一致, 语调, 程度;为...调音, 调整, 调谐, 使一致;协调, 调谐
regret|/ri'gret/n. 遗憾, 后悔, 悔恨, 抱歉, 歉意;为...感到遗憾, 后悔, 惋惜, 懊悔, 抱歉;感到抱歉
mild|/maild/a. 温和的, 温柔的, 淡味的, 适度的, 轻微的, (肥皂等)软性的; 轻的, 缓和的
upset|/ʌp'set/a. 弄翻的, 混乱的, 心烦的;弄翻, 颠覆, 推翻, 打乱, 使不适, 使心烦;翻倒
giant|/'dʒaiәnt/n. 巨人, 大力士, 巨大怪物;庞大的, 巨大的
brave|/breiv/a. 勇敢的, 美好的, 华丽的;勇敢者;勇敢地面对
neat|/ni:t/a. 整洁的, 巧妙的, 匀称的, 简洁的;牛
elegant|/'eligәnt/a. 优雅的, 端庄的, 高雅的
crazy|/'kreizi/a. 发狂的, 狂热的
concrete|/'kɒnkri:t/n. 凝结物, 混凝土;具体的, 实在的, 混凝土的;(使)凝结, 用混凝土浇筑
spin|/spin/n. 旋转, 自旋, 疾驰, 情绪低落;纺织, 纺, 使旋转, 编造;纺纱, 吐丝, 作茧, 结网, 旋转, 自旋, 疾驰
lonely|/'lәunli/a. 孤单的, 孤寂的, 荒凉的
ingredient|/in'gri:diәnt/n. 成分, 因素; 配合剂;拼料;成分;组分
divorce|/di'vɒ:s/n. 离婚;与...离婚
rescue|/'reskju:/n. 援救, 解救, 营救;援救, 救出, 营救
contest|/'kɒntest/n. 竞赛, 争论;竞争, 争取, 争辩;竞争
stamp|/stæmp/n. 印, 邮票, 打印器, 戳子, 图章, 印花税票, 标志, 特征, 类型, 跺脚;盖章于, 顿足, 贴上邮票, 铭刻, 捣碎, 扑灭;捣碎, 跺脚
striking|/'straikiŋ/a. 醒目的, 惊人的, 打击的, 罢工的; 罢工的, 罢市的, 罢课的
explode|/ik'splәud/vi. 爆炸, 爆发, 激增;使爆炸
ton|/tʌn/n. 吨; 吨
peaceful|/'pi:sful/a. 平静的, 和平的, 和平时期的, 爱好和平的, 喜爱安静的; 和平的, 爱好和平的, 和平时期的
magic|/'mædʒik/n. 魔术, 魔法;魔术的, 有魔力的, 不可思议的
decorate|/'dekәreit/v. 装饰
orange|/'ɒ:rindʒ/n. 柑橘, 桔子, 橘色;橘色的
flavour|/'fleivә/n. 味, 调味香料, 滋味, 香味, 气味, 风味, 情味, 情趣, 风韵;给...调味, 给...增添风趣, 加香料, 加味于
fold|/fәuld/n. 折层, 折, 羊栏, 折痕, 信徒;折叠, 包, 合拢, 交迭;折叠起来, 彻底失败; 折叠;合并
forecast|/'fɒ:kɑ:st/n. 预想, 预测, 预报;预想, 预测, 预报; 趋势预测
rider|/'raidә/n. 骑手, (文件后的)附件, 扶手; 游码
flash|/flæʃ/n. 闪光, 闪现, 一瞬间;闪光, 闪现, 反射;使闪光, 反射
criticize|/'kritisaiz/v. 批评, 吹毛求疵, 非难
bye|/bai/interj. 再会, 回头见; 结束命令
impress|/im'pres/n. 印象, 特征, 印记;使有印象, 印, 铭刻, 传送, 影响, 强征;给人印象
shelter|/'ʃeltә/n. 庇护所, 避难所, 庇护, 隐蔽处, 掩蔽;庇护, 保护, 隐匿;躲避
advertise|/'ædvәtaiz/vt. 做广告, 通知, 公布;做广告
determined|/di'tә:mind/a. 坚决的, 已下决心的
smart|/smɑ:t/a. 聪明的, 漂亮的, 刺痛的, 剧烈的, 敏捷的, 巧妙的, 伶俐的, 潇洒的;刺痛, 痛苦;刺痛
flood|/flʌd/n. 洪水, 大量之水, 涨潮;淹没, 使泛滥, 注满;被淹, 溢出, 涌进
evil|/'i:vl/n. 邪恶, 不幸, 罪恶;邪恶的, 不幸的, 有害的, 讨厌的
cooking|/'kukiŋ/n. 烹饪; 熬炼;热炼;蒸煮
rice|/rais/n. 米, 米饭, 稻;将...压成米粒状
dump|/dʌmp/n. 垃圾场;倾倒, 倾销;倒垃圾, 倾销商品; 转出;转储;倾卸;切断电源
killing|/'kiliŋ/n. 谋杀, 杀戮;杀害的, 疲惫的, 迷人的
drum|/drʌm/n. 鼓, 鼓声;击鼓, 作鼓声;打鼓奏出; 磁鼓
comedy|/'kɒmidi/n. 喜剧, 有趣的事情
sauce|/sɒ:s/n. 酱油, 调味汁, 酱;给...调味, 使增加趣味
missing|/'misiŋ/a. 不见的, 缺少的; 行踪不明的, 失踪的, 遗失的
praise|/preiz/n. 赞美, 称赞, 崇拜;称赞, 赞美;赞扬, 表扬
penny|/'peni/n. 便士, 一分, 小钱, 点滴; 便士
pan|/pæn/n. 平锅, 浅盘, 盆地, 硬土层, 拍摄全景;上下左右移动, 摇镜头, 淘洗, 淘金
hunt|/hʌnt/n. 狩猎, 追捕, 搜寻, 猎区;狩猎, 打猎, 搜索;打猎, 猎食, 搜寻
qualified|/'kwɒlifaid/a. 有资格的; 合格的, 有条件的, 有限制的
hook|/huk/n. 钩, 钩状, 镰刀, 陷阱;挂...于钩上, 钩住, 引上钩, 偷窃;弯成钩状, 钩紧; 钩
slice|/slais/n. 薄的切片, 一部分, 菜刀;切成薄片, 切下;切; 片
smash|/smæʃ/n. 打碎, 粉碎, 打碎时哗啦声, 猛击, 扣球, 杀球, 经营失败, 破产, 硬币, 假硬币;非常轰动的, 了不起的;打碎, 粉碎, 击溃, 使破产, 使裂变, 使用假硬币;碎裂, 猛撞, 破产, 扣球, 杀球;轰隆一声, 哗啦一声
runner|/'rʌnә/n. 跑步者, 赛跑者, 送信人, 走私船, 操作者, 滑槽; 碾碎机;压碎机
mobile|/'mәubil/a. 移动的, 易变的, 机动的;活动物体
calm|/kɑ:m/n. 平稳, 风平浪静;平静的, 冷静的;平静下来, 镇静;使平静
entertain|/.entә'tein/vt. 娱乐, 招待, 怀抱;款待
bunch|/bʌntʃ/n. 串, 束; 骨肿块(马)
manufacture|/.mænju'fæktʃә/n. 产品, 制造;制造, 假造;制造
rear|/riә/n. 后面, 背后, 后方;后面的, 背面的, 后方的;养育, 培养, 饲养, 举起, 树立, 栽种;高耸, 暴跳
pin|/pin/n. 大头针, 针, 别针, 栓, 销子, 图钉, 插头, 管脚, 品(液量单位);将...用针别住, 钉住, 压住, 牵制, 使不能动, 归罪于;针的, 销子的, 闩的
substitute|/'sʌbstitju:t/n. 代理, 代理人, 代用品, 代替者, 代替物;代替;替代, 取代, 代用;代替的, 代用的, 代用品的; 置换;替代
kilometre|/'kilәjmi:tә(r)/n. 公里, 千米
allied|/ә'laid/a. 联盟的, 联姻的, 联系起来的
behalf|/bi'hɑ:f/n. 利益, 方面
sack|/sæk/n. 麻布袋, 洗劫;把...装入袋, 洗劫
deliberate|/di'libәrәt/a. 深思熟虑的, 故意的, 从容的;仔细考虑
chat|/tʃæt/n. 闲谈;闲谈, 聊天
bargain|/'bɑ:gin/n. 交易, 买卖协定, 特价商品;讲价, 交易
boil|/bɒil/n. 煮沸, 沸腾, 疖;煮沸, 激动
pill|/pil/n. 药丸, 弹丸, 屈辱, 胡说;做成药丸, 形成丸状, 服药丸, 挫败, 抢劫
prior|/'praiә/a. 更重要的, 较早的, 在先的;小隐修院院长, 大隐修院副院长
broadcast|/'brɒ:dkæst/n. 广播, 传播;广播的;广播;经广播, 四散地; 广播命令, 广播
cure|/kjuә/n. 治疗, 治愈, 治疗法;治疗, 治愈, 改正, 腌制, 加工处理, 使硫化;受治疗, 被加工处理, 被硫化
thorough|/'θʌrә/a. 十分的, 彻底的
underground|/'ʌndәgraund/n. 地下, 地铁, 地道, 秘密活动;地下的, 秘密的;在地下, 秘密地
punch|/pʌntʃ/n. 打洞器, 钻孔机, 冲压机, 冲床, 潘趣酒;以拳重击, 开洞, 冲压;用拳猛击
gradual|/'grædʒuәl/a. 逐渐的, 渐增的;弥撒升阶圣歌
injured|/'indʒәd/a. 受伤的, 受损害的, 被触怒的; 受害的, 被害的
ruin|/ruin/n. 毁灭, 推翻, 废墟;毁灭, 衰败, 破坏, 破产, 堕落;使毁灭, 毁坏, 使破产
pepper|/'pepә/n. 胡椒粉, 胡椒, 辣椒; 胡椒;辣椒;花椒
winning|/'winiŋ/n. 胜利, 获得, 成功, 赢得物;得胜的, 胜利的
spray|/sprei/n. 水沫, 浪花, 水花, 喷雾, 喷雾器, 小树枝;喷雾, 扫射, 喷射;喷, 溅开
chop|/tʃɒp/n. 肋条肉, 排骨, 砍, 戳记, 商标;剁碎, 砍, 切击, 割断;砍, 突然转向
cough|/kɒf/n. 咳嗽;咳嗽;咳出
bore|/bɒ:/n. 令人讨厌的人, 激浪, 枪膛, 孔;使烦扰, 钻孔;钻孔;bear的过去式; 内径;孔径
offensive|/ә'fensiv/a. 令人不快的, 侮辱的, 攻击性的; 攻击的, 进攻的, 冒犯的
bake|/beik/vt. 烘焙, 烤;烤面包;烘焙, 烤
infect|/in'fekt/vt. 传染, 感染; 传染, 感染
hi|/hai/interj. 喂
senator|/'senәtә/n. 参议员, (某些大学的)理事; 参议员, 上议员
heal|/hi:l/vi. 痊愈;使复原, 使和解, 治愈
attorney|/ә'tә:ni/n. 代理人, 律师; 律师, 代理人
racing|/'reisiŋ/n. 赛马, 赛车; 空转, 急转
shaped|/ʃeipt/a. 成某种形状的, 制成一定形状的, 有某种形状的, 合适的, 计划好的, 有目标的; 具形的, 形似的
fry|/frai/n. 油炸食物, 鱼苗;油炸, 煎
organized|/'ɔ:^әnaizd/a. 有组织的, 组织起来的
abandoned|/ә'bændәnd/a. 被抛弃的, 无约束的, 恣意放荡的
threatening|/'θretniŋ/a. 胁迫的, 危险的; 威胁的, 恐吓的, 危险的
gamble|/'gæmbl/n. 赌博, 冒险;赌博, 孤注一掷
spite|/spait/n. 恶意, 怨恨, 使人烦恼的事物;故意刁难, 欺侮
CD|镭射碟, 镭射唱片; 光盘, 压缩盘, 载波检测, DOS内部命令:显示或改变当前目录
in|/in/prep. 在...期间, 在...之内, 处于...之中, 从事于, 按照, 穿着;进入, 朝里, 在里面, 在屋里;在里面的, 在朝的;执政者, 交情
can|/kæn/vt. 装罐;罐头, 容器;能, 可以; 作废字符
up|/ʌp/a. 向上的, 起床的, 涨的;向上, 上涨;在...上面, 向...的较高处
well|/wel/n. 井, 泉水, 源泉, 好;涌出;健康的, 良好的, 适宜的, 恰当的;很好地, 适当地, 好意地, 很, 完全;好啦
down|/daun/a. 向下的;下, 下去, 降下;往下, 沿着;丘陵, 软毛, 开阔的高地; 向下, 退下命令
last|/lɑ:st/a. 最后的, 末尾的, 最近的;持续, 支持, 维持;使维持, 够...用;最后, 后来;最后, 末尾, 鞋楦头
mean|/mi:n/a. 低劣的, 卑贱的, 简陋的, 吝啬的, 惭愧的, 平均的, 中间的, 普通的;意谓, 想要, 意欲, 预定;用意, 有意义;平均数, 中间, 中庸
case|/keis/n. 情形, 情况, 箱, 容器, 事实, 病例, 案例, 框子;装箱, 包盖
place|/pleis/n. 地方, 地点, 位置, 住所, 座位, 地位, 处境, 特权, 空间, 余地, 职务, 位;放置, 寄予, 认出, 评定, 任命;名次列前
long|/lɒŋ/a. 长的, 长久的, 冗长的, 做多头的;渴望, 热望, 极想;长久, 始终;长时间, 长信号, 长整型; 长, 长整型
court|/kɒ:t/n. 法院, 庭院, 奉承;献殷勤, 追求, 招致;求爱
lead|/li:d. led/n. 铅, 铅条, 领导, 超前量, 领引, 榜样, 主角, 导线;引导, 带领, 领导, 指挥, 致使, 加铅于, 用铅包;领导, 带头, 导致, 用测深锤测深, 被铅覆盖;带头的, 最重要的
kind|/kaind/n. 种类, 性质, 方式;亲切的, 仁慈的, 和蔼的
short|/ʃɒ:t/a. 短的, 近的, 矮的, 短期的, 简短的, 少量的;简短地, 突然;扼要, 短片, 缺乏;故意少给, 使短路
foreign|/'fɒ:rin/a. 外国的, 外交的, 外省的, 外来的, 不相关的; 外来的
present|/'preznt/n. 现在, 礼品, 瞄准;现在的, 出席的;介绍, 引见, 赠送, 提出, 呈现, 上演;举枪瞄准
fire|/'faiә/n. 火, 炉火, 电炉, 火灾, 闪光体, 炮火, 热情;点燃, 烧制, 使发光, 激动, 放枪, 解雇;着火, 烧火, 开枪, 射击, 激动
round|/raund/n. 圆, 圆形物, 巡回, 循环, 一轮, 一回合, 一局, 范围, 轮唱;圆的, 球形的, 丰满的, 肥胖的, 完全的, 大概的, 完美的, 圆润的;围着, 附近, 绕过, 在...周围;围绕着, 在周围, 迂回地, 挨个, 朝反方向;弄圆, 使成圆形, 绕行,…
sound|/saund/n. 声音, 语音, 吵闹, 声调, 听力范围, 探条, 海峡;健全的, 可靠的, 合理的, 健康的, 彻底的, 资金充实的;彻底地, 充分地;发出声音, 回响, 测深, 试探, 听起来;使发声, 宣告, 听诊, 测...深, 试探; 声音
sun|/sʌn/n. 太阳, 日, 日光, 阳光;晒;晒太阳
post|/pәust/n. 柱, 杆, 准星, 邮件, 邮政, 标竿, 职位, 岗位, 哨所, 兵营;张帖, 邮递, 公布, 登入帐, 使熟悉, 布置;快速行进;急速地; 记入;登记, 上电自检
fit|/fit/n. 适宜, 合身, 发作, 痉挛;适宜的, 对的, 准备好的;适合, 安装, 使合身, 使适应, 使合格;适合, 符合, 合身; 非特
consideration|/kәn.sidә'reiʃәn/n. 考虑, 原因; 考虑, 思考, 报酬
content|/kәn'tent/n. 内容, 满足, 意义, 要旨;满足的, 满意的;使...满足, 使...安心; 内容
estate|/i'steit/n. 不动产, (人生的)阶段, 阶层, 财产; 房地产, 遗产, 财产
cross|/krɒs/n. 十字架, 十字架形物件, 交叉, 十字标, 交叉路, 磨难, 杂交;生气的, 交叉的, 相反的;交叉, 横过, 越过; 交叉, 十字标
commitment|/kә'mitmәnt/n. 委托, 交押, 承担义务, 赞助; 院禁
introduction|/.intrә'dʌkʃәn/n. 介绍, 传入, 采用, 初步
row|/rәu. rau/n. 排, 行, 街道, 划船, 吵闹;使成排, 划, 划船, 参加(赛船), 痛骂;划船, 划动, 争吵; 行
instruction|/in'strʌkʃәn/n. 指令, 教导, 命令; 指令
congress|/'kɒŋgres/n. 国会, 会议, 讨论会; 会议, 会合
interpretation|/in.tә:pri'teiʃәn/n. 解释, 演出, 翻译; 插值;插值法;解释
variation|/.vєәri'eiʃәn/n. 变更, 变化, 变种, 变奏; 变异, 变易;变度
derive|/di'raiv/vt. 得自;起源
criterion|/krai'tiәriәn/n. 标准, 准则, 规范; 判据
effectively|/i'fektivli/adv. 有效地, 有力地, 实际上
observation|/.ɒbzә:'veiʃәn/n. 观察, 注意, 观测, 观察力; 观察
drawing|/'drɒ:iŋ/n. 图画, 制图, 拉; 绘图
hence|/hens/adv. 因此, 从此
exclude|/iks'klu:d/vt. 除外, 排除, 排斥; 除外(诊断)
mine|/main/n. 矿, 矿藏, 地雷;挖掘, 开采, 在...布雷, 破坏;开矿, 埋设地雷;我的
achievement|/ә'tʃi:vmәnt/n. 完成, 成就, 功业
similarly|/'similәli/adv. 相像地, 类似于
connect|/kә'nekt/v. 连接, 联合, 联系
accommodation|/ә.kɒmә'deiʃәn/n. 膳宿, 预订铺位, 适应性调节, 调和, 贷款; 调节(眼);适应
topic|/'tɒpik/n. 主题, 论题, 话题
interpret|/in'tә:prit/vt. 解释, 演出, 翻译, 理解;翻译, 解释
secondary|/'sekәndәri/a. 中级的, 中等的, 次要的, 第二的, 从属的, 辅助的; 仲(指CH-3...CH(CH-3)-型支链烃基或指二元胺及R-2CHOH型的醇);第二
extension|/ik'stenʃәn/n. 延长, 扩充, 范围, 扩展名;伸缩的; 扩展名, 扩充名
possess|/pә'zes/vt. 持有, 占有, 拥有, 克制, 支配, 迷住; 持有, 占有, 具有
analyse|/'ænәlaiz/vt. 分析, 细察, 分解; 分析
calculate|/'kælkjuleit/v. 计算, 预测, 计划, 打算
restrict|/ri'strikt/vt. 限制, 限定, 约束; 限制
distinguish|/dis'tiŋgwiʃ/v. 区别, 辨别
creature|/'kri:tʃә/n. 人, 动物, 创造物, 生物
locate|/'lәukeit/vt. 找出, 设于, 位于;定居
presentation|/.prezәn'teiʃәn/n. 赠与, 描述, 介绍; 简报
possession|/pә'zeʃәn/n. 拥有, 占有, 所有, 财产, 领土, 领地, 自制, 着迷; 占有, 持有
certificate|/sә'tifikeit/n. 证书, 证明书;发给证明书, 用证书批准, 用证书证明
custom|/'kʌstәm/n. 习惯, 风俗, 海关, 自定义;定制的; 定制;自定义
qualification|/.kwɒlifi'keiʃәn/n. 资格, 条件, 限制; 限定
cheek|/tʃi:k/n. 颊, 厚颜, 脸蛋; 颊
carpet|/'kɑ:pit/n. 地毯, 地毯状物;铺以地毯, 铺盖
curve|/kә:v/n. 曲线, 弯曲, 曲线球;弯, 使弯曲;成曲形
briefly|/'brifli/adv. 简短地, 扼要地, 简明地, 简单地
helpful|/'helpful/a. 有帮助的, 有益的, 有用的
assure|/ә'ʃuә/vt. 保证, 使确信, 弄清楚, 担保; 确信, 保证, 保障
preference|/'prefәrәns/n. 偏爱, 优先, 喜爱物; 首选项
prayer|/prєә. 'preiә/n. 祈祷, 恳求, 祷辞, 祈祷者
concerning|/kәn'sә:niŋ/prep. 关于; 关于
distribute|/di'stribju:t/vt. 分配, 散布, 分发; 分配, 分发
measurement|/'meʒәdmәnt/n. 尺寸, 度量, 度量单位; 度量, 度量单位
disabled|/dis'eibld/a. 残废的, 有缺陷的, 失效的; 失效的
primarily|/'praimәrili/adv. 主要地, 首先地
satisfaction|/.sætis'fækʃәn/n. 满足, 满意, 快事, 赔偿, 赎罪, 报仇的机会; 偿还, 赎回
interval|/'intәvәl/n. 间隔, 距离, 间歇, 间隙; 时间间隔
confusion|/kәn'fju:ʒәn/n. 混乱, 混淆, 无秩序; 含混
provided|/prә'vaidid/conj. 倘若, 以...为条件
sheep|/ʃi:p/n. 羊, 胆小者
summary|/'sʌmәri/n. 摘要, 概要;摘要的, 简略的; 摘要;概要
practise|/'præktis/v. 实践, 实行, 练习, 实习, 从事(职业)
cheque|/tʃek/n. 支票
precise|/pri'sais/a. 精确的, 严谨的, 明确的; 精密的, 正确的
satisfy|/'sætisfai/vt. 使满意, 满足, 符合, 使确信, 赔偿;令人满意, 替人赎罪
determination|/di.tә:mi'neiʃәn/n. 决心, 果断; 判定;测定
silly|/'sili/a. 愚蠢的, 糊涂的
bush|/buʃ/n. 矮树丛; 管衬
brick|/brik/n. 砖块, 积木;用砖做的;用砖造, 用砖砌
adapt|/ә'dæpt/vt. 使适应, 改编;适应
unemployed|/.ʌnim'plɒid/a. 失业的, 未被利用的; 没有被雇用的, 失业的, 没有被利用的
tongue|/tʌŋ/n. 舌, 语言能力, 讲话方式, 语言;舔, 斥责, 发...的音;使用舌头, 吹管乐器
classroom|/'klɑ:sru:m/n. 教室
mouse|/maus/n. 老鼠, 胆小羞怯的人, 鼠标;捕鼠, 窥探;探出; 鼠标
weakness|/'wi:knis/n. 虚弱, 薄弱, 弱点; 欲振乏力
ceiling|/'si:liŋ/n. 天花板; 顶点, 顶线, 上限
absorb|/әb'sɒ:b/vt. 吸收, 使全神贯注, 同化, 买进, 理解, 承受, 忍受, 承担; 吸收
pretend|/pri'tend/v. 假装, 伪称, 自命, 自称
grateful|/'greitful/a. 感谢的, 感激的, 令人快意的, 受欢迎的
aged|/'eidʒid/a. 老的, 陈的, 有...岁的; 老化的;老化了的;陈化的;陈化了的
excitement|/ik'saitmәnt/n. 刺激, 兴奋; 兴奋, 激动
deaf|/def/a. 聋的; 聋的
confine|/kәn'fain/vt. 限制, 使不外出, 禁闭;邻接, 交界;边缘, 范围, 区域
reception|/ri'sepʃәn/n. 接待, 接受, 招待会; 接受, 感受
purely|/'pjuәli/adv. 纯粹地, 清白地, 贞洁地
shelf|/ʃelf/n. 架子, 搁板; 架子
continuous|/kәn'tinjuәs/a. 连续的, 继续的, 连续不断的; 连续的
tin|/tin/n. 锡, 马口铁, 罐头;在...镀锡于;锡制的; tin阅读程序
clerk|/klә:k/n. 办事员, 职员, 文书;当店员
trousers|/'trauzәz/pl. 裤子, 长裤
grammar|/'græmә/n. 语法学, 入门书; 语法检查
funeral|/'fju:nәrәl/n. 葬礼, 出殡
pig|/pig/n. 猪, 猪肉, 贪婪的人, 猪一样的人;生小猪, 象猪般地生活
wander|/'wɒndә/vi. 游荡, 漫步, 徘徊, 迷路, 离题, 蜿蜒;在...漫游
punishment|/'pʌniʃmәnt/n. 处罚, 刑罚, 惩罚; 罚, 处罚, 刑罚
flesh|/'fleʃ/n. 肉, 肉体, 肉欲, 人性, 亲属, 人类, 众生, 人体;以肉喂, 激起...的杀戳情绪, 使肥, 赋以血肉;长胖
asleep|/ә'sli:p/a. 睡着的, 长眠的, 麻木的;熟睡地
hurry|/'hʌri/n. 匆忙, 急忙, 急促;急派, 催促;匆忙, 赶快
printer|/'printә/n. 印刷工, 打印机; 打印机
upstairs|/'ʌp'stєәz/a. 楼上的;在楼上, 向楼上, 处于更高地位;楼层
hers|/hә:z/pron. 她的
outer|/'autә/a. 外部的, 外面的, 在外的, 远离中心的; 外部的, 外面的, 外侧的
machinery|/mә'ʃi:nәri/n. 机器, 机械装置, 机构; 机械
petrol|/'petrәl/n. 汽油; 汽油, 挥发油, 石油
organ|/'ɒ:gәn/n. 风琴, 器官, 元件, 机构, 机关; 风琴
anticipate|/æn'tisipeit/vt. 预期, 占先, 加速, 提前使用; 提前出现, 先期发生
attraction|/ә'trækʃәn/n. 吸引, 吸引人的事物, 吸引力; 吸引
garage|/gә'rɑ:ʒ. 'gærɑ:ʒ/n. 车库, 汽车修理厂, 机库;把车送入修车场
slope|/slәup/n. 倾斜, 斜坡, 斜率, 扛枪姿势;使倾斜, 弄斜, 扛;倾斜, 走, 逃走
informal|/in'fɒ:mәl/a. 非正式的, 不拘礼的, 通俗的; 非正式的, 日常使用的
silk|/silk/n. 丝, 绸, 绸锻类, 丝织品;丝的, 丝织的
disc|/disk/n. 圆盘, 唱片;灌唱片
essay|/'esei. e'sei/n. 随笔, 短文, 评论, 企图;试图
logical|/'lɒdʒikәl/a. 合乎逻辑的, 合理的; 逻辑的, 符合逻辑的
electrical|/i'lektrikәl/a. 电的, 有关电的; 电的
logic|/'lɒdʒik/n. 逻辑, 逻辑学, 推理的方法, 推理, 逻辑性; 逻辑
flame|/fleim/n. 火焰, 火舌, 热情, 光辉;焚烧, 用火焰给...灭菌, 用火焰传送(信号), 点燃, 激动;燃烧, 爆发, 闪耀; 无聊邮件, 无益邮件
wherever|/hwєәr'evә/adv. 无论哪里
rubbish|/'rʌbiʃ/n. 废物, 垃圾, 胡说
valid|/'vælid/a. 有确实根据的, 有法律效力的, 正当的, 正确的; 有效的
mineral|/'minәrәl/n. 矿物, 无机物, 苏打水;矿物的, 似矿物的
swear|/swєә/vt. 发誓, 咒骂, 使宣誓;发誓, 诅咒;诅咒, 誓言
stranger|/'streindʒә/n. 陌生人, 门外汉; 局外人, 非当事人, 第三者
rub|/rʌb/n. 摩擦, 困难, 障碍, 磨损处;擦, 搓, 摩擦, 惹怒;摩擦, 擦破
needle|/'ni:dl/n. 针, 尖;用针缝;缝纫; 探针
disturb|/dis'tә:b/vt. 扰乱, 妨碍, 使不安; 滋扰, 扰乱
advertisement|/.ædvә'taizmәnt/n. 广告, 启事, 广告宣传; 广告, 公告, 告示
hesitate|/'heziteit/vi. 犹豫, 迟疑, 踌躇, 支吾, 停顿
translate|/træns'leit/vt. 翻译, 解释, 转化, 转变为, 调动;翻译, 被译; 转换
swallow|/'swɒlәu/n. 燕子, 吞咽, 喉;咽, 淹没, 吞没, 耗尽, 轻信, 忍受, 抑制;吞下, 咽下
farming|/'fɑ:miŋ/n. 农业, 耕作
removal|/ri'mu:vl/n. 移动, 移居, 迁移, 排除, 切除; 切除, 除去
cloth|/klɒ:θ. klɒθ/n. 布料, 织品, 布; 布
taxi|/'tæksi/n. 出租车;乘出租车;用出租车送
shine|/ʃain/n. 光泽, 阳光;使发光;照耀, 发光, 发亮
dictionary|/'dikʃәnәri/n. 字典, 词典; 词典
rope|/rәup/n. 绳, 索, 粗绳, 绞索, 决窍;捆, 缚, 绑, 圈起, 以绳将...系住;拧成绳状
lamp|/læmp/n. 灯;照亮; 逻辑模拟分析系统
knit|/nit/v. 编织, 结合
tonne|/tʌn/n. 吨, 公吨; 吨
interrupt|/.intә'rʌpt/vt. 中断, 妨碍, 插嘴;打断;中断; 中断
forgive|/fә'giv/vt. 原谅, 宽恕, 免除; 免除, 宽恕, 原谅
battery|/'bætәri/n. 电池, 殴打; 蓄电池
devote|/di'vәut/vt. 投入于, 献身
typically|/'tipikәli/adv. 代表性地;作为特色地
piano|/pi'ɑ:nәu/n. 钢琴
insect|/'insekt/n. 昆虫, 卑鄙的人; 昆虫
closed|/klәuzd/a. 关闭的, 限于少数人的; 关闭指令
convenient|/kәn'vi:njәnt/a. 方便的, 合宜的; 适当的, 合理而可行的, 方便的
artificial|/.ɑ:ti'fiʃәl/a. 人造的, 假的, 非原地产的; 人工的, 人造的, 伟牟
heating|/'hi:tiŋ/n. 加热, 供热, 暖气设备, 供暖系统, 暖气装置;加热的, 供暖的
naked|/'neikid/a. 裸体的, 无装饰的, 无保护的, 赤贫的; 裸露的
strictly|/'striktli/adv. 严格地, 确实地
regarding|/ri'gɑ:diŋ/prep. 关于
disadvantage|/.disәd'vɑ:ntidʒ/n. 缺点, 不利, 坏处
mud|/mʌd/n. 泥, 诽谤;弄脏
lorry|/'lɒri/n. 卡车, 货车; 载重汽车
warmth|/wɒ:mθ/n. 温暖, 温情, 暖和, 激动, 生气
uncertain|/.ʌn'sә:tn/a. 不确定的, 无常的, 不确信的, 不可预测的; 不确定的, 未定的, 不确信的
heel|/hi:l/n. 脚后跟, 踵, 后部, 倾侧;尾随, 装以鞋跟, 倾侧, 追赶;紧随, 用脚后跟传球
toilet|/'tɒilit/n. 厕所, 梳妆;梳妆, 打扮, 上厕所;给...梳妆打扮
menu|/'menju:/n. 菜单, (功能)选择单; 菜单
chemistry|/'kemistri/n. 化学, 化学过程; 化学
nail|/neil/n. 钉子, 指甲;用钉钉牢, 使固定, 截住, 揭露
adventure|/әd'ventʃә/n. 冒险, 冒险经历;冒险
refusal|/ri'fju:zl/n. 拒绝, 推却, 优先决定权; 拒绝, 谢绝, 取舍权
painter|/'peintә/n. 画家, 油漆匠; 油漆匠, 喷漆匠
formerly|/'fɒ:mәli/adv. 从前, 以前
skirt|/skә:t/n. 裙子, 下摆, 边缘, 郊区;位于...边缘, 绕过, 回避;位于边缘
mathematics|/.mæθә'mætiks/n. 数学; 数学
confused|/kәn'fju:zd/a. 困惑的, 混乱的
realistic|/riә'listik/a. 现实的, 逼真的, 现实主义的, 实在论的
unite|/ju:'nait/vi. 联合, 接合, 混合;使联合, 统一, 使粘合, 使结合
ridiculous|/ri'dikjulәs/a. 荒谬的, 可笑的
receipt|/ri'si:t/n. 收据, 收入, 收到;开...的收据
unnecessary|/.ʌn'nesәsәri/a. 不必要的
invent|/in'vent/vt. 发明, 创作, 虚构; 发明
educate|/'edjukeit/vt. 教育, 培养, 训练
envelope|/'envәlәup/n. 信封, 封套, 封袋; 膜, 包袋
hungry|/'hʌŋgi/a. 饥饿的, 荒年的, 渴望的, 不毛的; 欠鞣皮
fetch|/fetʃ/n. 取得, 拿, 诡计, 魂;接来, 取来, 售得, 带来, 推出, 引出, 杀死, 吸引, 到达;取物, 前进; 取
crack|/kræk/n. 裂缝, 爆裂声;(使)爆裂, (使)裂开, (使)发出爆裂声;第一流的;啪地一声
cupboard|/'kʌpbɒ:d/n. 食橱, 碗柜, 餐具柜
faint|/feint/n. 昏厥, 昏倒;模糊的, 微弱的, 无力的;昏倒, 变得微弱
accent|/'æksәnt/n. 重音, 口音, 特点, 注重点;重读, 加重音号于, 强调
shower|/'ʃauә/n. 阵雨, 淋浴, 一阵, 展出者, 显示者;淋浴, 下阵雨;淋湿, 倾注
physics|/'fiziks/n. 物理学, 物理过程, 物理现象; 物理;物理学
delicate|/'delikәt/a. 细致优雅的, 微妙的, 美味的; 柔弱的
wool|/wul/n. 羊毛, 毛织物, 毛线, 绒线; 羊毛, 绒毛, 棉
steep|/sti:p/n. 浸渍, 悬崖;险峻的, 陡峭的, 急剧升降的, 夸大的;浸, 泡
insert|/in'sә:t/n. 插入物;插入, 把(人造卫星)射入(轨道), 添写;附着; 插入
forever|/fә'revә/adv. 永远
dull|/dʌl/a. 钝的, 无趣的, 呆滞的, 阴暗的;使迟钝, 使阴暗, 缓和;变迟钝, 减少
backwards|/'bækwәdz/adv. 向后
pity|/'piti/n. 遗憾, 同情, 怜悯, 憾事, 可惜;同情, 怜悯;觉得可怜, 有同情心
packet|/'pækit/n. 小包, 一批信件, 大量, 信息包;打包, 装进小包; 分组, 分组报文, 数据分组
skilled|/'skild/a. 熟练的; 熟练的, 有技能的
lung|/lʌŋ/n. 肺, 肺脏, 空地; 肺
swimming|/'swimiŋ/n. 游泳, 眩晕
damp|/dæmp/n. 潮湿, 湿气;潮湿的;使潮湿, 使阻尼, 抑止;变潮湿, 衰减
hunting|/'hʌntiŋ/n. 狩猎, 猎狐, 探求; 寻找平衡;寻找
vertical|/'vә:tikl/a. 垂直的, 直立的; 垂直的, 顶的, 头顶的
ambulance|/'æmbjulәns/n. 救护车; 救护车
nest|/nest/n. 巢, 窝, 休息所, 隐匿处;筑巢, 找鸟巢;为...设窝, 使套叠; 嵌套
parallel|/'pærәlel/n. 平行, 对比, 相匹敌之物;平行的, 相似的;与...平行, 与...相似, 相比, 使平行; 并联;并行
exhibit|/ig'zibit/n. 显示, 显现, 展览品, 陈列品, 展览;展现, 陈列, 展览;开展览会
tropical|/'trɒpikl/a. 热带的, 热情的; 热带的
disappointment|/.disә'pɒintmәnt/n. 失望
diamond|/'daiәmәnd/n. 钻石, 菱形; 菱形
neighbourhood|/'neibәhud/n. 邻接, 周围, 附近一带, 邻近, 邻居关系, 地区, 街道, 街坊, 四邻; 邻域
ours|/'auәz/pron. 我们的
thief|/θi:f/n. 小偷, 贼; 取样
geography|/dʒi'ɒgrәfi/n. 地理学, 地理; 地理
pint|/paint/n. 品脱(干量或液量的单位); 量磅, 品脱
translation|/træns'leiʃәn/n. 翻译, 译文, 转化, 调任, 平移, 转译; 转换
toe|/tәu/n. 足趾, 趾部, 脚趾;以趾踏触, 用脚尖走;动脚尖
blade|/bleid/n. 叶片, 刀锋, 刀口, 剑; 页;, 叶片, 刀片, 刀刃, 刀口
alternatively|/ɒ:l'tә:nәtivli/adv. 非此即彼
substantially|/sәb'stænʃәli/adv. 实质上, 本质上, 大体上
unfortunate|/.ʌn'fɒ:tʃәnit/a. 不幸的, 不合适的, 不吉利的
freely|/'fri:li/adv. 自由地, 随意地, 无拘束地, 直率地, 坦白地, 慷慨地, 免费地, 大量地; 浮动地
definite|/'definit/a. 明确的, 一定的; 明确的, 确切的, 一定的
upwards|/'ʌpwәdz/adv. 以上, 向上
supermarket|/'sju:pәmɑ:kit/n. 超级市场; 超级市场, 自助售货商店
nonsense|/'nɒnsәns/n. 无意义的事, 荒谬言行, 荒唐
horn|/hɒ:n/n. 角, 角质, 喇叭, 号角;角制的;用角触, 长角于
awkward|/'ɒ:kwәd/a. 笨拙的, 棘手的
affection|/ә'fekʃәn/n. 影响, 病, 喜爱, 情感, 倾向; 疾患, 病变, 病;感情
excited|/ik'saitid/a. 兴奋的, 已励磁的, 已激发的, 激昂的, 激动的
dissolve|/di'zɒlv/v. 溶解, 解散
stiff|/stif/a. 坚硬的, 严厉的, 呆板的, 生硬的, 刚强的, 强烈的, 粘的, 稠的, 艰难的;死尸, 醉鬼, 钞票;不肯付...小费
boring|/'bɒ:riŋ/a. 烦人的, 无聊的, 无趣的; 成孔期, 搪孔
container|/kәn'teinә/n. 容器, 集装箱; 集装箱;贮存箱;容器(任何一种)
arrow|/'ærәu/n. 箭, 箭状物, 箭头记号
dot|/dɒt/n. 点, 圆点, 小数点, 小东西, 嫁妆;作小点记号, 加小点于;打上点; 点
lively|/'laivli/a. 活泼的, 鲜明的, 生动的
reservation|/.rezә'veiʃәn/n. 保留, 预定, 保留品, 保留地; 预定, 预约, 权益保留
artistic|/ɑ:'tistik/a. 艺术的, 艺术家的, 富有艺术性的
suck|/sʌk/vt. 吸, 吮, 吸入, 吮吸, 吸收;吸, 吸奶;吸, 吸入, 吮吸
ruler|/'ru:lә/n. 统治者, 管理者, 尺, 直尺;划线板; 标尺
reproduce|/.ri:prә'dju:s/v. 繁殖, 再生, 复制, 生殖; 复制
elbow|/'elbәu/n. 手肘, 弯头, 扶手;用手肘推开, 推挤
tent|/tent/n. 帐篷, 帷幕, 住处, 塞条, 塞子;住帐蓬, 宿营, 暂时居住;用帐篷遮盖, 使住帐篷, 用塞条嵌入
sleeve|/sli:v/n. 袖子, 套管;缝上袖子
exam|/ig'zæm/n. 考试, 测验
drawer|/'drɒ:ә/n. 抽屉, 开票人; 抽屉
grandfather|/'grændfɑ:ðә/n. 祖父, 始祖; 原始资料组
drunk|/drʌŋk/a. 喝醉了的;drink的过去式
oven|/'ʌvәn/n. 烤箱, 灶, 子宫; 烘箱
broadly|/'brɒ:dli/adv. 宽广地, 明白地, 无礼貌地
biscuit|/'biskit/n. 饼干; 素坯;饼干
chin|/tʃin/n. 下巴, 颏; 颏
indirect|/.indi'rekt/a. 间接的, 非直截了当的, 不坦率的; 间接的
decrease|/'di:kri:s/n. 减少, 减少量;减少
atom|/'ætәm/n. 原子, 核能, 微粒, 微量; 原子
encouragement|/in'kʌridʒmәnt/n. 鼓励, 激励, 奖励; 怂恿, 煽动, 助长
depressed|/di'prest/a. 沮丧的, 降低的; 抑郁的, 阻抑的, 压低的, 凹;的, 扁平的
shallow|/'ʃælәu/n. 水浅的地方, 浅滩;浅的, 肤浅的;(使)变浅
powder|/'paudә/n. 粉, 粉末, 火药;搽粉于, 搽粉, 撒粉, 使成粉末;搽粉, 变成粉末
signature|/'signәtʃә/n. 签字, 识别标志, 调号; 签名附件
nut|/nʌt/n. 坚果, 核心, 螺帽; Novell NetWare服务器实用程序
sympathetic|/.simpә'θetik/a. 有同情心的, 合意的, 赞成的;交感神经, 容易感受的人
spoil|/spɒil/n. 战利品, 赃物, 奖品, 变质, 次品;损坏, 破坏, 溺爱;腐坏, 掠夺
soap|/sәup/n. 肥皂, 阿谀;以肥皂洗, 阿谀; 评语
beef|/bi:f/n. 牛肉, 肌肉;养(牛), 宰(牛);抱怨, 告发
zero|/'ziәrәu/n. 零, 零点, 零度, 无, 乌有, 最低点;零的, 没有的;调零, 对(炮火等)作协调校正; 零
absent|/'æbsәnt/a. 缺席的, 不在的, 缺乏的, 漫不经心的;使缺席
lump|/lʌmp/n. 块, 瘤, 很多, 肿块, 笨人;使成块状, 混在一起;结块
whoever|/hu'evә/pron. 任何人, 无论谁
blank|/blæŋk/n. 空格, 空白;空白的, 空虚的, 完全的, 无色的;消失, 成为空白;使无效, 取消, 封锁; 空白
grandmother|/'grændmʌðә/n. 祖母, 女祖先
liquid|/'likwid/n. 液体, 流体, 流音;液体的, 透明的, 明亮的, 流动的, 易变的
Polish|/'pɒliʃ/a. 波兰的;波兰人, 上光剂, 光泽, 优雅;擦亮, 擦去, 使完美;擦亮, 变得光亮
soup|/su:p/n. 汤, 马力;加速, 增加马力
waist|/weist/n. 腰部, 腰; 腰
ankle|/'æŋkl/n. 踝; 踝, 踝关节
wrist|/rist/n. 手腕, 腕关节; 腕
tomato|/tә'mɑ:tәu/n. 番茄, 西红柿
km|千米, 公里
practically|/'præktikli/adv. 几乎, 差不多, 事实上
enthusiastic|/in.θju:zi'æstik/a. 狂热的, 热心的, 热烈的
loyal|/'lɒiәl/a. 忠诚的, 忠实的, 忠贞的
suspicious|/sә'spiʃәs/a. 可疑的, 多疑的, 怀疑的; 怀疑的, 令人怀疑的, 可疑的
uncomfortable|/.ʌn'kʌmfәtәbl/a. 不舒服的, 不自在的, 不安的
suffering|/'sʌfәriŋ/n. 苦难, 受苦
highway|/'haiwei/n. 公路, 大道, 捷径; 公路, 大路
cruel|/'kru:әl/a. 残酷的, 令人极痛苦的; 残忍的, 残酷的
embarrassment|/im'bærәsmәnt/n. 困难, 阻碍, 困窘; 窘迫
ugly|/'ʌgli/a. 丑陋的, 邪恶的, 险恶的, 不祥的;丑陋的人(或物)
tyre|/'taiә/n. 轮胎;装轮胎于
thumb|/θʌm/n. 拇指;以拇指拨弄, 笨拙地摆弄, 用拇指翻旧, 迅速翻阅, 作搭车手势
honestly|/'ɒnistli/adv. 真诚地, 公正地
statue|/'stætju/vt. 以雕像装饰;雕像
pencil|/'pensl/n. 铅笔, 色笔, 眉笔, 画笔, 光线束;用铅笔写或涂, 草拟
melt|/melt/n. 熔化, 熔化物, 溶解;(使)熔化, (使)溶解, (使)消散, (使)变软
glove|/glʌv/n. 手套;给...戴手套
timetable|/'taimteibl/n. 时间表
lid|/lid/n. 盖子, 限制, 眼睑;给...盖盖子
decoration|/.dekә'reiʃәn/n. 装饰, 装饰品
bored|无聊的;烦人的;无趣的
worship|/'wә:ʃip/n. 崇拜, 礼拜, 尊敬;参加礼拜;崇拜, 尊敬
lemon|/'lemәn/n. 柠檬, 柠檬树, 柠檬色; 柠檬
girlfriend|女朋友
dancer|/'dɑ:nsә/n. 舞蹈演员, 跳舞者
salad|/'sælәd/n. 色拉
confuse|/kәn'fju:z/vt. 使混乱, 使狼狈, 使困惑; 混淆
useless|/'ju:slis/a. 无用的, 无效的, 无益的; 无用, 无价值, 无效
disagree|/.disә'gri:/vi. 不一致, 不适宜; 抵触, 不同意, 争执
punish|/'pʌniʃ/vt. 处罚, 惩罚, 严厉对待;惩罚
unpleasant|/.ʌn'pleznt/a. 使人不愉快的, 使人厌恶的, 煞风景的
shooting|/'ʃu:tiŋ/n. 发射, 猎场, 射击
embarrassed|/im'bærәst/a. 尴尬的;窘迫的
bullet|/'bulit/n. 子弹; 弹, 子弹, 距节(马)
varied|/'vєәrid/a. 不同的, 杂色的, 各式各样的; 不同的, 种种的, 变化的
invention|/in'venʃәn/n. 发明, 创作能力, 虚构的故事; 发明
mysterious|/mis'tiәriәs/a. 神秘的, 难解的, 不可思议的
jewellery|/'dʒu:әlri/n. 宝石, 贵重饰物, 珠宝, 宝石饰物, 受珍视的人/物, 宝贝, 有价值的人/物
tablet|/'tæblit/n. 平板, 门牌, 笔记簿, 碑, 匾, 药片; 片剂
awake|/ә'weik/a. 醒着的;唤醒, 唤起, 使意识到;醒来, 被唤起, 意识到
feather|/'feðә/n. 羽毛;长羽毛;用羽毛装饰
towel|/'tauәl/n. 手巾, 毛巾;擦干身子
jeans|/dʒi:nz/n. 工装裤, 牛仔裤
boyfriend|/'bɔifrend/n. 男朋友
passing|/'pæsiŋ/n. 通过, 逝去, 死, 流逝;经过的, 流逝的, 目前的, 短暂的, 及格的, 仓促的
exit|/'eksit/n. 出口, 退场, 离去, 去世;退出, 脱离, 去世; 退出;DOS内部命令:本命令用于退出当前的命令处理器(COMMAND.COM);恢复前一个命令处理器
steer|/stiә/vt. 引导, 驾驶, 航行, 控制;驾驶, 掌舵, 行驶;驾驶指示, 劝告
patience|/'peiʃәns/n. 耐性, 忍耐
revise|/ri'vaiz/n. 校订, 修正, 改样;校订, 修正, 校正
pronounce|/prә'nauns/v. 发音, 宣告, 断言
dislike|/dis'laik/n. 嫌恶;讨厌, 不喜欢
obey|/ә'bei/vt. 服从, 遵从, 顺从;服从
hammer|/'hæmә/n. 锤, 铁锤, 钉锤;锤打, 敲打, 钉;连续锤打; 锤头
openly|/'әjpәnli/adv. 公开地, 坦率地, 直率地, 公然地
crush|/krʌʃ/n. 压碎, 粉碎, 群众, 迷恋;压破, 征服, 塞, 弄皱, 榨出;被压碎, 起皱, 挤
polite|/pә'lait/a. 有礼貌的, 文雅的, 客气的, 有教养的
fashionable|/'fæʃәnәbl/a. 时髦的, 上流社会的, 流行的
devoted|/di'vәutid/a. 投入的, 深爱的
headache|/'hedeik/n. 头痛, 令人头痛之事; 头痛
surroundings|/sә'rajndiŋz/n. 环境, 周围的事物; 环境
thread|/θred/n. 线, 丝, 纤维, 线索;穿线于, 穿过, 通过, 用线穿成;穿过; 线索, 线程
scratch|/skrætʃ/n. 抓痕, 搔, 抓, 擦伤, 刮擦声, 乱写, 零分, 起跑线;搔, 抓, 挖出, 擦, 刮, 乱涂, 勾抹掉;搔, 抓, 发刮擦声, 勉强糊口;碰巧的, 凑合的, 打草稿用的; 擦除
unconscious|/.ʌn'kɒnʃәs/a. 未意识到的, 无意识的, 无知觉的; 人事不省的, 神志丧失的;无意识的
multiply|/'mʌltiplai/v. 繁殖, 乘, 增加; 乘
fur|/fә:/n. 毛皮;以毛皮制作, 使生苔, 使生水垢;生苔, 积水垢
chemist|/'kemist/n. 化学家, 药剂师; 化学家;化学师;化学工作者;药剂师;药房
fame|/feim/n. 名望, 名声, 传说
cheerful|/'tʃiәful/a. 快活的, 高兴的, 兴高采烈的
frighten|/'fraitn/vt. 使惊吓;惊恐
disagreement|/.disә'gri:mәnt/n. 不合, 争论, 不一致; 不一致, 不同意, 陪审团的意见不一
sailor|/'seilә/n. 水手, 船员, 海员; 水手, 船员, 海员
knot|/nɒt/n. 结, 群, 难题;打结, (使)纠缠
sock|/sɒk/n. 短袜, 鞋垫, 一击;重击, 猛投, 给...穿袜;打击;正着地, 不偏不倚地;非常成功的
snake|/sneik/n. 蛇, 阴险的人;曲折行进;迂回, 拉, 急抽
scared|/skeәd/a. 害怕的, 担惊受怕的, 惊慌的, 吓坏了的
unacceptable|/.ʌnәk'septәbl/a. 无法接受的, 不受欢迎的; 不能接受的, 不受欢迎的, 难以承认的
onion|/'ʌnjәn/n. 洋葱;因洋葱使掉泪
sweat|/swet/n. 汗, 汗水, 水珠, 焦急;出汗, 渗出, 冒出水气, 结水珠, 烦恼, 懊恼;使出汗, 流出, 榨出, 使汗流浃背
curl|/kә:l/n. 拳曲, 鬈发;弄卷;拳曲, 弯曲
rob|/rɒb/v. 抢夺, 抢掠, 剥夺
retired|/ri'taiәd/a. 隐退的, 退休的, 退役的; 退休的, 已收回的
noisy|/'nɒizi/a. 嘈杂的, 喧闹的; 噪声的, 嘈杂的
ending|/'endiŋ/n. 终止, 终了, 收场; 末梢
frozen|/'frәuzn/a. 冻结的, 冰冷的, 严寒的, 冻伤的, 冷酷的;freeze的过去分词
worrying|/'wʌriiŋ/a. 使人烦恼的, 忧虑重重的
rubber|/'rʌbә/n. 橡皮, 橡胶, 做摩擦动作的人, 按摩师, 决胜盘;用橡胶制造, 涂橡胶于
dying|/'daiiŋ/a. 垂死的; 快要死的, 垂死的, 临终的
passport|/'pæspɒ:t/n. 护照, 手段, 通行证; 通行证, 护照
ashamed|/ә'ʃeimd/a. 惭愧的, 羞耻的
quit|/kwit/vi. 离开, 辞职, 停止;离开, 放弃, 使解除, 停止;离开; 结束, 退出
shy|/ʃai/n. 惊跳, 惊避;胆怯的, 畏缩的, 迟疑的, 羞怯的;惊退, 乱投, 乱掷, 厌恶, 避开;乱投, 乱掷
bicycle|/'baisikl/n. 自行车
inability|/.inә'biliti/n. 无能, 无力
purple|/'pә:pl/n. 紫色, 帝位;紫色的, 帝王的, 华而不实的;(使)成紫色
fever|/'fi:vә/n. 发烧, 发热, 热病; 发热, 热
hatred|/'heitrid/n. 憎恨, 仇恨, 憎恶; 敌意, 憎恨, 憎恶
flour|/'flauә/n. 面粉, 粉沫, 碎粉; 面粉, 麦粉
bin|/bin/n. (贮存谷物等的)容器, 箱子; 二进制, 商业信息网
keyboard|/'ki:bɒ:d/n. 键盘; 键盘
outdoor|/'autdɒ:/a. 户外的, 屋外的, 露天的
biology|/bai'ɒlәdʒi/n. 生物学; 生物;生物学
photography|/fә'tɒgrәfi/n. 摄影, 摄影术; 照相术
screw|/skru:/n. 螺旋, 螺杆, 螺钉, 螺旋桨, 吝啬鬼;调节, 扭紧, 旋, 拧, 加强, 压榨, 勒索;转动, 旋, 拧
fridge|/fridʒ/n. 电冰箱
swell|/swel/n. 增大, 隆起的部分, 巨浪, 肿胀;优秀的, 一流的;增大, 膨胀, 肿胀, 增强, 骄傲;使膨胀, 使增大, 使上涨, 使骄傲
promptly|/'prɒmptli/adv. 敏捷地, 迅速地
offend|/ә'fend/v. 犯罪, 冒犯, 违反, 进攻
faithful|/'feiθful/a. 忠实的, 详确的, 可靠的;信徒
umbrella|/ʌm'brelә/n. 伞, 雨伞, 保护伞;伞的, 包罗万象的;用伞遮掩
underneath|/.ʌndә'ni:θ/adv. 在下面;在...的下面
bubble|/'bʌbl/n. 泡沫;冒泡, 沸腾;使冒泡, 滔滔不绝地说
jam|/dʒæm/n. 果酱, 拥塞之物, 堵塞, 困境;挤进, 使塞满, 混杂, 压碎, 使堵塞;堵塞, 轧住, 拥挤
unwilling|/.ʌn'wiliŋ/a. 不愿意的, 勉强的; 不愿意的, 勉强的, 不服从的
nicely|/'naisli/adv. 漂亮地, 谨慎地, 恰好地
fork|/fɒ:k/n. 叉子, 叉状物, 分岔;分支, 分歧;做成叉形, 叉起; 派生指令
dirt|/dә:t/n. 污垢, 泥土; 污垢
poison|/'pɒizn/n. 毒药, 毒, 毒物, 有毒害的事物;毒害, 毒杀, 使中毒;放毒, 下毒
beard|/biәd/n. 胡须;抓住胡须, 公开反对
unusually|/ʌn'ju:ʒәli/adv. 不寻常地, 异乎寻常地, (非正式)非常
disappointing|/.disә'pɒintiŋ/a. 使失望的, 期待落空的, 令人沮丧的
rude|/ru:d/a. 粗鲁无礼的, 粗陋的, 粗暴的, 原始的, 未开化的, 大略的, 崎岖不平的, 狂暴的
unsuccessful|/.ʌnsәk'sesful/a. 不成功的
repeated|/ri'pi:tid/a. 重复的, 再三的; 反复的, 再三的, 屡次的
chew|/tʃu:/vt. 咀嚼, 嚼碎;咀嚼, 细想;咀嚼, 咀嚼物
jealous|/'dʒelәs/a. 嫉妒的, 羡慕的, 留心的, 戒备的
packaging|/'pækidʒiŋ/n. 包装, 包装业, 包装术; 组装;封装
sailing|/'seiliŋ/n. 航行, 航海术, 启航;航行的
restricted|/ri'striktid/a. 受限制的, 有限的
litre|/li:tә(r)/n. 升, 公升; 升
spider|/'spaidә/n. 蜘蛛, 设圈套者; 星形轮
goodbye|/gud'bai/interj. 再见
waiter|/'weitә/n. 侍者
exaggerate|/ig'zædʒәreit/v. 夸大, 夸张
cheat|/tʃi:t/n. 欺骗, 作弊, 骗子;欺骗, 逃脱, 骗取
crowded|/'kraudid/a. 拥挤的, 塞满的
plug|/plʌg/n. 塞子, 栓, 插头;插入, 塞住, 接插头;被塞住
kindly|/'kaindli/a. 和蔼的, 温和的, 爽快的;温和地, 亲切地
hobby|/'hɒbi/n. 嗜好, 癖好, 爱好
enjoyable|/in'dʒɒiәbl/a. 可从中得到乐趣的, 令人愉快的
ink|/iŋk/n. 墨水, 墨汁;涂墨水于, 签署, 加墨水
decay|/di'kei/n. 衰退, 腐败;(使)衰退, (使)腐败
gallon|/'gælәn/n. 加仑; 加仑
carrot|/'kærәt/n. 胡萝卜; 胡萝卜
sticky|/'stiki/a. 粘的, 有粘性的, 顽固的
dentist|/'dentist/n. 牙科医生; 牙医师
attempted|企图的;未遂的
spoon|/spu:n/n. 匙, 调羹, 匙形工具;以匙舀起, 调情, 使成匙状
decorative|/'dekәreitiv/a. 装饰性的
indoor|/'indɒ:/a. 户内的, 室内的
blonde|/blɔnd/a. (头发)亚麻色的, 淡色的, 白肤金发碧眼的, 白里透红的, 白皙的, 淡黄色的;肤色白皙的金发女人
confusing|令人困惑的;混淆的;混乱的
noticeable|/'nәutisәbl/a. 显而易见的, 显著的, 值得注意的
amusing|/ә'mju:ziŋ/a. 有趣的, 引人发笑的
finished|/'finiʃt/a. 完成的, 完结的, 精巧的, 完美的
tidy|/'taidi/n. 椅子的背罩, 装杂物的容器;整齐的, 有条理的;弄整齐, 收拾, 整理;整理, 收拾
satisfying|/'sætisfaiiŋ/a. 满意的, 充分的, 足可相信的
lazy|/'leizi/a. 懒惰的, 怠惰的, 缓慢的;懒散
harmful|/'hɑ:mful/a. 有害的, 伤害的
shiny|/'ʃaini/a. 有光泽的, 发光的, 辉煌的, 磨光的, 磨损的
sore|/sɒ:/a. 悲伤的, 痛的, 引起痛苦的;痛处, 溃疡, 疮
wildly|狂暴地, 激动地, 狂热地, 鲁莽地, 轻率地
suitcase|/'sju:tkeis/n. 手提箱
click|/klik/n. 咔哒声, 啪嗒声;作咔哒声;使发咔哒声; 单击
license|/'laisns/n. 执照, 许可证, 特许;许可, 特许
climbing|/'klaimiŋ/a. 攀缘而登的, 上升的;攀登
sweater|/'swetә/n. 毛衣, 毛线衫, 运动衫, 出汗者; 发汗器
depressing|/di'presiŋ/a. 抑压的, 沉闷的, 阴沉的
downwards|/'daunwәdz/adv. 向下
insult|/'insʌlt/n. 侮辱, 无礼, 损害;损害, 侮辱, 攻击
moving|/'mu:viŋ/a. 动人的, 令人感动的, 鼓动的, 原动的, ;活动的, 转动的
accidental|/.æksi'dentl/a. 意外的, 偶然的, 非主要的, 附属的;临时记号, 次要方面
singing|/'siŋiŋ/n. 歌唱, 歌声; 振鸣;蜂鸣
whistle|/'hwisl/n. 口哨, 汽笛, 啸啸声, 口哨声;吹口哨, 鸣汽笛, 发嘘嘘声;用口哨或吹哨传意, 用口哨演奏
educated|/'edjukeitid/a. 受过教育的, 有教养的
harmless|/'hɑ:mlis/a. 无害处的, 未受损害的, 无辜的, 无恶意的; 无害的, 无恶意的, 无损害的
hollow|/'hɒlәu/n. 洞, 窟窿, 山谷;空的, 虚伪的, 空腹的, 凹的;形成空洞;挖空
curb|/kә:b/n. 抑制, 勒马绳, 边石;抑制, 束缚, 勒住
impatient|/im'peiʃәnt/a. 不耐烦的, 着急的, 急切的
stripe|/straip/n. 斑纹, 条纹; 纹, 条纹
shave|/ʃeiv/n. 修面, 刮胡子, 幸免, 剃刀;修面, 剃, 修剪, 掠过;刮脸, 勉强通过
crisp|/krisp/a. 脆的, 新鲜的, 活泼的;(使)烘脆, (使)拳曲, (使)起皱;松脆物
shocking|/'ʃɒkiŋ/a. 令人震惊的, 极坏的, 不正当的
excite|/ik'sait/vt. 刺激, 使兴奋, 激励
scare|/skєә/n. 惊吓, 恐慌;惊吓, 使恐慌;受惊
sour|/'sauә/a. 酸的, 酸臭的, 发酵的, 愠怒的, 讨厌的, 拙劣的, 不健全的;变酸, 发酵, 厌烦, 变坏;使变酸, 使失望;酸味, 酸饮料
pants|/pænts/n. 裤子, 长裤, 短衬裤, 女式运动短裤
spice|/spais/n. 香料, 药料, 香气, 调味品, 情趣, 少许;加香料, 使添趣味
irritate|/'iriteit/vt. 激怒, 使发怒, 使兴奋, 使发炎;引起不快
disgust|/dis'gʌst/n. 厌恶, 嫌恶;令人厌恶;使作呕
glue|/glu:/n. 胶, 粘性物;粘合, 胶合
alcoholic|/.ælkә'hɒlik/n. 酒鬼, 酒精中毒者;酒精的
sincere|/sin'siә/a. 诚实的, 正直的, 真挚的, 纯净的
pointed|/'pɒintid/a. 尖的, 有尖顶的, 锐利的, 率直的, 显然的
backward|/'bækwәd/adv. 向后地, 相反地;向后的, 相反的; 倒推
sting|/stiŋ/n. 叮, 刺痛, 刺激, 讽刺;叮, 刺痛, 刺激, 使苦恼;叮, 刺痛
gram|/græm/n. 克, 绿豆, 鹰嘴豆; 克
apologize|/ә'pɒlәdʒaiz/vi. 道歉, 辩解
exaggerated|/ig'zædʒәreitid/a. 夸大的, 夸张的, 言过其实的
mistaken|/mis'teikәn/a. 犯错的, 错误的;mistake的过去分词
embarrass|/im'bærәs/vt. 使困窘, 使局促不安, 阻碍
vacation|/vei'keiʃәn/n. 假期, 休假; 假期, 停审期, 休庭期
covering|/'kʌvәriŋ/n. 覆盖物, 掩蔽物;掩护的, 掩盖的; 覆盖
faithfully|/'feiθfuli/adv. 忠实地, 诚心诚意地, 深信着地
approximate|/ә'prɒksimәt/a. 大约的, 接近的, 近似的;接近, 使接近, 粗略估计;接近于
cent|/sent/n. 分; 美分
riding|/'raidiŋ/n. 骑, 乘车, 乘, 骑术, 骑马
amaze|/ә'meiz/vt. 使吃惊
justified|有道理的, 合乎情理的; 两端对齐的
attached|/ә'tætʃt/a. 附加的;依恋的, 充满爱心的
GM|通用汽车公司, 总经理, 导弹; 通用汽车公司
mom|/mʌm/n. 妈妈
confined|/kәn'faind/a. 被限制的, 狭窄的, 在分娩中的, 坐月子的; 有限的, 狭窄的
engaged|/in'geidʒd/a. 忙碌的, 使用中的
bent|/bent/a. 弯曲的, 决心的;爱好;bend的过去式和过去分词
grandchild|/'^rændtʃaild/n. 孙, 外孙女, 外孙, 孙女, 孙子
gasoline|/'gæsәli:n/n. 汽油; 汽油
stair|/stєә/n. 梯级, 楼梯, 阶梯
bacteria|/bæk'tiәriә/pl. 细菌; 细菌, ;杆菌
credit card|信用卡, 记帐卡; 信用卡片, 赊购证, 购物信用卡
customs|海关, 关卡, 关税; 关税, 海关
ice cream|冰淇淋; 冰淇淋
post office|邮局; 邮局
swimming pool|/ˈswɪmɪŋ pu:l/n. 游泳池
take|/teik/vt. 拿, 取, 抓, 带领, 获得, 就座, 接受, 吃, 吸引, 采取, 乘, 需要, 花费;吃掉对方棋子, 抓住, 起作用, 依法获得财产;拿, 取, 收成, 奏效
just|/dʒʌst/a. 正直的, 合理的, 正确的, 应得的;刚刚, 正好, 仅仅
even|/'i:vәn/a. 平坦的, 相等的, 连贯的, 均等的, 公平的, 偶数的, 平均的, 平衡的, 恰好的;使平坦, 使相等;变平, 成为相等;甚至, 实际上, 完全, 十分;偶数, 偶校验; 偶数, 偶校验
might|/mait/n. 力量, 权力;可能, 也许
home|/hәum/n. 家, 避难所, 故乡;家庭的, 国内的, 打中目标的;在家, 在本国, 打中目标地; 返回始位
minute|/'minit. mai'nju:t/n. 分, 分钟, 片刻, 备忘录, 笔记;记录, 摘录, 测定时间;微小的, 详细的
bank|/bæŋk/n. 银行, 堤, 岸; 库
common|/'kɒmәn/a. 通常的, 共同的, 通俗的, 公共的; 公用块
used|/'ju:st/a. 使用过的, 二手的, 习惯的
planning|计划的制订, 策划, 设计, 规划; 计划, 规划
bear|/bєә/n. 熊;忍受, 支承, 产生, 怀有, 通过卖空使跌价;忍受, 结果实, 压挤, 行进, 转向
directly|/di'rektli, dai'rektli/adv. 径直地, 直接地, 直率地, 正好地, 直截了当地, (非正式)立即, 马上;一...(就...), 一当...就...; 直接的
senior|/'si:njә/n. 年长者, 资深者, 毕业班学生;年长的, 高级的, 资深的
equally|/'i:kwәli/adv. 相等地, 同样地, 平等地
unemployment|/.ʌnim'plɒimәnt/n. 失业, 失业人数; 失业
count|/kaunt/vt. 计算, 视为;计数;计算, 合计, 计数, 伯爵; 计数
entrance|/'entrәns/n. 入口, 进入点, 入场, 入学, 进入, 开始(阶段), 就任;使出神, 使入迷; 入口
disk|/disk/n. 圆盘, 磁盘; 磁盘
broken|/'brәukәn/a. 坏掉的, 打破的, 断掉的;break的过去分词
coin|/kɒin/n. 硬币, 金钱, 货币;铸币, 创造, 杜撰
injure|/'indʒә/vt. 伤害, 损害, 使受冤屈; 损伤
specially|/'speʃәli/adv. 特别地, 专门地
happily|/'hæpili/adv. 幸福地, 快乐地, 幸好
diagram|/'daiәɡræm/n. 图表;图解
fancy|/'fænsi/n. 想象力, 幻想, 喜好;想象的, 精美的, 新奇的, 奇特的, 高价的, 特级的;想象, 设想, 相信, 喜爱;想象, 幻想
walking|/'wɒ:kiŋ/n. 步行, 步态;步行的, 步行用的
washing|/'wɒʃiŋ/n. 洗涤, 浸, 洗涤物; 涂浆, 洗涤
seal|/si:l/n. 印章, 封条, 海豹, 海豹皮, 火漆, 封蜡, 玺, 保证, 批准, 象征, 标志;封闭, 盖印, 盖章;猎海豹
ad|/æd/n. 广告; 地址, 模拟-数字
driving|/'draiviŋ/n. 赶, 操纵, 驾驶;推进的, 强劲的, 精力旺盛的
width|/widθ/n. 宽度, 宽广, 广博; 宽度
vocabulary|/vә'kæbjulәri/n. 词汇(量), 词汇表; 词表
privately|秘密地;私下地
ideally|/ai'diәli/adv. 完美地, 理想地
probable|/'prɒbәbl/a. 很可能的, 大概的, 可信的;很有希望的候选人, 很可能的事情
horizontal|/.hɒri'zɒntәl/n. 水平线, 水平面, 水平位置;水平线的, 平坦的, 横的;水平; 水平
triangle|/'traiæŋgl/n. 三角形, 三个一组, 三角关系; 三角, 三角形
sincerely|/sin'siәli/adv. 真诚地
enjoyment|/in'dʒɒimәnt/n. 享乐, 快乐, 享受; 使用权
unreasonable|/.ʌn'ri:znәbl/a. 不合理的, 过度的, 不切实际的; 不讲道理的, 非理智的, 不合理的
spelling|/'speliŋ/n. 拼, 拼字, 拼法; 拼写检查
aloud|/ә'laud/adv. 出声地, 大声地
knitting|/'nitiŋ/n. 编结, 针织法, 针织, 编结法, 编结物, 针织品; 骨愈合
comfortably|/'kʌmfәtәbli/adv. 安乐地, 舒服地, 宽裕地
matching|/'mætʃiŋ/a. 相同的, 协调的; 匹配, 对比
undo|/.ʌn'du:/vt. 解开, 取消, 破坏, 毁灭, 扰乱;松开; 撤消
nephew|/'nefju:/n. 侄子, 外甥
sew|/sәu/vt. 缝纫, 缝合, 缝;缝纫
homework|/'hәumwә:k/n. 家庭作业, 家里做的工作; 家庭作业
curved|弯曲的;弄弯的
disgusting|/dis'gʌstiŋ/a. 令人厌恶的
sideways|/'saidweiz/adv. 向旁边, 向侧面地;旁边的, 向侧面的
calmly|/'kɑ:mli/adv. 平静地, 安静地, 冷静地
stove|/stәuv/n. 火炉, 窑;用火炉烤;stave的过去式和过去分词
amused|/ә'mju:zd/a. 愉快的, 被逗乐的
worse|/wә:s/n. 更坏的事, 更恶劣的事, 败局;更坏的, 更恶劣的;更坏地, 更恶劣地
imaginary|/i'mædʒinәri/a. 想像的, 虚构的, 假想的
transparent|/træns'pærәnt/a. 透明的, 显然的, 清晰的; 透明
web|/web/n. 网, 蛛丝, 蹼, 织物, 圈套, 卷筒纸;结网, 形成网;织蜘蛛网于, 使落入圈套
grandson|/'grændsʌn/n. 孙子, 外孙
kindness|/'kaindnis/n. 仁慈, 亲切, 和蔼
annoyed|恼怒的;烦闷的
wallet|/'wɒlit/n. 皮夹; 皮包, 皮夹, 钱袋
oddly|/'ɒdli/adv. 奇怪地
fasten|/'fɑ:sәn/vt. 拴紧, 使固定, 系, 集中于, 强加于;扣紧
luggage|/'lʌgidʒ/n. 行李, 皮箱
cooker|/'kukә/n. 炊事用具, 炉灶, 锅, 炊具, 烹饪用水果, 窜改者, 伪造者; 蒸锅
pleasing|/'pli:ziŋ/a. 令人喜爱的, 愉快的, 舒适的
midday|/'middei/n. 正午, 中午;正午的
grandparent|/'grændperәnt/n. 祖父母
unload|/.ʌn'lәud/vi. 卸货;从...卸下, 摆脱...之负担, 倾销, 卸(货); 卸载
opposing|/ә'pәuziŋ/a. 对面的, 反对的, 相反的, 相对的
careless|/'kєәlis/a. 粗心的, 不关心的, 无忧无虑的
congratulations|祝贺词, 祝贺语
annoy|/ә'nɒi/vt. 使恼怒, 骚扰
indoors|/'in'dɒ:z/adv. 在户内
rounded|/'raundid/a. 圆形的, 滚圆的, 完整的, 圆润的
hairdresser|/'hєәdresә/n. 美发师, 理发师
niece|/ni:s/n. 侄女, 甥女
jelly|/'dʒeli/n. 果冻, 果冻甜食, 胶状物;(使)结冻, (使)成胶状
clap|/klæp/n. 拍手, 拍手声, 霹雳声, 花柳病;鼓掌, (使)啪地关上
flu|/flu:/n. 流感, 流行性感冒
pronunciation|/prәu.nʌnsi'eiʃәn/n. 发音, 读法
skilful|/'skilful/a. 灵巧的, 熟练的, 制作精巧的
disapprove|/.disә'pru:v/v. 不赞成
unlucky|/.ʌn'lʌki/a. 不吉利的, 不祥的, 不幸的
cardboard|/'kɑ:dbɒ:d/n. 薄纸板; 咭纸;特等纸板;卡纸板;卡片纸板
infectious|/in'fekʃәs/a. 有传染性的, 易传染的; 传染性的
disapproval|/.disә'pru:vәl/n. 不赞成
striped|/straipt/a. 有斑纹的
scissors|/'sizәz/pl. 剪刀; 剪
amuse|/ә'mju:z/vt. 消遣, 娱乐, 使发笑
underwear|/'ʌndәwєә/n. 内衣
baggage|/'bægidʒ/n. 行李; 行李
centimetre|/'senti,mi:tә(r)/n. 厘米, 公分
depress|/di'pres/vt. 使沮丧, 压低, 降低, 使萧条; 推下
humorous|/'hju:mәrәs/a. 富幽默感的, 滑稽的, 诙谐的
complicate|/'kɒmplikeit/vt. 弄复杂, 使错综, 使恶化;变复杂
surname|/'sә:neim/n. 姓, 别号, 绰号;呼以姓氏, 起绰号
unimportant|/.ʌnim'pɒ:tnt/a. 不重要的
disappoint|/.disә'pɒint/vt. 使失望
poisonous|/'pɒizәnәs/a. 有毒的, 恶毒的, 讨厌的; 有毒的
annoying|/ә'nɒiiŋ/a. 恼人的, 讨厌的
untidy|/.ʌn'taidi/a. 不整齐的, 懒散的, 混乱的
motorcycle|/'mәutәsaikl/n. 摩托车; 机动车, 机踏车, 摩托车
millimetre|/'milimi:tә/n. 毫米; 公厘
refrigerator|/ri'fridʒәreitә/n. 电冰箱, 冷藏库; 冷冻机;致冷器
excluding|把...排除在外, 不包括..., 不计...
dishonest|/dis'ɒnist/a. 不诚实的; 不忠实的, 不诚实的, 欺诈的
sewing|/'sәuiŋ/n. 缝制品, 缝纫
swollen|/'swәulәn/a. 肿大的, 涨水的, 夸张的, 骄傲的;swell的过去分词
ruined|/'ruind/a. 毁灭的, 没落的, 荒废的
curly|/'kә:li/a. 拳曲的, 卷毛的, 弯曲的
beak|/bi:k/n. 鸟嘴, 喙; 嘴, 喙
awfully|/'ɒ:fuli/adv. 恶劣地, 非常地, 极端地
bandage|/'bændidʒ/n. 绷带; 帘布筒;实心轮胎;紧带;绷带
yawn|/jɒ:n/n. 哈欠;打哈欠, 裂开;打着哈欠说
candy|/'kændi/n. 糖果, 冰糖;用糖煮, 使结晶为砂糖;结晶为砂糖
tire|/taiә/n. 轮胎, 头饰;使疲倦, 使厌烦, 打扮;疲劳, 厌倦
alphabet|/'ælfәbit/n. 字母; 字母表
covered|/'kʌvәd/a. 隐蔽着的, 掩藏着的, 有屋顶的; 涂抹了的, 覆盖了的, 掩盖了的
uncontrolled|/.ʌnkәn'trәuld/a. 不受抑制的, 不受控制的, 自由的
tiring|/'taiәriŋ/a. 引起疲劳的, 累人的; 轮箍术(髌骨骨折时)
immoral|/i'mɒrәl/a. 不道德的, 邪恶的, 放荡的; 不道德的, 道德败坏的, 邪恶的
mall|/mɔ:l/n. 林荫路
unkind|/.ʌn'kaind/a. 不仁慈的, 不亲切的
underwater|/'ʌndә'wɒ:tә/a. 在水中的;在水下
granddaughter|/'^rændɔ:tә(r)/n. 孙女, 外孙女
disgusted|/dis'ɡʌstid/a. 厌恶的;厌烦的
thirsty|/'θә:sti/a. 口渴的, 渴望的, 干燥的
cracked|/krækt/a. 破碎的, 破裂的, 声音嘶哑的; 有裂缝的, 裂化的
closet|/'klɒzit/n. 壁橱, 小室;秘密的, 空谈的;把...关入小室
garbage|/'gɑ:bidʒ/n. 垃圾, 废物; 无用信息
elevator|/'eliveitә/n. 电梯, 升降机; 提升机
PT|点, 处理时间, 可编程序终端; 铂(78号元素)
unfriendly|/.ʌn'frendli/adv. 不友善地
wrapping|/'ræpiŋ/n. 用于包裹的材料; 绕接
photocopy|/'fәutәu.kɒpi/n. 影印, 复印件;影印
entertainer|/.entә'teinә/n. 表演娱乐节目的人, 演艺人员
swelling|/'sweliŋ/n. 肿胀, 肿大, 隆起部, 身上的肿胀处, 膨胀, 增大;肿大的, 突起的
outdoors|/'aut'dɒ:z/n. 户外, 野外活动;在户外, 在野外
spicy|/'spaisi/a. 香的, 多香料的, 辛辣的, 下流的
salty|/'sɒ:lti/a. 有盐分的, 咸味浓的, 海洋的, 辛辣的, 有经验的
kilogram|/'kilәgræm/n. 千克, 公斤; 千克, 公斤
stressed|感到有压力的;紧张的
suited|/'sju:tid/a. 适合的
cookie|/'kuki/n. 饼干, 小甜点; 糕点
milligram|/'miligræm/n. 毫克; 毫克
dishonestly|/dɪs'ɒnɪstlɪ/adv. 不诚实地, 不正直地
MG|微粒剂; 镁(12号元素)
drugstore|/'drʌgstɒ:/n. 药房, 杂货店
mobile phone|移动电话
upside down|颠倒着, 混乱
yeah|/jɑ:/adv. (非正式)是, 是的
mm|毫米; 毫米
teacher|/'ti:tʃә/n. 教师, 老师, 导师
training|/'treiniŋ/n. 训练, 培养; 训练
clearly|/'kliәli/adv. 清楚地
per|/pә:/prep. 每一, 通过, 经, 按照; 每, 按照
quickly|/'kwikli/adv. 很快地
Dr|博士, 医生; 英钱
western|/'westәn/n. 西方人, 西部片, 西部小说;向西方的, 来自西方的, 西方的, 西洋的, 西部的
importance|/im'pɒ:tәns/n. 重要, 重要性, 重要地位, 自大; 重要, 重要性
completely|/kәm'pli:tli/adv. 完全地, 十分地, 圆满地
contribution|/.kɒntri'bju:ʃәn/n. 捐助, 捐助之物, 贡献; 贡献, 捐款, 补助品
driver|/'draivә/n. 驾驶员, 驱动器, 驱动程序; 驱动器
relatively|/'relәtivli/adv. 相对地, 比较地, 相当地, 相关地; 相对地
slowly|/'slәuli/adv. 慢慢地, 迟缓地
additional|/ә'diʃәnәl/a. 附加的, 另外的, 额外的; 加添的, 附加的
writer|/'raitә/n. 作家, 撰稿者, 抄写员; 记录器
carefully|/'kєәfuli/adv. 小心地, 谨慎地
currently|/'kʌrәntli/adv. 现在, 当前, 一般, 普通; 当前
investigation|/in.vesti'geiʃәn/n. 调查, 审查; 调查, 调查研究
northern|/'nɒ:ðәn/n. 北方人;北方的, 向北的, 自北方来的
existence|/ig'zistәns/n. 存在, 生存; 存在, 存在状态, 实体
thanks|感谢, 谢意, 谢忱;interj. 谢谢, 谢谢你
totally|/'tәutli/adv. 完全地
frequently|/'fri:kwәntli/adv. 频繁, 经常地
properly|/'prɒpәli/adv. 适当地, 相当地
widely|/'waidli/adv. 广泛地
closely|/'klәusli/adv. 接近地
marketing|/'mɑ:kitiŋ/n. 行销, 买卖; 推销, 在市场买卖, 销售
surprised|/sә'praizd/a. 感到惊讶的
strongly|/'strɒŋli/adv. 强有力地, 坚强地, 激烈地
rapidly|/'ræpidli/adv. 飞快地, 迅速地, 赶紧地
independence|/.indi'pendәns/n. 独立, 自立, 自主; 自主性, 独立性
buyer|/'baiә/n. 买主, 买方; 买主, 买方, 买手
supporter|/sә'pɒ:tә/n. 支持者, 后盾, 迫随者, 护身织物; 支持者, 赡养者, 抚养者
manufacturing|/.mænju'fæktʃәriŋ/n. 制造业;制造业的
significantly|值得注目地;意味深长地
heavily|/'hevili/adv. 很重地, 严重地, 难以忍受地
saving|/'seiviŋ/n. 存款, 挽救, 节约;搭救的, 节约的, 保留的, 补偿的;除...之外
quietly|/'kwaiәtli/adv. 安静地, 沉着地, 秘密地
advertising|/'ædvәtaiziŋ/n. 广告业, 广告;广告的; 发广告
occasionally|/ә'keiʒәnli/adv. 有时候, 偶而
firmly|/'fә:mli/adv. 坚固, 坚定, 断然
gently|/'dʒentli/adv. 温和地, 温柔地, 轻轻地, 逐渐地
restriction|/ri'strikʃәn/n. 限制, 限定, 约束; 限定
regularly|/'regjulәli/adv. 有规则地, 一丝不苟地, 正式地
trading|交易
gradually|/'grædʒuәli/adv. 逐渐地
deeply|/'di:pli/adv. 深刻地, 在深处, 深沉地
promotion|/prәu'mәuʃәn/n. 晋级, 创建, 增进; 推广, 推销, 促进
producer|/prә'dju:sә/n. 生产者, 制作者, 制作人; 发生器;(炉煤气)发生炉;制气炉;生产者
surprising|/sә'praiziŋ/a. 令人惊讶的
enquiry|/in'kwaiәri/n. 询问; 询价, 询盘
judgement|/'dʒʌdʒmәnt/n. 审判, 判决, 判断; 判定, 审定, 鉴定
successfully|/sәk'sesfjli/adv. 成功, 结果良好, 有成就
greatly|/'greitli/adv. 很, 非常
constantly|/'kɒnstәntli/adv. 不变地, 不断地, 时常地
reasonably|/'ri:znәbli/adv. 适度地, 相当地
indication|/.indi'keiʃәn/n. 指示, 象征, 暗示; 指示, 指征, 适应征
inevitably|/in'evitәbli/adv. 不可避免地
considerably|/kәn'sidәrәbli/adv. 非常地, 很, 颇
deliberately|/di'libәrәtli/adv. 故意地
automatically|/.ɒ:tә'mætikli/adv. 自动地, 机械地
approximately|/ә'prɒksimәtli/adv. 大约, 大致, 近于; 大约, 近似
departure|/di'pɑ:tʃә/n. 离开, 出发, 违背, 偏离; 启运
surprisingly|使人惊奇, 出人意外, 惊人, 令人惊讶
sufficiently|/sә'fiʃәntli/adv. 足够, 充分
commonly|/'kɒmәnli/adv. 一般, 普通, 通常
sharply|/'ʃɑ:pli/adv. 锐利地, 严厉地, 厉害地; 剧烈地
softly|/'sɒftli/adv. 柔和地, 静静地, 温柔地
destruction|/di'strʌkʃәn/n. 破坏, 毁灭; 破坏
potentially|/pә'tenʃәli/adv. 可能地, 潜在地
roughly|/'rʌfli/adv. 概略地, 粗糙地, 粗暴地
calculation|/.kælkju'leiʃәn/n. 计算, 考虑, 计算的结果; 计算
formally|/'fɒ:mәli/adv. 正式地, 形式上
CM|厘米, 中央存储器, 通信多路转换器, 控制标志, 磁心存储器; 锔(96号元素)
thoroughly|/'θʌrәli/adv. 彻底地, 绝对地, 透彻地, 详尽地, 周到地, 完全地, 完善地, 全面地
experienced|/ik'spiәriәnst/a. 富有经验的, 老练的, 熟练的
frightened|/'frait(ә)nd/a. 受惊吓的, 受惊的, (非正式)害怕...的
fighting|/'faitiŋ/a. 战斗的, 容易引起争斗的, 适于格斗的, 好斗的, 好战的, 斗争的, 搏斗的;战斗, 斗争, 搏斗
expected|预期的;预料的
traditionally|传统上;传说上;习惯上
physically|/'fizikli/adv. 按自然规律, 完全地, 实际上, 真正地, 身体上地
desperately|/'despәrәtli/adv. 拼命地;绝望地;极度地
lightly|/'laitli/adv. 轻轻地, 少许, 不费力地
mentally|/'mentli/adv. 心理上, 精神上, 智力上; 精神上, 智力上
correctly|/kә'rektli/adv. 对, 正确, 恰当, 符合一般性准则, 符合行为准则, 端正, 符合
flying|/'flaiiŋ/a. 飞的, 飘扬的, 飞速的;飞行, 飞花
sadly|/'sædli/adv. 悲痛地, 悲惨地, 悲伤地, 说来遗憾
separation|/.sepә'reiʃәn/n. 分离, 分居, 缺口, 退职; 分离
OK|/'әu'kei/a. 好, 不错, 可以;好, 不错, 可以;批准, 认可; 确定
separately|/'sepәrәtli/adv. 分开, 不相连, 分隔, 分离, 不同, 单独, 独立, 各自, 各别, 脱离肉体, 灵魂; 分离地
officially|/ә'fiʃәli/adv. 作为公务员, 职务上, 官方地
locally|/'lәukәli/adv. 地方性地, 局部性地, 在当地
severely|/si'viәli/adv. 严格, 尖锐, 严肃, 严重, 严厉, 朴素
safely|/'seifli/adv. 安全地, 确实地
tightly|/'taitli/adv. 紧紧地, 坚固地
surrounding|/sә'raundiŋ/n. 环境;周围的
happiness|/'hæpinis/n. 快乐, 幸运, 适当
photographer|/fә'tɔ^rәfә/n. 摄影师, 摄影者
steadily|/'stedili/adv. 稳定地, 无变化地, 有规则地
politically|政治上
downstairs|/'daun'stєәz/n. 楼下;楼下的;在楼下
impressed|外加的;印象深刻的;了不起的;受感动的
publicly|/'pʌblikli/adv. 公然地, 以公众名义
differently|/'difrentli/adv. 差异, 不同, 各别, 各种
shocked|/ʃɔkt/a. 震撼的;震惊的
dramatically|/drә'mætikli/adv. 戏剧地, 引人注目地, 突然地
rightly|/'raitli/adv. 合适地, 正当地, 正确地
remarkably|/ri'mɑ:kәbli/adv. 显著地, 引人注目地, 非常地
socially|/'sәuʃәli/adv. 在社会上, 在社交上, 以社会生活方式
actively|/'æktivli/adv. 活跃地, 积极地
remains|/ri'meins/n. 剩余物, 废墟, 残余; 遗体, 尸体, 遗骸
genuinely|真诚地;诚实地
relaxed|/ri'lækst/a. 松懈的, 不严密的, 不严格的, 放松的, 得到休息的, 随意的, 不拘束的, 自在的
accurately|/'ækjurәtli/adv. 正确地, 精确地
independently|/.indi'pendәntli/adv. 独立地, 自立地
revision|/ri'viʒәn/n. 校订, 修正, 修订本, 修订版; 修订版
temporarily|/'tempәrәrәli/adv. 暂时, 一时, 临时
importantly|重要地;大量地;有名望地;自命不凡地
neatly|/'ni:tli/adv. 整洁地, 干净地, 匀称地
repeatedly|/ri'pi:tidli/adv. 重复地, 再三地
terribly|/'terәbli/adv. 可怕地, 甚为, 非常
printing|/'printiŋ/n. 印刷, 印刷术, 印花; 打印;印刷
pence|/pens/pl. (非正式)copper便士, (美)分, 分币
senate|/'senit/n. 参议院, 立法机构, 评议会
permanently|/'p\\\\:mәntli/adv. 永久, 不变, 持久; 永久性的
legally|/'li:gәli/adv. 法律上, 合法地; 法律上, 合法地, 法定地
beautifully|/'bju:tifuli/adv. 美好地, 漂亮地
willingness|乐意, 心甘情愿, 愿意
dancing|/'dænsiŋ/n. 舞蹈; 跳动的
smoking|/'smәukiŋ/n. 抽烟, 冒烟; 烟熏;吸烟
embarrassing|/im'bærәsiŋ/a. 令人为难的, 麻烦的
adequately|/'ædikwәtli/adv. 足够地, 适当地
bitterly|/'bitәli/adv. 怨恨地, 悲痛地, 残酷地
efficiently|/i'fiʃәntli/adv. 生效, 能胜任, 有能力, 效率高, 有效
performer|/pә'fɒ:mә/n. 表演者, 执行者, 完成者; 执行者, 履行者, 实行者
jointly|/'dʒɒintli/adv. 共同地, 连带地
annually|/'ænjuәli/adv. 一年一次, 每年; 年度的, 每年的
loudly|/'laudli/adv. 高声地, 大声地, 吵闹地
gray|/grei/n. 灰色, 暗淡;灰色的, 灰白的, 面色苍白的, 年老的, 老练的, 阴沉的;(使)变灰色
angrily|/'æŋgrili/adv. 愤怒地
theirs|/ðєәz/pron. 他们的
disturbing|/dis'tә:biŋ/a. 引起烦恼的, 令人不安的
smoothly|/'smu:ðli/adv. 平滑地, 流畅地, 流利地
frightening|/'fraitәniŋ/a. 令人恐惧的;引起突然惊恐的
controlled|/kәn'trәuld/a. 受约束的, 克制的; 受管制的, 受控制的, 受管辖的
breathing|/'bri:ðiŋ/n. 呼吸, 瞬间, 微风;呼吸的, 逼真的
sexually|性别地;两性之间地
admiration|/.ædmә'reiʃәn/n. 赞赏, 钦佩, 引人赞赏的对象
indirectly|间接, 曲折, 迂回, 不直截了当, 不诚实, 不坦率; 间接地
strangely|/'streindʒli/adv. 奇妙地, 奇怪地, 不可思议地
continuously|/kәn'tinjuәsli/adv. 不断地, 连续地; 连续地
entertaining|/.entә'teiniŋ/a. 使人愉快的, 有趣的
amazed|/ә'meizd/a. 吃惊的, 惊奇的
unexpectedly|想不到的, 突然的, 意外的, 出乎意料的
curiously|/'kjuәriәsli/adv. 好奇地
sadness|/'sædnis/n. 悲哀, 悲伤
violently|/'vaiәlәntli/adv. 猛烈地, 激烈地, 极端地
thickness|/'θiknis/n. 厚度, 密度, 愚钝, 含混不清; 厚度
wounded|受伤的; 受伤者; 受伤的, 受了损害的
interruption|/.intә'rʌpʃәn/n. 打扰, 中断, 障碍物; 间断, 阻断, 中止
politely|/pә'laitli/adv. 有礼貌地, 文雅地, 客气地
brightly|/'braitli/adv. 生辉地, 明亮地, 鲜明地
spoken|/'spәukәn/a. 口头讲的, 口语的;speak的过去分词
emotionally|/i'mәuʃәnәli/adv. 在情绪上
secretly|/'si:kritli/adv. 秘密地, 背地里
proudly|/'praudli/adv. 傲慢地, 自大地, 得意洋洋地
intended|/in'tendid/a. 有意的, 故意的;未婚夫(妻)
finely|/'fainli/adv. 雅致地, 仔细地, 敏锐地, 微细地
freshly|/'freʃli/adv. 新, 新近, 精神饱满
anxiously|/'æŋʃәsli/adv. 忧虑地, 不安地
nervously|焦急地;神经质地;提心吊胆地
faintly|/'feintli/adv. 微弱地, 模糊地, 朦胧地
wrongly|错误地, 不恰当地, 不正确地, 不正直地, 不公正地
alarming|/ә'lɑ:miŋ/a. 使人惊恐的, 引起惊恐的
loosely|/'lu:sli/adv. 松弛地, 宽松地, 不紧
upward|/'ʌpwәd/a. 向上的;以上
morally|/'mɒrәli/adv. 道德上, 德性上, 有道德地
deserted|/di'zә:tid/a. 被遗弃的, 废弃的; 被遗弃的, 无人的, 放弃的
occupied|已占用的;使用中的;无空闲的
cheerfully|/'tʃiәfuli/adv. 高高兴兴地
coldly|/'kәuldli/adv. 冷淡地
euro|/'juәrәu/n. 欧元（欧盟的统一货币单位）
impatiently|不耐烦, 忍受不了, 急躁, ;急欲, 急切
accidentally|/.æksi'dentli/adv. 偶然地, 意外地
confidently|自信地;安心地
alarmed|受惊的;焦虑的;惊恐的
willingly|/'wiliŋli/adv. 自动地, 欣然地
downward|/'daunwәd/a. 向下的
generously|宽大地;慷慨地;丰盛地
cheaply|/'tʃipli/adv. 便宜地
twisted|/'twistid/a. 扭曲的
pleasantly|和蔼地, 亲切地;友好地;愉快地
illegally|非法地, 不合法地, 违法地
contrasting|/kənˈtrɑ:stɪŋ/v. （靠近或作比较时）显出明显的差异, 形成对比( contrast的现在分词 );对比, 对照
cycling|/'saikliŋ/n. 骑脚踏车兜风, 骑脚踏车消遣; 循环操作
infected|/in'fektid/a. 被感染的; 被感染的
stiffly|/'stifli/adv. 呆板地, 顽固地, 僵硬地
irritating|/'iriteitiŋ/a. 刺激的, 使愤怒的, 气人的
gambling|/'gæmbliŋ/n. 赌博
rented|租用的
grocery|/'grәusәri/n. 食品杂货店, 食品杂货业
relaxing|令人轻松的
insulting|/in'sʌltiŋ/a. 侮辱的, 损害人体的
farther|/'fɑ:ðә/a. 更远的, 进一步的;更远的, 此外, far的比较级
awkwardly|笨拙地;无技巧地
thickly|厚地;浓地
separated|/'sepәreitid/a. 分居;分开的;不在一起生活的
artificially|/.ɑ:ti'fiʃәli/adv. 人工地, 人为地, 不自然地
steeply|/'sti:pli/adv. 险峻地
skilfully|熟练地（等于skillfully）
unfairly|不正当地;不公平地
unhappiness|苦恼;忧愁
camping|/'kæmpiŋ/n. 野营, 露营
burnt|burn的过去式和过去分词
betting|/'betiŋ/n. 打赌; 打赌, 赌博
noisily|/'nɒizili/adv. 吵闹地
blankly|/'blæŋkli/adv. 茫然地, 毫无表情地
divorced|离婚的
folding|/'fәuldiŋ/a. 可折叠的; 折叠;折叠效应
alphabetical|/.ælfә'betikәl/a. 依字母顺序的, 字母的
carelessly|/'kєәlisli/adv. 不注意地, 粗心地
unsteady|/'ʌn'stedi/a. 不稳固的, 摇摆的, 不稳定的, 易变的, 不安定的, 不规则的, 古怪的, 无常的;使不稳定, 使不安定, 动摇
knitted|knit的过去式和过去分词
disapproving|/ˌdɪsəˈpru:vɪŋ/a. 不满的, 反对的;不赞成( disapprove的现在分词 )
upsetting|镦(粗); 镦锻
unwillingly|/ʌn'wɪlɪŋlɪ/adv. 不情愿地, 勉强地;勉勉强强
rudely|/'ru:dli/adv. 无礼地, 粗鲁地, 粗陋地
swearing|发誓, 宣誓
irritated|/'iriteitid/a. 被激怒的, 生了气的, 变粗的, 因刺激而发炎的, 发红的
dressed|/'dresid/a. 穿好衣服的;打扮好的;去内脏及分割加工好的（特指动物, 如鱼, 禽类等）
alphabetically|/.ælfә'betikәli/adv. 按字母顺序地
CT|计算机断层扫描; 通信终端, 计算机终端, 计算机断层造影, 计数器
arms|/ɑ:mz/n. 武器, 军事行动; 武器, 军械, 枪械
internet|因特网, 国际互连网, 网际网络, 互连网络, 广域网
coughing|/ˈkɒfɪŋ/v. 咳嗽( cough的现在分词 );（从喉咙或肺中）咳出;（突然）发出刺耳的噪音
approving|/әp'ru:viŋ/a. 赞成的
lacking|/'lækiŋ/a. 缺乏的, 不足的
cellphone|/'selfәun/n. 蜂窝式便携无线电话;大哥大
located|处于, 位于;坐落的
website|网站（全球资讯网的主机站）
faucet|/'fɒ:sit/n. 龙头, 开关, 旋塞
a bit|一点儿;有一点儿
a couple|一对夫妇;夫妻俩
a few|几个, 少数, 一些
a little|一些, 一点点, 一点儿, 稍微, 些许
a lot|大量, 很, 非常
apart from|除了...之外
as soon as|一...就
as well|也
aside from|除...以外
associated with|与…有关系;与…相联系
at first|起先
at least|至少; 至少
Based On|基准样式
be called|被叫做…;被称为…
be going to|将要;打算
be sick|恶心, 呕吐
because of|因为
by accident|偶然
by means of|依靠
cannot|/'kænɒt/aux. 无法, 不能
care for|喜欢, 照顾, 为...操心, 尊重
consist of|由...组成
deal with|安排, 处理, 涉及, 做生意
due to|由于, 应归于
dvd|数字化视频光盘（Digital Video Disk）
each other|彼此
email|/'i:'meil/n. 电子信函
fall asleep|入睡, 长眠, 懈怠, 静止不动
fall over|被…绊倒; 意外地从…上跌落; 落在…之外; 迫不及待做某事
feel sick|觉得要呕吐
for instance|例如; 例如
get off|下来, 脱下, 出发, 动身, 开始, 被容忍
get on|生活, 融洽相处, 进展, 穿上, 上去, 使前进
give birth|使诞生, 生（孩子）
glasses|/'glɑ:siz/n. 眼镜;双筒望远镜;玻璃（glass的复数形式）
go bad|变质; 坏
go down|下去, 下沉, 坠落, 被接受, 咽下, 平静下来, 下降, 传下去
go up|上升, 兴建
go wrong|走错路, 出毛病, 失败
good at|擅长…
good for|值...的, 有支付...能力的, 有效的, 对...有用的
groceries|食品, 杂货
grow up|成熟, 成年, 发展, 逐渐形成
have to|不得不, 只好; 只得; 必须; 不得已
in a hurry|匆忙
in addition|另外
in advance|预先; 预先
in case|万一
in charge of|负责..., 管理..., 主管..., 掌管..., 看管..., 在...掌管/看管之下
in common|共有
in control|控制, 管理, 负责
in detail|详细地
in exchange|在兑换中
in front|在前面
in general|大多数
in memory of|纪念...
in order to|为了…
in public|当众
in the end|最后, 终于
instead of|代替
involved in|涉及;包含;牵涉进…
keen on|热衷于有兴趣的
leave out|省去, 遗漏, 不考虑
look after|目送, 照顾, 关心
look at|看, 考虑, 着眼于
look for|寻找, 期待
look forward to|期望, 盼望; 瞩望; 属望; 企
make friends|交朋友
make fun of|取笑
make sth up|补足, 弥补, 编造, 虚构
make sure|确定
movie theater|电影院
next to|几乎
on board|在船/车/飞机上, 在公共交通车辆上; 已装船
on purpose|故意; 故意地
one another|彼此
opposed to|反对;反对…的
ought to|应该
pay attention|专心
per cent|/pә'sent/n. 每百中, 百分之..., (英)利息...厘的证券, (非正式)百分率; 每百分, 百分数
pick sth up|得到; 恢复; 捡起
premises|房屋, 上述各点, 上述房屋; 房屋, 店铺, 契约前言
prime minister|总理, 首相; 总理, 首相, 内阁总理
put sth on|穿上, 增加, 安排, 打开
put sth out|熄灭, 发布
rather than|与其...不如...
refer to|查阅, 提到, 谈到, 打听
rely on|依赖, 依靠
set fire to|点燃
sit down|坐下, 占据, 参加静坐罢工(或示威)
so that|所以
stand up|站起来, 竖立, 站得住脚, 经得起
stick out|(使)突出, (非正式)明显, 醒目
such as|例如..., 像这种的
take action|采取行动, 提出诉讼
take advantage of|/teik ədˈvɑ:ntidʒ ɔv/v. 利用;欺骗, 占…的便宜
take care|当心, 小心; 坚持到底
take notice of|注意到; 在意; 睬; 理睬
take part|参加比赛
take place|发生
take sth off|拿去, 拿走, 去掉, 取消, 脱下, 夺去, 复制, 带领
thank you|谢谢你
the rest|其余者
the web|网
throw sth away|扔掉, 浪费掉, 放过机会
tie sth up|连接, 联系, 密切联系
under control|被控制住
used to|过去经常(做)..., 过去有规律地发生
well known|众所周知的; 出名的
wind sth up|卷紧, 卷拢, 上紧...的发条
yours faithfully|（主英）[给不知姓名者的正式信件的结尾客套语]
yours sincerely|鄙人, 我
yours truly|鄙人, 我
two|/tu:/num. 二, 二个
these|/ði:z/pron. 这些
those|/ðәuz/pron. 那些
three|/θri:/num. 三, 三个
four|/fɒ:/num. 四, 四个; 四冲程循环
going|/'gәuiŋ/n. 去, 离去, 工作情况, 地面状况, 行为;进行中的, 流行的, 成功的, 现存的
five|/faiv/num. 五, 五个
six|/siks/num. 六, 六个
million|/'miljәn/n. 百万, 无数;百万
lot|/lɒt/n. 运气, 签, 抽签, 份额, 许多, 一堆;划分;抽签, 抓阄
hundred|/'hʌndrәd/n. 百, 百个东西;百, 百个;一百的, 许多的
ten|/ten/num. 十, 十个
seven|/'sevn/num. 七, 七个
eight|/eit/num. 八, 八个
twenty|/'twenti/num. 二十, 二十个
thousand|/'θauznd/num. 千;成千的, 许多的;许许多多
nine|/nain/num. 九, 九个
thirty|/'θә:ti/num. 三十, 三十个
fifty|/'fifti/num. 五十, 五十个
forty|/'fɒ:ti/num. 四十, 四十个
twelve|/twelv/num. 十二, 十二个
sixty|/'siksti/num. 六十, 六十个
fifteen|/'fif'ti:n/num. 十五, 十五个
billion|/'biljәn/num. 十亿, 十亿个
nineteen|/.nain'ti:n/num. 十九, 十九个
eighty|/'eiti/num. 八十, 八十个
ninety|/'nainti/num. 九十, 九十个
seventy|/'sevnti/num. 七十, 七十个
eleven|/i'levn/num. 十一, 十一个
eighteen|/'ei'ti:n/num. 十八, 十八个
percent|/pә'sent/n. 百分比, 百分数, 部分; 百分率
fourteen|/'fɒ:'ti:n/num. 十四, 十四个
sixteen|/'siks'ti:n/num. 十六, 十六个
thirteen|/'θә:'ti:n/num. 十三, 十三个
photo|/'fәutәu/n. 相片, 照片, 逼真的描绘;照相;照相的, 摄影用的, 详细记录的, 逼真的, 酷似的
seventeen|/sevn'ti:n/num. 十七, 十七个
coming|/'kʌmiŋ/n. 来临;就要来的, 接着的
accord|/ә'kɒ:d/n. 一致, 调和, 协定;给与, 使一致;相符合
got|get的过去式和过去分词; 谷草转氨酶; 谷氨酸草酰乙酸转氨酶
based|/beist/v. 立基于, 以…为基础（base的过去式和过去分词）
can't|/kɑ:nt/vi. 不能
couldn't|(=could not)不能
didn't|/ˈdɪdnt/abbr. did not 没有
doesn't|/ˈdʌznt/aux. 表示否定
don't|(= do not)不要;n. 禁忌
he's|他是, 他有
I'd|/aɪ'd/abbr. 我愿意（等于I would）
I'll|我将, 我会（=I shall）
I'm|/aɪm/abbr. 我是（缩写）
I've|（等于I have）
isn't|(=is not)不是
it's|it is的缩写, it has的缩写
that's|(=that is)说得更精确些, 简而言之
they're|/ðeə(r)/abbr. they are 他们是
wasn't|/'wɔznt/prep. 不是
we're|(we are 的常用口语形式)
we've|（尤当 have 为助动词时, we have 的常用口语形式）
won't|将不, 不会（=will not）
wouldn't|=would not
you're|/jʊə(r)/abbr. you are 你（你们）是
you've|/ju:v/abbr. you have 你（们）已经
third|/θә:d/num. 第三, 三分之一; 第三;第三的
someone|/'sʌmwʌn/pron. 有人, 某人
refer|/ri'fә:/vt. 提交, 归诸于, 把...提交, 使求助于;提到, 涉及, 查阅, 查询, 咨询
okay|/әj'kei/a. 好, 可以, 行, 对, 好吗, 很好;好, 可以, 行, 对, 好吗, 很好;同意, 签认, 批准, 认可;同意, 签认, 批准, 认可
earlier|早的;初期的
involved|/in'vɔlvd/a. 难懂的, 复杂的, 不易懂的, 卷入...之中的, 累及..., 与...有关, 被纠缠的; 包含, 涉及
Christmas|/'krismәs/n. 圣诞节
born|/bɒ:n/a. 天生的;bear的过去分词
administration|/әd.mini'streiʃәn/n. 行政, 管理, 政府机关; 给药
assess|/ә'ses/vt. 估定, 对...征税, 评定; 估计, 估价, 确定(税款罚款等)的金额
asset|/'æset/n. 资产, 有益的东西
fourth|/fɒ:θ/num. 第四, 四分之一
everybody|/'evribɒdi/pron. 每个人, 人人
settlement|/'setlmәnt/n. 安顿, 解决, 处理, 结算, 殖民, 殖民地, 沉降; 居住区;沉渣
democratic|/.demә'krætik/a. 民主的; 民主的, 民主政体的, 平民的
republic|/ri'pʌblik/n. 共和国, 共和政体, 团体, 界
treaty|/'tri:ti/n. 条约, 谈判; 协议, 协定, 协商
supposed|/sә'pәuzd/a. 想象上的, 假定的, 被信以为真的; 推测的, 想像的, 被信以为真的
liberal|/'libәrәl/n. 自由主义者;慷慨的, 不拘泥的, 宽大的, 自由主义的
troop|/tru:p/n. 军队, 一群, 一队;群集, 结队, 成群而行
deputy|/'depjuti/n. 副手，代理人
leadership|/'li:dәʃip/n. 领导能力, 领导阶层
championship|/'tʃæmpiәnʃip/n. 冠军身份, 冠军称号, 捍卫
negotiation|/ni.gәuʃi'eiʃәn/n. 谈判, 磋商, 交涉; 谈判, 协商
champion|/'tʃæmpiәn/n. 冠军, 拥护者, 战士;保卫, 拥护;优胜的
democracy|/di'mɒkrәsi/n. 民主政治, 民主主义; 民主, 民主政治, 民主政体
territory|/'teritәri/n. 领土, 领地, 版图, 地区, 活动范围; (推销员等的)推销区域
inflation|/in'fleiʃәn/n. 胀大, 夸张, 通货膨胀; 充气吹胀;膨胀
resolution|/.rezә'lu:ʃәn/n. 解析, 决心, 坚定, 决定, 决议, 消除, 解答, 分解;图形分辨率; 图形分辨率
dispute|/dis'pju:t/n. 争论;争论
currency|/'kʌrәnsi/n. 货币, 通货, 流通, 通用; 货币, 货币型
spokesman|/'spәuksmәn/n. 发言人, 代言者
communist|/'kɒmjunist/n. 共产主义者, 共产党员; 共产主义的, 共产党的
critic|/'kritik/n. 批评家, 鉴定家
poll|/pәul/n. 投票, 民意测验, 选举投票, 投票数, 一组人中的一个, 头颈和后脑部, 鹦鹉;对...进行民意测验, 获得...票, 剪树枝, 轮询;投票;剪过毛的, 修过枝的; 轮询
recession|/ri'seʃәn/n. 后退, 凹处, 衰退, 归还; 退缩
radical|/'rædikl/n. 激进分子, 词根, 基础, 根式, 根;激进的, 根本的, 基本的, 根的
bond|/bɒnd/n. 捆绑物, 结合, 债券, 契约, 粘合剂, 保证人, 键, 关栈保留;存入关栈, 使黏合;结合
fifth|/fifθ/num. 第五, 五分之一
investor|/in'vestә/n. 投资者; 投资者
mortgage|/'mɒ:gidʒ/n. 抵押, 约束性义务, 抵押借款;抵押, 以...作担保, 把...许给
journal|/'dʒә:nәl/n. 日记, 杂志, 日报; 轴颈
nineteenth|/.nain'ti:nθ/num. 第十九, 十九分之一
negotiate|/ni'gәuʃieit/vi. 商议, 谈判, 交涉;谈妥, 转让, 处理
mission|/'miʃәn/n. 任务, 代表团, 使命, 传教团;派遣, 向...传教
talent|/'tælәnt/n. 天才, 才能, 有才干的人, 天资
democrat|/'demәkræt/n. 民主人士, 民主主义者, 民主党党员; 民主党
stake|/steik/n. 桩, 炮烙刑, 木柱, 赌注, 奖金;打桩, 用桩撑, 下赌注, 资助;打赌
economics|/.i:kә'nɒmiks/n. 经济学; 经济学
refugee|/.refju'dʒi:/n. 难民, 流亡者; 避难者, 流亡者, 难民
summit|/'sʌmit/n. 顶点, 最高阶层, 最高级会议;政府首脑的, 最高级的
deficit|/'defisit/n. 赤字, 不足额; 短缺
album|/'ælbәm/n. 粘贴簿, 唱片套; 白色物
sixth|/siksθ/num. 第六, 六分之一
maker|/'meikә/n. 制造者, 上帝; 制造者, 出票人
inspire|/in'spaiә/vt. 使感动, 激发, 启示, 吸入, 鼓舞, 产生, 使生灵感;吸入, 赋予灵感
correspondent|/.kɒri'spɒndәnt/n. 通讯记者, 通信者; 客户, 代理商行, 代理银行
voter|/'vәutә/n. 选民, 投票人; 选民, 选举人, 投票人
rebel|/'rebl/n. 叛徒, 反叛者;造反, 反抗, 抵抗, 反感;造反的, 反抗的
airline|/'єәlain/n. 航线, 航线的设备, 航空公司
eighteenth|/ei'ti:nθ/num. 第十八, 十八分之一
reporter|/ri'pɒ:tә/n. 记者, 报告者; 指示器
allege|/ә'ledʒ/vt. 宣称, 主张, 提出, 断言; 断言, 指称, 指证
analyst|/'ænәlist/n. 分析者, 精神分析学家; 分析员;化验员
AIDS|/eidz/n. 爱滋病(获得性免疫缺陷综合征); 高级综合数据系统, 先进交互调试系统, 自动图解文档编制系统;美国决策学学会, 信息自动显示系统, 自动综合调试系统
twentieth|/'twentiiθ/num. 第二十, 二十分之一
republican|/ri'pʌblikәn/n. 共和主义者, 共和党员;共和政体的, 共和国的, 共和主义的
sterling|/'stә:liŋ/n. 英国货币, 标准纯银;英国货币的, 标准纯银的, 含标准成分的
sanction|/'sæŋkʃәn/n. 核准, 制裁, 处罚, 约束力;制定制裁规则, 认可, 核准, 同意
gay|/gei/a. 欢快的, 艳丽的, 快乐的, 放荡的
seventh|/'sevnθ/num. 第七, 七分之一
eighth|/eitθ/num. 第八, 八分之一
seventeenth|/sevn'ti:nθ/num. 第十七, 十七分之一
reporting|/ri'pɒ:tiŋ/n. 报道; 报告, 汇报
tenth|/tenθ/num. 第十, 十分之一
hostage|/'hɒstidʒ/n. 人质, 抵押品; 人质, 抵押品
accepted|/әk'septid/a. 公认的, 一般承认的; 已承兑, 已认付
ninth|/nainθ/num. 第九, 九分之一
nationalist|/'næʃәnәlist/n. 国家主义者, 民族主义者
twelfth|/twelfθ/num. 第十二, 十二分之一
Muslim|/'mjzlim; (?@) 'mʌzlem/n. 伊斯兰教, 伊斯兰教教徒
eleventh|/i'levnθ/num. 第十一, 十一分之一
fifteenth|/'fif'ti:nθ/num. 第十五, 十五分之一
thirteenth|/'θә:ti:nθ/num. 第十三, 十三分之一
fourteenth|/'fɒ:'ti:nθ/num. 第十四, 十四分之一
caption|/'kæpʃәn/n. 说明, 字幕, 标题;加上标题, 加上说明; 标题
fiftieth|/'fiftiiθ/num. 第五十, 五十分之一
thirtieth|/'θә:tiiθ/num. 第三十, 三十分之一
Christian|/'kristʃәn/n. 基督徒, 正派人;基督的, 基督教的
fortieth|/'fɒ:tiiθ/num. 第四十, 四十分之一
millionth|/'miljәnθ/a. 第一百万的, 百万分之一的;第一百万, 百万分之一
eightieth|/'eitiiθ/num. 第八十, 八十分之一
sixtieth|/'sikstiiθ/num. 第六十, 六十分之一
seventieth|/'sevntiiθ/num. 第七十, 七十分之一
ninetieth|/'naintiiθ/num. 第九十, 九十分之一
aren't|/ɑ:nt/abbr. 不是（are not）
gone|/gɒn/a. 离去的, 死去的, 用完的;go的过去分词
hadn't|/ˈhædnt/abbr. had not 没有
hasn't|=has not
haven't|=have not
he'd|他将, 他会, 他已经, 他有
let's|/lets/abbr. let us 让我们
she'd|/ʃi:d/abbr. she had 她已经;she would 她可以
she's|/ʃi:z/abbr. she has 她（已经）;she is 她是
they'd|(=they had, they would)厚皮的
they'll|/ðeɪl/abbr. they will 他们将
they've|/ðeɪv/abbr. they have 他们曾经
tion|象征式互动;支票电托收
we'll|(we shall或 we will 的常用口语形式)
weren't|/wә:nt, weәnt/prep. 不是
what's|（尤当 has 为助动词时, what is 或 what has 的常用口语形式）; 乌
who's|/hu:z/abbr. who is 谁是…
provision|/prә'viʒәn/n. (政府提供的)钱和设备, 准备, 供应品, 规定, 条款;供给...食物及必需品
prime|/praim/n. 最佳部分, 初期, 全盛期;主要的, 最初的, 根本的;加油启动, 灌注, 填装
species|/'spi:ʃiz/n. 种, 类, 外形; 茶剂;种
existing|/i^'zistiŋ/a. 存在的, 目前的, 现存的, 现有的; 现成的, 已有的, 现存的
etc|及其他, 等等
legislation|/.ledʒis'leiʃәn/n. 立法, 法律; 立法, 法规
consist|/kәn'sist/vi. 组成, 存在于, 一致
ought|/ɒ:t/aux. 应该, 大概;责任
enterprise|/'entәpraiz/n. 企业, 事业心, 进取心, 干事业; 企业
nod|/nɒd/n. 点头, 打盹, 晃动;点头, 打盹;点头表示, 点(头)
assembly|/ә'sembli/n. 与会者, 集会, 装配, 组件; 装配
solicitor|/sә'lisitә/n. (英)律师, 初级律师, (美)法务官, (美)掮客, 游说者, (美)募捐者; 募损者, 律师
component|/kәm'pәunәnt/n. 元件, 组件, 成分;组成的, 构成的; 组件
assumption|/ә'sʌmpʃәn/n. 假定, 自负, 担任, 假装; 假定, 承担
gallery|/'gælәri/n. 走廊, 最高楼座, 画廊, 收集, 图库; 图库
rely|/ri'lai/vi. 信赖, 依赖, 信任
bloody|/'blʌdi/a. 血腥的, 嗜杀的, 有血的
revenue|/'revinju:/n. 收入, 岁入, 税收, 税务局; 岁入, 税收, 税务局
anybody|/'enibɒdi/pron. 任何人;重要人物
mechanism|/'mekәnizm/n. 机械, 机构, 结构, 机理, 技巧; 机理;历程;机构
welfare|/'welfєә/n. 福利, 安宁, 幸福, 福利事业;福利的
establishment|/i'stæbliʃmәnt/n. 确立, 制定, 设施; 企业, 公司, 商店
being|/'bi:iŋ/n. 存在, 性质, 生命, 人, 生物, be的现在分词
outcome|/'autkʌm/n. 结果, 出口
notion|/'nәuʃәn/n. 概念, 观念, 想法, 打算, 别致的小东西; 概念, 打算, 想法
corporate|/'kɒ:pәrit/a. 社团的, 合伙的, 公司的; 团体的, 法人的, 社团的
Co|钴(27号元素)
corporation|/.kɒ:pә'reiʃәn/n. 公司, 合作, 法人团体; 法人团体, 社团, 法人
subsequent|/'sʌbsikwәnt/a. 后来的, 接下去的; 后来的
parliamentary|/.pɑ:lә'mentәri/a. 国会的, 议会的, 议会制度的
mill|/mil/n. 压榨机, 磨坊, 制造厂;碾磨, 磨细, 搅拌, 使乱转;乱转, 被碾磨
constitution|/.kɒnsti'tju:ʃәn/n. 构成, 宪法, 体格; 体质;结构, 组织
implement|/'implimәnt/n. 工具, 器具, 手段;实现, 使生效, 执行
gene|/dʒi:n/n. 基因; 基因(遗传因子)
agricultural|/.ægri'kʌltʃәrәl/a. 农业的; 农业的, 耕作的
regime|/rei'ʒi:m/n. 政权, 当权期间, 政体, 社会制度, 体制, 情态; 制度, 生活制度
glance|/'glɑ:ns/n. 一瞥, 闪光, 掠过, 辉矿类;扫视, 闪光, 掠过, 提到, 略说;扫视, 反射, 使掠过
protein|/'prәuti:in/n. 蛋白质;蛋白质的
crew|/kru:/n. 全体人员, 一群人, 全体队员;crow的过去式
principal|/'prinsipәl/n. 校长, 首长, 本金, 主犯, 资本, 委托人;主要的, 最重要的, 首要的
golden|/'gәuldn/a. 金的, 含金的, 金色的, 贵重的, 繁盛的; 金制的, 金色的, 兴隆的
recovery|/ri'kʌvәri/n. 恢复, 复原, 痊愈, 重获; 恢复
voluntary|/'vɒlәntәri/a. 自动的, 自愿的, 故意的, 志愿的, 自发的;自愿行动, 志愿者, 自由调
inspector|/in'spektә/n. 检查员, 巡视员; 检查员
agriculture|/'ægrikʌltʃә/n. 农业; 农业, 农学
shareholder|/'ʃєә.hәuldә/n. 股东; 股东, 股票持有人
penalty|/'penәlti/n. 处罚, 刑罚, 罚款, 罚球, 报应, 不利结果, 妨碍; 罚金(款), 违约金
perspective|/pә'spektiv/n. 远景, 透视感, (观察问题的)视角, 透视法, 看法, 透视图;透视的, 透视法的; 透视
judgment|/'dʒʌdʒmәnt/n. 裁判, 宣告, 判决书; 判断
symptom|/'simptәm/n. 症状, 征候, 征兆; 症状
alliance|/ә'laiәns/n. 联盟, 联合; 同盟, 联盟, 联姻
comprehensive|/.kɒmpri'hensiv/a. 广泛的, 有理解力的, 综合的; 广泛的, 综合的, 全面的
dealer|/'di:lә/n. 经销商, 商人; 交易员, 贩卖商
lad|/læd/n. 青年, 家伙, 少年, 情人
policeman|/pә'li:smәn/n. 警察; 淀帚
tale|/teil/n. 故事, 谎言, 谣言, 陈述, 叙述; 虚语, 诽语, 谣言
cricket|/'krikit/n. 蟋蟀, 板球
golf|/gɒlf/n. 高尔夫球;打高尔夫球
literary|/'litәrәri/a. 文学的, 文艺的, 精通文学的; 文学的, 从事文学的, 从事写作的
guitar|/gi'tɑ:/n. 吉他
sake|/seik/n. 目的, 缘故, 理由
circuit|/'sә:kit/n. 电路, 环(行)道, 巡回; 线路;电路
demonstration|/.demәn'streiʃәn/n. 示范, 实证; 示教, 实物教授
resign|/ri'zain/vt. 辞职, 放弃, 使顺从;辞职, 屈从
adviser|/әd'vaizә/n. 顾问, 劝告者, 指导教师; 顾问, 劝告者
personnel|/.pә:sә'nel/n. 人员, 人事部门, 人事科(处); 人事, 全体人员, 职工
classical|/'klæsikl/a. 古典的, 正统派的, 经典的; 古典的;标准的, 典型的
province|/'prɒvins/n. 省, 地方, 职权, 领域; 省, 地方, 领域
acquisition|/.ækwi'ziʃәn/n. 获得, 获得物; 收购, 招揽, 取得
socialist|/'sәuʃәlist/n. 社会主义者, 社会党党员; 社会主义的
occupation|/.ɒkju'peiʃәn/n. 职业, 占有, 占有期, 占领, 占领军; 占有, 占用, 职业
catholic|/'kæθәlik/n. 天主教徒;天主教的, 普遍的, 广泛的, 宽宏大量的
numerous|/'nju:mәrәs/a. 很多的, 数目众多的, 多数的; 多数的, 甚多的
consultant|/kәn'sʌltәnt/n. 顾问, 征询意见者; 顾问医师
percentage|/pә'sentidʒ/n. 百分比, 比率, 部分, 可能性; 百分比
compensation|/.kɒmpen'seiʃәn/n. 补偿, 赔偿金, 工资; 代偿(机能), 补偿
poet|/'pәuit/n. 诗人
earnings|/'ә:niŋ/n. 所赚的钱, 工资, 收入; 工资, 收入, 收益, 盈余
widespread|/'waidspred/a. 充分伸展的, 广布的, 普及的, 流传广的
observer|/әb'zә:vә/n. 观察者, 遵守者, 观察员; 观察者, 观察员, 监场员
given|/'givәn/a. 赠予的, 沉溺的, 约定的;give的过去分词
poverty|/'pɒvәti/n. 贫穷, 贫困, 缺乏; 贫乏, 缺乏
enhance|/in'hæns/vt. 提高, 加强, 增加
consistent|/kәn'sistәnt/a. 一致的, 坚持的, 并立的, 坚固的
ownership|/'әunәʃip/n. 所有权, 物主身份; 所有权, 所有制
burden|/'bә:dn/n. 负担, 重载, 担子, 责任;装货于, 烦扰, 使负担
operator|/'ɒpәreitә/n. 操作员, 行家, 经纪人, 算子, 运算符; 运算符
strengthen|/'streŋθәn/vt. 加强, 变坚固;变强, 股票上涨
publisher|/'pʌbliʃә/n. 出版者, 发行人; 发行人, 出版者, 报刊发行者
dominant|/'dɒminәnt/a. 占优势的, 支配的; 优性的, 显性的
strategic|/strә'ti:dʒik/a. 战略的, 战略上的; 战略的
childhood|/'tʃaildhud/n. 孩童时期; 儿童期
merchant|/'mә:tʃәnt/n. 商人, 店主;商业的, 商人的
designer|/di'zainә/n. 设计者, 谋划者, 制图者; 设计员
fabric|/'fæbrik/n. 织物, 布, 结构, 构造, 建筑物; 组织, 建筑物, 工厂
sustain|/sә'stein/vt. 承受, 支持, 供养, 继续, 忍受, 蒙受, 证实, 准许; 持续
vessel|/'vesl/n. 船, 容器, 脉管; 管, 脉管, (容)器
participate|/pɑ:'tisipeit/vi. 参加, 分享, 参与, 带有;分享, 分担
tissue|/'tiʃu:/n. 薄的织物, 薄纱, 棉纸, 组织, 一套; 组织
rugby|/'rʌ^bi/n. 橄榄球, 橄榄球赛
unity|/'ju:niti/n. 一致, 联合, 单一(性), 个体; 统一
squad|/skwɒd/n. 班, 小队, 小集团;编成班
profile|/'prәufail/n. 侧面, 轮廓, 传略;描绘...轮廓, 写...的传略; 提问档;剖面图法;剖面法
headquarters|/hed'kwɒ:tәz/n. 总部, 司令部, 总部人员; 本部, 总部, 总署
announcement|/ә'naunsmәnt/n. 公告, 发表, 告知; 通告, 布告, 公告
surgery|/'sә:dʒәri/n. 外科, 手术, 手术室, 换球术
psychological|/.saikә'lɒdʒikәl/a. 心理学的, 精神上的, 心灵的; 心理上的, 心理学的
conviction|/kәn'vikʃәn/n. 定罪, 信服, 坚信; 定罪, 证明有罪, 判罪
snap|/snæp/vt. 使突然中断, 猛咬, 争夺, 拉断, 使有啪啪声, 厉声说, 突然射击, 用快照拍摄;咬, 扑, 抓, 折断, 劈啪地响, 厉声说, 砰然关上;猛咬, 猛扑, 劈啪声, 申斥, 快照, 活力, 一般时期的寒冷天气, 揿钮;突然的, 装搭扣的;猛地; 子网访问协…
tennis|/'tenis/n. 网球
monetary|/'mʌnitәri/a. 货币的, 金钱的; 货币的, 金融的
amendment|/ә'mendmәnt/n. 修订, 改善, 改良, 改正; 调理剂;修正
pit|/pit/n. 深坑, 矿井, 果核, 地窖, 深渊, 绝境, 陷阱;窖藏, 使凹下, 使有麻点, 去...之核, 使留疤痕, 使相斗, 使竞争;起凹点, 凹陷
gesture|/'dʒestʃә/n. 手势, 姿态;作手势, 作姿态
treasury|/'treʒәri/n. 国库, 宝库, 财政部, 国库券; 库存, 国库, 金库
detective|/di'tektiv/n. 侦探;侦探的
transition|/træn'ziʃәn/n. 转变, 转换, 变迁, 过渡时期, 临时转调; 跃迁
occasional|/ә'keiʒәnl/a. 偶然的, 临时的; 偶然的, 特殊场合的
lower|/'lәuә/a. 低的, 下级的, 下层的;降低, 跌落, 减弱;放下, 降下, 减弱, 贬低
passion|/'pæʃәn/n. 激情, 酷爱, 热爱, 强烈感情, 耶稣受难(故事)
folk|/fәuk/n. 人们, 家人, 亲属, 民族;民间的
margin|/'mɑ:dʒin/n. 页边的空白, 边缘, 界限, 余裕, 差数, 差额, 保证金;加边于, 加旁注于; 页边距
fulfil|/ful'fil/vt. 实践, 履行, 实行, 完成, 结束, 满足; 履行(契约), 满期
assault|/ә'sɒ:t/n. 攻击, 袭击;袭击, 攻击;发动攻击
seize|/si:z/vt. 抓住, 逮捕, 俘获, 没收, 扣押, 掌握;突然抓住, 利用
psychology|/sai'kɒlәdʒi/n. 心理学, 心理状态; 心理学
opera|/'ɒpәrә/n. 歌剧
consciousness|/'kɒnʃәsnis/n. 意识, 知觉, 自觉; (有)意识, 清醒
overseas|/'әuvә'si:z/a. 海外的, 国外的;在海外, 在国外
cite|/sait/vt. 引用, 引证, 表彰; 引证, 指引
coalition|/.kәuә'liʃәn/n. 结合体, 结合, 联合; 联合, 联盟
vulnerable|/'vʌlnәrәbl/a. 易受伤害的, 有弱点的, 易受影响的, 脆弱的, 成局的; 易损的
volunteer|/.vɒlәn'tiә/n. 志愿者;志愿的;自愿
sophisticated|/sә'fistikeitid/a. 复杂的, 久经世故的; 尖端的, 高级的, 非常有经验的
agenda|/ә'dʒendә/pl. 议程, 日常工作事项; 待议事件
creative|/kri:'eitiv/a. 有创造力的, 创作的, 产生的
exploit|/'eksplɒit/n. 功绩, 勋绩;开发, 利用, 开拓, 剥削
intellectual|/.intә'lektʃuәl/n. 有知识者, 知识分子, 凭理智做事者;智力的, 用脑力的, 聪明的
lease|/li:s/n. 租约, 租期, 租;出租, 租出, 租得
portrait|/'pɒ:treit/n. 肖像, 人像, 半身像, 描写, 竖排格式; 纵向
jury|/'dʒuәri/n. 陪审团, 评判委员会;应急的
dividend|/'dividend/n. 被除数, 股利; 被除数
carbon|/'kɑ:bәn/n. 碳, 副本, 复写纸; 碳
charter|/'tʃɑ:tә/n. 特许状, 执照, 宪章;特许, 发给特许执照
sigh|/sai/n. 叹息;叹息, 渴望;叹息着说
eliminate|/i'limineit/vt. 除去, 排除, 剔除, 消除
wipe|/waip/n. 擦拭, 用力打, 凸轮;擦, 揩, 消灭, 涂上, 拭去;擦, 打
depression|/di'preʃәn/n. 不景气, 消沉, 沮丧, 洼地; 抑郁;, 阻抑, 压低, 凹, 窝, 衰退, 俯角
suspend|/sә'spend/vt. 悬, 吊, 使悬浮, 暂停, 中止, 推迟;暂停, 中止, 悬浮, 停止偿付债务; 暂停
commissioner|/kә'miʃәnә/n. 委员, 理事, 行政长官; 委员, 政府的特派员, 地方地官
flexible|/'fleksәbl/a. 易曲的, 灵活的, 柔顺的, 能变形的, 可通融的; 能屈的
compose|/kәm'pәuz/vt. 组成, 写作, 作曲, 使平静;创作, 排字; 编写
collective|/kә'leiktiv/a. 集体的, 聚集的, 共同的; 集体的, 集合的
commander|/kә'mɑ:ndә/n. 司令官, 指挥官
native|/'neitiv/n. 本地人, 土产, 当地人;本国的, 与生俱来的, 自然的
exposure|/ik'spәuʒә/n. 暴露, 揭发, 揭露; 曝光量;照射;照射量
resignation|/.rezig'neiʃәn/n. 辞职, 辞呈, 听从; 辞职
revolutionary|/.revә'lu:ʃәnәri/n. 革命者, 革命党人;革命的, 革命性的
modest|/'mɒdist/a. 谦逊的, 羞怯的, 端庄的, 适度的; 适当的
fate|/feit/n. 命运, 运气;注定
barely|/'bєәli/adv. 几乎不
bare|/bєә/a. 赤裸的, 缺少的, 无遮蔽的, 坦率的;使赤裸, 露出
gross|/grәus/n. 总数, 总量;总共的, 未打折扣的, 恶劣的, 粗野的;总共收入
intense|/in'tens/a. 非常的, 强烈的, 紧张的, 热情的; 强的
withdrawal|/wið'drɒ:l/n. 提款, 撤退, 退回, 撤消, 退隐, 戒毒过程; 戒除, 脱瘾
prominent|/'prɒminәnt/a. 卓越的, 显著的, 突出的, 凸出的
condemn|/kәn'dem/vt. 判刑, 责备, 谴责; 定罪, 判刑, 宣告有罪
declaration|/.deklә'reiʃәn/n. 宣告, 说明, 宣布; 说明
historic|/hi'stɒrik/a. 历史上著名的, 有历史性的
bike|/baik/n. 自行车, 脚踏车
youngster|/'jʌŋstә/n. 小孩, 年轻人, 少年; 儿童, 少年, 青年
ethnic|/'eθnik/a. 人种的, 种族的; 人种的
federation|/fedә'reiʃәn/n. 联邦, 联合, 联盟; 联邦, 联盟, 联邦政府
molecule|/'mɒlikju:l/n. 分子, 些微; 分子
reliable|/ri'laiәbl/a. 可靠的, 可信赖的; 可靠的, 可信赖的, 确实的
tide|/taid/n. 潮, 潮汐, 趋势, 潮流, 涨潮, 高潮;使随潮漂流;顺潮行驶
acre|/'eikә/n. 英亩
clinic|/'klinik/n. 诊所, 临床教学; 诊所(门诊部);临床(讲解);临床(学)科
mutual|/'mju:tʃuәl/a. 相互的, 共有的; 相互的
Jew|/dʒu:/n. 犹太人, 守财奴, 犹太教信徒;欺骗, 杀价
era|/'iәrә/n. 时代, 纪元, 时期
laughter|/'lɑ:ftә/n. 笑, 笑声; 笑, 大笑
satellite|/'sætlait/n. 人造卫星; 伴行静脉, 陪静脉, 陪病部, 随体, 卫星
competitor|/kәm'petitә/n. 竞争者; 竞争者, 竞争对手
yield|/ji:ld/n. 生产量, 投资收益;出产, 给予, 让出, 放弃, 使屈服;出产, 屈服, 投降, 倒塌
coverage|/'kʌvәridʒ/n. 覆盖的范围, 保险总额, 新闻报导; 可达范围;覆盖度
miner|/'mainә/n. 矿工, 开矿机, 坑道工兵; 矿工
integrate|/'intigreit/vt. 综合, 使完整, 使成整体;成一体;完整的, 完全的
ruling|/'ru:liŋ/n. 判决, 裁定, 统治;统治的, 支配的, 普遍的
equity|/'ekwiti/n. 公平, 公正; 权益, 产权
electoral|/i'lektәrәl/a. 选举人的, 选举的, (有关)选举的; 选举的, 选举人的, 由选举人组成的
grip|/grip/n. 紧握, 柄, 握力, 握手方式, 手提包, 掌握, 支配, 控制;抓紧, 抱住, 吸住, 掌握;握牢, 有吸引力
marked|/mɑ:kt/a. 有记号的, 显著的, 醒目的; 有记号的;显著的
superb|/sju'pә:b/a. 极度的, 华丽的, 极好的
await|/ә'weit/vt. 等候;等待着
shortage|/'ʃɒ:tidʒ/n. 不足, 缺乏; 缺额
undermine|/.ʌndә'main/vt. 在...下面挖, 渐渐破坏, 暗地里破坏; 暗中破坏, 以阴谋中伤伤害
flee|/fli:/vt. 逃避, 逃跑, 逃走;逃, 消失
myth|/miθ/n. 神话, 虚构的事, 虚构的人
invasion|/in'veiʒәn/n. 侵犯, 侵入, 侵害; 侵袭, 侵入, 发病
fleet|/fli:t/n. 舰队, 港湾, 小河;快速的, 敏捷的, 浅的, 短暂的;浅;疾驰, 飞逝, 掠过;消磨, 变换船(或船员)的位置
crystal|/'kristl/n. 水晶, 水晶装饰品, 结晶;水晶的, 水晶一样的, 透明的
leap|/li:p/n. 跳跃, 剧增, 急变, 被越过之物;跳跃, 突然经过;跃过, 使跃过
raid|/reid/n. 袭击, 突袭, 搜捕;奇袭, 搜捕; 廉价磁盘冗余阵列
therapy|/'θerәpi/n. 治疗; 疗法, 治疗
controversial|/.kɒntrә'vә:ʃәl/a. 争论的, 论争的, 被议论的
banking|/'bæŋkiŋ/n. 银行业务; 银行业, 银行事务
temple|/templ/n. 圣堂, 庙宇, 教堂, 礼拜堂, 太阳穴, 鬓角; 颞颥, 颞部
allegation|/.æli'geiʃәn/n. 断言, 主张, 申辩; 声明, 事实陈述, 断言
controversy|/'kɒntrәvә:si/n. 论争, 辩论, 论战, 争论; 论战, 争论, 争吵
merger|/'mә:dʒә/n. 合并, 归并; 购并
tournament|/'tә:nәmәnt/n. 比赛, 竞赛, 锦标赛, 联赛
hint|/hint/n. 暗示, 提示;暗示, 示意
recruit|/ri'kru:t/n. 新兵, 新手, 新会员, 补给品;恢复, 补充, 充实, 征募;征募新兵, 复原, 得到补充
tremendous|/tri'mendәs/a. 巨大的, 非常的, 可怕的
fade|/feid/vi. 褪色, 消失, 凋谢;使褪色;淡入, 淡出;平淡的
tragedy|/'trædʒidi/n. 悲剧, 惨案, 悲剧作品; 惨事, 灾难, 不辛
rape|/reip/n. 抢夺, 掠夺, 强奸, 葡萄渣, 芸苔;掠夺, 抢夺, 强奸
reluctant|/ri'lʌktәnt/a. 不情愿的, 勉强的; 不愿的, 勉强的, 难以处理的
echo|/'ekәu/n. 回声, 回音, 回波;发回声, 随声附和;摹仿, 重复, 反射; 回显;DOS批处理命令:控制MS-DOS命令是否在屏幕上显示
shore|/ʃɒ:/n. 海岸, 海滨, 斜撑柱;把...送上岸, 支撑, 支持
drift|/drift/n. 漂流物, 漂流, 动向;(使)漂流
harbour|/'hɑ:bә/n. 港, 避难所;庇护, 藏匿, (使)入港停泊
triumph|/'traiәmf/n. 凯旋, 胜利, 欢欣;得胜, 成功
testing|/'testiŋ/n. 测试;吃力的, 试验的
gang|/gæŋ/n. 队, 群, 帮;成群结队, 结成一伙;使成群结队
provoke|/prә'vәuk/vt. 激怒, 惹起, 诱导; 刺激, 煽动, 激怒
stimulate|/'stimjuleit/vt. 刺激, 激励, 鼓舞;起刺激作用
colonel|/'kә:nәl/n. 陆军上校, 长官
diplomatic|/.diplә'mætik/a. 外交的, 老练的; 外交的, 外交上的, 文献上的
marine|/mә'ri:n/n. 舰队, 水兵, 海景画;海的, 海产的, 海底的, 船舶的, 海运的
retail|/'ri:teil/n. 零售;零售的;零售, 详述, 传播;零售
liberty|/'libәli/n. 自由, 特权, 许可, 冒失; 自由, 自由权, 自由区域
carrier|/'kæriә/n. 运送者, 邮递员, 带菌者; 载波
fantasy|/'fæntәsi/n. 幻想, 想象的产物; 幻想
spectacular|/spek'tækjulә/a. 公开展示的, 惊人的, 壮观的;奇观, 惊人之举, 展览物
monthly|/'mʌnθli/n. 月刊;每月的, 每月一次的
dialogue|/'daiәlɒg/n. 对话;对话;用对话表达
suicide|/'sjuisaid/n. 自杀, 自杀者;自杀;自杀的
fraud|/frɒ:d/n. 欺骗, 欺诈, 诡计, 骗子; 欺诈, 舞弊, 骗子
fool|/fu:l/n. 愚人, 受骗者, 奶油拌水果;愚弄, 欺骗, 浪费;干傻事, 开玩笑, 游荡;傻的
compromise|/'kɒmprәmaiz/n. 妥协, 折中, 折中方案, 和解;妥协处理;危害
killer|/'kilә/n. (非正式)杀人者, 屠杀者, 猛兽, 致死(疾病), 杀手, 止痛药, 限制器, 瞄准器; 删除程序;断路器
graduate|/'grædʒueit/n. 毕业生, 量杯;已得学位的, 研究生的, 毕业的;毕业, 得学位, 逐渐变为;准予...毕业, 授予...学位, 分等级, 刻刻度
execute|/'eksikju:t/vt. 执行, 实行, 完成, 处死, 制成; 执行
delegate|/'deligeit/n. 代表;委派...为代表
premium|/'pri:miәm/n. 额外补贴, 奖金, 奖赏, 保险费; 保险费
missile|/'misail/n. 发射物, 导弹, 飞弹, 火箭;可发射的
associated|联合的; 关联的; 结合的
panic|/'pænik/n. 恐慌, 惊慌;惊慌的, 没有理由的, 恐慌的;使惊慌, 使狂热;惊慌
bean|/bi:n/n. 豆子; 油嘴;豆
riot|/'raiәt/n. 暴动, 喧闹, 放纵;发动, 暴动, 纵情, 放荡;浪费, 挥霍
nightmare|/'naitmєә/n. 梦魇, 恶梦, 可怕的事物(或情景、人物); 梦魇, 恶梦
teenager|/'ti:nidʒә/n. 十三岁到十九岁的少年
scandal|/'skændәl/n. 丑闻, 中伤, 耻辱, 反感, 流言蜚语; 丑事, 丑闻, 干丑事的人
instruct|/in'strʌkt/vt. 教, 教育, 命令, 通知; 托办, 指导, 指示
tactic|/'tæktik/n. 一项战术, 一条策略;战术的, 顺序的, 排列的
opt|/ɒpt/vi. 选择
trader|/'treidә/n. 商人, 商船; 交易者, 商船
concession|/kәn'seʃәn/n. 特许, 让步, 认可; 核准, 许可, 特殊(权)
jet|/dʒet/n. 喷射流, 喷嘴, 煤玉;射出, 迸出, 喷射;黑而发亮的, 墨黑的
besides|/bi'saidz/prep. 除...之外;而且, 此外
concede|/kәn'si:d/vt. 承认, 退让;让步
ray|/rei/n. 光线, 射线, 闪烁, 光辉;射出光线, 浮现, 放射光线;放射, 显出
clash|/klæʃ/n. 冲突, 撞击声, 抵触;冲突, 抵触;使发出撞击声; 对撞
disclose|/dis'klәuz/vt. 揭露, 透露; 揭发, 揭露, 公开
delegation|/.deli'geiʃәn/n. 代表团, 派遣代表团, 代表的地位(或权力); 派遣, 委任, 委托
coup|/'ku:/n. 砰然的一击, 妙计, 出乎意料的行动, 政变; 发作, 中, 击
peer|/piә/n. 同等的人, 匹敌, 贵族;凝视, 窥视, 费力地看, 隐现;与...同等, 封为贵族
subsidy|/'sʌbsidi/n. 补助金, 津贴; 补助金, 津贴, 补贴
boom|/bu:m/n. 繁荣, 隆隆声;急速发展, 发隆隆声;使兴旺, 发隆隆声
deck|/dek/n. 甲板, (汽车后部的)行李仓;装饰, 打扮, 装甲板; 纸牌背面图案
fierce|/fiәs/a. 凶猛的, 猛烈的, 热烈的, 暴躁的
drain|/drein/n. 排水沟, 消耗, 排水;排出, 喝光, 耗尽;排水, 流干
edit|/'edit/vt. 编辑, 编校, 修订, 剪辑; 编辑;DOS外部命令:该命令是一个用于编辑文本文件的全屏幕编辑程序
casualty|/'kæʒjuәlti/n. 意外事故, 伤亡, 受害者; 事故
fighter|/'faitә/n. 斗士, 战士, 好战者, 战斗机
rating|/'reitiŋ/n. 等级, 额定功率, 责骂; 等级评定
venue|/'venju:/n. 犯罪地点, 审判地, 发生地点
boost|/bu:st/n. 推进, 吹捧;推进, 提高, 宣扬, 促进
counterpart|/'kauntәpɑ:t/n. 副本, 复本, 配对物, 相应物; 副本, 正副二份中之一
advocate|/'ædvәkeit/n. 提倡者, 拥护者;主张, 提倡
interim|/'intәrim/a. 暂时的, 临时的, 间歇的;过渡时期
premier|/'pri:mjә/n. 总理, 首相;首位的, 最初的
cutting|/'kʌtiŋ/n. 切断, 切下, 路堑; 切屑
chaos|/'keiɒs/n. 大混乱, 混沌; 混沌;浑沌
script|/skript/n. 手迹, 手稿, 正本, 手写体;改编为演出本; 手写体, 小型程序
lap|/læp/n. 膝盖, 舔, 一圈, 下摆, 衣兜, 山坳;重叠, 围住, 轻拍, 舔;包围, 抱...在膝上, 使重叠, 舔, 拍打, 泼溅; 链接访问程序
sponsor|/'spɒnsә/n. 保证人, 赞助者, 发起者, 倡议者, 教父;发起, 赞助, 倡议
super|/'sju:pә/n. 跑龙套角色, 冗员, 特级品, 特大号, 管理人;上等的, 特大的, 超级的, 极好的, 十分的, 过分的;非常
helicopter|/'helikɒptә/n. 直升机;由直升机运送;乘直升机
cave|/keiv/n. 洞, 穴;凹陷, 塌落;挖洞, 使凹陷, 损坏...的基础
verdict|/'vә:dikt/n. 裁决, 判决, 判断性意见, 定论, 结论; 定论, 判断, 意见
commerce|/'kɒmә:s/n. 商业, 商务, 贸易; 商业, 贸易, 商务
medal|/'medl/n. 奖牌, 勋章;授勋予
broadcasting|/'brɒ:dkæstiŋ/n. 广播; 广播
rally|/'ræli/n. 重振旗鼓, 集合, 群众集会, 跌停回升;重整旗鼓, 集合, 恢复精神, 团结, 挖苦, 嘲笑
debut|/'deibju:/n. 初次登台, 开张;初次登台
inspect|/in'spekt/vt. 检查, 检阅, 检验;检查
mask|/mæsk/n. 面具, 假面具, 掩饰, 石膏面模;戴面具, 掩饰, 使模糊;化装, 戴面具, 掩饰, 参加化装舞会; 屏蔽;掩码
pump|/pʌmp/n. 抽水机, 打气筒, 泵, 抽吸;用唧筒抽水, 打气, 盘问, 倾注, 使疲惫;抽水, 上下(或往复)运动
trail|/treil/n. 踪迹, 痕迹, 一串, 尾部, 小径, 持枪姿势;拖, 尾随, 追踪, 落后于, 开出路;拖曳, 垂下, 落后, 飘出, 蔓生
banker|/'bæŋkә/n. 银行家, 庄家; 银行业者, 银行家
abortion|/ә'bɒ:ʃәn/n. 流产, 堕胎, 失败, 夭折, 中止; 流产, 小产;顿挫
corruption|/kә'rʌpʃәn/n. 腐败, 堕落, 贪污; 论误
halt|/hɒ:lt/n. 停止, 立定, 休息;使停止, 使立定;立定, 停止, 蹒跚, 踌躇, 有缺点; 停止
auction|/'ɒ:kʃәn/n. 拍卖;拍卖
naval|/'neivl/a. 海军的, 军舰的, 有舰队的; 海军的, 军舰的, 船的
embassy|/'embәsi/n. 大使馆, 大使馆全体人员; 大使馆
terrorist|/'terәrist/n. 恐怖分子; 恐怖份子, 恐怖主义
segment|/'segmәnt/n. 片段, 部分, 分节, 段;分割, 分裂; 段
takeover|接管, 接收; 接收
referendum|/.refә'rendәm/n. （就重大政治或社会问题进行的）全民公决，全民投票
weaken|/'wi:kәn/vt. 削弱, 减弱, 使虚弱;变弱, 变软弱
barrel|/'bærәl/n. 桶;装入桶内
shed|/ʃed/n. 车棚, 小屋, 脱落之物, 分水岭;使流出, 放射, 脱落, 散发, 摆脱;流出, 散布, 脱落
fare|/fєә/n. 费用, 旅客, 食物;进展, 进步, 经营, 过活
headline|/'hedlain/n. 大标题, 新闻摘要;为...做标题, 写标题
eager|/'i:gә/a. 热心的, 渴望的, 热望的
overwhelming|/.әuvә'hwelmiŋ/a. 压倒性的, 无法抵抗的
stem|/stem/n. 茎, 干, 柄, 船首, 血统, 堵塞物;摘掉茎, 装柄于, 阻止, 堵住, 逆行;堵住, 逆行
plunge|/plʌndʒ/n. 钻进, 跳进, 跳水, 跳水池, 猛跌, 落下, 投入, 开始从事, 盲目投资;投入, 投身于, 跳进, 陷入, 下降;使投入, 使插入, 使陷入, 使遭受
excess|/ik'ses/n. 过度, 剩于, 超过, 超额;过量的, 额外的
moderate|/'mɒdәrәt/a. 适度的, 稳健的, 中等的, 节制的;节制, 减轻, 使缓和;变缓和, 主持会议
racial|/'reiʃәl/a. 人种的, 种族的; 种族的
ambassador|/æm'bæsәdә/n. 大使; 大使, 使节, 代理
yacht|/jɒt/n. 快艇, 游艇;驾游艇, 乘游艇
faction|/'fækʃәn/n. 小派系, 内讧; 宗派, 派别, 小集团
commentator|/'kɔmenteitә/n. 评论员, 实况广播员, 注释者, 时事评论员
wicket|/'wikit/n. 小门, 腰门, 售票窗
forth|/fɒ:θ/adv. 往前, 以后, 向外
slim|/slim/a. 瘦的, 苗条的, 微小的, 稀少的, 微薄的;变苗条;使苗条
offering|/'ɒfәriŋ/n. 提供, 奉献物, 牲礼, 上市的股票(或证券等); 出售物
bat|/bæt/n. 蝙蝠, 球棒;用球棒打, 眨眼; 成批
surplus|/'sә:plәs/n. 剩余, 过剩, 盈余;过剩的, 剩余的
actress|/'æktris/n. 女演员
rage|/reidʒ/n. 愤怒, 情绪激动, 狂暴;大怒, 狂吹, 流行
convict|/kәn'vikt/n. 囚犯, 罪犯;宣告有罪, 使知罪
vitamin|/'vaitәmin/n. 维生素; 维生素
fiscal|/'fiskәl/a. 财政的, 国库的; 财政上的, 会计的, 国库的
soccer|/'sɒkә/n. 英式足球
Islamic|/iz'læmik/a. 伊斯兰教的, 穆斯林的
guerrilla|/gә'rilә/n. 游击队
renew|/ri'nju:/vt. 使更新, 使恢复, 复兴, 修补, 补充, 继续, 重订, 重申, 续借;更新, 重新开始
foreigner|/'fɒ:rinә/n. 外国人, 外地人; 外国人, 进口货, 外国货
overnight|/'әuvәnait/n. 前一天晚上, 一夜的逗留;通宵的, 晚上的, 前夜的;在前一夜, 整夜, 昨晚一晚上
instant|/'instәnt/n. 立即, 瞬间;紧急的, 立即的, 即时的
incredible|/in'kredәbl/a. 难以置信的
exhaust|/ig'zɒ:st/n. 排气, 排气装置, 废气;抽完, 用尽, 耗尽, 使精疲力尽;排气
trigger|/'trigә/n. 触发器, 扳机;触发, 发射, 引起;松开扳柄; 切换开关
alert|/ә'lә:t/a. 警觉的, 灵敏的, 留心的;警报;使警觉, 通知, 使意识到
confrontation|/.kɔnfrʌn'teiʃәn/n. 对抗;对质;面对
backing|/'bækiŋ/n. 后退, 衬背, 后援, 支持者; 衬垫
amateur|/'æmәtә/n. 业余爱好者, 外行, 爱好者; 业余家
surrender|/sә'rendә/vt. 交出, 放弃, 使投降, 让与;投降, 自首;交出, 放弃, 投降
civilian|/si'viljәn/n. 平民, 民法专家;平民的, 百姓的, 民用的
spur|/spә:/n. 马刺, 刺激物, 鼓舞;刺激, 激励, 用马刺策(马)前进;用马刺驱马, 疾驰
motivate|/'mәutiveit/vt. 给与动机, 刺激, 提高...的学习欲望, 促动; 促动, 激发, 激励
cheer|/tʃiә/n. 愉快, 振奋, 欢呼;欢呼, 喝彩, 快活起来;使振奋, 欢呼
jail|/dʒeil/n. 监牢, 监狱, 拘留所;监禁, 下狱
exile|/'eksail/n. 放逐, 流放, 被放逐者;放逐, 流放, 使背井离乡
worldwide|/'wә:ldwaid/a. 全世界的
pact|/pækt/n. 契约, 协定, 条约; 合同
presidency|/'prezidәnsi/n. 总统职权, 总裁职位
luxury|/'lʌkʃәri/n. 奢侈, 豪华;奢侈的, 豪华的
cautious|/'kɒ:ʃәs/a. 谨慎的, 小心的
homeless|/'hәumlis/a. 无家的, 无养主的
sacrifice|/'sækrifais/n. 牺牲, 供奉, 祭品;牺牲, 祭祀, 贱卖;献祭
deadline|/'dedlain/n. 最后期限, 截止期限; 截止日期
lobby|/'lɒbi/n. 大厅, 休息室, 游说议员者;游说议员, 游说;游说
retreat|/ri'tri:t/n. 休息寓所, 撤退, 隐居, 退避;撤退, 隐退, 向后倾;退(棋)
broker|/'brәukә/n. 掮客, 经纪人; 经纪人, 掮客
amid|/ә'mid/prep. 在其间, 在其中; 在...中
prosecute|/'prɒsikju:t/vt. 告发, 起诉, 彻底进行, 执行, 从事;告发, 起诉, 作检察官
immigration|/.imi'greiʃәn/n. 移民, 移居; 移民
ballot|/'bælәt/n. 投票, 投票用纸, 抽签;投票, 抽签;投票选出, 拉选票
blast|/blæst/n. 一阵风, 爆炸, 枯萎病;炸, 使枯萎;炸, 猛攻, 猛烈抨击, 枯萎
combat|/'kɒmbæt/n. 争斗, 战斗;战斗, 争斗;与...战斗, 与...斗争
immune|/i'mju:n/a. 免疫的, 免除的, 不受影响的;免疫者
pledge|/pledʒ/n. 诺言, 保证, 誓言, 抵押, 信物, 保人, 祝愿;许诺, 保证, 使发誓, 抵押, 典当, 举杯祝...健康
jazz|/dʒæz/n. 爵士乐, 喧闹;爵士乐的, 喧吵的;演奏爵士乐, 跳爵士舞, 游荡;奏爵士乐, 使活泼
hunter|/'hʌntә/n. 猎人, 猎犬, 追求者
stadium|/'steidiәm/n. 露天大型运动场; 期, 病期
leak|/li:k/n. 漏洞, 漏处, 漏出, 泄漏;漏, 泄漏;使渗漏
whip|/hwip/n. 鞭子, 抽打, 车夫, 搅拌器;鞭打, 搅拌, 煽动, 召集, 仓促制成;拍击, 急走, 抽打
rocket|/'rɒkit/n. 火箭, 烟火;急升, 猛涨, 飞驰;用火箭运载
counsel|/'kaunsәl/n. 商议, 忠告, 法律顾问;商议, 劝告
immigrant|/'imigrәnt/n. 移民;移入的, 移民的
cruise|/kru:z/n. 巡航, 巡弋, 漫游;巡航, 巡弋, 漫游
diplomat|/'diplәmæt/n. 外交官, 有外交手腕的人; 外交家, 外交官, 有权谋的人
ski|/ski:/n. 滑雪橇;滑雪
considering|/kәn'sidәriŋ/prep. 就...而论;考虑到
spark|/spɑ:k/n. 火花, 火星, 闪光, 无线电报务员, 瞬间放电, 活力, 朝气, 花花公子, 情郎;闪光, 发火花, 求婚;发动, 鼓舞, 使有朝气, 求婚
veteran|/'vetәrәn/n. 老手, 退伍军人, 老兵, 老树;老兵的, 老练的, 经验丰富的
speculate|/'spekjuleit/vi. 深思, 推测, 投机; 投机
cue|/kju:/n. 提示, 线索;给...暗示(或提示); 尾接指令
antique|/æn'ti:k/n. 古董, 古物;古老的, 古风的, 旧式的, 过时的
athlete|/'æθli:t/n. 运动员, 运动选手; 运动员
ceasefire|/ˈsi:sfaɪə(r)/n. （通常指永久性的）停火, 停战;停火命令
caring|/'kεәriŋ/a. 有同情心的;表示或感到关怀或关心的
violate|/'vaiәleit/vt. 违犯, 亵渎, 违反, 侵犯, 妨碍; 违犯, 违反
opposed|/ә'pәuzd/a. 反对的, 敌对的, 对抗的, 相对的; 反对的, 相反的, 对立的
jersey|/'dʒә:zi/n. 运动衫
torture|/'tɒ:tʃә/n. 拷问, 苦闷;拷问, 曲解, 折磨, 使弯曲
peg|/peg/n. 钉, 桩, 栓, 藉口, 销子, 借口;钉木钉, 固定, 限制, 使受约束;坚持不懈地奋力于, 疾行
editorial|/.edi'tɒ:riәl/n. 社论, 评论;编辑的, 主笔的, 社论的
lens|/lenz/n. 透镜, 镜头, 镜片, 晶状体;给...摄影
vice|/vais/n. 恶习, 恶行, 罪恶, 堕落, 缺陷, 恶癖, 老虎钳;钳住;代替
homosexual|/.hɒmәu'sekjuәl/a. 同性恋的;同性恋者
Islam|/'izlɑ:m/n. 伊斯兰教
frustrate|/'frʌstreit/vt. 挫败, 击败, 破坏;无益的, 挫败的, 挫折的
Saint|/seint/n. 圣徒, 圣人;神圣的; 自动积分程序符号
militant|/'militәnt/a. 好战的
regulator|/'regjuleitә/n. 调整者, 校准者, 校准器, 调整器, 标准钟; 调节剂;调节器
liberate|/'libәreit/vt. 解放, 释放, 使自由; 释出, 放出
specialize|/'speʃәlaiz/vt. 使特殊化, 列举, 特别指明, 限定...的范围;成为专家, 专攻
rouge|/ru:ʒ/n. 口红, 胭脂;擦口红
yen|/jen/n. 日元(日本货币单位), 渴望, 嗜好;渴望
congressional|/kәn'greʃәnl/a. 会议的, 议会的, 国会的; 代表大会的, 大会的, 议会的
harass|/'hærәs/vt. 使困扰, 使烦恼, 折磨
assured|/ә'ʃuәd/a. 确定的, 自信的; 被保险人, 被保证者, 投保人
beaten|/'bi:tn/a. 被打败了的, 筋疲力竭的, 敲平的, 踏平的;beat的过去分词
reel|/ri:l/n. 卷轴, 一卷, 纺车, 旋转, 蹒跚;卷...于轴上, 绕, 使旋转;蹒跚地走, 旋转, 眩晕, 摇晃, 退缩; 卷;盘
baseball|/'beisbɒ:l/n. 棒球; 棒球系统
calculated|/'kælkjuleitid/a. 有计划的, 适当的, 适合的, 计算出的; 算清了的
unidentified|/.ʌnai'dentifaid/a. 未被认出的, 未经确认的
auto|/'ɒ:tәu/n. 汽车;表示"自己"、"本身", 表示"自己的", 表示"自动的"
roach|/rәutʃ/n. 斜齿鳊;使成凹状
statistic|/stә'tistik/n. 统计量;统计的, 统计学的
privatize|vi. 私有化
noted|/'nәutid/a. 著名的, 显著的, 扬名的
excerpt|/'eksә:pt/n. 摘录;引用, 摘录
appal|/ә'pɒ:l/vt. 使惊骇, 使吓坏
activism|/'æktivizm/n. 激进主义, 行动主义, 能动论; 激进主义, 行动主义
victimize|/'viktimaiz/vt. 使牺牲, 使受害; 使受害, 使作牺牲, 欺骗
done|/dʌn/a. 完成了的, 好了的;do的过去分词
o'clock|/ә'klɔk/n. ...点钟, 钟头
ahead of|在…之前
air force|空军, 美国航空队
armed forces|陆海空三军; 武装; 军队; 部队
civil war|内战; 内战
exchange rate|/iksˈtʃeindʒ reit/n. 汇率, 兑换率
general election|普选; 大选, 普选
he'll|他将, 他愿意, 他必须, 他要
it'll|it will的缩写, it shall的缩写
local authority|/ˈləukəl ɔ:ˈθɔriti/n. 地方当局, 地方政权
middle class|中产阶级; 中级
one's|/wʌnz/a. 人们的;自己的
point of view|观点; 论点, 见解, 立场
police officer|/pəˈli:s ˈɔfisə/n. 警察
savings|/'seiviŋz/n. 储蓄, 存款; 储金, 储蓄
shouldn't|不该, 不可, 必须不, 不应该, 不应当, 可能不, 可以不, 竟然不, 竟然会不
stock exchange|证券交易(所); 证券交易所
stock market|股票市场; 证券市场, 证券交易, 证券行市
Third World|第三世界
we'd|/wi:d/abbr. we had 我们已;we should 我们应
world war|/wɜː(r)ld wɔ:/n. 世界大战
undertake|/.ʌndә'teik/vt. 试图, 从事, 保证, 承担, 同意, 接受; 承包;承担
jack|/dʒæk/n. 插座, 千斤顶, 男人;抬起, 提醒, 扛举, 增加, 提高, 放弃;雄的; 插座
expenditure|/ik'spenditʃә/n. 开支, 费用, 用光, 消费额; 支出, 费用, 消费
sequence|/'si:kwәns/n. 序列, 续发事件, 顺序, 连续;按顺序排好; 顺序
curriculum|/kә'rikjulәm/n. 课程; 课程, 学程
representation|/.reprizen'teiʃәn/n. 表示法, 表现, 陈述, 代表; 表示法指定
creation|/kri:'eiʃәn/n. 创造, 创作物, 发明; 产生
distinction|/dis'tiŋkʃәn/n. 区别
external|/ik'stә:nl/n. 外部, 外面;外部的, 客观的, 表面的
clause|/klɒ:z/n. 子句, 条款; 子句
defendant|/di'fendәnt/n. 被告; 被告方
bind|/baind/vt. 绑, 约束, 装订, 包扎, 使结合;凝固, 有约束力; 赋值, 绑定
liability|/laiә'biliti/n. 责任, 债务, 倾向; 责任, 义务, 负债
significance|/sig'nifikәns/n. 重要性, 意义, 意味; 有效;有效性
Christ|/kraist/n. 基督, 救世主
parish|/'pæriʃ/n. 教区, 堂区; 救贫区, 教区
China|/'tʃainә/n. 中国, 瓷器;中国的
ooh|/u:/int. （表示惊异、热心、高兴或不悦的叫声）哦！
amongst|/ә'mʌŋst/prep. 在...当中, 在...之间, 在...之中
finding|/'faindiŋ/n. 发现, 发现物, 决定, 裁决; 调查结果, 对事实的认定, 判定的要素
councillor|/'kaunsilә/n. 地方议会成员, 议会委员, 顾问, 评议员, 参赞; 议员, 评议员, 顾问
tenant|/'tenәnt/n. 承租人, 房客, 居住者;租借; 占据者
Jan|/dʒæn/n. 一月
boundary|/'baundri/n. 边界, 分界线; 边界
formation|/fɒ:'meiʃәn/n. 形成, 构造, 编队; 形成, 结构
kingdom|/'kiŋdәm/n. 王国, 领域; 界(动物,植物,矿物)
incorporate|/in'kɒ:pәreit/a. 合并的, 组成公司的, 一体化的;吸收, 合并, 使组成公司, 体现;合并, 混合, 组成公司
proceeding|/prәu'si:diŋ/n. 进行, 程序, 行动, 诉讼程序, 事项; 会议论文集
premise|/'premis/n. 前提, 房屋连地基, 上述各项;预先提出, 引出, 作为...的前提;作出前提
framework|/'freimwә:k/n. 结构, 骨架, 参照标准, 准则, 观点; 构架组织
obligation|/.ɒbli'geiʃәn/n. 义务, 责任, 约束, 契约, 恩惠, 债务; 待付款, 债务, 义务
setting|/'setiŋ/n. 环境, 背景, 布景, 镶嵌, 调整, 沉落, 一副餐具; 设置
maintenance|/'meintәnәns/n. 维护, 保持, 维修, 生活费用, 坚持, 扶养; 维护;维修
bob|/bɒb/vt. 剪短, 敲击;振动, 上下跳动;短发, 悬挂的饰品, 浮子, 摆动, 轻敲, 5便士
mode|/mәud/n. 模态, 调式, 样式, 文体, 状态, 方式, 风尚; 方式;DOS外部命令:设定各种设备命令
specify|/'spesifai/vt. 详列, 指定, 说明; 指定
submit|/sәb'mit/vt. 使服从, 使受到, 委托, 提交, 认为;屈服, 服从
constitute|/kәn'stitjut/vt. 构成, 组成, 任命; 构造, 组成
input|/'input/n. 输入, 输入电路;输入; 输入
efficiency|/i'fiʃәnsi/n. 效率, 效能, 功效; 效率, 效力
frank|/fræŋk/a. 坦白的, 率直的, 老实的;免费邮寄;免费邮寄特权
statutory|/'stætjutәri/a. 法令的, 法定的, 可依法惩处的; 法定的
ratio|/'reiʃәu/n. 比, 比率; 比, 比率, 比例
PC|个人计算机; 外部控制, 个人计算机, 光电导体, 伪码
variable|/'vєәriәbl/n. 易变的事物, 变数, 可变物, 变量;可变的, 不定的, 易变的, 变量的; 变量
phenomenon|/fi'nɒminәn/n. 现象, 迹象, 表现, 奇迹, 奇才; 现象
frequency|/'fri:kwәnsi/n. 频率, 频数; 频率
landlord|/'lændlɒ:d/n. 房东, 地主; 业主, 地主, 房东
administrative|/әd'ministrәtiv/a. 管理的, 行政的; 行政的, 管理的, 遗产管理的
breach|/bri:tʃ/n. 裂口, 违背, 破坏, 违反, 突破, 破裂;攻破, 突破;跳出水面
equation|/i'kweiʃәn/n. 相等, 等式, 平衡; 方程式;等式;反应式;公式
eh|/ei/interj. 啊!嗯!是吗?好吗?; 氧化还原电位
allowance|/ә'lauәns/n. 津贴, 零用钱, 限额, 折扣, 允许;定量供应
scope|/skәup/n. 范围, 机会, 广度, 眼界, 观察仪器, 导弹射程; 作用域
paragraph|/'pærәgrɑ:f/n. 段落, 短评;将...分段, 分段落;写短讯; 段落
detect|/di'tekt/vt. 发现, 察觉, 探测; 发现, 查明, 探测
consent|/kәn'sent/n. 同意, 许可;同意, 赞同
comprise|/kәm'praiz/vt. 包含, 构成
visual|/'viʒuәl/a. 视觉的; 视觉的, 视力的, 视觉性记忆优势者
DNA|脱氧核糖核酸; 无效数据, 数字网络体系结构, 分布式网络体系结构
perception|/pә'sepʃәn/n. 知觉, 感觉, 领悟力, 获取; 知觉
differ|/'difә/vi. 不一致, 不同; 差异, 不同
consumption|/kәn'sʌmpʃәn/n. 消费, 消费量, 痨病; 消耗量;耗量
peasant|/'peznt/n. 农夫, 乡下人
workshop|/'wә:kʃɒp/n. 工场, 车间, 研讨会; 讨论会;专题研究组
guidance|/'gaidns/n. 指导, 领导; 导
distinct|/dis'tiŋkt/a. 清楚的, 显著的, 不同的
supplier|/sә'plaiә/n. 供应者, 供给国, 供应商; 承制厂;供应厂商
respectively|/ri'spektivli/adv. 各自地, 独自地, 个别地, 分别地
developing|/di'velәpiŋ/a. 发展中的; 显影
practitioner|/præk'tiʃәnә/n. 从业者, 开业者; 行医者, 医师
dimension|/dai'menʃәn/n. 尺寸, 次元, 面积, 维数;标出尺寸
storage|/'stɒ:ridʒ/n. 存储器, 储藏, 保管, 库存, 仓库; 存放处;存储
catalogue|/'kætәlɒg/n. 目录, 大学情况一览;编入目录
architecture|/'ɑ:kitektʃә/n. 建筑学, 建筑式样; 体系结构
exceed|/ik'si:d/vt. 超过, 超越, 胜过;超过其他
historian|/hi'stɒ:riәn/n. 历史学家, 记事者
clinical|/'klinikәl/a. 临床的, 门诊部的; 临床的, 临证的
theoretical|/θiә'retikәl/a. 理论的, 理论上的, 假设的, 推理的; 理论的
distant|/'distәnt/a. 远的, 疏远的; 远期的
leisure|/'li:ʒә/n. 空闲, 闲暇, 悠闲;空闲的, 有闲的
admission|/әd'miʃәn/n. 准许进入, 入场费, 录用, 承认; 加入, 入股
perceive|/pә'si:v/vt. 感觉, 认知, 理解, 意识到
secondly|/'sekәndli/adv. 第二, 其次
residential|/.rezi'denʃәl/a. 住宅的, 与居住有关的; 有关居住的, 房产的:居所的, 适于居住的
turnover|/'tә:n.әuvә/n. 翻倒, 翻转, 半圆酥饼, 营业额, 流通, 周转;可翻转的
nick|/nik/n. 刻痕, 缺口, 划痕;刻痕于, 弄缺, 擦伤;狙击
furthermore|/'fә:ðә'mɒ:/adv. 此外, 而且
Aug|八月（August）
corridor|/'kɒridɒ:/n. 走廊, 回廊, 人口密集地带
reinforce|/.ri:in'fɒ:s/vt. 加强, 增援, 补充;求援, 得到增援;加固材料
magistrate|/'mædʒistreit/n. 长官, 法官, 推事; 司法行政官, 治安法官, 地方法官
readily|/'redili/adv. 迅速地, 轻易地, 乐意地
sergeant|/'sɑ:dʒәnt/n. 警察小队长, 军士
participant|/pɑ:'tisipәnt/n. 参加者, 参与者;有份的, 参加的, 参与的
shrug|/ʃrʌg/n. 耸肩;耸肩
architect|/'ɑ:kitekt/n. 建筑师, 设计者, 缔造者
cathedral|/kә'θi:drәl/n. 大教堂
acceptance|/әk'septәns/n. 接受, 接纳, 承认, 同意, 赞同, 容忍, 相信; 承兑, 认付, (工程)验收
limitation|/.limi'teiʃәn/n. 限制, 缺陷, 限额; 限界, 限制, 限度
thereby|/'ðєәbai/adv. 因此
constituency|/kәn'stitjuәnsi/n. 选民, 顾客, 读者; 选区, 全体选民, 选区内的选民
structural|/'strʌktʃәrәl/a. 结构的, 建筑的; 结构的
objection|/әb'dʒekʃәn/n. 异议, 反对, 不喜欢, 缺点, 缺陷, 妨碍, 拒绝之理由; 异议, 反对, 抗议
bench|/bentʃ/n. 长椅子; 台
infant|/'infәnt/n. 婴儿, 儿童, 初学者;婴儿的, 幼稚的
ward|/wɒ:d/n. 病房, 守卫, 保卫, 保护, 监护, 牢房, 行政区, 锁孔内的榫舌;使入病房, 守护, 保卫
guardian|/'gɑ:diәn/n. 看守者, 监护人, 保护人;保护的
virtue|/'vә:tju:/n. 德行, 美德, 优点, 功效, 效力; 美德, 贞操, 优点
canal|/kә'næl/n. 运河, 水道, 管, 沟渠;开运河
universal|/.ju:ni'vә:sl/a. 全世界的, 普遍的, 宇宙的, 通用的;一般概念
timber|/'timbә/n. 木材, 木料;用木材建造
cattle|/kætl/n. 牛, 家畜; 家畜
evident|/'evidәnt/a. 显然的, 明显的
uncertainty|/.ʌn'sә:tnti/n. 不确定, 不可靠, 不确定的事物; 不确定度
expertise|/.ekspә:'ti:z/n. 专家意见, 专门技术; 专门知识, 专家意见
constraint|/kәn'streint/n. 强制, 约束; 约束
guideline|/'gaidlain/n. 指导路线, 方针, 指标; 指导路线, 方针, 准则
privilege|/'privilidʒ/n. 特权, 特别恩典, 基本权利, 特免;给与...特权, 特免
reflection|/ri'flekʃәn/n. 反映, 沉思, 映像, 想法, 责难; 反射
Victorian|/vik'tɔ:riәn/a. 英国维多利亚女王时代的, 笃信宗教的, 讲究体面的;维多利亚女王时代的英国人
consequently|/'kɒnsikwәntli/adv. 所以
companion|/kәm'pænjәn/n. 朋友, 陪伴, 指南, 升降口围罩;陪伴
allocate|/'ælәukeit/vt. 分派, 分配; 分配
rabbit|/'ræbit/n. 兔子;猎兔;让...见鬼去
patch|/pætʃ/n. 片, 补缀, 碎片, 斑, 傻瓜;补缀, 掩饰, 拼凑, 平息; 修补;拼凑
medieval|/.medi'i:vl/a. 中古的, 中世纪的
pray|/prei/v. 祈祷, 恳求, 请
VAT|/væt/n. 大桶;装入大桶, 在大桶里处理
undergo|/.ʌndә'gәu/vt. 遭受, 经历, 忍受; 经受, 经历, 忍受
disorder|/dis'ɒ:dә/n. 杂乱, 混乱;扰乱, 使失调
evolution|/.i:vә'lu:ʃәn/n. 进化, 发展, 进展, (气体)放出, 开方; 进化, 演化, 旋出
accounting|/ә'kauntiŋ/n. 会计学, 帐单, 清帐; 帐户处理, 记帐
specimen|/'spesimәn/n. 样品, 标本, 试料; 试样
closure|/'klәuʒә/n. 关闭;使终止
taxation|/tæk'seiʃәn/n. 课税, 征税, 抽税, 税款, 估定的税额; 征税, 纳税, 税制
conservation|/.kɒnsә'veiʃәn/n. 保护, 保存; 保存
ideology|/.aidi'ɒlәdʒi/n. 思想体系, 意识形态, 观念学, 空论; 观念学, 观念形态
format|/'fɒ:mæt/n. 开本, 版式, 形式, 格式;格式化; 格式;DOS外部命令:对磁盘进行格式化
judicial|/dʒu:'diʃәl/a. 法庭的, 公正的, 审判上的, 司法的; 司法的, 审判上的, 法官的
NHS|国家医疗保健机构
carriage|/'kæridʒ/n. 马车, 客车, 举止, 运输; 搬运费, 运费
junction|/'dʒʌŋkʃәn/n. 连接, 会合处, 交叉点; 接;处, 接点.;界
conversion|/kәn'vә:ʃәn/n. 转变, 转换, 改变宗教信仰, 换位法; 转换
imperial|/im'piәriәl/a. 帝王的, 宗主国的, 至尊的, 壮丽的;特等品
assurance|/ә'ʃuәrәns/n. 保证, 把握, 信心, 保险; 保证, 担保, 保险
registration|/.redʒi'streiʃәn/n. 登记, 挂号, 注册; 登记;定位;对齐;记录
terrace|/'terәs/n. 阶地, 梯田, 房屋之平顶, 阳台, 沿岸防地, 露台;叠层式的;使成梯田, 使成有平台屋顶
rat|/ræt/n. 鼠, 卑鄙的人, 破坏者, 变节者;捕鼠, 变节;弄蓬松
experimental|/ik.speri'mentәl/a. 实验的, 根据实验的; 实验的
borough|/'bә:rәu/n. 自治的市镇, 区
innovation|/.inәu'veiʃәn/n. 改革, 创新; 创新, 改革, 刷新
particle|/'pɑ:tikl/n. 颗粒, 粒子, 质点, 极小量; 粒子;质点
notably|/'nәjtbәli/adv. 显著地, 著名地, 尤其, 特别
remedy|/'remidi/n. 药物, 治疗法, 治疗, 补救, 赔偿;治疗, 补救, 矫正, 改善, 修补, 修缮
seller|/'selә/n. 销售者; 卖方
applicant|/'æplikәnt/n. 申请者; 申请人, 请求人, 谋事人
emperor|/'empәrә/n. 皇帝, 君主
evaluate|/i'væljueit/vt. 评估, 评价, 赋值
grin|/grin/n. 露齿笑;露齿而笑
audit|/'ɒ:dit/n. 审计, 查帐;查(帐), 旁听;查账; 查帐;审查;检查
accordingly|/ә'kɒ:diŋli/adv. 相应地, 因此, 于是
disposal|/dis'pәuzәl/n. 丢掉, 处理, 排列, 销毁, 布置; 处理, 处置
fibre|/'faibә/n. 纤维, 构造, 纤维制品; 纤维
inadequate|/in'ædikwәt/a. 不充分的, 不适当的; 不充分的, 不适当的
devise|/di'vaiz/vt. 设计, 发明, 图谋, 遗赠给;遗赠
correspond|/.kɒri'spɒnd/vi. 符合, 通信, 相当; 符合, 一致, 相当
modify|/'mɒdifai/vt. 修正, 变更, 修饰, 缓和, 减轻;被修改; 修改
chapel|/'tʃæpәl/n. 小教堂, 礼拜式
rational|/'ræʃәnl/a. 理性的, 合理的;有理数
conception|/kɒn'sepʃәn/n. 观念, 概念; 妊娠, 受孕;概念
attribute|/ә'tribju:t/n. 属性, 标志, 定语;把...归于, 认为...属于; 属性
acute|/ә'kju:t/a. 尖锐的, 敏锐的, 激烈的, 严重的, 急性的; 急性的;尖锐的
dose|/dәus/n. 剂量, 服用量;给药, (用药)医治;服药
incentive|/in'sentiv/n. 动机;激励的
stimulus|/'stimjulәs/n. 刺激, 激励, 刺激品; 刺激特, 刺激
directive|/di'rektiv/a. 指导的, 指挥的, 方向的;指令; 指令;命令
gaze|/geiz/n. 注视, 凝视;注视, 凝视
darling|/'dɑ:liŋ/n. 亲爱的, 可爱的人, 可爱的物;可爱的, 亲爱的
identical|/ai'dentikәl/a. 同一的, 恒等的, 完全相同的; 同一的, 同等的
isle|/ail/n. 小岛, 群岛;使成为岛状;住在岛屿上
sole|/sәul/n. 脚掌, 鞋底, 底部;唯一的, 仅有的, 单独的, 独身的;上鞋底, 触底
kit|/kit/n. 装备, 工具箱, 成套工具; 成套部件;成套零件
accountant|/ә'kauntәnt/n. 会计人员, 会计师; 会计师, 会计人员
satisfactory|/.sætis'fæktәri/a. 满意的, 赎罪的; 令人满意的, 令当事人满意的, 充分的
distinctive|/di'stiŋktiv/a. 有特色的, 出众的
multiple|/'mʌltipl/n. 倍数, 并联;多样的, 许多的, 多功能的
angel|/'eindʒәl/n. 天使, 守护神, 善人
liable|/'laiәbl/a. 有义务的, 应负责的, 有...倾向的; 有责任的, 可受处理的, 应受罚的
insight|/'insait/n. 察看, 洞察力, 见识; 自知力, 洞察, 顿悟
greet|/gri:t/vt. 问候, 致敬, 欢迎, 映入眼帘
wholly|/'hәuli/adv. 完全地, 整个, 统统, 全部; 完全地, 统统地
render|/'rendә/vt. 回报, 给于, 付给, 汇报, 提出, 舍弃, 反映, 表示, 表演, 致使, 执行, 实施;给予补偿;交纳, 打底
disability|/disә'biliti/n. 无力, 无能, 残疾; 劳动能力丧失, 病废
induce|/in'dju:s/vt. 引诱, 招致, 归纳出, 感应; 诱导, 感应
underlying|/.ʌndә'laiiŋ/a. 在下面的; 优先的, 基础的, 放在下面的
complexity|/kәm'pleksiti/n. 复杂, 复杂性, 复杂的事物
constable|/'kʌnstәbl/n. 治安官, 警官, 总管; 警察, 警官, 巡警
pond|/pɒnd/n. 池塘;筑成池塘
namely|/'neimli/adv. 即, 就是, 换句话说
processor|/prә'sesә/n. 信息处理机, 加工者, 处理者; 处理器
fragment|/'frægmәnt/n. 碎片, 破片, 片段; 段落;片段;分段
daddy|/'dædi/n. 爸爸
marginal|/'mɑ:dʒinәl/a. 边缘的, 最低限度的, 有旁注的; 缘的
murmur|/'mә:mә/n. 低语, 低声的怨言;低语, 低声而言;低声说
sheer|/ʃiә/a. 绝对的, 全然的, 纯粹的, 透明的, 峻峭的;偏转, 偏航;使急转向, 使偏航;完全, 全然, 峻峭;偏航
bulk|/bʌlk/n. 大小, 体积, 大块, 大多数;显得大, 显得重要
necessity|/ni'sesәti/n. 需要, 必需品, 必然; 必要性, 必然性, 必要
exclusive|/ik'sklu:siv/a. 排外的, 独占的, 唯一的; 独占的
everyday|/'evri'dei/a. 每天的, 日常的, 平常的
nursery|/'nә:sәri/n. 托儿所, 苗圃, 温床; 婴儿室, 托儿所
encouraging|/in'kʌridʒiŋ/a. 鼓励的, 促进的
overlook|/.әuvә'luk/vt. 俯瞰, 远眺, 没注意到;眺望, 俯瞰到的景色
episode|/'episәud/n. 插曲, 插话, 有趣的事件, 一段情节; 插话, 插曲, 发作
lion|/'laiәn/n. 狮子, 狮子(星)座, 国际狮子会会员
accommodate|/ә'kɒmәdeit/vt. 使适应, 调和, 通融, 容纳, 向...提供;适应
motive|/'mәutiv/n. 动机, 目的, 主题, 基调;运动的, 成为动机的
desirable|/di'zairәbl/a. 令人想望的, 可取的
initiate|/i'niʃieit/n. 入会, 开始;新加入的;开始, 传授基本知识给
bible|/'baibl/n. 圣经
fiction|/'fikʃәn/n. 小说, 虚构故事; 虚构的事实, 捏造, 拟制
hardware|/'hɑ:dwєә/n. 硬件, 五金器具, 零件; 硬件
assert|/ә'sә:t/vt. 主张, 坚称, 断言; 宣称, 断言, 维护
comply|/kәm'plai/vi. 顺从, 依从; 遵守, 承诺, 照做
colony|/'kɒlәni/n. 殖民地, 移民队; 菌(集)落, 菌丛;移民区
evolve|/i'vɒlv/vi. 进展, 进化, 展开;使发展, 使推断出, 使进化
monopoly|/mә'nɒpәli/n. 垄断, 专卖权, 独占事业; 垄断, 专利品, 垄断(权)独占
organic|/ɒ:'gænik/a. 器官的, 有机的, 组织的, 根本的; 器官的, 有生命的, 有机的, 器质的
villa|/'vilә/n. 别墅
tribunal|/trai'bju:nl/n. 法庭, 法官席, 裁决; 法庭, 裁判所, 裁判
oral|/'ɒ:rәl/n. 口试;口头的, 口述的, 口部的
capitalist|/'kæpitәlist/n. 资本家, 资本主义者;资本主义的
trustee|/.trʌs'ti:/n. 受托人, 理事; 委托者
statistical|/stә'tistikl/a. 统计的, 统计上的, 统计学的; 统计的, 统计学的
mutter|/'mʌtә/n. 喃喃低语;喃喃自语, 作低沉声;出怨言, 抱怨地说
emission|/i'miʃәn/n. 发射, 射出, 发行; 发射, 遗精
clue|/klu:/n. 线索, 暗示;暗示, 提供线索
straightforward|/streit'fɒ:wәd/a. 笔直的, 率直的, 明确的, 简单的, 直接的
widow|/'widәu/n. 寡妇, 孀妇;使成寡妇
attendance|/ә'tendәns/n. 出席, 出席的人数, 照料; 管理, 照料, 资助
fraction|/'frækʃәn/n. 小部分, 破片, 分数; 部分, 成分, 分散
literally|/'litәrәli/adv. 逐字地, 按照字面上地, 不夸张地
mechanical|/mi'kænikәl/a. 机械的, 机械性的, 力学的; 机械的, 力学的
dock|/dɒk/n. 码头, 船坞, 被告席, 尾巴的骨肉部分;使靠码头, 使(船)进港, 剪短;进港
magnificent|/mæg'nifisnt/a. 华丽的, 高尚的, 宏伟的
essence|/'esns/n. 实质, 本质, 香精; 香精
beg|/beg/v. 乞求, 乞讨, 请求
landing|/'lændiŋ/n. 登陆, 码头, 降落; 上岸, 登陆, 降落
verse|/vә:s/n. 诗, 韵文, 诗句;用诗表达;作诗
ghost|/gәust/n. 鬼, 灵魂, 幻影, 一丝, 一点;鬼似地游荡
devil|/'devәl/n. 魔鬼;折磨, 戏弄
receiver|/ri'si:vә/n. 接收器;接受者;收信机;收款员, 接待者
proposition|/.prɒpә'ziʃәn/n. 建议, 命题, 主张;向...提议, 向...提出猥亵的要求
theft|/θeft/n. 盗窃, 失窃, 盗窃罪, 赃物; 盗窃行为, 偷窃, 失窃
cliff|/klif/n. 悬崖, 绝壁
champagne|/ʃæm'pein/n. 香槟酒, 香槟酒色; 香槟酒
loyalty|/'lɒiәlti/n. 忠贞, 忠诚, 忠实; 忠诚, 忠心
chap|/tʃæp/n. 小伙子, 颌, 龟裂;皲裂
whereby|/(h)weә'bai/adv. 靠什么, 如何, 为何, 靠那个, 因此, 由此; 因此, 由是
successor|/sәk'sesә/n. 继承者, 接任者; 后继
established|/is'tæbliʃt/a. (被)建立的, 固定的, 既定的, 确定的, 确认的, 确立的, (被)制定的; 确定的, 既定的
leaflet|/'li:flit/n. 小叶, 传单; 小叶
abbey|/'æbi/n. 大修道院
heritage|/'heritidʒ/n. 遗产, 祖先遗留物, 继承物; 遗传性
indicator|/'indikeitә/n. 指示器, 指示剂, 指标; 指示器
filter|/'filtә/n. 滤波器, 过滤器, 滤光器, 过滤嘴, 去尘器;过滤, 渗透, 走漏;滤过, 渗入; 过滤器, 筛选
enforce|/in'fɒ:s/vt. 强迫, 执行, 坚持; 予以强制执行
restoration|/.restә'reiʃәn/n. 恢复, 归还, 复位; 恢复, 康复, 复位, 回复, 修复
spectrum|/'spektrәm/n. 光谱, 范围, 系列; 光谱
biological|/.baiәu'lɒdʒikәl/a. 生物学的; 生物学的
pensioner|/'penʃәnә(r)/n. 领取抚恤金者, (英国剑桥大学的)自费生, 为金钱所收买的人, 帮佣; 领取退休金者, 领取抚恤金者
hierarchy|/'haiәrɑ:ki/n. 等级制度, 僧侣统治, 等级体系; 分级结构;分层结构;新闻组, 新闻组分层
discrimination|/dis.krimi'neiʃәn/n. 差别, 岐视, 辨别力; 鉴别
pope|/pәup/n. 罗马教皇, 主教
compound|/kәm'paund/n. 混合物, 复合词, 化合物, 院子;复合的, 混合的, 化合的;化合, 和解, 妥协;使复合, 使化合
wildlife|/'waildlaif/n. 野生动植物
digital|/'didʒitәl/a. 数字显示的, 数字的;数字仪表, 数字式电子表(或时钟); 数字, 数字式
raf|英国皇家空军（Royal Air Force）
institutional|/.insti'tju:ʃәnәl/a. 制度的, 公共机构的, 学会的; 组织机构的, 制度的, 公共机构的
productivity|/.prәudʌk'tiviti/n. 生产力; 生产率, 生产能力
doctrine|/'dɒktrin/n. 教条, 学说; 学说
gender|/'dʒendә/n. 性;产生
creditor|/'kreditә/n. 债权人; 债权人, 债主, 贷方
sociology|/.sәusi'ɒlәdʒi/n. 社会学; 社会学
lifetime|/'laiftaim/n. 一生, 终生;一生的, 终生的
consume|/kәn'sju:m/vt. 消耗, 消费, 消灭;耗尽, 毁灭
avenue|/'ævәnju:/n. 大街, 途径, 林荫路
merit|/'merit/n. 优点, 功绩, 价值, 功过, 真相;值得;应受
equip|/i'kwip/vt. 装备, 配备; 设备, 装置
oak|/әuk/n. 橡树, 橡木;橡木制的
nasty|/'nɑ:sti/a. 污秽的, 下流的, 险恶的
hopefully|/'hәjpfjli/adv. 有希望地, 如果希望能实现的话
sin|/sin/n. 罪, 犯罪, 过失, 失礼;犯
copper|/'kɒpә/n. 铜, 警察; 铜Cu
builder|/'bildә/n. 建立者; 组份
residence|/'rezidәns/n. 住宅, 居留, 驻扎, 居住期间; 住房
recipe|/'resipi/n. 食谱, 处方, 秘诀; 取(处方头语), 处方
bureau|/'bjuәrәu/n. 局, 办公处; 局, 司, 处
isolation|/.aisә'leiʃәn/n. 隔绝, 孤立, 隔离; 分离;生物分离
sandwich|/'sændwitʃ/n. 三明治, 夹心面包, 夹层板;插入, 夹入, 把...制成三明治
rod|/rɒd/n. 竿, 笞鞭, 小枝; 棒
sword|/sɒ:d/n. 刀, 剑, 战争, 武力, 剑状物
fluid|/'flu:id/n. 液体, 分泌液, 流体;流动的, 可改变的
discretion|/dis'kreʃәn/n. 慎重, 辨别力, 考虑, 处理权; 有决定权的
directory|/di'rektәri/n. 目录, 工商名录, 指南; 目录
decent|/'di:sәnt/a. 有分寸的, 得体的, 大方的
convey|/kәn'vei/vt. 传达, 运输, 转让; 转让(财产等), 搬运
duration|/dju'reiʃәn/n. 持续时间, 持续; 持续时间
administer|/әd'ministә/vt. 管理, 料理, 执行;执行遗产管理人的职责, 给予帮助
succession|/sәk'seʃәn/n. 连续, 继承权, 继位, 演替, 地层次序; 继承, 继承权, 继位
palm|/pɑ:m/n. 手掌, 棕榈, 胜利;与...握手, 藏...于掌中
justification|/.dʒʌstifi'keiʃәn/n. 辩护, 证明正当, 释罪; 调整
duck|/dʌk/n. 鸭子;没入水中, 闪避;猛按...入水, 躲避
stance|/stæns/n. 准备击球姿势, 站立的姿势, 位置, 姿态; 地位, 形势
whisky|/'hwiski/n. 威士忌酒, 轻便马车; 威士忌酒
norm|/nɒ:m/n. 基准, 模范, 标准, 准则, 平均数; 定额
oxygen|/'ɒksәdʒәn/n. 氧; 氧O-2
explicit|/ik'splisit/a. 详述的, 清楚的, 直言的
seminar|/'seminɑ:/n. 研究班, 专题讨论会; 讨论会, 专家讨论会
doorway|/'dɒ:wei/n. 门口, 途径
abstract|/'æbstrækt/a. 抽象的, 深奥的;摘要, 抽象概念;摘要, 提炼, 使抽象化; 摘录;摘要;抽象
defender|/di'fendә/n. 防卫者, 防护者, 辩护者; 辩护人, 保护人
portfolio|/pɒ:t'fәuliәu/n. 皮包, 公文包, 部长职务, 有价证券财产目录, 艺术代表作选辑; 公文包, 文件夹, 阁员职务
sculpture|/'skʌlptʃә/n. 雕刻, 雕塑;雕刻, 雕塑;当雕刻师
successive|/sәk'sesiv/a. 继承的, 连续的; 接续承运人;连续的
abolish|/ә'bɒliʃ/vt. 废止, 革除, 消灭; 废除, 取消, 裁撤
sensation|/sen'seiʃәn/n. 感觉, 轰动; 感觉
diagnosis|/.daiәg'nәusis/n. 诊断; 诊断
developer|/di'velәpә/n. 开发者; 显影器
comparable|/'kɒmpәrәbl/a. 可比较的, 比得上的
installation|/.instә'leiʃәn/n. 安装, 装置, 就职; 结构, 装置, 设立
bastard|/'bæstәd/n. 私生子, 劣货;私生的, 杂种的, 不合标准的
offender|/ә'fendә/n. 罪犯, 无礼的人, 得罪人的人
forum|/'fɒ:rәm/n. 论坛, 公开讨论的广场, 法庭, 讨论会; 讨论会, 专题讨论, 公共论坛
capitalism|/'kæpitәlizәm/n. 资本主义; 资本主义
frown|/fraun/n. 皱眉;皱眉头;皱眉表示
polytechnic|/.pɒli'teknik/a. 各种工艺的, 工艺教育的;工艺专科学校, 理工专科学校
computing|计算
legislative|/'ledʒislәtiv/n. 立法机构;立法的, 有立法权的
timing|/'taimiŋ/n. 时间选择, 时间测定, 定时, 调速; 定时器时钟
interfere|/.intә'fiә/vi. 妨碍, 冲突, 干涉, 抵触; 干扰, 干涉, 阻碍, 碰腿(马)
sooner|/'su:nә/n. (美)(非正式)抢先占有土地者, 抢先而获得不正当利益的人
plead|/pli:d/vi. 辩护, 恳求;为...辩护, 提出...借口, 托称, 恳求
bonus|/'bәunәs/n. 奖金, 红利; 奖金, 红利, 额外补贴
casual|/'kæʒjuәl/a. 偶然的, 不经意的, 便装的;临时工, 待命士兵
persist|/pә'sist/vi. 坚持, 固执, 持续, 坚称; 持续
inherit|/in'herit/vt. 继承, 遗传;接受遗产
extract|/ik'strækt/n. 榨出物, 精汁, 摘录, 选段;(费力地)取出, 采掘, 榨取, 摘录, 吸取; 提取
lesser|/'lesә/a. 较少的, 较小的, 次要的
subtle|/'sʌtl/a. 敏锐的, 精细的, 狡猾的, 稀薄的, 灵巧的, 微妙的; 锐敏的;精细的
glory|/'glɒ:ri/n. 光荣, 荣耀, 荣誉, 壮丽, 繁荣;自豪
partial|/'pɑ:ʃәl/a. 部分的, 偏袒的, 偏爱的;分音
conceive|/kәn'si:v/vt. 构思, 认为;怀孕
cater|/'keitә/v. 提供饮食及服务, 投合, 迎合
random|/'rændәm/n. 随意, 随机;任意的, 随便的, 胡乱的, 随机的;胡乱地
assignment|/ә'sainmәnt/n. 分配, 功课, 任务, 转让, 归因, 陈述; 赋值
marvellous|/'mɑ:vilәs/a. 奇异的, 神奇的, 奇迹般的, 惊人的, 不可思议的, 绝妙的, 妙极的
resemble|/ri'zembl/vt. 相似, 类似
intensive|/in'tensiv/a. 加强的, 内涵的, 集中的;加强器
guilt|/gilt/n. 罪行, 内疚; 罪, 犯罪, 罪行
basket|/'bɑ:skit/n. 篮, 篮子;装入篮
horizon|/hә'raizәn/n. 地平线, 眼界, (天)视地平
envisage|/in'vizidʒ/vt. 面对, 正视, 想象
capability|/.keipә'biliti/n. 能力, 性能, 约束力; 能力
tutor|/'tju:tә/n. 家庭教师, 导师, 助教, 监护人;当...的教师, 教, 指导, 约束, 克制;当家庭教师, 受家庭教师的指导
instinct|/'instiŋkt/n. 本能, 直觉;充满着的
eagle|/'i:gl/n. 鹰, 鹰状标饰
preliminary|/pri'liminәri/n. 初步做法, 初步措施, 预试, 预选赛;初步的, 开始的, 预备的
inn|/in/n. 旅馆, 客栈;住旅馆
scholar|/'skɒlә/n. 学者, 奖学金获得者, 有文化者, 学习者
pavement|/'peivmәnt/n. 路面, 人行道, 铺面路, 铺路材料
sphere|/sfiә/n. 球, 球面, 球体, 天体, 地球仪, 范围;包围, 使成球体, 放入球内
holding|/'hәuldiŋ/n. 把持, 支持, 保持; 租借地, 占有物, 拥有的财产
reign|/rein/v. 为王，为君;当政;统治;为王，为君;当政;统治
motivation|/.mәuti'veiʃәn/n. 动机, 刺激, 推动; 促动, 推动, 诱导
influential|/.infu'enʃәl/a. 有影响的, 有势力的
entity|/'entiti/n. 实体, 实存物, 存在; 实体
assign|/ә'sain/vt. 分配, 指派, 赋值; 赋值
redundancy|/ri'dʌndәnsi/n. 过多, 冗长, 累赘, 多余, 冗余位, 冗余度, 冗余码, 多余信息; 冗余
pat|/pæt/n. 轻拍;轻拍;适时, 正好, 恰好, 毫不迟疑, 熟记地;恰好的, 合适的, 熟练的, 坚定的, 人为的
update|/ʌp'deit/vt. 更新, 使现代化;更新; 更新
tray|/trei/n. 托盘, 公文盘, 满盘, 发射箱; 淋盘
Christianity|/.kristʃi'æniti/n. 基督教, 基督教精神
thesis|/'θi:sis/n. 论题, 论文
regulate|/'regjuleit/vt. 管理, 控制, 调节, 调整, 校准; 控制, 管理
commonwealth|/'kɔmәnwelθ/n. 共和国;联邦;国民整体
radiation|/.reidi'eiʃәn/n. 辐射; 放射
consensus|/kәn'sensәs/n. 合意, 一致, 同感; 合意
hey|/hei/interj. 嗨
subsidiary|/sәb'sidiәri/n. 子公司, 附件, 辅助者;辅助的, 次要的, 津贴的
organism|/'ɒ:gәnizm/n. 生物, 有机体, 社会组织; 生物;,;机体
plc|可编程逻辑控制器
lighting|/'laitiŋ/n. 照明, 照明设备, 舞台灯光
assemble|/ә'sembl/vt. 集合, 收集, 装配;集合; 汇编
poster|/'pәustә/n. 海报, 招贴, 驿马
harsh|/hɑ:ʃ/a. 粗糙的, 刺耳的, 严厉的; 粗糙的, 严厉的, 苛刻的
blanket|/'blæŋkit/n. 毛毯, 毯子;掩盖, 覆盖;总共的
tribute|/'tribju:t/n. 贡物, 礼物, 颂辞
surgeon|/'sә:dʒәn/n. 外科医生, 军医, 船医; 外科医师
beam|/bi:m/n. 横梁, 杆, 光线, 容光焕发;用梁支承, 微笑, 射出光线;照耀, 感到欣喜; 束
slave|/sleiv/n. 奴隶, 从动装置, 卑鄙的人;拼命工作; 从设备
engagement|/in'geidʒdmәnt/n. 诺言, 约会, 婚约, 交战; 衔接
contemplate|/'kɒntempleit/vt. 注视, 沉思, 盘算;冥思苦想
excessive|/ik'sesiv/a. 过度的, 过多的, 极端的; 过度的, 过分的, 额外的
splendid|/'spendid/a. 光亮的, 了不起的, 灿烂的, 壮丽的, 显著的, 杰出的
remainder|/ri'meindә/n. 剩余物, 其他人, 残余, 余数;削价出售(图书);剩余的, 出售削价剩书的; 余数
intervene|/.intә'vi:n/vi. 插入, 调停, 干涉; 进场干预
clay|/klei/n. 泥土, 肉体, 黏土; 粘土
metropolitan|/.metrә'pɒlitn/n. 大都市居民, 都主教, 宗主国的公民;大都市的, 都主教区的, 宗主国的
embrace|/im'breis/n. 拥抱;拥抱, 互相拥抱, 包含, 收买;拥抱
exceptional|/ik'sepʃәnәl/a. 例外的, 异常的, 特别的
descend|/di'send/vi. 下降, 世代相传, 屈尊, 袭击;下降
combined|/kәm'baind/a. 结合的;组合的
grasp|/græsp/n. 把握, 抓紧, 理解, 抓, 柄, 控制;抓住, 紧握, 领会;抓
supervision|/.sju:pә'viʒәn/n. 监督, 管理; 监督, 管理
limb|/lim/n. 四肢, 枝干, 翼, 边缘;切断...之手足
cling|/kliŋ/vi. 粘紧, 附着, 紧贴, 坚持
monster|/'mɒnstә/n. 怪物, 恶人, 巨物; 畸胎
memorial|/mi'mɒ:riәl/n. 纪念物, 请愿书;记念的, 记忆的
exclusively|/ik'sklu:sivli/adv. 排他地, 仅仅, 专门, 只, 仅, 唯一地, 专有地
conceal|/kәn'si:l/vt. 隐藏, 掩盖, 隐瞒; 隐瞒, 隐匿, 保守秘密
compulsory|/kәm'pʌlsәri/a. 被强制的, 强迫的, 义务的; 强迫的, 强制的
similarity|/.simi'læriti/n. 类似, 类似处; 类似, 相似, 类似事例
jaw|/dʒɒ:/n. 颚, 颌;闲谈, 教训, 唠叨
ridge|/ridʒ/n. 脊, 山脊, 山脉; 嵴, 脊, 棱线
liver|/'livә/n. 肝脏, 生活者, 居民; 肝
progressive|/prә'gresiv/n. 改革论者, 进步论者;前进的, 累进的, 进步的
terminal|/'tә:minәl/n. 终端机, 终点, 末端, 极限, 终点站;终点的, 定期的, 致死的, 结尾的, 末端的, 晚期的; 终端;终端设备
incur|/in'kә:/vt. 招致, 蒙受, 遭遇; 招致, 蒙受, 担负
continental|/.kɒnti'nentl/a. 大陆的, 洲的;欧洲大陆人
cab|/kæb/n. 出租车, 出租汽车, 出租马车;乘出租马车(或汽车)
chronic|/'krɒnik/a. 慢性的, 习惯性的;慢性病患者
primitive|/'primitiv/n. 原始人, 早期艺术家;原始的, 上古的; 图元;原语;基元
legend|/'ledʒәnd/n. 传说, 传奇文学, 图例; 图例
bronze|/brɒnz/n. 青铜, 铜像;青铜色的
orchestra|/'ɒ:kistrә/n. 管弦乐队, 乐队演奏处
scarcely|/'skɑ:sli/adv. 简直不, 一定不, 仅仅
operational|/.ɒpә'reiʃәnl/a. 操作的, 运作的; 操作上的, 业务上的, 可起作用的
handsome|/'hænsәm/a. 英俊的, 大方的, 慷慨的, 相当可观的, 美观的, 灵敏的
horrible|/'hɒrәbl/a. 可怕的, 遭透的, 极讨厌的
faculty|/'fækәlti/n. 才能, 能力, 全体教员, (大学的)系; 能力, ;院系
socialism|/'sәuʃәlizm/n. 社会主义, 社会主义运动
exclusion|/ik'sklu:ʒәn/n. 排除, 除外, 逐出; 排除, 除外, 分离术
systematic|/.sisti'mætik/a. 有系统的, 分类上的, 体系的; 系统的, 系的, 分类的
constituent|/kәn'stitjuәnt/n. 成分, 选民, 构成物;构成的, 组织的, 选举的
pardon|/'pɑ:dn/n. 原谅, 赦免;宽恕, 原谅
ideological|/.aidiә'lɒdʒikәl/a. 意识形态的, 空想的; 思想的, 思想上的, 意识形态的
GP|普通医师, 普通医生开业医生; 通用程序设计, 图形处理器
striker|/'straikә/n. 打击者, 罢工者; 罢工者
fortunately|/'fɒitʃәnitli/adv. 幸运地, 幸亏
pursuit|/pә'sju:t/n. 追踪, 追求, 追赶, 娱乐, 职业; 追捕, 追求
sue|/su:/vt. 控告, 起诉, 请求;提出诉讼, 提出请求
nowadays|/'nauәdeiz/n. 现在, 现时, 当今;时下, 现今
endless|/'endlis/a. 不停的, 无穷尽的, 无尽的; 无端的, 环状的
invariably|/in'vєәriәbli/adv. 不变化地, 恒定地, 始终如一地
dispose|/dis'pәuz/vt. 处理, 排列, 布置;处置
confess|/kәn'fes/v. 承认, 坦白, 忏悔, 供认
grace|/greis/n. 优雅, 风度, 慈悲, 恩惠, 体面, 赦免, 恩典, 谢恩祷告;使优美
isolated|/'aisәleitid/a. 孤立的, 孤零零的; 隔离的, 绝缘的
precious|/'preʃәs/a. 宝贵的, 珍贵的, 过于精致的, 珍爱的
miracle|/'mirәkl/n. 奇迹, 奇事
prejudice|/'predʒudis/n. 偏见, 成见, 侵害;使存偏见, 使有成见, 侵害
shield|/'ʃi:ld/n. 盾, 防卫物, 保护者, 屏蔽;保护, 遮蔽, 屏蔽, 庇护, 挡开, 避开;起保护作用
wealthy|/'welθi/a. 富有的, 丰裕的, 充分的
scatter|/'skætә/n. 消散, 分散, 散播, 散射, 散布, 酒馆;散布, 散播, 消散;使消散, 使分散, 撒, 散布, 散播, 散射; 散点图
forthcoming|/'fɒ:θ'kʌmɑŋ/a. 即将来临的;来临
hedge|/hedʒ/n. 树篱, 障碍, 套头交易;用树篱围, 套期保值, 妨碍, 两面下注以防...的损失;筑树篱, 躲闪, 两面下注以防损失;树篱的, 偷偷摸摸的
brass|/bræs.brɑ:s/n. 黄铜, 黄铜制品;黄铜的, 铜管乐器的;镀以黄铜, 支付
terror|/'terә/n. 恐怖, 可怕的人; 惊吓, 惊悸
neutral|/'nju:trәl/n. 中立者, 中立国, 非彩色, 空档;中立的, 中性的, 无色的
mature|/mә'tjuә/a. 成熟的, 到期的, 充分考虑的;使成熟;成熟, 到期
vanish|/'væniʃ/vi. 消失, 不见, 成为零
virgin|/'vә:dʒin/n. 处女;处女的, 贞洁的, 纯洁的, 初始的, 纯的
coincide|/.kәuin'said/vi. 一致, 符合; 重合
ladder|/'lædә/n. 梯, 梯状物, 发迹的途径;袜子抽丝, 成名
keeper|/'ki:pә/n. 监护人, 管理人, 看守人; 保管人, 看守人, 保持片
hostile|/'hɒstail/a. 敌人的, 怀敌意的, 敌对的;敌对分子
formulate|/'fɒ:mjuleit/vt. 用公式表示, 明确叙述, 制订; 公式化, 公式表示
correspondence|/.kɒri'spɒndәns/n. 相符, 通信, 信件; 对应, 相对
supper|/'sʌpә/n. 晚餐
creep|/kri:p/n. 爬, 徐行, 蠕动;爬, 蔓延, 潜行
contractor|/'kɒntræktә/n. 立契约的人, 承包商; 承包者;承包工厂
accessible|/әk'sesәbl/a. 易接近的, 可进入的, 可使用的, 易受影响的, 可理解的
deem|/di:m/v. 认为, 相信
inhabitant|/in'hæbitәnt/n. 居民, 居住者; 居民
prediction|/pri'dikʃәn/n. 预言, 预报; 预测
classify|/'klæsifai/vt. 分类, 归类, 分等; 分类, 分级, 分粒
lamb|/læm/n. 小羊, 羔羊;产羊羔
candle|/'kændl/n. 蜡烛;对着光检查
fist|/fist/n. 拳头, 手;拳打, 握成拳, 紧握
prey|/prei/n. 被掠食者, 牺牲者;捕食
predecessor|/.predi'sesә/n. 前任, 先辈, 前身; 初牙, 前辈, 祖先
provincial|/prә'vinʃәl/n. 外地人, 粗野的人;省的, 外地的, 偏狭的
coffin|/'kɒfin/n. 棺材, 灵柩;把...装进棺材
notable|/'nәutәbl/n. 著名人士, 值得注意之事物;值得注意的, 显著的
transmission|/træns'miʃәn/n. 传输, 传送, 变速器; 传输
marble|/'mɑ:bl/n. 大理石, 石弹, 雕刻品;大理石的, 冷酷无情的, 有大理石花纹的
endorse|/in'dɒ:s/vt. 支持, 赞同, 背书于, 签署; 赞成, 背书
barn|/bɑ:n/n. 谷仓; 靶(恩)(核反应截面单位)
collar|/'kɒlә/n. 衣领, 颈圈;控制, 扭住衣领, 给...装上领子
hut|/hʌt/n. 小屋, 茅舍, 临时军营;(使)住在茅舍
utility|/ju:'tiliti/n. 功用, 有用之物, 实用, 公用事业, 实用程序;实用的, 有多种用途的; 实用程序, 工具
trophy|/'trәufi/n. 战利品, 奖品;用战利品装饰
elite|/ei'li:t/n. 精华, 精锐, 中坚分子
workforce|劳动力;工人总数, 职工总数
dynamic|/dai'næmik/a. 动态的, 有活力的, 有力的, 动力的, 不断变化的;动力, 动态; 动态的
technological|/.teknә'lɒdʒikl/a. 技术的; 工艺的, 技术的
dolphin|/'dɒlfin/n. 海豚
advisory|/әd'vaizәri/a. 顾问的, 咨询的, 劝告的; 劝告的, 忠告的, 咨询的
geographical|/dʒiә'græfikl/a. 地理学的, 地理的
stitch|/stitʃ/n. 一针, 疼痛, 针法, 碎布条, 针脚;缝, 缝合, 装订
bloke|/blәuk/n. 小子, 家伙
owl|/aul/n. 猫头鹰; 走私
tumour|/'tju:mә/n. 瘤, 肿块
electron|/i'lektrɒn/n. 电子; 电子
antibody|/'æntibɒdi/n. 抗体; 抗体
relieve|/ri'li:v/vt. 减轻, 救济, 解除, 使免除, 换...的班, 使得到调剂, 使不单调, 衬托, 使显著;救济, 当替补投手, 呈鲜明突出
handful|/'hændful/n. 少数, 一把, 棘手事
worthwhile|/'wә:θ'hwail/a. 值得花时间的, 值得做的, 有真实价值的
vague|/veig/a. 含糊的, 不清楚的, 茫然的
odds|/ɒdz/n. 可能性, 几率, 机会, 胜算, 不平等
portion|/'pɒ:ʃәn/n. 部分, 一份, 命运, 嫁妆;分配, 给...嫁妆
conscience|/'kɒnʃәns/n. 良心; 良心, 道德感, 正义感
tobacco|/tә'bækәu/n. 烟草, 香烟; 烟草
wisdom|/'wizdәm/n. 智慧, 明智行为, 学识, 名言, 贤人
regardless|/ri'gɑ:dlis/a. 不管, 不注意, 不顾
certainty|/'sә:tәnti/n. 确定, 确实的事情; 确定, 肯定, 必然的事
distress|/di'stres/n. 苦恼, 贫困, 痛苦;使苦恼;亏本出售的
fortnight|/'fɒ:tnait/n. 两星期
circulation|/.sә:kju'leiʃәn/n. 流通, 循环, 发行量; 环流
suite|/swi:t/n. 随员, 套房, (一)组, (一)套, 组曲, 继之而来的事; 程序组
disturbance|/dis'tә:bәns/n. 扰乱, 不安, 忧虑; 扰动;干扰;失调
tighten|/'taitn/vt. 勒紧, 使变紧;变紧, 绷紧
ambitious|/æm'biʃәs/a. 有野心的, 抱负不凡的, 雄心勃勃的
straw|/strɒ:/n. 稻草, 麦管, 吸管, 一文不值的东西, 草帽;稻草的, 稻草色的, 琐碎的, 无价值的
erect|/i'rekt/a. 直立的, 竖立的, 笔直的;使竖立, 使直立, 树立, 建立;勃起
evidently|/'evidәntli/adv. 明显地, 根据现有证据来看
destination|/.desti'neiʃәn/n. 目的地, 目标, 目的; 目的文件, 目的单元
verbal|/'vә:bl/a. 用言辞的, 言语的, 口头的, 逐字的, 动词的; 言语的, 口述的
enclose|/in'klәuz/vt. 围绕, 圈起, 放入封套, 附上
discharge|/dis'tʃɑ:dʒ/vt. 卸下, 放出, 解雇, 拔染, 履行, 放电;卸货, 流出;卸货, 流出, 放电
hazard|/'hæzәd/n. 冒险, 危险, 机会;冒...的危险, 赌运气, 使冒危险; 相关危险;冒险
log|/lɒg/n. 记录, 圆木, 日志, 计程仪;伐木, 切, 航行;伐木; 日志
elephant|/'elifәnt/n. 象
seldom|/'seldәm/a. 不常的, 稀少的;很少, 不常
precede|/.pri:'si:d/vt. 在...之前, 优于, 较...优先;在前面
legitimate|/li'dʒitimәt/a. 合法的, 正当的, 婚生的;认为正当, 立为嫡嗣, 使合法
grief|/gri:f/n. 伤心, 忧愁, 悲痛, 不幸, 灾难
tuck|/tʌk/n. 缝褶, 活力, 鼓声, 船尾突出部, 食品;打褶, 卷起, 挤进, 塞, 收藏;缝褶裥, 缩拢
restraint|/ri'streint/n. 抑制, 克制, 束缚; 约束, 拘束
charm|/tʃɑ:m/n. 吸引力, 魔力, 符咒;迷住, 使陶醉, 行魔法;用符咒, 有魅力
omit|/әu'mit/vt. 省略, 删除, 疏忽, 遗漏; 省略
contradiction|/.kɒntrә'dikʃәn/n. 反驳, 矛盾; 矛盾, 否认, 反驳
suspension|/sә'spenʃәn/n. 悬挂, 暂停, 中止; 悬浮;悬浮体;悬浮液
vein|/vein/n. 血管, 静脉, 纹理, 气质, 情绪;使有脉络, 像脉络般分布于
petition|/pi'tiʃәn/n. 请愿, 诉状, 陈情书, 申请, 祈求, 祷文;正式请求, 恳求, 请愿
basin|/'beisn/n. 盆, 盆地; 第三脑室, 骨盆
favourable|/'feivәrәbl/a. 有用的, 良好的, 赞成的, 顺利的; 良好的, 顺利的
expedition|/.ekspi'diʃәn/n. 远征, 探险队, 迅速
administrator|/әd'ministreitә/n. 管理人, 行政官; 遗产管理人员
plea|/pli:/n. 恳求, 辩解, 抗辩, 诉讼, 请愿, 托词; 抗辩, 申诉案件, 答辩
integrity|/in'tegriti/n. 正直, 廉正, 完整; 完整性
commodity|/kә'mɒditi/n. 农产品, 商品, 有用的物品; 商品, 货物, 日用品
academy|/ә'kædәmi/n. 学院, 院校, 学会
goodness|/'gudnis/n. 仁慈, 善良
cluster|/'klʌstә/n. 串, 丛, 群, 簇;成串, 丛生;使聚集; 簇
supplement|/'sʌplimәnt/n. 补充物, 增刊, 补充, 补遗, 补编, 附录, 补角;补充, 增补
profound|/prә'faund/a. 极深的, 深厚的, 深刻的, 渊博的
depict|/di'pikt/vt. 描述, 描写
dawn|/dɒ:n/n. 破晓, 黎明;破晓
parking|/'pɑ:kiŋ/n. 停车;停车的
tile|/tail/n. 砖瓦, 瓷砖, 瓦片;铺以瓦, 铺以瓷砖; 平铺
pulse|/pʌls/n. 脉冲, 脉搏, 情绪, 意向, 拍子, 豆类;跳动, 脉跳;使跳动, 用脉冲调制; 脉冲
manual|/'mænjuәl/n. 手册, 指南;手的, 手动的, 手工的, 体力的; 人工的, 手动的
mining|/'mainiŋ/n. 采矿; 采矿, 采矿业
originate|/ә'ridʒineit/vt. 创始, 发明, 发起;发源, 发生, 起航; 发自
moor|/muә/n. 荒野;旷野;Moor: 摩尔人.;系住;停泊
regiment|/'redʒimәnt/n. （军队）团, 大量（人或物）;组编成团，组织，严格管制
custody|/'kʌstәdi/n. 监护, 拘留, 监禁; 保管, 照顾, 保护
electronics|/.ilek'trɒniks/n. 电子学; 电子学
handicap|/'hændikæp/n. 障碍, 困难, 不利条件;加障碍于, 妨碍
manor|/'mænә/n. 庄园; 采邑, 庄园, 采地
defect|/di'fekt/n. 缺点; 缺损, 缺陷
breeze|/bri:z/n. 微风, 煤屑, 轻而易举的事;吹微风, 逃走
spine|/spain/n. 背骨, 脊柱, 尖刺; 脊柱;棘, 刺;马蹄嵴
lounge|/laundʒ/n. 闲逛, 休闲室, 长沙发;闲混, (懒洋洋地)躺;闲混
colonial|/kә'lәunjәl/a. 殖民的, 殖民地的; 殖民地居民
magnetic|/mæg'netik/a. 有磁性的, 有吸引力的, 催眠术的; 磁;的
bureaucracy|/bjuә'rɒkrәsi/n. 官僚, 官吏; 官僚主义, 官僚政治, 官僚机构
ballet|/'bælei/n. 芭蕾舞
tourism|/'tuәrizm/n. 观光业, 游览; 旅游业
bowel|/'bauәl/n. 肠, 内脏, 内部;挖...的内脏
tremble|/'trembl/n. 战栗, 颤抖;战栗, 忧虑, 摇晃
thigh|/θai/n. 大腿, 股; 股, 大腿
composer|/kәm'pәuzә/n. 作曲家, 作家, 调停者
reportedly|/ri'pɒ:tidli/adv. 根据传说, 根据传闻, 据报道
meantime|/'mi:ntaim/n. 间隔时间, 其时;其间
fatal|/'feitәl/a. 致命的, 重大的, 命运注定的, 粗心的, 不幸的; 致命的, 致死的
compensate|/'kɒmpenseit/v. 偿还, 补偿, 付报酬
bold|/bәuld/a. 大胆的;粗体; 粗体
rigid|/'ridʒid/a. 坚硬的, 刚性的, 严格的, 精密的, 刻板的
peculiar|/pi'kju:ljә/a. 奇特的, 罕见的, 特殊的, 特别的;特有财产, 特权
neglect|/ni'glekt/n. 疏忽, 忽略, 漏做;疏忽, 忽视, 不顾
making|/'meikiŋ/n. 制造, (手工)制造业, 制作, 形成, 发展, 要素, 内在因素, 赚头, 制造物
circulate|/'sә:kjuleit/v. (使)流通, (使)循环, (使)传播
spill|/spil/n. 溢出, 溅出, 摔下, 溢出量, 木片, 小塞子;使溢出, 使散落, 洒, 使流出, 倒出, 使摔下;溢出, 涌流, 摔下
profitable|/'prɒfitәbl/a. 有利润的, 有利益的, 赚钱的; 有利(可图)的, 合算的
deprive|/di'praiv/vt. 剥夺, 使丧失; 剥夺, 剥夺, 夺去
warehouse|/'wєәhaus/n. 仓库, 货栈, 大商店;储入仓库
drown|/draun/vi. 淹死;把...淹死, 淹没
lecturer|/'lektʃәrә/n. 演讲者, 讲师; 讲演人, 讲课人, 讲师
bucket|/'bʌkit/n. 桶; 存储桶;桶
compact|/kәm'pækt/a. 紧凑的, 紧密的, 简洁的;使紧密结合, 压缩;变坚实
embark|/im'bɑ:k/vi. 乘船, 着手, 从事, 上飞机;使上船, 使上飞机, 使从事
depart|/di'pɑ:t/vi. 离开, 出发, 背离, 违反, 去世
irrelevant|/i'relәvәnt/a. 不恰当的, 无关系的, 不相干的; 无关的, 不相干的, 离题的
crude|/kru:d/a. 天然的, 未成熟的, 粗糙的, 粗鲁的;天然的物质
summon|/'sʌmәn/vt. 召唤, 召集, 号召, 振奋, 唤起, 鼓起; 传唤, 传讯
lifestyle|/'laifstail/n. 生活方式
outlet|/'autlet/n. 出口, 发泄方法, 市场; 出口
passive|/'pæsiv/a. 消极的, 被动的, 冷漠的, 顺从的, 无源的; 被动的
interference|/.intә'fiәrәns/n. 冲突, 干涉; 干扰
beast|/bi:st/n. 畜生, 动物, 野兽, 兽性
symbolic|/sim'bɒlik/a. 象征的, 符号的; 符号化
ritual|/'ritʃuәl/n. 仪式, 典礼, 宗教仪式;仪式的, 依仪式进行的
skull|/skʌl/n. 头盖骨, 头脑, 好学生; 头颅
widen|/'waidn/vt. 弄宽, 加宽, 扩大;变宽, 扩大
obstacle|/'ɒbstәkl/n. 障碍, 妨害物, 阻碍
diminish|/di'miniʃ/v. (使)减少, (使)变小
revive|/ri'vaiv/vt. 使苏醒, 使复兴, 使振奋, 回想起, 重播;苏醒, 复活, 复兴, 恢复精神
reassure|/.ri:ә'ʃuә/vt. 使...安心, 向...再保证; 重新保证, 再保险, 使清除疑虑
transmit|/træns'mit/vt. 传输, 传染, 传达, 遗传, 发射, 传播;发射信号, 留传下来; 传送
stall|/stɒ:l/n. 厩, 停车处, 牧师职位, 货摊, 托辞, 拖延;关入厩, 停顿, 推托, 支吾, 使陷于泥中;被关在厩内, 陷于泥中, 停止, 支吾
treasure|/'treʒә/n. 宝物, 财富;珍爱, 重视, 秘藏
canvas|/'kænvәs/n. 帆布, 画布, 油画; 帆布
suppress|/sә'pres/vt. 镇压, 使止住, 禁止, 抑制, 查禁; 镇压, 平定, 禁止出版
immense|/i'mens/a. 极广大的, 无边的, 非常好的
arouse|/ә'rauz/vt. 唤醒, 鼓励, 引起;醒来
minimal|/'miniml/a. 最小的, 极微的, 最小限度的; 最小的, 最低的
revelation|/.revi'leiʃәn/n. 揭露, 泄露, 发觉, 默示, 启示
neighbouring|/'neibәriŋ/a. 邻近的, 接壤的, 附近的; 邻近的, 附近的, 接壤的
dilemma|/di'lemә/n. 困境, (进退两难的)窘境
clarify|/'klærifai/vi. 澄清, 阐明;使明晰
frontier|/'frʌntjә/n. 边界, 边境; 国境, 边境, 边界
charming|/'tʃɑ:miŋ/a. 迷人的, 有吸引力的
productive|/prә'dʌktiv/a. 能生产的, 有生产价值的, 多产的; 产出性的, 产生性的
motorway|/'mәutәwei/n. 高速公路
strand|/strænd/n. (绳索的)股, 绳, 串, 海滨, 河岸;搁浅;使搁浅, 使落后, 使陷于困境, 弄断, 搓
injection|/in'dʒekʃәn/n. 注射, 注射剂; 注入;注射
compile|/kәm'pail/vt. 编译, 编辑, 编纂, 收集; 编译
thereafter|/.ðєәr'æftә/adv. 其后, 从那时以后
dreadful|/'dredful/a. 可怕的
bang|/bæŋ/n. 重击, 突然巨响, 刘海;发巨响, 重击;砰然地, 突然巨响地, 直接地; 撞击符
fling|/fliŋ/n. 投掷, 急冲, 嘲弄;投, 丢下, 抛弃, 使陷入, 挥动, 嘲笑, 扫视;猛冲
beneficial|/.beni'fiʃәl/a. 有益的, 受益的; 有使用权的, 可享利益的
thrust|/θrʌst/n. 插, 戳, 刺, 猛推, 口头攻击, 推力;插入, 猛推, 刺, 戳, 强加, 延伸;插, 刺, 戳, 延伸, (用力)推
amend|/ә'mend/vt. 修改, 改善, 改良;改过自新
comparative|/kәm'pærәtiv/a. 比较的, 相对的;对手
albeit|/ɔ:l'bi:it/conj. 尽管, 虽然
lawn|/lɒ:n/n. 草地, 草坪, 上等细麻布; 细筛
ferry|/'feri/n. 渡船, 渡口; 摆渡营业权, 轮渡
booking|/'bukiŋ/n. 预约演出合同; 书型模法
manuscript|/'mænjuskript/n. 手稿, 原稿, 底稿;手写的
tribe|/traib/n. 宗族, 部落, 一群人; 族(生物分类)
quota|/'kwәutә/n. 配额, 限额; 定额
heir|/єә/n. 继承人, 嗣子, 后嗣; 继承人, 后嗣
slam|/slæm/n. 砰然声, 猛然, 猛烈的抨击;猛然关上, 砰地关上, 猛烈抨击;砰地关上, 猛攻
habitat|/'hæbitæt/n. 栖息地, 居留地, 自生地, 聚集处; 习生地, 产地, 生境, 栖所
bias|/'baiәs/n. 偏见, 斜纹;偏斜的;偏斜;使有偏见; 偏流;偏压;偏磁;偏离
diameter|/dai'æmitә/n. 直径; 直经, 径
fox|/fɒks/n. 狐狸, 狡猾的人;奸狡地行动, (书页)生斑, 变酸;欺骗, 使变酸, 为(鞋等)换面, 使生黄斑
collaboration|/kә.læbә'ræʃәn/n. 合作, 勾结; 通敌卖国者, 奸细
sexuality|/.sekʃu'æliti/n. 性征, 性行为, 性欲; 性别, 性欲
eyebrow|/'aibrau/n. 眉毛; 眉
diesel|/'di:zәl/n. 内燃机, 柴油机, 柴油
forehead|/'fɒ:rid/n. 额, 前额, 前部; 额
referee|/.refә'ri:/n. 仲裁人, 调解人, 裁判员;仲裁, 裁判
taxpayer|/'tækspeiә/n. 纳税人; 纳税人, 纳税义务人
fossil|/'fɒsәl/n. 化石, 古物;化石的, 陈腐的, 守旧的
diversity|/dai'vә:siti/n. 差异, 多样性; 多样性
retailer|/'ri:teilә/n. 零售商人, 传播的人; 零售商
rug|/rʌg/n. 小块地毯, 揭露某人
worthy|/'wә:ði/n. 杰出人物;有价值的, 可敬的, 值得的
doubtful|/'dautful/a. 可疑的, 疑心的, 不明确的; 怀疑的, 有疑问的, 未确的
dictate|/'dikteit/vi. 听写, 口述, 口授;口述, 使听写, 命令;命令, 指挥, 指令
protective|/prә'tektiv/a. 给予保护的, 保护的; 保护的, 防护的, 保护剂, 保护物, 油绸
promising|/'prɒmisiŋ/a. 有希望的, 前途有望的; 有希望的
forbid|/fә'bid/vt. 禁止, 不准, 妨碍; 不许, 禁止, 阻止
dedicate|/'dedikeit/vt. 献出, 贡献
tender|/'tendә/a. 嫩的, 柔软的, 脆弱的, 温柔的, 亲切的, 未成熟的, 微妙的, 棘手的, 审慎的;使变嫩, 提供, 偿还;变柔软, 投标;照料, 看管人, 供应船, 小船, 提出, 偿付, 投标
supervise|/'sju:pәvaiz/v. 监督, 管理, 指导
misery|/'mizәri/n. 痛苦, 悲惨, 不幸, 穷困
illusion|/i'lju:ʒәn/n. 幻影, 错觉, 幻想; 错觉
fringe|/frindʒ/n. 边缘, 端, 流苏, 穗, 初步;加穗于, 加饰边于;边缘的, 附加的
reminder|/ri'maindә/n. 提醒的人, 暗示; 催单
fortunate|/'fɒ:tʃәnit/a. 幸运的, 幸福的
temptation|/temp'teiʃәn/n. 诱惑, 诱惑物; 诱惑, 诱惑物
underline|/'ʌndәlain/vt. 在...下面划线, 作...的衬里, 强调;下划线, 图下说明文字; 加下划线;下划线
merge|/mә:dʒ/vt. 使合并, 使消失, 吞没;合并, 渐渐消失; 合并
manipulate|/mә'nipjuleit/vt. 操纵, 利用, 操作, 巧妙地处理, 假造
burning|/'bә:niŋ/a. 燃烧的, 象燃烧一样的;烧, 燃烧
throne|/'θrәun/n. 王座, 君主
sacred|/'seikrid/a. 神圣的, 献给上帝的, 庄严的, 祭祀的; 神圣的, 不可侵犯的
calendar|/'kælindә/n. 日历, 日程表;列入表中; 日历
harmony|/'hɑ:mәni/n. 协调, 和睦, 调和; 和声学
intent|/in'tent/n. 意图, 含义, 故意;专心的, 决心的, 热心的
persistent|/pә'sistәnt/a. 固执的, 坚持的, 持续的, 作用持久的; 坚持的, 固执的, 持续的
outsider|/' aut'saidә/n. 外人, 局外人, 非会员, 外行, 门外汉, 比赛中获胜可能性不大的选手; 外船公司
elaborate|/i'læbәreit/a. 精细的, 详尽的, 精心计划(或制作)的;详细地说明, 用心地制作, 发挥;变复杂, 作详细说明
utterly|/'ʌtәli/adv. 完全地, 全然, 绝对
rebuild|/ri'bild/vt. 改建, 重建, 改造;重建
circular|/'sә:kjulә/a. 圆形的, 循环的, 间接的; 环状的, 循环的
ash|/æʃ/n. 灰, 灰烬; 灰分
fitting|/'fitiŋ/a. 适宜的;试穿, 试衣, 装配, 装置
hidden|/'hidn/a. 隐藏的;hide的过去分词; 隐藏的
defensive|/di'fensiv/a. 防卫的, 防备用的, 自卫的;守势, 防卫姿势, 防卫物
caution|/'kɒ:ʃәn/n. 小心, 慎重, 警示;警告; 警告
partially|/'pɑ:ʃәli/adv. 部分地, 一部分地, 不公平地
distinguished|/dis'tiŋgwiʃt/a. 卓著的, 著名的
sunshine|/'sʌnʃain/n. 阳光, 光明, 晴天
stuck|stick的过去式和过去分词
proclaim|/prә'kleim/vt. 宣布, 公告, 宣言, 表明, 赞扬; 宣布, 宣告, 公布
shaft|/ʃæft/n. 轴, 箭杆, 矛, 矿井;装杆于, 利用
furious|/'fjuәriәs/a. 狂怒的, 激烈的, 吵闹的
monument|/'mɒnjumәnt/n. 纪念碑, 纪念物, 石碑
prescribe|/pris'kraib/v. 规定, 指定, 嘱咐, 开处方
divine|/di'vain/a. 神的, 神圣的, 非凡的;神学家
morality|/mә'ræliti/n. 道德, 教训, 品行; 道德, 道义
syndrome|/'sindrәum/n. 并发症状, 综合征, 同时存在的事物; 校验子;并发位
invisible|/in'vizәbl/a. 看不见的, 无形的; 无形的, 表面上看不见的, 未列在公开帐目的
dignity|/'digniti/n. 尊严, 高贵; 尊严, 高位, 高贵
despair|/di'spєә/n. 绝望, 失望;绝望
steward|/'stju:wәd/n. 管理人, 招待员, 管家, 乘务员; 轮船, 飞机的服务员, (财务)管理员
salmon|/'sæmәn/n. 鲑鱼, 大麻哈鱼; 鲑
contempt|/kәn'tempt/n. 轻视, 轻蔑; 藐视, 侮辱, 轻视
loop|/lu:p/n. 环, 圈, 弯曲部分, 循环;使成环, 以圈结, 以环连结;打环, 翻筋斗; 循环
gardener|/'gɑ:dәnә/n. 园丁, 花匠, 园艺家
brochure|/'brәuʃә/n. 小册子, 小册
contrary|/'kɒntrәri/a. 相反的, 矛盾的, 对立的;相反, 对立面;相反地
prospective|/prәs'pektiv/a. 预期的, 将来的; 预期的, 未来的
array|/ә'rei/n. 排列, 衣服, 大批, 军队;布署, 打扮, 排列; 数组;阵列
temper|/'tempә/n. (钢等的)硬度, 脾气, 心情, 中和剂, 倾向, 回火;使回火, 锻炼, 调和, 使缓和;回火
bee|/bi:/n. 蜜蜂, 聚会
arch|/ɑ:tʃ/n. 拱门, 拱形, 足弓;使成弓形;拱起, 成弓形;主要的, 调皮的, 傲慢无礼的, 狡猾的
aggression|/ә'greʃәn/n. 侵犯, 侵略; 攻击
solar|/'sәulә/a. 太阳的, 日光的, 源自太阳的; 太阳的;腹腔丛的
cage|/keidʒ/n. 笼, 牢房, 战俘营;关进笼内
regain|/ri'gein/vt. 取回, 恢复, 重回, 复得; 回潮
misleading|/mis'li:diŋ/a. 引入歧途的, 使人误解的, 骗人的; 误写姓名的, 误称的, 令人误解的
bounce|/bauns/n. 跳, 跳跃, 弹力, 撞击;反跳, 弹跳;使跳回, 撞击; 打回
philosophical|/.filә'sɒfikl/a. 哲学的, 冷静的, 达观的, 哲学上的, 哲学家似的
realm|/relm/n. 王国, 领土, 领域; 领域
mist|/mist/n. 雾, 迷蒙, 朦胧不清;使模糊, 使蒙上雾;变模糊, 下雾
brigade|/bri'geid/n. 旅, 队; 团体, 队, 组
minus|/'mainәs/n. 负号, 不足;减的, 负的, 阴性的;减, 缺; 负差
inappropriate|/.inә'prәupriәt/a. 不适当的, 不相称的
insufficient|/.insә'fiʃәnt/a. 不够的, 不能胜任的, 不充足的; 不足的, 不充分的, 不能胜任的
conform|/kәn'fɒ:m/vt. 使一致, 使遵守, 使符合;一致, 符合, 适应
ancestor|/'ænsestә/n. 祖先, 祖宗
eligible|/'elidʒәbl/a. 有资格当选的, 合格的;有资格者, 合格者, 适任者
sunlight|/'sʌnlait/n. 日光; 日光, 太阳光
philosopher|/fi'lɒsәfә/n. 哲学家, 哲人, 思想开创人, 达观的人; 哲学家, 哲学研究者
toss|/tɒs/n. 投掷, 抛, 摇摆, 震荡, 掷钱币决定;投掷, 猛抬, 摇荡, 使不安, 掷钱币决定;被到处扔, 摇摆, 颠簸, 辗转, 掷钱币决定某事
mistress|/'mistris/n. 主妇, 女主人, 情妇
noble|/'nәubl/n. 贵族;高贵的, 高尚的, 贵族的, 辉煌的
mathematical|/.mæθә'mætikl/a. 数学的, 精确的; 数学上的
whale|/hweil/n. 鲸;捕鲸;使惨败, 猛揍
gospel|/'gɒspәl/n. 福音, 信仰, 真理
diverse|/dai'vә:s/a. 不同的, 变化多的
monk|/mʌŋk/n. 修道士, 僧侣, 和尚
cylinder|/'silindә/n. 圆筒, 圆筒状物, 汽缸, 柱面; 柱面
archive|/'ɑ:kaiv/vt. 把...存档;档案馆, 档案文件; 挡案库, 存档
garment|/'gɑ:mәnt/n. 衣服, 衣装, 外表
nonetheless|/,nʌnðә'les/conj. 然而, 尽管, 不过;不过, 仍然, 尽管如此, 然而
textile|/'tekstail/n. 纺织品, 纺织业;织的, 纺织的
woodland|/'wudlænd/n. 林区, 林地
feedback|/'fi:dbæk/n. 反馈, 反应; 反馈
cabin|/'kæbin/n. 小屋, 客舱;关在小屋
patent|/'pætnt. 'peitnt/n. 专利权, 许可证, 执照, 专利品, 素质;专利的, 特许的, 显著的, 新奇的;取得...的专利权, 请准专利
laser|/'leizә/n. 激光; 激光器
dragon|/'drægәn/n. 龙, 凶暴的人; 凶恶的人, 凶恶严厉的监护人
lace|/leis/n. 饰带, 花边, 缎带, 鞋带;结带子, 饰以花边;系带子; 全穿孔
lab|/læb/n. 实验室, 研究室; 凝乳酶
inherent|/in'hiәrәnt/a. 固有的, 与生俱来的; 固有的, 生来的
viewer|/'vju:ә/n. 观察者, 看电视者, 视察员, 观察器; 指示器
selective|/si'lektiv/a. 选择的, 选择性的; 选择的, 选择性的
clutch|/klʌtʃ/n. 抓紧, 掌握, 离合器, 一窝小鸡;抓住, 踩汽车离合器踏板;抓; 联轴器;离合器
intermediate|/.intә'mi:diәt/n. 中间物, 调停者, 中级;中间的, 中级的;起媒介作用; 中级
greater|大的
ace|/eis/n. 幺点, 好手, 少许, 发球得分;一流的, 杰出的; 应答允许, 自适应计算机试验, 自动呼叫设备, 自动执行控制
promoter|/prә'mәutә/n. 促进者, 助长者; 助催化剂
characterize|/'kærәktәraiz/vt. 描绘...的特性, 刻划...的性格
probe|/prәub/n. 探索, 调查, 探针, 探测器;用探针探测, 调查, 探索
ozone|/'әuzәun/n. 新鲜的空气, 臭氧, 使人愉快的影响; 臭氧
ft|英尺
calcium|/'kælsiәm/n. 钙; 钙Ca
reactor|/ri'æktә/n. 反应者, 反应器, 反应堆, 电抗器; 反应釜;反应锅
presume|/pri'zu:m/vt. 假定, 推测, 擅自, 意味着;擅自行动, 相信
divert|/dai'vә:t/vt. 转移, 使欢娱;转移
convincing|/kәn'vinsiŋ/a. 使人信服的, 有力的, 令人心悦诚服的
carve|/kɑ:v/v. 雕刻, 切开
parcel|/'pɑ:sl/n. 包裹, 部分, 片;分配, 打包;部分的;局部地
crossing|/'krɒsiŋ/n. 横越, 横渡, 交叉点, 渡口; 划线
gathering|/'gæðәriŋ/n. 聚集, 集中, 采集; 富集
fantastic|/fæn'tæstik/a. 奇妙的, 稀奇的, 空想的
costly|/'kɒstli/a. 昂贵的, 奢华的, 费用大的
sketch|/sketʃ/n. 素描, 草图, 小品;描绘略图, 画素描或速写
respectable|/ri'spektәbl/a. 值得尊重的, 人格高尚的, 相当数量的;品格高尚的人
relieved|/ri'li:vd/a. 宽慰的, 解除的, 减轻的
apology|/ә'pɒlәdʒi/n. 道歉, 辩护; 道歉, 谢罪, 辩解者
sickness|/'siknis/n. 疾病, 不健康, 呕吐; 病
intact|/in'tækt/a. 尚未被人碰过的, 原封不动的, 完整的; 完整的, 无伤的
fond|/fɒnd/a. 喜欢的, 宠爱的, 温柔的
gravity|/'græviti/n. 地心引力, 重力; 重力
corn|/kɒ:n/n. 玉蜀黍, 谷类, 谷粒, 鸡眼;使成颗粒, 腌
anonymous|/ә'nɒnimәs/a. 姓氏不详的, 无名的, 无特色的; 无记录
tolerate|/'tɒlәreit/vt. 宽容, 容许, 有耐力
queue|/kju:/n. 辫子, 一队人, 队列;使排队, 将...梳成辫子;排队; 队列
compel|/kәm'pel/vt. 强迫, 迫使
tragic|/'trædʒik/a. 悲惨的, 悲剧的
redundant|/ri'dʌndәnt/a. 多余的, 过多的, 冗长的; 过多的, 多余的
decisive|/di'saisiv/a. 决定性的, 坚定的, 果断的
parade|/pә'reid/n. 游行, 炫耀, 阅兵;游行, 炫耀, (使)列队行进
recorder|/ri'kɒ:dә/n. 记录员, 录音机;记录器; 宏录制器, 记录器
foolish|/'fu:liʃ/a. 愚蠢的, 傻的
mechanic|/mi'kænik/n. 机械工, 技工;手工的
intake|/'inteik/n. 入口, 吸入, 吸入量; 摄取量
complication|/.kɒmpli'keiʃәn/n. 复杂化, 复杂情况; 并发症, 并发病
unaware|/.ʌnә'wєә/a. 未认识到的, 不知道的; 不知道的, 不察觉的, 无意的
lengthy|/'leŋθi/a. 冗长的, 漫长的
dip|/dip/v. 浸, 降下, 把(手、勺等)伸入, 舀取;浸, 涉猎; 双列直插式组件, 分布式输入输出系统, 双排直插封装
alike|/ә'laik/a. 相似的, 同样的;一样, 以同样的方式
threshold|/'θreʃәuld/n. 门槛, 入口, 开端, 阈; 阈;阈值
mercy|/'mә:si/n. 仁慈, 宽恕, 慈悲, 怜悯, 幸运; 权宜处置权, 决定权, 宽恕
trunk|/trʌŋk/n. 树干, 干线, 躯干, 主干, 象鼻, 箱子;把...放入旅行箱内;树干的, 躯干的, 干线的, 箱形的; 中继线;母线
likelihood|/'laiklihud/n. 可能, 可能性
competent|/'kɒmpitәnt/a. 能干的, 胜任的, 有效的, 足够的; 有权的, 授权的, 胜任的
boast|/bәust/n. 吹牛;吹牛, 自夸;夸口说, 自恃有
accumulate|/ә'kju:mjuleit/v. 积聚, 堆积
rip|/rip/n. 裂痕, 破绽, 拉裂, 浪子, 巨浪;被拉开, 裂开, 猛冲;撕, 扯, 劈
humanity|/hju:'mæniti/n. 人性, 人类, 博爱
genius|/'dʒi:njәs/n. 天才, 天赋, 精神, 神魔; 特征
scan|/skæn/n. 审视, 浏览, 扫描, 细查;细看, 浏览, 扫描, 详细调查, 标出格律;押韵, 扫描; 网络软件目录, 编码与分析系统
crawl|/krɒ:l/n. 爬行, 匍匐而行, 养鱼池;爬行
bull|/bul/n. 公牛; 买方, 买空者
prevail|/pri'veil/vi. 获胜, 流行, 盛行; 流行, 盛行
likewise|/'laikwaiz/adv. 同样地, 也
follower|/'fɒlәuә/n. 从者, 属下, 追补者; 随动机
wit|/wit/n. 机智, 智力, 头脑, 理智, 妙语, 机智的人
spectacle|/'spektәkl/n. 引人羡慕的东西, 景象, 眼镜, 场面, 公开展示
miserable|/'mizәrәbl/a. 悲惨的;痛苦的;卑鄙的
dual|/'dju:әl/a. 双重的, 双的;双数
accusation|/ækju:'zeiʃәn/n. 控告, 指控, 指责; 控告, 起诉, 告发
cleaner|/'kli:nә/n. 清洁工人, 清洁剂, 干洗商; 滤清器;除垢器;洗净剂;清洁剂
penetrate|/'penitreit/vt. 穿透, 刺穿, 渗透, 看穿, 洞察, 了解, 使充溢;刺入, 看穿, 渗透, 打进
spectator|/spek'teitә/n. 观众, 目击者, 旁观者
scrutiny|/'skru:tini/n. 细看, 仔细检查, 监视, 选票检查; 复查, 评核, 仔细检查
outlook|/'autluk/n. 观点, 景色, 前途, 了望; 展望
texture|/'tekstʃә/n. (织物的)密度, (材料等的)结构, 纹理; 纹理
orthodox|/'ɒ:θәdɒks/a. 正统的, 传统的, 惯常的
snatch|/snætʃ/n. 抢夺, 攫取, 片断;夺取, 攫取;想抢走, 攫取
precision|/pri'siʒәn/n. 精密, 精确, 精确度, 精度;精密的, 精确的; 精度
bolt|/bәult/n. 门闩, 螺钉, 筛子, 闪电, 意外事件;闩住, 发射, 脱口而出, 筛, 囫囵吞下;囫囵吞枣, 射箭, 脱缰, 退出党派;突然
exert|/ig'zә:t/vt. 发挥, 运用, 施以影响; 施加, 产生, 行使
patron|/'peitrәn/n. 赞助人, 顾客, 保护人; 保护人, 庇护人, 赞助人
curiosity|/.kjuәri'ɒsiti/n. 好奇心, 新奇的事物, 珍品
outbreak|/'autbreik/n. 爆发, 暴动; 暴发
legacy|/'legәsi/n. 祖先传下来之物, 遗赠物; 遗产, 遗赠物
worm|/wә:m/n. 虫, 蠕虫, 小人物, 螺纹, 蜗杆;蠕行, 慢慢前进;使蠕行, 慢慢地走, 除虫; 蠕虫病毒
propaganda|/.prɒpә'gændә/n. 宣传, 宣传活动; 宣传
conspiracy|/kәn'spirәsi/n. 同谋, 阴谋, 阴谋集团; 阴谋, 通谋, 共谋
rib|/rib/n. 肋骨, 肋状物, 笑话;装肋状物于, 戏弄
cart|/kɑ:t/n. 二轮运货马车;驾运货马车;用车装载
territorial|/.teri'tɒ:riәl/a. 领土的, 土地的, 地方的, 区域性的;本土自卫队队员
costume|/'kɒstju:m/n. 装束, 服装
pine|/pain/n. 松树, 松木;消瘦, 憔悴, 痛苦, 怀念, 渴望; 邮件程序
inland|/'inlәnd/a. 内陆的, 国内的;内地
weep|/wi:p/n. 哭, 哭泣;哭泣, 流泪, 哀悼, 滴落;哭着使..., 悲叹, 滴下
implicit|/im'plisit/a. 暗示的, 含蓄的, 固有的, 绝对的; 不讲明的, 含蓄的
choir|/'kwaiә/n. 唱诗班, 唱诗班的席位;合唱
precedent|/'presidәnt/n. 先例, 前例;在先的, 在前的
viewpoint|/'vju:pɒint/n. 观点
doll|/dɒl/n. 洋娃娃, 无头脑的美丽女人
bride|/braid/n. 新娘
boxing|/'bɒksiŋ/n. 拳击; 围模(牙科)
herb|/hә:b/n. 药草, 香草; 草, 草本, 草药
goat|/gәut/n. 山羊, 替罪羊, 色鬼
adverse|/'ædvә:s/a. 不利的, 敌对的, 相反的, 逆的; 相反的, 敌对的, 逆的
planner|/'plænә/n. 计划者, 设计者, 安排者; 刨床机
valve|/vælv/n. 活瓣, 阀, 活门;装阀, 用阀调节
metaphor|/'metәfә/n. 隐喻
revival|/ri'vaivl/n. 复兴, 复活, 恢复精神, 苏醒; 复苏, 回生, 精神重振
sponsorship|/'spɔnsәʃip/n. 发起, 倡议, 主办, 保证人的地位, 教父的地位, 教母的地位
fury|/'fjuri/n. 愤怒, 狂暴, 狂怒的人; 狂乱, 狂暴, 狂怒
differentiate|/.difә'renʃieit/v. 区别, 区分
sofa|/'sәufә/n. 沙发
compatible|/kәm'pætәbl/a. 能共处的, 可并立的, 适合的; 相容的;兼容的
corpse|/kɒ:ps/n. 尸体; 尸体
toxic|/'tɒksik/a. 有毒的, 中毒的; 中毒的, 毒物的
torch|/tɒ:tʃ/n. 火把, 启发之物; 火炬
knight|/nait/n. 骑士, 爵士;授以爵位
booklet|/'buklit/n. 小册子
aesthetic|/i:s'θetik/a. 美学的, 审美的, 有美感的
binding|/'baindiŋ/n. 装订; 联编;汇集;绑定, 捆绑
maid|/meid/n. 少女, 未婚女子, 女仆
narrative|/'nærәtiv/n. 叙述, 故事;叙述的, 叙事的, 故事体的
corps|/kɒ:/n. 军, 队, 部队, 兵种; 对, 团;体, 物体
solo|/'sәulәu/n. 独奏, 独唱, 单独表演;单独的, 独奏的, 独唱的;放单飞
wee|/wi:/a. 很小的, 微小的;一点点
yell|/jel/vi. 叫喊, 大叫, (齐声)呐喊欢呼;喊叫着说;叫声, 喊声, 呐喊
tariff|/'tærif/n. 关税, 关税表, 价格表, 收费表;课以关税; 价目表
census|/'sensәs/n. 户口普查;实施统计调查
stride|/straid/n. 大步, 步幅, 步态, 进步;迈大步走, 跨过, 跨
sovereignty|/'sɒvrәnti/n. 主权, 独立国; 主权, 主权国家, 统治权
gasp|/gæsp/n. 喘气;喘气, 喘息, 渴望;气喘吁吁地说`,

cn2en: `一一|one by one; one after another
一下|(after a verb) a bit; a little (indicating brief duration, or softening the tone, or suggesting giving sth a try);all at once; sud…
一世|generation;period of 30 years;one's whole lifetime;lifelong
一二|one or two; a few;a little; just a bit
一些|some; a few; a little; (following an adjective) slightly ...er
一代|an era; an age; a generation
一作|first author (of an academic paper) (abbr. for 第一作者[di4 yi1 zuo4 zhe3])
一来|firstly, ...
一切|everything;every;all
一口|readily;flatly (deny, admit and so on);a mouthful;a bite
一同|together
一向|a period of time in the recent past;(indicating a period of time up to the present) all along; the whole time
一品|superb;first-rate;(of officials in imperial times) the highest rank
一员|a member (of an organization)
一字|in a row; in a line
一定|surely; certainly; definitely;fixed; settled;a certain ...; a given ...
一家|the whole family;the same family;the family ... (when preceded by a family name);group
一对|couple; pair
一带|region; area
一度|for a time;at one time;one time;once
一心|wholeheartedly;heart and soul
一意|focus;with complete devotion;stubbornly
一战|World War I (1914–1918)
一手|a skill;mastery of a trade;by oneself;without outside help
一打|dozen
一方|a party (in a contract or legal case);one side;area;region
一族|social group;subculture;family;clan
一时|a period of time;a while;for a short while;temporary
一会|a moment;a while;in a moment;also pr. [yi1 hui3]
一月|January;first month (of the lunar year)
一样|same;like;equal to;the same as
一气|at one go;at a stretch;for a period of time;forming a gang
一流|top quality;front ranking
一生|all one's life; throughout one's life
一发|(Japanese mahjong) to complete one's hand within a single turn after declaring riichi (orthographic borrowing from Japanese 一発 "ip…
一直|straight (in a straight line);continuously; always; all the way through
一眼|a glance;a quick look;a glimpse
一瞬|one instant;very short time;the twinkle of an eye
一空|leaving none left;(sold etc) out
一经|as soon as;once (an action has been completed)
一线|front line
一声|first tone in Mandarin (high, level tone)
一致|consistent; unanimous; in agreement;together; in unison
一号|first day of the month;toilet;(slang) top (in a homosexual relationship)
一血|(gaming) first blood
一行|party;delegation
一起|(in) the same place;together; in company (with);altogether; in total;an instance of; a case of (murder, accident, dispute etc)
一路|the whole journey;all the way;going the same way;going in the same direction
一身|whole body;from head to toe;single person;a suit of clothes
一连|in a row;in succession;running
一道|together
一边|one side;either side;on the one hand;on the other hand
一面|one side;one aspect;simultaneously... (and...);one's whole face
一头|one head;a head full of sth;one end (of a stick);one side
一体|an integral whole;all concerned;everybody
一点|a bit; a little bit;(used in negative expressions) (not) the least bit;(after an adjective, used to form the comparative) a bit mo…
丈夫|husband
三不|the three no's (abbreviated catchphrase)
三世|the Third (of numbered kings)
三亚|see 三亞市，三亚市[San1 ya4 Shi4]
三代|three generations of a family;the three earliest dynasties (Xia, Shang and Zhou)
三光|the sun, the moon, and the stars
三分|somewhat;to some degree
三包|"three-guarantee service": repair, exchange, refund
三北|China's three northern regions, 東北，东北[Dong1 bei3], 華北，华北[Hua2 bei3] and 西北[Xi1 bei3]
三原|see 三原縣，三原县[San1 yuan2 Xian4]
三反|"Three Anti" campaign (anti-corruption, anti-waste, anti-bureaucracy), early PRC purge of 1951–52
三台|see 三台縣，三台县[San1 tai2 Xian4]
三国|Three Kingdoms period (220–280) in Chinese history;any of several Three Kingdoms periods in Korean history, esp. from 1st century …
三小|(Tw) (vulgar) what the hell? (from Taiwanese 啥潲, Tai-lo pr. [siánn-siâ], equivalent to Mandarin 什麼，什么[shen2 me5])
三度|third (musical interval)
三教|the Three Doctrines (Daoism, Confucianism, Buddhism)
三族|(old) three generations (father, self and sons);three clans (your own, your mother's, your wife's)
三明|see 三明市[San1 ming2 Shi4]
三星|Samsung (South Korean electronics company)
三月|March;third month (of the lunar year)
三板|sampan
三民|see 三民區，三民区[San1 min2 Qu1]
三水|see 三水區，三水区[San1 shui3 Qu1]
三江|see 三江侗族自治縣，三江侗族自治县[San1 jiang1 Dong4 zu2 Zi4 zhi4 xian4]
三沙|see 三沙市[San1 sha1 Shi4]
三河|see 三河市[San1 he2 Shi4]
三流|third-rate;inferior
三无|lacking three key attributes (or at least one of them)
三自|for 三自愛國教會，三自爱国教会[San1 zi4 Ai4 guo2 Jiao4 hui4], Three-Self Patriotic Movement
三角|triangle;(math.) trigonometry (abbr. for 三角學，三角学[san1 jiao3 xue2])
三军|(in former times) upper, middle and lower army;army of right, center and left;(in modern times) the three armed services: Army, Na…
三通|T-joint;T-piece;T-pipe;three links
三重|Sanchong, a district of New Taipei City 新北市[Xin1 bei3 Shi4], Taiwan;Mie (prefecture in Japan)
三门|see 三門縣，三门县[San1 men2 Xian4]
三音|third (musical interval, e.g. do-mi)
三体|trisomy
上下|the top and bottom of sth;the full vertical extent of sth; from top to bottom;to go up and down;before and after (as in 上下文[shang4…
上交|to hand over to;to give to higher authority;to seek connections in high places
上代|previous generation
上来|to come up;to approach;(verb complement indicating success)
上传|to upload
上分|(coll.) (gaming) to progress to the next level;to level up
上前|to advance; to step forward
上午|morning
上口|to be able to read aloud fluently;to be suitable (easy enough) for reading aloud
上古|the distant past;ancient times;antiquity;early historical times
上台|to rise to power (in politics);to go on stage (in the theater)
上合|SCO (Shanghai Cooperation Organization) (abbr. for 上海合作組織，上海合作组织[Shang4 hai3 He2 zuo4 Zu3 zhi1])
上品|top-quality
上回|last time; the previous time
上城|see 上城區，上城区[Shang4 cheng2 Qu1]
上报|to report to one's superiors;to appear in the news;to reply to a letter
上场|on stage;to go on stage;to take the field
上外|for 上海外國語大學，上海外国语大学[Shang4 hai3 Wai4 guo2 yu3 Da4 xue2]
上天|Heaven; Providence; God;the sky above;to fly skywards;(euphemism) to die; to pass away
上好|first-rate;top-notch
上学|to go to school;to attend school
上家|preceding player (in a game)
上山|to climb a hill;to go to the mountains;(of silkworms) to go up bundles of straw (to spin cocoons);to pass away
上工|to go to work;to start work
上市|to hit the market (of a new product);to float (a company on the stock market)
上年|last year
上座|seat of honor (at a banquet, meeting etc);(Buddhism) senior monk's seat or title
上心|carefully;meticulously;to set one's heart on sth
上房|see 正房[zheng4 fang2]
上手|to obtain;to master;overhand (serve etc);seat of honor
上文|the text above; the preceding text
上新|to introduce new items; to roll out new offerings or content
上方|place above (it);upper part (of it)
上星|to broadcast via satellite; satellite (channel etc);shangxing acupoint (DU23)
上书|to write a letter (to the authorities);to present a petition
上月|last month
上期|previous period (week, month or quarter etc)
上林|see 上林縣，上林县[Shang4 lin2 Xian4]
上次|last time
上水|Sheung Shui (area in Hong Kong)
上流|upper class
上海|Shanghai municipality (short name 滬，沪[Hu4])
上火|to get angry;to suffer from excessive internal heat (TCM)
上片|(of a movie) to start screening (Tw)
上班|to go to work;to be on duty;to start work;to go to the office
上皮|(anatomy) epithelium; epithelial tissue
上相|photogenic;(old) high official
上空|the skies above a certain place; (aviation) airspace;(Tw) topless
上网|to go online;to connect to the Internet;(of a document etc) to be uploaded to the Internet;(tennis, volleyball etc) to move in clo…
上线|to go online; to put sth online;to reach a specific standard;to put into production;handler (person who oversees and directs the a…
上声|falling and rising tone;third tone in modern Mandarin
上色|top-quality;top-grade
上菜|to serve food
上行|(of trains) up (i.e. towards the capital);(of river boats) to go against the current;to submit (a document) to higher authorities
上装|upper garment
上课|to go to class;to attend class;to go to teach a class
上调|to raise (prices);to adjust upwards
上路|to start on a journey;to be on one's way
上身|upper part of the body;to put on (clothes on the upper body);(of a spirit, disease, misfortune etc) to afflict one; to possess one
上车|to get on or into (a bus, train, car etc)
上达|to reach the higher authorities
上边|the top;above;overhead;upwards
上门|to drop in;to visit;to lock a door;(of a shop) to close
上面|on top of;above-mentioned;also pr. [shang4 mian5]
上头|(of alcohol, love etc) to go to one's head; (of an idea, a song etc) to get into one's head; to capture one's attention;(old) (of …
上风|on the up;currently winning;rising (in popularity etc)
上香|to offer incense (at a temple etc)
上马|to get on a horse;to mount
上高|see 上高縣，上高县[Shang4 gao1 Xian4]
上龙|pliosaurus
下世|to die;future incarnation;next life;to be born
下人|(old) servant;(dialect) children; grandchildren
下作|contemptible;disgusting
下来|to come down;(completed action marker);(after verb of motion, indicates motion down and towards us, also fig.);(indicates continua…
下午|afternoon;p.m.
下去|to go down;to descend;to go on;to continue
下同|similarly hereinafter
下单|to place an order; to order
下回|next chapter;next time
下地|to go down to the fields;to get up from bed;to leave one's sickbed;to be born
下场|to leave (the stage, an exam room, the playing field etc);to take part in some activity;to take an examination (in the imperial ex…
下士|lowest-ranked noncommissioned officer (e.g. corporal in the army or petty officer, third class in the navy)
下家|player whose turn comes next (in a game);next one;my humble home
下山|to go down a hill;(of the sun or moon) to set
下工|to knock off (at the end of a day's work);to finish work
下巴|chin
下情|feelings of the masses;my situation (humble speech)
下手|to start;to put one's hand to;to set about;the seat to the right of the main guest
下文|the text below; the following text;(fig.) what happened next; later developments
下方|underneath;below;the underside;world of mortals
下月|next month
下期|next period (week, month or quarter etc)
下次|next time
下水|downstream;to go into the water;to put into water;to launch (a ship)
下流|lower course of a river;low-class;mean and lowly;vulgar
下海|to go out to sea;to enter the sea (to swim etc);(fig.) to take the plunge (e.g. leave a secure job, or enter prostitution etc)
下片|to stop screening a movie;to end the run of a movie
下班|to finish work; to get off work;next service (train, bus etc)
下发|to issue (a memorandum etc) to lower levels;to distribute (e.g. disaster relief to victims)
下网|to cast a fishing net;(computing) to go offline
下线|to go offline;(of a product) to roll off the assembly line;downline (person below oneself in a pyramid scheme)
下脚|to get a footing
下台|to go off the stage;to fall from position of prestige;to step down (from office etc);to disentangle oneself
下行|(of trains) down (i.e. away from the capital);(of river boats) to travel downstream;to issue (a document) to lower bureaucratic le…
下装|to take off costume and makeup;bottom garment (trousers etc)
下课|to finish class;to get out of class;(fig.) (esp. of a sports coach) to be dismissed;to be fired
下调|to demote;to pass down to a lower unit
下身|lower part of the body;genitalia;trousers
下车|to get off or out of (a bus, train, car etc)
下达|to transmit to lower levels; to issue (a command, decree etc)
下边|under;the underside;below
下酒|to be appropriate to have with alcohol;to down one's drink
下关|Shimonoseki (city in Japan)
下面|below;under;next;the following
下头|(slang) (of a person or manner) off-putting;(slang) to feel put off
下风|leeward;downwind;disadvantageous position;to concede or give way in an argument
下马|to dismount from a horse;(fig.) to abandon (a project)
下体|the lower part of the body (usu. a euphemism for the genitals)
不一|to vary;to differ
不下|to be not less than (a certain quantity, amount etc)
不二|the only (choice, way etc);undivided (loyalty)
不亚|no less than;not inferior to
不光|not the only one;not only
不克|cannot;to not be able (to);to be unable to
不儿|(coll.) no (contracted form of 不是[bu4 shi4])
不公|unjust;unfair
不分|not to distinguish; to make no distinction;(LGBT slang) versatile (open to either penetrative or receptive role)
不利|unfavorable;disadvantageous;harmful;detrimental
不力|not to do one's best;not to exert oneself
不加|without;not;un-
不动|motionless
不可|cannot; should not; must not
不合|to not conform to;to be unsuited to;to be out of keeping with;should not
不同|different;distinct;not the same;not alike
不和|not to get along well;to be on bad terms;to be at odds;discord
不单|not the only;not merely;not simply
不图|not to seek (sth);to have no expectation of (sth);(literary) unexpectedly
不外|not beyond the scope of;nothing more than
不大|not very (clear, far away etc); not too;not often; infrequently
不好|no good
不安|unpeaceful;unstable;uneasy;disturbed
不定|indefinite;indeterminate;(botany) adventitious
不实|untrue; false; unfounded;(literary) (of a plant) to not bear fruit
不对|incorrect;wrong;amiss;abnormal
不少|many; quite a few; a good number of
不带|not to have;without;un-
不平|uneven;injustice;unfairness;wrong
不得|must not;may not;not to be allowed;cannot
不意|unexpectedly;unawareness;unpreparedness
不成|won't do;unable to;(at the end of a rhetorical question) can that be?
不日|within the next few days;in a few days time
不明|not clear;unknown;to fail to understand
不时|from time to time;now and then;occasionally;frequently
不会|improbable;unlikely;will not (act, happen etc);not able
不月|amenorrhoea;irregular menstruation
不期|unexpectedly;to one's surprise
不比|unlike
不毛|barren
不法|lawless;illegal;unlawful
不清|unclear
不无|not without
不然|not so;no;or else;otherwise
不特|not only
不理|to refuse to acknowledge;to pay no attention to;to take no notice of;to ignore
不用|need not
不管|not to be concerned;regardless of;no matter
不羁|unruly;uninhibited
不行|won't do;be out of the question;be no good;not work
不解|to not understand;to be puzzled by;indissoluble
不语|(literary) not to speak
不变|constant;unvarying;(math.) invariant
不通|to be obstructed;to be blocked up;to be impassable;to make no sense
不过|only;merely;no more than;but
世上|on earth
世世|from age to age
世事|affairs of life;things of the world
世交|(long time) friend of the family
世人|people (in general); people around the world; everyone
世代|for many generations;generation;era;age
世子|crown prince; heir of a noble house
世家|family influential for generations;aristocratic family
世情|worldly affairs;the ways of the world
世故|the ways of the world
世界|world
世相|the ways of the world
世行|World Bank (abbr. for 世界銀行，世界银行[Shi4 jie4 Yin2 hang2])
世运|World Games (abbr. for 世界運動會，世界运动会[Shi4 jie4 Yun4 dong4 hui4]);(old) (Tw, HK) Olympic Games
世道|the ways of the world;the morals of the time
世面|the wider world;diverse aspects of society
世风|public morals
中中|middling;average;impartial;(Hong Kong) secondary school that uses Chinese as the medium of instruction ("CMI school")
中亚|Central Asia
中人|go-between;mediator;intermediary
中保|middleman and guarantor
中分|to part one's hair in the middle
中区|central district (of a city);central zone
中午|noon;midday
中南|South Central China (Henan, Hubei, Hunan, Guangdong, Guangxi, Hainan);abbr. for China-South Africa
中原|Central Plain, the middle and lower regions of the Yellow river, including Henan, western Shandong, southern Shanxi and Hebei
中古|Sino-Cuban;China-Cuba
中和|Zhonghe or Chungho city in New Taipei City 新北市[Xin1 bei3 shi4], Taiwan
中国|China
中土|China-Turkey; Sino-Turkish
中场|(historical) middle period of a tripartite provincial exam;half-time; intermission;(sports) midfield; midcourt;(sports) midfielder
中外|Sino-foreign;Chinese-foreign;home and abroad
中天|(literary) midheaven; highest point in the sky;(astronomy) culmination; transit across the meridian
中女|middle-aged woman; (media term) middle-aged women regarded as a distinct social cohort
中子|neutron
中学|middle school
中宁|see 中寧縣，中宁县[Zhong1 ning2 Xian4]
中山|see 中山市[Zhong1 shan1 Shi4];see 中山區，中山区[Zhong1 shan1 Qu1];Nakayama (Japanese surname);see 孫中山，孙中山[Sun1 Zhong1 shan1]
中巴|China-Pakistan (relations);China-Bahamas
中年|middle age
中式|Chinese style
中心|center; heart; core
中性|neutral
中意|Sino-Italian
中文|Chinese language
中方|the Chinese side (in an international venture)
中日|China-Japan
中时|China Times (newspaper published in Taiwan) (abbr. for 中國時報，中国时报[Zhong1 guo2 Shi2 bao4])
中期|middle (of a period of time);medium-term (plan, forecast etc)
中东|Middle East
中板|moderato
中正|adopted name of Chiang Kai-shek 蔣介石，蒋介石[Jiang3 Jie4 shi2]
中水|reclaimed water;recycled water
中江|see 中江縣，中江县[Zhong1 jiang1 Xian4]
中油|CPC Corporation, a state-owned petroleum company in Taiwan (abbr. for 台灣中油，台湾中油[Tai2 wan1 Zhong1 you2])
中法|China-France; Sino-French
中波|Chinese-Polish
中流|midstream
中用|useful;helpful;Taiwan pr. [zhong4 yong4]
中盘|middle game (in go or chess);(share trading) mid-session;(abbr. for 中盤商，中盘商[zhong1 pan2 shang1]) distributor;wholesaler
中空|hollow;empty interior
中线|half-way line;median line
中美|China-US
中声|the medial (vowel or diphthong) of a Korean syllable
中台|China and Taiwan
中华|Zhonghua, historical and cultural term for China, often used to denote Chinese civilization and identity (as in 中華文化，中华文化[Zhong1 h…
中号|medium-sized
中行|for 中國銀行，中国银行[Zhong1 guo2 Yin2 hang2]
中装|Chinese dress
中西|China and the West;Chinese-Western
中调|(perfumery) middle note;heart note
中路|midway;mediocre (quality);midfield (soccer)
中转|to change (train or plane);transfer;correspondence
中间|the middle; the inside;in the middle; within; between; among;during; in the meantime
中阳|see 中陽縣，中阳县[Zhong1 yang2 Xian4]
中青|China Youth (official newspaper) (abbr. for 中國青年報，中国青年报[Zhong1 guo2 Qing1 nian2 Bao4])
中风|to suffer a paralyzing stroke
中点|midpoint;half-way point
主人|owner;host;master
主公|Your Highness;Your Majesty
主力|main force;main strength of an army
主动|to take the initiative;to do sth of one's own accord;spontaneous;active
主场|(sports) home ground; home field;(sports) home game;main venue (for a festival etc)
主子|Master (term used by servant);Your Majesty;operator (of machine)
主干|trunk;main;core
主意|plan;idea;decision;Beijing pr. [zhu2 yi5]
主打|principal; main; flagship (product); title (track);to specialize in; to take as one's priority; to primarily focus on
主教|bishop
主族|main group
主日|Sabbath;Sunday
主板|(computing) motherboard;(stock market) main board
主格|nominative case (grammar)
主业|main business
主机|main engine;(military) lead aircraft;(computing) host computer;main processor
主流|main stream (of a river);fig. the essential point;main viewpoint of a matter;mainstream (culture etc)
主球|cue ball (in pool etc)
主科|required courses in the major subject
主管|in charge;responsible for;person in charge;manager
主线|main line (of communication);main thread (of a plotline or concept);central theme
主菜|main course
主角|leading role; lead;protagonist
主词|subject
主语|subject (in grammar)
主调|main point of an argument;a principal viewpoint
主音|keynote;principal tone;tonic;vowel
主体|main part;bulk;body;subject
之前|before;prior to;ago;previously
之后|after; behind;(at the beginning of a sentence) afterwards; since then
也许|perhaps; maybe
干儿|adopted son (traditional adoption, i.e. without legal ramifications)
干果|dried fruit;dry fruits (nuts etc)
干净|clean;neat
干草|hay
干菜|dried vegetable
干号|to cry out loud without tears
干面|noodles mixed with a sauce and served with toppings (not in a soup);(dialect) flour
了然|to understand clearly; evident
了解|to understand; to know about;to learn about; to find out
事主|victim (of a criminal);party involved (in a dispute etc);main instigator
事事|everything
事儿|one's employment;business;matter that needs to be settled;(northern dialect) (of a person) demanding
事前|in advance; before the event
事实|fact
事工|(Christianity) ministry (work of a spiritual or charitable nature)
事后|after the event;in hindsight;in retrospect
事情|affair; matter; thing; business
事业|undertaking;project;activity;(charitable, political or revolutionary) cause
事机|confidential aspects of a matter;secrets;key moment for action
事物|thing; object
事理|reason;logic
事变|incident;unforeseen event;events (in general)
事关|to concern;on (some topic);about;concerning
事体|things;affairs;decorum
二世|the Second (of numbered kings);second generation (e.g. Chinese Americans)
二代|second generation
二来|secondly, ...
二分|second part;the equinox
二度|again; twice;(music) second (i.e. an interval between adjacent notes)
二心|disloyalty;half-heartedness;duplicity
二战|World War II
二房|second branch of an extended family;concubine
二手|indirectly acquired;second-hand (information, equipment etc);assistant
二月|February;second month (of the lunar year)
二流|second-rate;second-tier
二老|mother and father;parents
二者|both;both of them;neither
二声|second tone
二话|objection;differing opinion
二连|see 二連浩特市，二连浩特市[Er4 lian2 hao4 te4 Shi4]
二道|see 二道區，二道区[Er4 dao4 Qu1]
二重|double;repeated twice
二黄|one of the two chief types of music in Chinese opera;Peking opera;also written 二簧[er4 huang2];see also 西皮[xi1 pi2]
互相|each other;mutually;mutual
亚东|see 亞東縣，亚东县[Ya4 dong1 Xian4]
亚科|subfamily (taxonomy)
亚兰|Ram (son of Hezron)
亚军|second place (in a sports contest);runner-up
亚运|Asian Games
亚金|Achim (son of Zadok in Matthew 1:14)
亚门|(biology) subphylum (in zoological taxonomy); subdivision (in the taxonomy of plants or fungi)
交代|to transfer (duties to sb else);to give instructions; to tell (sb to do sth);to explain; to give an account; to brief;to confess; …
交保|to post bail;bail
交出|to hand over
交加|(of two or more things) to occur at the same time; to be mingled; to accompany each other
交口|see 交口縣，交口县[Jiao1 kou3 Xian4]
交合|to join; to meet;to copulate; sexual intercourse
交城|see 交城縣，交城县[Jiao1 cheng2 Xian4]
交大|Jiaotong University;University of Communications;abbr. of 交通大學，交通大学[Jiao1 tong1 Da4 xue2]
交好|to be on friendly terms
交安|road traffic safety (abbr. for 交通安全)
交心|to open one's heart; to have a heart-to-heart conversation
交情|friendship;friendly relations
交战|to fight;to wage war
交手|to fight hand to hand
交会|to encounter;to rendezvous;to converge;to meet (a payment)
交流|to exchange;exchange;communication;interaction
交火|to exchange fire; to engage in a firefight;(fig.) to clash verbally; to exchange sharp criticism
交管|traffic control
交角|(math.) angle of intersection
交变|half-period of a wave motion;alternation
交通|to be connected;traffic;transportation;communications
交运|to meet with luck;to hand over for transportation;to check (one's baggage at an airport etc)
交骨|pubic bone
交点|meeting point;point of intersection
京城|capital of a country
人世|the world;this world;the world of the living
人中|philtrum;infranasal depression;the "human center" acupuncture point
人事|personnel;human resources;human affairs;ways of the world
人人|everyone;every person
人保|personal guarantee;to sign as guarantor
人们|people
人儿|figurine
人力|manpower;labor power
人口|population;people
人名|personal name
人品|character; moral strength; integrity;(coll.) looks; appearance; bearing
人员|staff;crew;personnel
人士|person;figure;public figure
人大|Renmin University of China (abbr. for 中國人民大學，中国人民大学[Zhong1 guo2 Ren2 min2 Da4 xue2])
人子|son of man
人定|middle of the night;the dead of night
人家|household;dwelling;family;sb else's house
人工|artificial;manpower;manual work
人形|human form;human-shaped; humanoid
人心|popular feeling;the will of the people
人性|human nature;humanity;human;the totality of human attributes
人情|human emotions;social relationship; friendship;favor; a good turn
人意|people's expectations
人手|manpower;staff;human hand
人数|number of people
人文|humanities; culture; humanistic
人族|Hominini
人格|personality;integrity;dignity
人武|armed forces
人民|the people
人气|popularity;presence of people; liveliness
人流|stream of people;abortion;abbr. for 人工流產，人工流产[ren2 gong1 liu2 chan3]
人海|a multitude;a sea of people
人物|person; personage; figure (esp. sb of importance);character (in a play, novel etc);(genre of traditional Chinese painting) figure …
人球|person who is passed back and forth, with nobody willing to look after them (e.g. a child of divorced parents);(esp.) patient who …
人生|life (one's time on earth)
人相|physiognomy
人肉|to crowdsource information about sb or sth (typically as a form of vigilantism resulting in doxing) (abbr. for 人肉搜索[ren2 rou4 sou1…
人行|People's Bank of China (abbr. for 中國人民銀行，中国人民银行[Zhong1 guo2 Ren2 min2 Yin2 hang2])
人身|person;personal;human body
人道|human sympathy;humanitarianism;humane;the "human way", one of the stages in the cycle of reincarnation (Buddhism)
人头|person;number of people;(per) capita;(a person's) head
人马|men and horses;troops;group of people;troop
人体|human body
人鱼|mermaid;dugong;sea cow;manatee
人龙|a queue of people
今天|today;the present time; now
仔细|careful; attentive; cautious;to be careful; to look out;(dialect) thrifty; frugal
他们|they; them
付款|to pay a sum of money;payment
仙人|Daoist immortal;celestial being
代代|from generation to generation;generation after generation
代入|to substitute into
代字|abbreviated name of an entity (e.g. 皖政, a short name for 安徽省人民政府);code name;(old) pronoun
代工|OEM (original equipment manufacturer)
代数|algebra
代书|to write on sb's behalf;a scrivener (who writes legal documents or letters for others)
代理|to act on behalf of sb in a responsible position;to act as an agent or proxy;surrogate;(computing) proxy
代管|to administer;to manage;to hold in trust or escrow
代县|Dai County or Daixian, a county in Xinzhou City 忻州市[Xin1 zhou1 Shi4], Shanxi
代号|code name
代行|to act as a substitute; to act on sb's behalf
代表|representative;delegate;to represent;to stand for
代词|pronoun
以前|before;formerly;previous;ago
以后|after;later;afterwards;following
以为|to think; to believe (often with the implication that the belief is mistaken – unless referring to one's own current belief)
任何|any; whatever; whichever
分子|variant of 分子[fen4 zi3]
休息|rest;to rest
伸手|to reach out with one's hand;to hold out a hand;(fig.) to beg;to get involved
但是|but; however
伫立|to stand for a long time
布道|sermon;to sermonize;to preach;to evangelize
低头|to bow the head;to yield;to give in
作下|to do;to make (usually bad connotation)
作主|to decide; to have the final say
作人|to conduct oneself;same as 做人
作保|to act as surety for sb;to be sb's guarantor;to stand bail for sb
作出|to put out;to come up with;to make (a choice, decision, proposal, response, comment etc);to issue (a permit, statement, explanatio…
作古|to die;to pass away
作合|to make a match;to get married
作品|work (of art);opus
作客|to live somewhere as a visitor; to stay with sb as a guest; to sojourn
作家|author
作对|to set oneself against;to oppose;to make a pair
作战|combat;to fight
作手|writer;expert
作数|valid;counting (as valid)
作文|to write an essay;composition (student essay)
作东|to host (a dinner);to treat;to pick up the check
作业|school assignment;homework;work;task
作乐|to make merry
作死|to court disaster;also pr. [zuo1si3]
作法|course of action;method of doing sth;practice;modus operandi
作物|crop
作用|to act on; to affect;action; function; activity;impact; result; effect;purpose; intent
作者|author; writer
作色|to show signs of anger;to flush with annoyance
作风|style;style of work;way
作马|sawhorse
你们|you (plural)
来世|afterlife;next life
来事|(coll.) (esp. after 會，会[hui4]) to be socially adept; to know how to handle people
来信|incoming letter;to send us a letter
来到|to arrive; to come
来台|to come to Taiwan
来回|to make a round trip;return journey;back and forth;to and fro
来安|see 來安縣，来安县[Lai2 an1 Xian4]
来客|guest
来年|next year;the coming year
来得|to emerge (from a comparison);to come out as;to be competent or equal to
来意|one's purpose in coming
来文|received document;sent document
来日|future days;(literary) the next day;(old) past days
来火|to get angry
来生|next life
来神|to become spirited
来自|to come from (a place);From: (in email header)
来华|to come to China
来路|incoming road;origin;past history
来电|incoming telephone call (or telegram);to phone in; to send in a telegram;to have an instant attraction to sb;(of electricity, afte…
来头|cause;reason;interest;influence
例如|for example; for instance; such as
依然|still; as before
依稀|vaguely;dimly;probably;very likely
依旧|as before; still;to remain the same
便宜|convenient
俄而|(literary) very soon;before long
俄顷|in a moment;presently
保人|guarantor; person paying bail
保全|to save from damage;to preserve;to maintain;to keep in good repair
保单|guarantee slip
保安|Bonan ethnic group
保定|see 保定市[Bao3 ding4 Shi4]
保山|see 保山市[Bao3 shan1 Shi4]
保德|see 保德縣，保德县[Bao3 de2 Xian4]
保持|to keep;to maintain;to hold;to preserve
保有|to keep;to retain
保本|to break even
保尔|Paul (name)
保管|to hold in safekeeping; to have in one's care;to guarantee;certainly; surely;custodian; curator
保罗|Paul
保角|(math.) angle-preserving;conformal
保语|Bulgarian language
保护|to protect;to defend;to safeguard;protection
保重|to take care of oneself
保长|(math.) distance-preserving;isometric
侠气|chivalry
信任|to trust;to have confidence in
信口|to blurt sth out;to open one's mouth without thinking
信报|for 信報財經新聞，信报财经新闻, Hong Kong Economic Journal
信子|variant of 芯子[xin4 zi5]
信实|trustworthy;reliable;to believe something to be true
信州|see 信州區，信州区[Xin4 zhou1 Qu1]
信心|confidence;faith (in sb or sth)
信念|faith;belief;conviction
信意|at will;arbitrarily;just as one feels like
信手|casually;in passing
信教|religious belief;to practice a faith;to be religious
信然|indeed;really
信物|keepsake; token
信用|trustworthiness;(commerce) credit;(literary) to trust and appoint
信管|a fuse (for explosive charge);detonator
信经|Credo (section of Catholic mass)
信号|signal
信道|(telecommunications) channel;(in Confucian texts) to believe in the principles of wisdom and follow them
信阳|see 信陽市，信阳市[Xin4 yang2 Shi4]
信风|trade wind
修炼|(of Taoists) to practice austerities;to practice asceticism
修行|to devote oneself to spiritual development (esp. Buddhism or Daoism);to devote oneself to perfecting one's art or craft
倏忽|(literary) suddenly
倏然|(literary) suddenly
倔强|stubborn; obstinate; unbending
假如|if
伟岸|imposing;upright and tall;outstanding;gigantic in stature
停止|to stop; to halt; to cease
健康|health;healthy
偶尔|occasionally;once in a while;sometimes
傲气|air of arrogance;haughtiness
傲骨|lofty and unyielding character
传世|handed down from ancient times;family heirloom
传人|to teach;to impart;a disciple;descendant
传代|to pass to the next generation
传来|(of a sound) to come through;to be heard;(of news) to arrive
传入|to import;transmitted inwards;afferent
传出|to transmit outwards;to disseminate;efferent (nerve)
传动|drive (transmission in an engine)
传名|to spread one's reputation
传单|leaflet; flier; pamphlet
传回|to send back
传报|notification;memorial
传家|to pass on through the generations
传布|to spread; to propagate; to disseminate
传情|to pass on amorous feelings;to send one's love to sb
传教|to proselytize; to do missionary work
传本|edition (of a book) currently in circulation
传法|to pass on doctrines from master to disciple (Buddhism)
传流|to spread;to hand down;to circulate
传热|to transmit heat
传球|(sports) to pass the ball
传发|to order sb to start on a journey
传神|vivid;lifelike
传统|tradition; traditional
传经|to pass on scripture;to teach Confucian doctrine;to pass on one's experience
传声|to transmit sound
传话|to pass on a story;to communicate a message
传语|to pass on (information)
传道|to lecture on doctrine;to expound the wisdom of ancient sages;to preach;a sermon
传达|to pass on;to convey;to relay;to transmit
传开|(of news) to spread;to get around
伤心|to grieve;to be broken-hearted;to feel deeply hurt
倾慕|to adore;to admire greatly
仆人|servant
价格|price
儒雅|scholarly;refined;cultured;courteous
优点|merit;benefit;strong point;advantage
允许|to permit; to allow
元帅|(military) marshal; commander-in-chief
兄弟|brothers;younger brother;I, me (humble term used by men in public speech);brotherly
光光|bright;shiny;smooth;naked
光合|(bound form) photosynthetic
光大|splendid;magnificent;abbr. for 中國光大銀行，中国光大银行[Zhong1 guo2 Guang1 da4 Yin2 hang2], China Everbright Bank
光子|photon (particle physics)
光学|optics
光山|see 光山縣，光山县[Guang1 shan1 Xian4]
光年|light-year
光度|luminosity
光明|light;radiance;(fig.) bright (prospects etc);openhearted
光气|phosgene COCl2, aka carbonyl chloride, a poisonous gas
光波|light wave
光盘|compact disc (CD); DVD; CD-ROM
光线|light ray;light;illumination;lighting (for a photograph)
光脚|bare feet
光华|brilliance;splendor;magnificence
光量|quantity of light;luminosity
光电|photoelectric
光头|shaven head;bald head;to go bareheaded;hatless
光面|plain noodles in broth
克制|to restrain;to control;restraint;self-control
克国|(Tw) abbr. for 克羅埃西亞，克罗埃西亚[Ke4 luo2 ai1 xi1 ya4] Croatia
克山|see 克山縣，克山县[Ke4 shan1 Xian4]
克拉|carat (mass) (loanword)
克文|Kevin (name)
克日|to set a date;to set a time frame;within a certain time limit
克期|to set a date;to set a time frame;within a certain time limit
克东|see 克東縣，克东县[Ke4 dong1 Xian4]
克西|xi (Greek letter Ξ, ξ)
儿化|(Chinese phonetics) to rhotacize a syllable final; to apply r-coloring to the final of a syllable
儿女|children; sons and daughters;a young man and a young woman (in love)
儿子|son
儿时|childhood
儿科|pediatrics
儿马|(coll.) male horse; stallion
兔子|hare;rabbit
入世|to engage with secular society;to involve oneself in human affairs;to join the WTO (abbr. for 加入世界貿易組織，加入世界贸易组织[jia1 ru4 Shi4 jie4…
入主|to invade and take control of (a territory); to take the helm at (an organization); (of a company) to take control of (another com…
入口|entrance;to import
入土|to bury;buried;interred
入场|to enter the venue for a meeting;to enter into an examination;to enter a stadium, arena etc
入学|to enter a school or college;to go to school for the first time as a child
入定|(Buddhism) to enter a meditative state
入座|to take one's seat
入手|to begin (with ...) (typically used in a structure such as 從，从[cong2] + {noun} + 入手[ru4 shou3]: "to begin with {noun}; to take {no…
入教|to join a religion
入时|fashionable
入会|to join a society, association etc
入月|(of women) beginning of menstrual cycle;full-term gestation
入球|to score a goal;goal
入眼|to appear before one's eyes;pleasing to the eye; nice to look at
入神|to be engrossed; to be absorbed;(of artistic skill etc) masterful; superb
入声|entering tone;checked tone;one of the four tones of Middle Chinese
入肉|to have intercourse;to fuck
入行|to enter a profession
入道|to enter the Way;to become a Daoist
入门|entrance door;to enter a door;to learn the basics of a subject; introduction (to a subject); (attributive) entry-level
入关|to enter a pass;to go through customs
内中|within it;among them
内人|my wife (humble)
内传|biography recounting apocryphal anecdotes and rumors;(old) book of exegesis of a classic
内内|(coll.) panties
内化|internalization;to internalize
内地|mainland China (PRC excluding Hong Kong and Macau, but including islands such as Hainan);Japan (used in Taiwan during Japanese col…
内城|inner castle;donjon
内场|inner area (of a place that has an outer area);the kitchen of a restaurant (as opposed to the dining area);infield (baseball etc);…
内外|inside and outside;domestic and foreign;approximately;about
内定|to select sb for a position without announcing the decision until later;to decide behind closed doors;all cut and dried
内容|content; substance; details
内幕|inside story;non-public information;behind the scenes;internal
内心|heart; innermost being;(math.) incenter
内情|inside story;inside information
内战|civil war
内江|see 內江市，内江市[Nei4 jiang1 Shi4]
内河|river that flows only within a country's borders; inland waterway (esp. for transportation, in contrast to coastal or maritime wat…
内流|inward flowing (of river);flowing into desert
内海|inland sea;internal sea (wholly within the territory of one country, e.g. the Bohai Sea)
内用|to eat in (at a restaurant) (Tw);to take the medicine orally
内皮|(med.) endothelium;thin skin on the inside of some fruits (e.g. oranges)
内科|internal medicine; general medicine
内经|for 黃帝內經，黄帝内经[Huang2 di4 Nei4 jing1], The Yellow Emperor's Internal Canon, medical text c. 300 BC
内线|inside source; mole; insider;inside information; insider connections;(military) interior lines;internal telephone line
内行|expert;adept;experienced;an expert
内装|filled with;internal decoration;installed inside
内里|the inside
内黄|see 內黃縣，内黄县[Nei4 huang2 Xian4]
全力|with all one's strength;full strength;all-out (effort);fully (support)
全南|see 全南縣，全南县[Quan2 nan2 Xian4]
全同|identical
全员|all personnel; the whole staff
全国|whole nation;nationwide;countrywide;national
全城|whole city
全场|everyone present;the whole audience;across-the-board;unanimously
全天|whole day
全家|FamilyMart (convenience store chain)
全州|see 全州縣，全州县[Quan2 zhou1 Xian4]
全市|whole city
全年|the whole year;all year long
全心|with heart and soul
全情|wholeheartedly
全数|the entire sum;the whole amount
全文|entire text;full text
全新|all new; completely new
全书|entire book; unabridged book
全会|plenary session (at a conference)
全本|whole edition;whole performance (of Chinese opera)
全民|entire population; all the people (of a country or society)
全无|none;completely without
全然|completely
全球|the whole world;worldwide; global
全盘|overall;comprehensive
全网|the entire Internet
全线|the whole front (in a war);the whole length (of a road or railway line)
全美|throughout the United States;the whole of America
全色|full color;in all colors
全身|the whole body;(typography) em
全军|whole army
全部|whole; all
全长|overall length;span
全面|all-around;comprehensive;total;overall
全音|whole tone (musical interval)
全马|full marathon (abbr. for 全程馬拉松，全程马拉松[quan2 cheng2 ma3 la1 song1]);the whole of Malaysia
全体|all;entire
公主|princess
公事|work-related matters;documents
公交|public transportation;mass transit;abbr. for 公共交通[gong1 gong4 jiao1 tong1]
公布|variant of 公布[gong1 bu4]
公克|gram
公公|husband's father; father-in-law;grandpa; grandad;(old) form of address for a eunuch
公出|to be away on business
公分|centimeter (cm);(old) gram (g)
公制|metric system
公司|company; firm; corporation
公合|deciliter
公国|duchy;dukedom;principality
公地|public land;land in common use
公报|announcement;bulletin;communique
公子|son of an official;son of nobility;your son (honorific)
公学|elite fee-charging independent school in England or Wales (e.g. Eton College)
公安|see 公安縣，公安县[Gong1 an1 Xian4]
公家|the public;the state;society;the public purse
公平|fair;impartial
公干|official business; to do official business
公式|formula
公德|public ethics;social morality
公心|fair-mindedness;public spirit
公房|public housing;dormitory, esp. for unmarried people
公文|official document
公会|guild; professional or trade association
公有|publicly owned;communal;held in common
公正|just; fair; equitable
公民|citizen
公法|public law;international law
公海|the high seas; international waters
公然|openly;publicly;undisguised
公物|public property
公理|self-evident truth;(math.) axiom
公用|public;for public use
公石|hectoliter;quintal
公网|(computing) public network;wide area network;Internet
公路|highway;road
公车|bus;abbr. for 公共汽車，公共汽车[gong1 gong4 qi4 che1];car belonging to an organization and used by its members (government car, police car…
公转|orbital revolution
公道|justice;fairness;public highway
公里|kilometer
公开|open; overt; public;to make public; to release
公关|public relations
公马|male horse;stallion;stud
其中|among;in;included among these
其实|actually; in fact; really
再次|once more; once again
再见|goodbye;see you again later
冥顽|stupidly obstinate
冰释|to dispel (enmity, misunderstandings etc);to vanish (of misgivings, differences of opinion);thaw (in relations)
冷峻|grave and stern
凋零|withered;wilted;to wither;to fade
凌厉|swift and fierce;fierce;forceful
凛冽|biting cold
凝望|to gaze at;to stare fixedly at
凝视|to gaze at;to fix one's eyes on
凡尘|mundane world (in religious context);this mortal coil
出事|to have an accident;to meet with a mishap
出来|to come out;to appear;to arise
出入|to go out and come in;entrance and exit;expenditure and income;discrepancy
出力|to exert oneself
出动|to start out on a trip;to dispatch troops
出包|to contract out;to run into problems
出去|to go out
出口|an exit;to speak;to export;(of a ship) to leave port
出名|well-known for sth;to become well known;to make one's mark;to lend one's name (to an event, endeavor etc)
出品|to produce an item;output;items that are produced
出国|to go abroad; to leave the country
出土|to dig up;to appear in an excavation;unearthed;to come up out of the ground
出场|(of a performer) to come onto the stage to perform;(of an athlete) to enter the arena to compete;(fig.) to enter the scene (e.g. a…
出外|to go out;to leave for another place
出家|to enter monastic life; to become a monk or nun
出山|to leave the mountain (of a hermit);to come out of obscurity to a government job;to take a leading position
出差|to go on an official or business trip
出战|(military) to go off to war;(sports) to compete
出手|to dispose of;to spend (money);to undertake a task
出新|to make new advances;to move forwards
出书|to publish books
出月|next month;after this month
出格|to overstep the bounds of what is proper;to take sth too far;(of a measuring device) to go off the scale
出气|to vent one's anger;to breathe out; to exhale
出水|to discharge water;to appear out of the water;to break the surface
出海|to go out to sea;(neologism) to expand into overseas markets
出清|to clear out accumulated items;(retailing) to hold a clearance sale
出片|(coll.) (of a photographic subject) to photograph well; to yield good shots
出生|to be born
出发|to set off;to start (on a journey)
出盘|to sell up;to wind up a business
出神|spellbound;entranced;lost in thought
出线|(sports) to go out of bounds;to go over the line;to qualify for the next round of competition;(Tw) (fig.) to make the grade
出声|to make a sound;to speak;to cry out
出自|to come from
出台|to officially launch (a policy, program etc);to appear on stage;to appear publicly;(of a bar girl) to leave with a client
出色|remarkable; outstanding
出草|(of Taiwan aborigines) to go on a headhunting expedition
出菜|(at a restaurant) to bring a dish to a customer;to serve food
出号|large-sized (of clothes, shoes);(old) to give an order;(old) to quit one's job in a store
出血|to bleed; bleeding;(fig.) to spend money in large amounts
出行|to go out somewhere (relatively short trip);to set off on a journey (longer trip)
出路|a way out (lit. and fig.);opportunity for advancement; a way forward;outlet (for one's products)
出身|to be born of;to come from;family background;class origin
出车|to dispatch a vehicle;(of a vehicle or its driver) to set off
出道|to start one's career;(of an entertainer) to make one's debut
出门|to go out;to leave home;to go on a journey;away from home
出面|to appear personally;to step in;to step forth;to show up
出头|to get out of a predicament;to stick out;to take the initiative;remaining odd fraction after a division
出马|to set out (on a campaign);to stand for election;to throw one's cap in the ring
刁钻|crafty;tricky
分布|to scatter;to distribute;to be distributed (over an area etc);(statistical, geographic) distribution
分光|(prefix) spectro-
分克|decigram
分内|within one's area of responsibility
分力|component force (physics)
分包|to subcontract
分化|to split apart;differentiation
分区|allocated area (for housing, industry etc);district
分地|to distribute land
分外|exceptionally;not one's responsibility or job
分家|to separate and live apart;division of a large family into smaller groups
分工|to divide up the work;division of labor
分度|graduation (of a measuring instrument)
分形|fractal
分心|to divert one's attention; to get distracted;(courteous) to be so good as to take care of (a matter)
分成|to divide (into);to split a bonus;to break into;tenths
分房|to sleep in separate rooms;distribution of social housing
分手|to part company;to split up;to break up
分数|(exam) grade;mark;score;fraction
分文|a single penny;a single cent
分明|clear;distinct;evidently;clearly
分时|time-sharing (shared use, e.g. of a holiday home);(computing) time-sharing
分会|branch
分期|by stages;staggered;step by step;in installments
分机|(telephone) extension
分流|to diverge; to divert; to divide into separate streams (river flow, traffic etc);to stream (students into different programs); to …
分清|to distinguish (between different things);to make distinctions clear
分发|to distribute;distribution;to assign (sb) to a job
分相|split phase (elec.)
分神|to give some attention to; to divert one's attention; to be distracted
分管|to be put in charge of;to be responsible for;branched passage
分节|segmented
分米|decimeter
分红|dividend;to award a bonus
分色|color separation
分号|semicolon;branch (of a business, shop etc)
分行|branch of bank or store;subsidiary bank
分装|to divide into portions;to package in smaller quantities;to separate into loads
分解|to resolve;to decompose;to break down
分词|participle;word segmentation
分身|(of one who has supernatural powers) to replicate oneself so as to appear in two or more places at the same time;a derivative vers…
分量|(vector) component
分开|to separate;to part
分头|separately;severally;parted hair
分点|point of division
别人|other people; others; other person
利事|(Cantonese) same as 紅包，红包[hong2 bao1]
利器|sharp weapon;effective implement;outstandingly able individual
利基|asset that gives a competitive advantage; a strength;(market) niche
利多|see 利好[li4 hao3]
利好|(finance) sth that engenders bullish sentiment; favorable news;(finance) (of news, data etc) favorable; positive
利州|see 利州區，利州区[Li4 zhou1 Qu1]
利市|business profit;auspicious;lucky;small sum of money offered on festive days
利得|profit;gain
利手|dominant hand;handedness
利民|to benefit the people
利用|to exploit;to make use of;to use;to take advantage of
利空|(finance) sth that engenders bearish sentiment; unfavorable news;(finance) (of news, data etc) unfavorable; negative
利通|see 利通區，利通区[Li4 tong1 Qu1]
利马|Lima, capital of Peru
到底|finally;in the end;when all is said and done;after all
到处|everywhere
到达|to reach; to arrive
制动|to brake
制定|to draw up; to formulate
制度|system (e.g. political, adminstrative etc);institution
制式|standardized;standard (service, method etc);regulation (clothing etc);formulaic
刻骨|ingrained;entrenched;deep-rooted
克星|nemesis;bane;fated to be ill-matched
前事|past events;antecedent;what has happened
前人|predecessor;forebears;the person facing you
前来|to come (formal);before;previously
前传|forward pass (sport)
前儿|before;day before yesterday
前天|the day before yesterday
前年|the year before last
前后|around;from beginning to end;all around;front and rear
前情|former love;former circumstances
前文|the text above; the preceding text
前方|ahead;the front
前日|day before yesterday
前期|preceding period;early stage
前生|previous life;previous incarnation
前科|criminal record;previous convictions
前线|front line;military front;workface;cutting edge
前者|the former (i.e. the one mentioned first)
前台|stage;proscenium;foreground in politics etc (sometimes derog.);front desk
前菜|appetizer; starter; hors d'oeuvre
前行|(literary) to go forward
前调|(perfumery) top note
前路|the road ahead
前身|forerunner;predecessor;precursor;previous incarnation (Buddhism)
前途|prospects;future outlook;journey
前边|front;the front side;in front of
前金|see 前金區，前金区[Qian2 jin1 Qu1]
前门|Qianmen subway station on Beijing Subway Line 2
前面|ahead;in front;preceding;above
前头|in front;at the head;ahead;above
前体|(chemistry, biology) precursor
刹那|an instant (Sanskrit: ksana); split second; the twinkling of an eye
刚刚|just recently;just a moment ago
刚才|just now;a moment ago
剩下|to remain; to be left over
剑法|fencing;sword-play
力主|advocate strongly
力作|to put effort into (work, farming, writing etc);a masterpiece
力保|to seek to protect;to ensure;to maintain;to guard
力克|to prevail with difficulty
力图|to try hard to;to strive to
力场|force field (physics)
力士|strong man;sumo wrestler
力学|(physics) mechanics;(literary) to study hard
力工|manual laborer; unskilled laborer
力度|strength;vigor;efforts;(music) dynamics
力心|fulcrum;center of force
力战|to fight with all one's might
力气|physical strength
力波|Reeb, a beer brand
力行|to practice diligently;to act energetically
力道|strength;power;efficacy
力量|power; force; strength
加上|plus;to put in;to add;to add on
加入|to become a member;to join;to mix into;to participate in
加分|bonus point; extra credit;to award bonus points; to earn extra points
加和|to calculate the total;sum; total
加国|Canada
加大|to increase (e.g. one's effort)
加州|California
加工|to process;processing;working (of machinery)
加强|to reinforce; to strengthen; to enhance
加意|paying special care;with particular attention
加数|addend; summand
加时|(sports) overtime;extra time;play-off
加气|to aerate;to ventilate
加沙|Gaza (territory adjacent to Israel and Egypt)
加油|to add oil; to top up with gas; to refuel;to accelerate; to step on the gas;(fig.) to make an extra effort; to cheer sb on
加法|addition
加热|to heat
加号|(math.) plus sign (+)
加车|extra bus or train
加里|Gary (name)
加重|to make heavier;to emphasize;(of an illness etc) to become more serious;to aggravate (a bad situation)
加长|to lengthen
加点|to work extra hours;to do overtime
努力|to make an effort; to try hard; to strive;hard-working; conscientious
劫难|calamity
勇敢|brave; courageous
动人|touching;moving
动作|movement; motion; action;to act; to move
动保|animal protection (abbr. for 動物保護，动物保护[dong4 wu4 bao3 hu4])
动力|motive power;(fig.) motivation; impetus
动口|to use one's mouth (to say sth)
动员|to mobilize;mobilization
动图|(computing) dynamic image
动土|to break ground (prior to building sth);to start building
动工|to start (a building project)
动心|to be moved;to be tempted
动情|to get excited;passionate;aroused to passion;to fall in love
动手|to set about (a task);to raise a hand to hit sb;to touch; to handle (typically used in cautioning sb *not* to touch sth)
动机|motive; motivation
动武|to use force;to come to blows
动气|to get angry
动物|animal
动用|to utilize;to put sth to use
动线|path taken by people moving through a space; flowline (in architecture, interior design, urban planning etc)
动词|verb
动身|to go on a journey;to leave
动车|(PRC) (D- or C-class) high-speed train;power car;multiple-unit train (abbr. for 動車組，动车组[dong4 che1 zu3])
动量|momentum
动点|moving point
胜利|victory
胜负|victory or defeat;the outcome of a battle
劝告|to advise;to urge;to exhort;exhortation
包干|to have the full responsibility of a job;allocated task
包公|Lord Bao or Judge Bao, fictional nickname of Bao Zheng 包拯[Bao1 Zheng3] (999-1062), Northern Song official renowned for his honesty
包包|(coll.) handbag; purse;(Tw) (coll.) bag one carries (e.g. shoulder bag or backpack);(coll.) small bump on the skin (pimple, mosqui…
包商|(Tw) contractor
包场|to reserve all the seats (or a large block of seats) at a theater, restaurant etc
包子|baozi; bao (steamed stuffed bun)
包工|to undertake to perform work within a time limit and according to specifications;to contract for a job;contractor
包房|compartment (of train, ship etc);private room at restaurant;rented room for karaoke;hotel room rented by the hour
包括|to comprise;to include;to involve;to incorporate
包月|to make monthly payments;monthly payment
包机|chartered plane;to charter a plane
包河|see 包河區，包河区[Bao1 he2 Qu1]
包尔|Borr (Norse deity)
包皮|wrapping;wrapper;foreskin
包管|to assure; to guarantee
包米|variant of 苞米[bao1 mi3]
包罗|to include;to cover;to embrace
包菜|cabbage
包装|to wrap; to package (goods etc);packaging; packing materials;(fig.) to present attractively; to craft an image; to package (sb or …
包车|hired car;chartered car
包金|to gild;(old) wages paid to a performer or a troupe by a theater
包长|packet size (computing)
包头|see 包頭市，包头市[Bao1 tou2 Shi4]
匆匆|hurriedly
匍匐|to crawl; to creep; to lie prostrate
化作|to change into;to turn into;to become
化合|chemical combination
化名|to go by an alias; to assume a false name;alias; pseudonym; assumed name
化外|(old) outside the sphere of civilization
化子|beggar (old term);same as 花子
化学|chemistry;chemical
化州|see 化州市[Hua4 zhou1 Shi4]
化工|chemical industry (abbr. for 化學工業，化学工业[hua4 xue2 gong1 ye4]);chemical engineering (abbr. for 化學工程，化学工程[hua4 xue2 gong1 cheng2])
化德|see 化德縣，化德县[Hua4 de2 Xian4]
化日|sunlight;daytime
化武|chemical weapon;abbr. for 化學武器，化学武器[hua4 xue2 wu3 qi4]
化用|to adapt (an idea etc)
化石|fossil
化装|(of actors) to make up;to disguise oneself
化解|to dissolve;to resolve (contradictions);to dispel (doubts);to iron out (difficulties)
化身|incarnation;reincarnation;embodiment (of abstract idea);personification
化开|to spread out after being diluted or melted;to dissolve into a liquid
北上|to go up north
北亚|North Asia
北京|Beijing municipality, capital of the People's Republic of China (short name 京[Jing1])
北国|the northern part of the country;the North
北外|for 北京外國語大學，北京外国语大学[Bei3 jing1 Wai4 guo2 yu3 Da4 xue2]
北大|Peking University (abbr. for 北京大學，北京大学)
北安|see 北安市[Bei3 an1 Shi4]
北山|northern mountain;refers to Mt Mang 邙山 at Luoyang in Henan
北市|(Tw) Taipei (abbr. for 臺北市，台北市[Tai2 bei3 Shi4])
北平|Peiping or Beiping (name of Beijing at different periods, esp. 1928-1949)
北方|north;the northern part a country;China north of the Yellow River
北林|see 北林區，北林区[Bei3 lin2 Qu1]
北江|Beijiang River
北流|see 北流市[Bei3 liu2 Shi4]
北海|North Sea (in Europe);historical name for several bodies of water, including Lake Baikal 貝加爾湖，贝加尔湖[Bei4 jia1 er3 Hu2], Russia
北美|North America
北角|North Point district of Hong Kong
北车|(coll.) Taipei Railway Station (abbr. for 台北車站，台北车站[Tai2 bei3 Che1 zhan4]) (Tw)
北边|north;north side;northern part;to the north of
北关|see 北關區，北关区[Bei3 guan1 Qu1]
北面|northern side;north
北风|north wind
区分|to differentiate;to draw a distinction;to divide into categories
区区|insignificant;trifling;merely
区号|area code
区长|district chief
十分|very;completely;utterly;extremely
千万|ten million;countless;many;one must by all means
南下|to go down south
南亚|southern Asia
南北|north and south;north to south
南和|see 南和區，南和区[Nan2 he2 Qu1]
南城|see 南城縣，南城县[Nan2 cheng2 Xian4]
南大|Nanjing University, NJU (abbr. for 南京大學，南京大学[Nan2 jing1 Da4 xue2])
南安|see 南安市[Nan2 an1 Shi4]
南定|Nam Dinh, Vietnam
南宁|see 南寧市，南宁市[Nan2 ning2 Shi4]
南山|see 南山區，南山区[Nan2 shan1 Qu1]
南平|see 南平市[Nan2 ping2 Shi4]
南方|south; southern direction;(in China) southern regions, often referring to areas south of the Yangtze River
南明|see 南明區，南明区[Nan2 ming2 Qu1]
南乐|see 南樂縣，南乐县[Nan2 le4 Xian4]
南江|see 南江縣，南江县[Nan2 jiang1 Xian4]
南沙|see 南沙群島，南沙群岛[Nan2 sha1 Qun2 dao3];see 南沙區，南沙区[Nan2 sha1 Qu1]
南海|South China Sea
南无|Buddhist salutation or expression of faith (loanword from Sanskrit);Taiwan pr. [na2 mo2]
南特|Nantes (city in France)
南皮|see 南皮縣，南皮县[Nan2 pi2 Xian4]
南县|Nan County or Nanxian, a county in Yiyang City 益陽市，益阳市[Yi4 yang2 Shi4], Hunan
南美|South America
南华|South China;see 南華縣，南华县[Nan2 hua2 Xian4]
南通|see 南通市[Nan2 tong1 Shi4]
南边|south;south side;southern part;to the south of
南开|Nankai district of Tianjin municipality 天津市[Tian1 jin1 shi4]
南关|see 南關區，南关区[Nan2 guan1 Qu1]
南阳|see 南陽市，南阳市[Nan2 yang2 Shi4]
南面|south side;south
卡子|clip;hair fastener;checkpoint
卡带|cassette tape
卡座|booth (in restaurants etc) (loanword from "car seat")
卡式|(of a device) designed to accept a cassette, cartridge or canister (loanword from "cassette");designed to have a card or ticket in…
卡拉|Kara, city in northern Togo 多哥[Duo1 ge1];Cara, Karla etc (name)
卡方|chi-square (math.)
卡死|to jam up; to lock up; to become completely stuck
卡尔|(name) Karl; Carl
卡片|card
卡特|(name) Carter;Jimmy Carter (1924–2024), US president 1977–1981
卡盘|chuck (for a drill etc)
卡车|truck
卡通|cartoon (loanword)
卡达|Qatar (Tw)
卡门|Carmen (name);Carmen, 1875 opera by Georges Bizet 比才 based on novel by Prosper Mérimée 梅里美[Mei2 li3 mei3]
卡关|to be stuck;to feel stuck
卡点|to synchronize (a video etc) to the beat of a piece of music
危险|danger;dangerous
即使|even if; even though
厄运|bad luck;misfortune;adversity
原人|prehistoric man;primitive man
原作|original works;original text;original author
原来|original; former;originally; formerly; at first;so, actually, as it turns out
原名|original name
原因|cause;origin;root cause;reason
原图|original drawing, map or picture (as opposed to a copy or a modified version)
原地|(in) the original place;the place where one currently is;place of origin;local (product)
原子|atom;atomic
原定|originally planned;originally determined
原州|see 原州區，原州区[Yuan2 zhou1 Qu1]
原平|see 原平市[Yuan2 ping2 Shi4]
原形|original shape;true appearance (under the disguise);true character
原意|original meaning;original intention
原文|original text
原有|original;former
原木|logs
原本|originally;the original; original copy; original version
原水|raw water;unpurified water
原油|crude oil
原理|principle;theory
原生|original;primary;native;indigenous
原声|acoustic (musical instrument)
原色|primary color
原装|genuine;intact in original packaging (not locally assembled and packaged)
原语|source language (linguistics)
原谅|to excuse;to forgive;to pardon
原道|original path;essay by Tang philosopher Han Yu 韓愈，韩愈[Han2 Yu4]
原阳|see 原陽縣，原阳县[Yuan2 yang2 Xian4]
原点|starting point;square one;(coordinate geometry) origin
厉害|(used to describe sb or sth that makes a very strong impression, whether favorable or unfavorable) terrible; intense; severe; deva…
反光|to reflect light
反制|to take countermeasures against;to hit back;to counter
反动|reaction;reactionary
反口|to correct oneself;to renege;to break one's word
反对|to oppose; to be against; to object to
反式|trans- (isomer) (chemistry);see also 順式，顺式[shun4 shi4]
反战|anti-war
反手|to turn a hand over;to put one's hand behind one's back;fig. easily done
反方|the side opposed to the proposition (in a formal debate)
反日|anti-Japan
反正|anyway;in any case;to come over from the enemy's side
反比|inversely proportional;inverse ratio
反水|to turn traitor; to defect
反清|anti-Qing;refers to the revolutionary movements in late 19th and early 20th century leading up to 1911 Xinhai Revolution 辛亥革命[Xin1…
反特|to thwart enemy espionage; to engage in counterespionage
反白|reverse type (white on black);reversed-out (graphics);highlighting (of selected text on a computer screen)
反相|(a person's) rebellious appearance;signs of an impending rebellion;(physics) reversed phase
反美|anti-American
反华|anti-Chinese
反角|reflex angle
反话|irony;ironic remark
反语|irony
反身|to turn around
反转|reversal;inversion;to reverse;to invert (upside down, inside out, back to front, white to black etc)
反酸|acid reflux;regurgitation
反面|reverse side;backside;the other side (of a problem etc);negative
反骨|(physiognomy) protruding bone at the back of the head, regarded as a sign of a renegade nature
口交|oral sex
口信|oral message
口传|to convey orally; to pass on by word of mouth (instructions, information, stories etc)
口北|the area north of the Great Wall
口器|mouthparts (of an arthropod)
口子|hole;opening;cut;gap
口实|food;salary (old);a pretext;a cause for gossip
口形|variant of 口型[kou3 xing2]
口德|propriety in speech
口气|tone of voice;the way one speaks;manner of expression;tone
口水|saliva
口球|(BDSM) ball gag
口白|narrator;spoken parts in an opera
口皮|(coll.) lip
口红|lipstick
口号|slogan;catchphrase
口袋|pocket;bag; sack
口角|corner of the mouth
口语|colloquial speech;spoken language;vernacular language;slander
口音|(linguistics) oral speech sounds
口头|oral;verbal
口风|meaning behind the words;what sb really means to say;one's intentions as revealed in one's words;tone of speech
古交|see 古交市[Gu3 jiao1 Shi4]
古人|people of ancient times;the ancients;extinct human species such as Homo erectus or Homo neanderthalensis;(literary) deceased perso…
古代|ancient times
古来|since ancient times; it has ever been the case that
古国|ancient country
古城|ancient city
古字|ancient character;archaic form of a Chinese character
古巴|Cuba
古文|old language;the Classics;Classical Chinese as a literary model, esp. in Tang and Song prose;Classical Chinese as a school subject
古方|ancient prescription
古时|antiquity
古书|ancient book;old book
古板|outmoded;old-fashioned;inflexible
古法|traditional method; traditional technique;(of a product, craft etc) traditional; old-style
古波|Gubo (a personal name)
古物|antique
古县|Gu County or Guxian, a county in Linfen City 臨汾市，临汾市[Lin2 fen2 Shi4], Shanxi
古老|ancient;old;age-old
古装|ancient costume;period costume (in movies etc)
古语|ancient language;old expression
古道|ancient road;precepts of the antiquity
古音|ancient (esp. pre-Qin) pronunciation of a Chinese character;classical speech sounds
古风|old style;old custom;a pre-Tang Dynasty genre of poetry aka 古體詩，古体诗[gu3 ti3 shi1]
古龙|Gu Long (1938-1985), Taiwanese wuxia novelist and screenwriter
句子|sentence
另外|additional;in addition;besides;separate
只有|only have ...; there is only ...;(used in combination with 才[cai2]) it is only if ... (that one can ...) (as in 只有通過治療才能痊愈，只有通过治疗才…
只要|so long as; provided; if
可不|see 可不是[ke3 bu5 shi4]
可人|pleasant;agreeable;a person after one's heart (charming person);a gifted person
可以|can;may;possible;able to
可作|can be used for
可信|trustworthy
可儿|a person after one's heart (charming person);capable person
可分|can be divided (into parts);one can distinguish (several types)
可加|(botany) coca (loanword)
可动|movable
可口|tasty; to taste good
可可|(loanword) cocoa
可好|good or not?;luckily;fortuitously
可心|satisfying;to one's liking;to suit sb
可数|countable;denumerable
可是|but; however;(used for emphasis) indeed
可乐|amusing;entertaining;(loanword) cola
可比|comparable
可气|annoying;irritating;exasperating
可能|might (happen);possible;probable;possibility
可行|feasible
可解|soluble (i.e. can be solved)
可调|adjustable
可变|variable
可身|to fit well (clothes)
可通|passable;possible to reach
可体|well-fitting (of clothes)
台下|off the stage;in the audience
台中|variant of 臺中，台中[Tai2 zhong1]
台前|see 台前縣，台前县[Tai2 qian2 Xian4]
台北|Taipei, capital of Taiwan
台南|Tainan, a city and special municipality in southwest Taiwan
台商|Taiwanese businessperson or company (esp. one operating overseas, often in mainland China)
台安|see 檯安縣，台安县[Tai2 an1 Xian4]
台客|stereotypical Taiwanese person (often derogatory)
台山|see 台山市[Tai2 shan1 Shi4]
台州|see 台州市[Tai1 zhou1 Shi4]
台座|pedestal
台式|Taiwanese-style
台东|Taidong or Taitung city and county in Taiwan
台江|see 台江區，台江区[Tai2 jiang1 Qu1];see 台江縣，台江县[Tai2 jiang1 Xian4]
台球|billiards
台菜|Taiwanese food
台语|Taiwanese Hokkien (aka Taiwanese Minnan, or simply Taiwanese)
叱咤|to rebuke angrily
吃惊|to be startled;to be shocked;to be amazed
合一|to unite
合上|to close (box, book, mouth etc)
合作|to cooperate; to collaborate; to work together
合力|to join forces;concerted effort;(physics) resultant force
合同|contract; agreement
合子|zygote (biology)
合字|(typography) ligature
合家|whole family;entire household
合山|see 合山市[He2 shan1 Shi4]
合式|conforming to a pattern; up to standard;variant of 合適，合适[he2 shi4]
合心|acting together;to one's liking
合意|to suit one's taste;suitable;congenial;by mutual agreement
合成|to compose;to constitute;compound;synthesis
合手|to put one's palms together (in prayer or greeting);to work with a common purpose;harmonious;convenient (to use)
合数|composite number (i.e. not prime, has a factorization)
合时|in fashion;suiting the time;seasonable;timely
合格|to meet the standard required;qualified;eligible (voter etc)
合水|see 合水縣，合水县[He2 shui3 Xian4]
合江|see 合江縣，合江县[He2 jiang1 Xian4]
合法|lawful;legitimate;legal
合流|to converge;to flow together;fig. to act alike;to evolve together
合理|rational; reasonable; sensible; fair
合用|to share;to use in common;suitable;fit for purpose
合眼|to close one's eyes;to get to sleep
合身|well-fitting (of clothes)
合金|alloy
合阳|see 合陽縣，合阳县[He2 yang2 Xian4]
合音|backup vocal (music);(phonetic) contraction
合体|to combine;combination;composite character (i.e. a synonym of 合體字，合体字[he2 ti3 zi4]);(of clothes) to be a good fit
合龙|to join the two sections (of a linear structure: bridge, dike etc) to complete its construction
同一|identical; the same
同上|as above; ditto; idem
同事|colleague; co-worker
同人|people from the same workplace or profession; co-worker; colleague;(fandom) fan creator or enthusiast involved in derivative works…
同传|simultaneous interpretation (abbr. for 同聲傳譯，同声传译[tong2 sheng1 chuan2 yi4])
同化|assimilation (cultural, digestive, phonemic etc)
同名|of the same name;homonymous;self-titled (album)
同好|fellow enthusiasts
同学|to study at the same school;fellow student;classmate
同安|see 同安區，同安区[Tong2 an1 Qu1]
同工|fellow workers
同年|in the same year;to be the same age
同德|see 同德縣，同德县[Tong2 de2 Xian4]
同心|see 同心縣，同心县[Tong2 xin1 Xian4]
同性|same nature;homosexual
同情|to sympathize with;sympathy
同意|to agree;to consent;to approve
同房|(of a married couple) to have intercourse;(literary) to share the same room;of the same family branch
同日|on the same day
同时|at the same time; simultaneously
同期|the corresponding time period (in a different year etc);concurrent;synchronous
同业|same trade or business;person in the same trade or business
同乐|to enjoy together
同比|(statistics) compared with the same period of the previous year; year on year; year over year
同江|see 同江市[Tong2 jiang1 Shi4]
同理|Tongli, a city in Jiangsu Province, China
同台|to appear on the same stage
同花|flush (poker)
同行|person of the same profession;of the same trade, occupation or industry
同调|same tone;in agreement with;homology (invariant of a topological space in math.)
同路|to go the same way
同道|same principle
同量|commensurable;commensurate
同音|(music) unison;(linguistics) homophonous; homonymic
名下|under sb's name
名人|personage;celebrity
名作|masterpiece;famous work
名儿|name;fame
名分|a person's status
名利|fame and profit
名单|list of names
名城|famous city
名士|(old) a person of literary talent; a celebrity (esp. a distinguished literary person having no official post)
名字|name (of a person or thing)
名学|(archaic) logic
名家|School of Logicians of the Warring States Period (475-220 BC), also called the School of Names
名实|name and reality;how sth is portrayed and what it is actually like
名山|see 名山區，名山区[Ming2 shan1 Qu1]
名手|master;famous artist or sportsman
名数|(grammar) number plus classifier;household (in census)
名气|reputation; fame
名流|gentry;celebrities
名片|(business) card
名相|famous prime minister (in ancient China);names and appearances (Buddhism)
名节|reputation and integrity
名声|reputation
名菜|famous dishes;specialty dishes
名号|name; title;good reputation
名角|famous actor
名词|(linguistics) noun;term (name for a concept)
名酒|a famous wine
名表|famous watch (i.e. expensive brand of wristwatch)
名门|famous family;prestigious house
名头|reputation
后土|Earth Deity (often paired with 皇天[Huang2 tian1], August Heaven)
后座|empress's throne;(fig.) first place in a women's competition
否认|to declare to be untrue;to deny
告别|to leave; to part from;to bid farewell to; to say goodbye to
告诉|to press charges; to file a complaint
呢喃|(onom.) twittering of birds;whispering;murmuring
味道|flavor; taste;(fig.) feeling (of ...); sense (of ...); hint (of ...);(fig.) interest; delight;(dialect) smell; odor
呻吟|to moan; to groan
命运|fate; destiny
和合|harmony
和好|to become reconciled; on good terms with each other
和平|peace;peaceful
和数|sum (math.)
和会|peace conference
和乐|harmonious and happy
和气|friendly;polite;amiable
和煦|warm;genial
和县|He County or Hexian, a county in Ma'anshan City 馬鞍山市，马鞍山市[Ma3 an1 shan1 Shi4], Anhui
和美|harmonious;in perfect harmony
和声|harmony (music)
和解|to settle (a dispute out of court);to reconcile;settlement;conciliation
和音|harmony (pleasing combination of sounds)
和风|breeze;(Tw) Japanese-style (cooking etc)
和面|to knead dough
和龙|see 和龍市，和龙市[He2 long2 Shi4]
哀嚎|to wail; to cry piteously;(of a wild animal) to howl
品保|quality assurance (QA)
品名|name of product;brand name
品学|conduct and learning (of an individual);moral nature and skill
品客|Pringles (snack food brand)
品德|moral character
品性|nature;characteristic;moral character
品族|strain (of a species)
品月|light blue
品格|(of a person) moral character; integrity;(of a work of art or literature) style; character; quality;(music) fret (on a stringed in…
品相|condition;physical appearance (of a museum piece, item of food produced by a chef, postage stamp etc)
品管|quality control
品节|character; moral integrity
品红|magenta; fuschia
品色|variety;kind
品行|behavior;moral conduct
品达|Pindar, Greek poet
品酒|to taste wine;to sip wine
员外|landlord (old usage)
员工|staff; personnel; employee
哥哥|older brother
哽咽|to choke with emotion;to choke with sobs
唱歌|to sing a song
商事|commercial affairs
商人|merchant;businessman
商代|the prehistoric Shang dynasty (c. 16th-11th century BC)
商南|see 商南縣，商南县[Shang1 nan2 Xian4]
商品|commodity; goods; merchandise
商城|see 商城縣，商城县[Shang1 cheng2 Xian4]
商报|business newspaper
商场|shopping mall;shopping center;department store;emporium
商女|female singer (archaic)
商学|business studies;commerce as an academic subject
商定|to agree;to decide after consultation;to come to a compromise
商家|merchant;business;enterprise
商州|see 商州區，商州区[Shang1 zhou1 Qu1]
商店|store; shop
商战|trade war
商数|(math.) quotient
商会|chamber of commerce
商业|business;trade;commerce
商机|business opportunity;commercial opportunity
商民|merchant
商水|see 商水縣，商水县[Shang1 shui3 Xian4]
商河|see 商河縣，商河县[Shang1 he2 Xian4]
商用|(attributive) commercial
商科|Shangke corporation, PRC IT company (since 1994)
商号|store;a business
商行|trading company
商调|to negotiate the transfer of personnel
商路|trade route
商量|to consult;to talk over;to discuss
问题|question;problem;issue;topic
啜泣|to sob
善良|good and honest;kindhearted
喜欢|to like; to be fond of
单一|single;only;sole
单人|one person;single (room, bed etc)
单传|to have only one heir in a generation (of a family, clan etc);to be learned from only one master (of a skill, art etc)
单反|see 單反相機，单反相机[dan1 fan3 xiang4 ji1]
单品|(commerce) individual product; distinct product item; SKU;(retail) individual item (sold separately, not as part of a set)
单单|only;merely;just
单子|the only son of a family;(functional programming or philosophy) monad
单字|single Chinese character;(Tw) word (of a foreign language)
单宁|(loanword) tannin
单工|(telecommunications) simplex
单干|to work on one's own;to work single-handed;individual farming
单意|unambiguous;having only one meaning
单手|one hand;single-handed
单打|singles (in sports)
单数|positive odd number (also written 奇數，奇数);singular (grammar)
单方|unilateral;one-sided;home remedy;folk prescription(same as 丹方)
单日|on a single day
单月|monthly;in a single month
单独|alone;by oneself;on one's own
单用|to use (sth) on its own
单相|single phase (elec.)
单眼|ommatidium (single component of insect's compound eye);one eye (i.e. one's left or right eye)
单县|Shan County or Shanxian, a county in Heze City 菏澤市，菏泽市[He2 ze2 Shi4], Shandong
单色|monochrome;monochromatic;black and white
单号|odd number (on a ticket, house etc)
单行|to come individually;to treat separately;separate edition;one-way traffic
单词|word
单语|monolingual
单调|monotonous
单身|unmarried; single;alone
单车|(coll.) bicycle; bike (esp. in Hong Kong, Taiwan and southern China and, more generally, used across China to refer to a bike-shar…
单过|to live independently;to live on one's own
单边|unilateral
单体|monomer (chemistry)
单点|to order à la carte;single point (of measurement, mounting etc)
呜咽|to sob;to whimper
叹服|(to gasp) with admiration
嘴巴|mouth (CL:張，张[zhang1]);slap in the face
器乐|instrumental music
器物|implement;utensil;article;object
器重|to regard sth as valuable; to think highly of (a younger person, a subordinate etc)
器量|tolerance
严寒|bitter cold;severe winter
回事|(old) to report to one's master
回交|backcrossing (i.e. hybridization with parent)
回来|to return; to come back
回信|to reply;to write back;letter written in reply
回去|to return;to go back
回口|to answer back
回合|one of a sequence of contests (or subdivisions of a contest) between the same two opponents;round (boxing etc);rally (tennis etc);…
回单|receipt
回回|(old) the Hui ethnic group (Chinese Muslims); a Hui person
回国|to return to one's home country
回报|(in) return;reciprocation;payback;retaliation
回天|to reverse a desperate situation
回家|to return home
回忆|to recall;memories
回教|Islam
回数|number of times (sth happens);number of chapters in a classical novel;(math.) palindromic number
回文|palindrome
回族|Hui ethnic group (Chinese Muslims)
回本|to recoup one's investment
回民|Hui ethnic group (Chinese muslims)
回波|echo (e.g. radar);returning wave
回流|to flow back;reflux;circumfluence;refluence
回火|to temper (iron);to flare back;flareback (in a gas burner);(of an engine) to backfire
回神|to collect one's thoughts (after being surprised or shocked);to snap out of it (after being lost in thought)
回空|to return empty (i.e. to drive back with no passengers or freight)
回答|to reply; to answer;reply; answer
回声|echo
回血|(medicine) (of blood) to flow back into the IV tube;(gaming) to restore health points; (fig.) to recover (to some extent)
回话|to reply
回调|callback (computing)
回路|to return;circuit (e.g. electric);loop
回车|to turn a vehicle around;(computing) "carriage return" character;the "Enter" key;to hit the "Enter" key
回转|variant of 迴轉，回转[hui2 zhuan3]
回门|first return of bride to her parental home
回电|to call sb back (on the phone);a return call;to reply to a telegram;to wire back
回音|echo;reply;turn (ornament in music)
回头|to turn round; to turn one's head;later; by and by
因为|because; owing to; on account of
困难|difficult;challenging;straitened circumstances;difficult situation
困顿|fatigued;exhausted;poverty-stricken;in straitened circumstances
囹圄|(literary) prison
固执|obstinate;stubborn;to fixate on;to cling to
国中|junior high school (Tw);abbr. for 國民中學，国民中学[guo2 min2 zhong1 xue2]
国事|affairs of the nation;politics
国人|compatriots (literary);fellow countrymen
国保|Domestic Security Protection Bureau, the department of the Ministry of Public Security responsible for political security, monitor…
国内|domestic;internal (to a country);civil
国力|a nation's power
国名|name of country
国土|country's territory;national land
国外|abroad;external (affairs);overseas;foreign
国大|for 國民大會，国民大会, National Assembly of the Republic of China (extant during various periods between 1913 and 2005);abbr. for 新加坡國立大學，…
国字|Chinese character (Hanzi);the native script used to write a nation's language
国学|Chinese national culture;studies of ancient Chinese civilization;the Imperial College (history)
国安|national security (abbr. for 國家安全，国家安全[guo2 jia1 an1 quan2]);national security act;state security agency
国家|country; nation; state
国小|elementary school (Tw);abbr. for 國民小學，国民小学[guo2 min2 xiao3 xue2]
国度|country; nation
国情|the characteristics and circumstances particular to a country;current state of a country
国手|(sports) member of the national team;national representative;(medicine, chess etc) one of the most highly skilled practitioners in…
国教|state religion
国族|people of a country;nation
国书|credentials (of a diplomat);documents exchanged between nations;national or dynastic history book
国会|Parliament (UK);Congress (US);Diet (Japan);Legislative Yuan (Taiwan)
国有|nationalized;public;government owned;state-owned
国乐|national music;Chinese traditional music
国民|nationals;citizens;people of a nation
国法|national law
国王|king
国美|GOME, electronics chain founded in Beijing in 1987
国花|national flower (emblem, e.g. peony 牡丹[mu3 dan1] in China)
国菜|national food specialty
国号|official name of a nation (includes dynastic names of China: 漢，汉[Han4], 唐[Tang2] etc)
国行|(of a product etc) officially sold for the mainland China market
国语|Chinese language (Mandarin), emphasizing its national nature;Chinese as a primary or secondary school subject;Chinese in the conte…
国运|fate of the nation
国道|national highway
国门|(archaic) capital's gate;country's border
国关|for 國際關係學院，国际关系学院[Guo2 ji4 Guan1 xi4 Xue2 yuan4], University of International Relations, Beijing
国音|official pronunciation standard (esp. in the Republic of China in the early 20th century)
国风|traditional Chinese style
国体|state system (i.e. form of government);national prestige
圆滑|smooth and evasive;slick and sly
图形|picture;figure;diagram;graph
图书|books (in a library or bookstore)
图尔|Tours (city in France)
图片|picture; photograph
图皮|Tupi (a group of Indigenous peoples of South America)
图表|chart;diagram
图解|illustration;diagram;graphical representation;to explain with the aid of a diagram
土人|native;aborigine;clay figure
土器|earthenware
土地|land;soil;territory
土城|see 土城區，土城区[Tu3 cheng2 Qu1]
土家|Tujia ethnic group
土布|homespun cloth
土方|cubic meter of earth (unit of measurement);excavated soil;earthwork (abbr. for 土方工程[tu3 fang1 gong1 cheng2]);(TCM) folk remedy
土族|Tu ethnic group
土星|Saturn (planet)
土木|building;construction;civil engineering
土气|rustic;uncouth;unsophisticated
土法|traditional method
土神|earth God
土制|homemade;earthen
土话|vernacular;slang;dialect;patois
土语|dialect;patois
土路|dirt road
土门|Tumen or Bumin Khan (-553), founder of Göktürk khanate
土音|local accent
土香|see 香附[xiang1 fu4]
地上|on the ground;on the floor
地下|underground;subterranean;covert
地主|landlord;landowner;host
地保|(old) local constable
地儿|place;space
地利|favorable location;in the right place;productivity of land
地力|fertility; productivity (of soil or land)
地动|earthquake (old term)
地区|region; area (informal or geographical term);prefecture (in China's administrative system)
地台|floor;platform
地名|place name;toponym
地和|(mahjong) earthly hand; a hand that is completed by a non-dealer on their first draw;(mahjong) to obtain an earthly hand
地图|map
地基|foundations (of a building);base
地市|prefecture-level administrative jurisdiction (including prefecture-level cities, autonomous prefectures, prefectures and leagues)
地带|zone
地形|topography;terrain;landform
地心|the center of the Earth; (attributive) geocentric;the Earth's interior
地方|region;regional (away from the central administration);local
地书|writing on the ground with a large brush dipped in water
地板|floor
地热|geothermal heat
地球|the earth
地理|geography
地皮|lot;section of land;ground
地盘|domain;territory under one's control;foundation of a building;base of operations
地线|earth (wire);ground
地表|the surface (of the earth)
地调|geological survey, abbr. for 地質調查，地质调查[di4 zhi4 diao4 cha2]
地道|tunnel;causeway
地面|floor;ground;surface
地头|place;locality;edge of a field;lower margin of a page
地黄|Chinese foxglove (Rehmannia glutinosa), its rhizome used in TCM
地点|place;site;location;venue
地龙|(TCM) earthworm
城中|see 城中區，城中区[Cheng2 zhong1 Qu1]
城北|see 城北區，城北区[Cheng2 bei3 Qu1]
城区|Cheng District or Chengqu, a district of Shanwei City 汕尾市[Shan4 wei3 Shi4], Guangdong;Cheng District or Chengqu, a district of Yan…
城口|see 城口縣，城口县[Cheng2 kou3 Xian4]
城外|outside of a city
城市|city; town
城东|see 城東區，城东区[Cheng2 dong1 Qu1]
城管|local government bylaw enforcement officer;city management (abbr. for 城市管理行政執法局，城市管理行政执法局[Cheng2 shi4 Guan3 li3 Xing2 zheng4 Zhi2 …
城西|see 城西區，城西区[Cheng2 xi1 Qu1]
城镇|town;cities and towns
城门|city gate
城关|see 城關區，城关区[Cheng2 guan1 Qu1]
城阳|see 城陽區，城阳区[Cheng2 yang2 Qu1]
执拗|stubborn; willful; pigheaded;Taiwan pr. [zhi2ao4]
基地|al-Qaeda
基多|Quito, capital of Ecuador
基带|(telecommunications, electronics) baseband
基座|underlay;foundation;pedestal
基情|(slang) bromance;gay love
基数|cardinal number;(math.) radix;base
基本|basic;fundamental;main;elementary
基板|substrate
基业|foundation;base;family estate
基民|fund investor;(coll.) gay person
基波|fundamental (wave)
基尔|Kiel (German city)
基盘|base;foundation;(Tw) (geology) bedrock
基石|foundation stone; cornerstone;(fig.) basis; foundation
基础|base; foundation; basis;basic; fundamental
基网|base net (in geodetic survey)
基线|baseline (surveying, budgeting, typography etc);(math.) base (of a triangle)
基台|(dental implant) abutment
基调|main key (of a musical composition);keynote (speech)
基金|fund
基面|ground plane (in perspective drawing)
基音|fundamental tone
基体|base body;matrix;substrate
基点|base; center;basis; point of departure; starting point;(finance) basis point (abbr. for 基本點，基本点[ji1 ben3 dian3])
坚持|to persevere with;to persist in;to insist on
报上|in the newspaper
报人|journalist (esp. newspaper journalist)
报信|to notify;to inform
报分|call the score
报名|to sign up;to enter one's name;to apply;to register
报告|to inform;to report;to make known;report
报单|a tax declaration form;a tax return
报国|to dedicate oneself to the service of one's country
报子|bearer of good news (esp. announcing success in imperial examinations)
报德|to repay debts of gratitude;to repay kindness
报应|(Buddhism) divine retribution; karma
报数|number off! (command in military drill);count off!
报时|to give the correct time
报业|newspaper industry
报盘|offer;to make an offer (commerce)
报纸|newspaper;newsprint
报表|forms for reporting statistics;report forms
报道|to report (news);report
报关|to declare at customs
报头|masthead (of a newspaper etc);nameplate
场儿|see 場子，场子[chang3 zi5]
场区|(sports) section of a court or playing field;(computer chip manufacture) field area
场合|occasion; situation; context;setting; venue
场地|space;site;place;sports pitch
场子|(coll.) gathering place;public venue
场面|scene;spectacle;occasion;situation
增加|to raise; to increase
士人|scholar
士兵|soldier
士多|(dialect) store (loanword)
士子|official;scholar (old)
士族|land-owning class, esp. during Wei, Jin and North-South dynasties 魏晉南北朝，魏晋南北朝[Wei4 Jin4 Nan2 Bei3 Chao2]
士林|Shilin or Shihlin District of Taipei City 臺北市，台北市[Tai2 bei3 Shi4], Taiwan
士气|morale
外事|foreign affairs
外交|diplomacy;diplomatic;foreign affairs
外人|outsider;foreigner;stranger
外来|external;foreign;outside
外传|to tell others (a secret);to divulge to an outsider;to be rumored
外公|(coll.) mother's father;maternal grandfather
外出|to go out;to go away (on a trip etc)
外力|external force;pressure from outside
外加|in addition;extra
外包|outsourcing
外卡|(sports) wild card (loanword)
外商|foreign businessman;foreign enterprise; foreign company
外国|foreign country
外地|parts of the country other than where one is
外场|outside world;society
外子|(polite) my husband
外带|take-out (fast food);(outer part of) tire;as well;besides
外形|figure;shape;external form;contour
外心|(of a married person) interest in a third person;(old) (of a minister etc) disloyal disposition;(math.) circumcenter (of a polygon…
外手|right-hand side (of a machine);right-hand side (passenger side) of a vehicle
外教|foreign teacher (abbr. for 外國教師，外国教师);greenhorn;novice;amateurish
外文|foreign language (written)
外星|alien;extraterrestrial
外业|on-site operations (e.g. surveying)
外水|extra income
外流|outflow;to flow out;to drain
外海|offshore;open sea
外用|external
外皮|outer skin;carapace
外相|Foreign Minister
外科|surgery (branch of medicine)
外网|the Internet outside the GFW 防火長城，防火长城[Fang2 huo3 Chang2 cheng2]
外线|(military) line of troops encircling an enemy position;(telephony) outside line;(basketball) outside the three-point line
外号|nickname
外行|layman;amateur
外表|external;outside;outward appearance
外语|foreign language
外路|see 外地[wai4 di4]
外边|outside;outer surface;abroad;place other than one's home
外长|foreign minister;secretary of state;minister of foreign affairs
外电|reports from foreign news agencies
外面|outside (also pr. [wai4 mian5] for this sense);surface;exterior;external appearance
外头|outside; outdoors
多事|meddlesome;eventful
多利|Dolly (1996-2003), female sheep, first mammal to be cloned from an adult somatic cell
多国|multinational
多报|to overstate
多士|toast (loanword)
多多|many;much;a lot;lots and lots
多大|how old?;how big?;how much?;so big
多山|mountainous
多工|to multiplex;multiple;multi-
多年|many years;for many years;longstanding
多心|oversensitive;suspicious
多情|affectionate;passionate;emotional;sentimental
多数|majority; most
多方|in many ways;from all sides
多星|starry
多时|long time
多尔|Dole (name);Bob Dole (1923-2021), US Republican politician, Kansas senator 1969-1996
多用|multipurpose;having several uses
多肉|fleshy; meaty;succulents (abbr. for 多肉植物[duo1 rou4 zhi2 wu4])
多变|fickle;(math.) multivariate
多达|up to; no less than; as much as
多边|multilateral
多重|multi- (faceted, cultural, ethnic etc)
多金|rich; wealthy
多音|polyphony
多头|many-headed;many-layered (authority);devolved (as opposed to centralized);pluralistic
夜里|during the night;at night;nighttime
梦想|(fig.) to dream of;dream
大一|first year of university
大三|third year of university
大事|major event;major political event (war or change of regime);major social event (wedding or funeral);(do sth) in a big way
大二|second year of university
大人|adult;grownup;title of respect toward superiors
大作|your work (book, musical composition etc) (honorific);to erupt;to begin abruptly
大内|Danei, a district in Tainan 台南，台南[Tai2 nan2], Taiwan
大全|comprehensive collection
大公|grand duke;impartial
大分|Ōita (prefecture in Japan)
大力|energetically; vigorously
大加|(before a two-syllable verb) considerably;greatly (exaggerate);vehemently (oppose);severely (punish)
大化|see 大化瑤族自治縣，大化瑶族自治县[Da4 hua4 Yao2 zu2 Zi4 zhi4 xian4]
大卡|kilocalorie;big truck
大口|big mouthful (of food, drink, smoke etc);open mouth;gulping;gobbling
大同|see 大同市[Da4 tong2 Shi4];see 大同鄉，大同乡[Da4 tong2 Xiang1];see 大同區，大同区[Da4 tong2 Qu1];(Confucianism) Great Harmony (concept of an ideal…
大名|see 大名縣，大名县[Da4 ming2 Xian4]
大和|Yamato, an ancient Japanese province, a period of Japanese history, a place name, a surname etc;Daiwa, a Japanese place name, busi…
大员|high official
大器|very capable person;precious object
大国|a power (i.e. a dominant country)
大地|earth;mother earth
大城|see 大城縣，大城县[Da4 cheng2 Xian4]
大外|for 大連外國語大學，大连外国语大学[Da4 lian2 Wai4 guo2 yu3 Da4 xue2]
大多|for the most part;many;most;the greater part
大大|greatly;enormously;(dialect) dad;uncle
大学|the Great Learning, one of the Four Books 四書，四书[Si4 shu1] in Confucianism
大安|Da'an, the name of a numerous entities, including districts of several cities, and a county-level city 大安市[Da4 an1 Shi4] in Baiche…
大家|everyone;influential family;great expert
大宁|see 大寧縣，大宁县[Da4 ning2 Xian4]
大小|large and small;size;adults and children;consideration of seniority
大山|Dashan, stage name of Canadian Mark Henry Rowswell (1965-), actor and well-known TV personality in PRC
大巴|(coll.) large bus;coach;(abbr. for 大型巴士)
大干|to go all out;to work energetically
大度|magnanimous;generous (in spirit)
大心|(Tw) considerate; thoughtful (from Taiwanese 貼心, Tai-lo pr. [tah-sim])
大意|general idea;main idea
大战|war;to wage war
大数|Tarsus, Mediterranean city in Turkey, the birthplace of St Paul
大新|see 大新縣，大新县[Da4 xin1 Xian4]
大方|see 大方縣，大方县[Da4 fang1 Xian4]
大族|large and influential family;clan
大会|general assembly;general meeting;convention
大月|solar month of 31 days;a lunar month of 30 days
大有|there is a great deal of ... (typically followed by a bisyllabic word, as in 大有希望[da4 you3 xi1 wang4]);(literary) bumper harvest; …
大东|see 大東區，大东区[Da4 dong1 Qu1]
大业|great cause;great undertaking
大概|roughly;probably;rough;approximate
大正|Taishō, Japanese era name, corresponding to the reign (1912-1926) of emperor Yoshihito 嘉仁[Jia1 ren2]
大气|atmosphere (surrounding the earth);imposing; impressive; stylish
大水|flood
大河|large river (esp the Yellow River)
大油|lard
大海|sea;ocean
大清|Great Qing dynasty (1644-1911)
大火|conflagration; large fire
大热|great heat;very popular
大片|wide expanse;large area;vast stretch;extending widely
大王|king;magnate;person having expert skill in something
大球|sports such as soccer, basketball and volleyball that use large balls;see also 小球[xiao3 qiu2]
大理|see 大理白族自治州[Da4 li3 Bai2 zu2 Zi4 zhi4 zhou1];see 大理市[Da4 li3 Shi4]
大生|(Tw) university student (abbr. for 大學生，大学生[da4 xue2 sheng1])
大用|to put sb in powerful position;to empower
大病|serious illness
大发|Daihatsu, Japanese car company
大白|(of facts or truth) to become fully revealed; to come to light;(old) wine cup;(coll.) whiting (used in whitewash);(coll.) (neologi…
大神|deity;(Internet slang) guru;expert;whiz
大管|bassoon
大节|major festival;important matter;major principle;high moral character
大米|(husked) rice
大约|approximately;probably
大红|crimson
大声|loud voice;in a loud voice;loudly
大肉|pork
大臣|chancellor (of a monarchy);cabinet minister
大号|(music) tuba;(of clothes, print etc) large size; large format;(polite) your (given) name;(coll.) number two; poop; to defecate
大西|Ōnishi (Japanese surname)
大解|to defecate;to empty one's bowels
大调|(music) major key
大变|huge changes
大路|avenue
大军|army;main forces
大转|to turn left (Shanghainese)
大通|see 大通區，大通区[Da4 tong1 Qu1];see 大通回族土族自治縣，大通回族土族自治县[Da4 tong1 Hui2 zu2 Tu3 zu2 Zi4 zhi4 xian4]
大运|World University Games (formerly "Universiade") (abbr. for 大學生運動會，大学生运动会[Da4 xue2 sheng1 Yun4 dong4 hui4])
大过|serious mistake;major demerit
大道|main street;avenue
大量|great amount;large quantity;bulk;numerous
大门|the Doors, US rock band
大开|to open wide
大关|see 大關縣，大关县[Da4 guan1 Xian4]
大头|big head;mask in the shape of a big head;the larger end of sth;the main part
大风|gale
大马|Malaysia
大体|in general; more or less; in rough terms; basically; on the whole;overall situation; the big picture;cadaver for dissection in tra…
大黄|rhubarb (botany)
天上|the sky; the heavens
天下|land under heaven;the whole world;the whole of China;realm
天主|God (in Catholicism);abbr. for 天主教[Tian1 zhu3 jiao4], Catholicism
天人|Man and Heaven;celestial being
天儿|the weather
天全|see 天全縣，天全县[Tian1 quan2 Xian4]
天公|heaven;lord of heaven
天分|natural gift;talent
天台|Mt Tiantai near Shaoxing 紹興，绍兴 in Zhejiang, the center of Tiantai Buddhism 天台宗;Tiantai county in Taizhou 台州[Tai1 zhou1], Zhejiang
天后|Tin Hau, Empress of Heaven, another name for the goddess Matsu 媽祖，妈祖[Ma1 zu3];Tin Hau (Hong Kong area around the MTR station with …
天和|(mahjong) heavenly hand; a hand that is completed by the dealer on their first draw;(mahjong) to obtain a heavenly hand
天国|Kingdom of Heaven
天地|heaven and earth;world;scope;field of activity
天外|for 天津外國語大學，天津外国语大学[Tian1 jin1 Wai4 guo2 yu3 Da4 xue2]
天大|gargantuan;as big as the sky;enormous
天天|every day
天子|the (rightful) emperor;"Son of Heaven" (traditional English translation)
天宁|see 天寧區，天宁区[Tian1 ning2 Qu1]
天山|Tian Shan, mountain range straddling the border between China and Kyrgyzstan
天干|the 10 heavenly stems 甲[jia3], 乙[yi3], 丙[bing3], 丁[ding1], 戊[wu4], 己[ji3], 庚[geng1], 辛[xin1], 壬[ren2], 癸[gui3], used cyclically in…
天平|scales (to weigh things)
天年|natural life span
天心|see 天心區，天心区[Tian1 xin1 Qu1]
天性|nature;innate tendency
天意|providence;the Will of Heaven
天成|as if made by heaven
天数|number of days;fate;destiny
天文|astronomy
天方|(old) Arabia;Arabian
天明|dawn;daybreak
天时|the time;the right time;weather conditions;destiny
天书|imperial edict;heavenly book (superstition);obscure or illegible writing;double dutch
天机|mystery known only to heaven (archaic);inscrutable twist of fate;fig. top secret
天气|weather
天水|see 天水市[Tian1 shui3 Shi4]
天河|Milky Way;see 天河區，天河区[Tian1 he2 Qu1]
天然|natural
天王|emperor;god;Hong Xiuquan's self-proclaimed title;see also 洪秀全[Hong2 Xiu4 quan2]
天球|celestial sphere
天理|Heaven's law;the natural order of things
天生|nature;disposition;innate;natural
天眼|nickname of the FAST radio telescope (in Guizhou)
天神|god;deity
天空|sky
天网|Skynet (nationwide video surveillance system in China)
天线|antenna; aerial;(fig.) connection to higher authorities; channel to influential people
天色|color of the sky;time of day, as indicated by the color of the sky;weather
天花|smallpox;ceiling;stamen of corn;(old) snow
天车|gantry traveling crane
天道|natural law;heavenly law;weather (dialect)
天边|horizon;ends of the earth;remotest places
天量|a staggering number; a mind-boggling amount
天长|see 天長市，天长市[Tian1 chang2 Shi4]
天门|Tianmen sub-prefecture level city in Hubei
天电|atmospherics;static
天头|the upper margin of a page
天马|(mythology) celestial horse;fine horse; Ferghana horse;(Western mythology) Pegasus
天体|celestial body;nude body
天黑|to get dark;dusk
太子|crown prince
太阳|sun;sunlight; sunshine;temple (on the side of the human head) (abbr. for 太陽穴，太阳穴[tai4 yang2 xue2])
夫妻|husband and wife; married couple
失去|to lose
失败|to be defeated;to lose;to fail (e.g. experiments);failure
奇怪|strange;odd;to marvel;to be baffled
契机|opportunity; turning point
奥妙|marvelous;mysterious;profound;marvel
女主|female lead; female protagonist
女人|woman
女儿|daughter
女同|a lesbian (coll.)
女单|women's singles (in tennis, badminton etc)
女士|lady;madam;Miss;Ms
女大|(slang) female university student; female college student
女子|woman;female
女家|bride's family (in marriage)
女工|working woman;variant of 女紅，女红[nu:3 gong1]
女性|woman;the female sex
女方|the bride's side (of a wedding);of the bride's party
女星|female star;famous actress
女书|nüshu writing, a phonetic syllabary for Yao ethnic group 瑤族，瑶族[Yao2 zu2] dialect designed and used by women in Jiangyong county 江永…
女流|(derog.) woman
女王|queen
女生|schoolgirl;female student;girl
女神|goddess;nymph
女红|(literary) the feminine arts (e.g. needlework)
女色|female charms;femininity
女装|women's clothes
女双|women's doubles (in tennis, badminton etc)
女高|(slang) female high school student;all-girls high school
奴隶|slave
奸细|a spy;a crafty person
好不|not at all ...;how very ...
好事|good action, deed, thing or work (also sarcastic, "a fine thing indeed");charity;happy occasion;Daoist or Buddhist ceremony for th…
好人|good person;healthy person;person who tries not to offend anyone, even at the expense of principle
好像|as if;to seem like
好动|active;restless;energetic
好报|karmic reward (resulting from good deeds, in contrast to karmic retribution 惡報，恶报[e4 bao4])
好多|many;quite a lot;much better
好好|in perfectly good condition; perfectly all right;well; thoroughly; carefully; properly
好学|easy to learn
好客|hospitality;to treat guests well;to enjoy having guests;hospitable
好心|kindness;good intentions
好意|good intention;kindness
好战|warlike
好手|expert;professional
好时|Hershey's (brand)
好比|to be just like; can be compared to
好气|(coll.) good mood (usu. used in the negative);angry (usu. used in combination with 好笑[hao3 xiao4])
好物|fine goods
好球|(ball sports) good shot!;nice hit!;well played!
好生|(dialect) very; quite; properly; well; thoroughly
好用|useful;serviceable;effective;handy
好色|to want sex;given to lust;lecherous;lascivious
好话|friendly advice;words spoken on sb's behalf;a good word;kind words
好转|to improve;to take a turn for the better;improvement
好运|good luck
好过|to have an easy time;(feel) well
好道|don't tell me ...;could it be that...?
如果|if; in case; in the event that
妖娆|enchanting;alluring (of a girl)
妖怪|monster;devil
妹妹|younger sister;young woman
妻子|wife and children
始终|from beginning to end;all along
姐妹|sisters;siblings;sister (school, city etc)
姐姐|older sister
姻缘|a marriage predestined by fate
威仪|majestic presence;awe-inspiring manner
娉婷|(literary) (of a woman) to have a graceful demeanor;beautiful woman
婀娜|(of a woman) graceful; elegant; lithe
婆娑|to swirl about;(of leaves and branches) to sway
妈妈|mama;mommy;mother
嫌隙|hostility;animosity
嫣然|beautiful;sweet;engaging
妩媚|lovely;charming
子代|offspring;child's generation
子儿|(coll.) penny;buck
子女|children; sons and daughters
子实|variant of 籽實，籽实[zi3 shi2]
子房|ovary (botany)
子民|people
子网|subnetwork
子路|Zi Lu (542-480 BC), disciple of Confucius 孔夫子[Kong3 fu1 zi3], also known as Ji Lu 季路[Ji4 Lu4]
子长|see 子長市，子长市[Zi3 chang2 Shi4]
子音|consonant
字典|Chinese character dictionary (containing entries for single characters, contrasted with a 詞典，词典[ci2 dian3], which has entries for …
字图|glyph
字形|form of a Chinese character;variant of 字型[zi4 xing2]
字数|number of written characters; number of words; word count
字书|character book (i.e. school primer)
字林|Zilin, Chinese character dictionary with 12,824 entries from ca. 400 AD
字母|letter (of the alphabet)
字眼|wording
字节|(computing) byte
字号|characters and numbers (as used in a code);alphanumeric code;serial number
字词|letters or words;words or phrase
字调|tone of a character
字重|font weight
字面|literal;typeface
字音|phonetic value of a character
字头|single-character headword (in a dictionary);first character of a Chinese word;the top part (esp. a radical) of a Chinese character…
字体|calligraphic style;typeface;font
孩子|child
学人|scholar;learned person
学分|course credit
学制|educational system;length of schooling
学力|scholastic attainments
学区|school district
学名|scientific name;Latin name (of plant or animal);(according to an old system of nomenclature) on entering school life, a formal per…
学员|student;member of an institution of learning;officer cadet
学报|a scholarly journal;Journal, Bulletin etc
学士|bachelor's degree;person holding a university degree
学好|to follow good examples
学子|(literary) student;scholar
学年|academic year
学时|class hour;period
学会|to learn; to master;institute; learned society; (scholarly) association
学期|term;semester
学校|school
学业|studies;schoolwork
学海|sea of learning;erudite;knowledgeable person;scholarship
学理|scientific principle;theoretical standpoint
学生|student;schoolchild
学科|subject;branch of learning;course;academic discipline
学习|to learn; to study
学者|scholar
学号|student ID number
学运|student movement
学长|senior or older male schoolmate
学门|(Tw) field of knowledge;academic discipline
学风|style of study;academic atmosphere;school discipline;school traditions
孽缘|ill-fated relationship
宇宙|universe; cosmos; space
安人|to pacify the people;landlady (old);wife of 員外，员外[yuan2 wai4], landlord
安保|security
安全|safe; secure;safety; security
安分|content with one's lot;knowing one's place
安利|Amway (brand)
安化|see 安化縣，安化县[An1 hua4 Xian4]
安南|Annam (Tang Dynasty protectorate located in what is now northern Vietnam);Annam (autonomous kingdom located in what is now norther…
安可|encore (loanword)
安国|see 安國市，安国市[An1 guo2 Shi4]
安图|see 安圖縣，安图县[An1 tu2 Xian4]
安士|(HK) (loanword) ounce
安多|see 安多縣，安多县[An1 duo1 Xian4]
安好|safe and sound;well
安安|(Tw) (Internet slang) Greetings! (used when it's unknown what time the reader will see one's post, or just to be cute)
安定|stable; calm; settled;to stabilize;Valium; diazepam
安家|to settle down;to set up a home
安宁|see 安寧區，安宁区[An1 ning2 Qu1];see 安寧市，安宁市[An1 ning2 Shi4]
安州|see 安州區，安州区[An1 zhou1 Qu1]
安平|see 安平縣，安平县[An1 ping2 Xian4];see 安平區，安平区[An1 ping2 Qu1]
安得|(literary) How can one get...?; Oh, if only there were... (rhetorical wish);(literary) Is it possible that...?; How can this be? (…
安心|at ease;to feel relieved;to set one's mind at rest;to keep one's mind on sth
安打|base hit (baseball)
安拉|Allah (Arabic name of God)
安新|see 安新縣，安新县[An1 xin1 Xian4]
安时|ampere-hour (Ah)
安乐|see 安樂區，安乐区[An1 le4 Qu1]
安然|calmly;without qualms;free from worry;safe and sound
安生|peaceful;restful;quiet;still
安神|to calm (soothe) the nerves;to relieve uneasiness of body and mind
安装|to install;to erect;to fix;to mount
安身|to make one's home;to take shelter
安达|see 安達市，安达市[An1 da2 Shi4]
安阳|see 安陽市，安阳市[An1 yang2 Shi4];see 安陽縣，安阳县[An1 yang2 Xian4]
安静|quiet;peaceful;calm
安龙|see 安龍縣，安龙县[An1 long2 Xian4]
完成|to complete; to accomplish
官府|authorities;feudal official
定下|to set (the tone, a target etc);to lay down (the beat)
定作|to have sth made to order
定出|to determine;to fix upon;to set (a target, a price etc)
定分|predestination;one's lot (of good and bad fortune)
定力|ability to concentrate;willpower; resolve
定南|see 定南縣，定南县[Ding4 nan2 Xian4]
定名|to name (sth)
定员|fixed complement (of crew, passengers etc)
定单|variant of 訂單，订单[ding4 dan1]
定子|(electricity) stator
定安|Ding'an county, Hainan
定州|see 定州市[Ding4 zhou1 Shi4]
定式|joseki (fixed opening pattern in go game)
定性|to determine the nature (of sth);to determine the chemical composition (of a substance);qualitative
定情|to exchange love tokens or vows;to pledge one's love;to get engaged
定数|constant (math.);quota;fixed number (e.g. of places on a bus);fixed quantity (e.g. load of truck)
定日|see 定日縣，定日县[Ding4 ri4 Xian4]
定时|to fix a time;fixed time;timed (of explosive etc)
定期|at set dates;at regular intervals;periodic;limited to a fixed period of time
定格|to fix;to confine to;freeze frame;stop motion (filmmaking)
定海|Dinghai district of Zhoushan city 舟山市[Zhou1 shan1 shi4], Zhejiang;Qing dynasty name of 舟山市
定然|certainly;of course
定理|theorem
定神|to compose oneself;to concentrate one's attention
定制|custom-made; made-to-order;to have sth custom made
定西|see 定西市[Ding4 xi1 Shi4]
定语|attributive (modifier)
定调|to set the tone
定边|see 定邊縣，定边县[Ding4 bian1 Xian4]
定量|quantity;fixed amount;ration
定金|down payment;advance payment
定音|to call the tune;to make the final decision
定点|to determine a location;designated;appointed;specific
客人|visitor;guest;customer;client
客商|nonlocal merchant; trader from another area
客场|away-game arena;away-game venue
客家|Hakka ethnic group, a subgroup of the Han that in the 13th century migrated from northern China to the south
客房|guest room;room (in a hotel)
客机|passenger plane
客死|to die in a foreign land;to die abroad
客气|polite;courteous;formal;modest
客流|passenger flow;customer flow
客语|Hakka dialect
客车|coach;bus;passenger train
客运|passenger transportation;(Tw) intercity bus
客体|object (philosophy)
害怕|to be afraid; to be scared
家主|head of a household
家事|family matters;domestic affairs;housework
家人|family member;(old) servant
家信|letter to or from home or family
家传|handed down in a family;family traditions
家儿|(old) child, particularly referring to the son who resembles his father
家公|head of a family;(polite) my father;(polite) my grandfather;your esteemed father
家子|household;family
家小|wife and children;wife
家教|family education;upbringing;to bring sb up;private tutor
家数|the distinctive style and techniques handed down from master to apprentice within a particular school
家族|family;clan
家书|see 家信[jia1 xin4]
家业|family property
家法|the rules and discipline that apply within a family;stick used for punishing children or servants;traditions of an artistic or aca…
家用|home-use;domestic;family expenses;housekeeping money
家老|(old) a senior in one's household
家里|home
家语|The School Sayings of Confucius (abbr. for 孔子家語，孔子家语[Kong3 zi3 Jia1 yu3])
家道|family financial circumstances
家长|head of a household;family head;patriarch;parent or guardian of a child
家门|house door;family clan
家电|household electric appliance;abbr. for 家用電器，家用电器
家马|domestic horse
容易|easy; straightforward;likely; liable to; apt to
宿命|predestination;karma
寂寥|(literary) quiet and desolate;lonely;vast and empty
寒冷|cold (climate);frigid;very cold
寥廓|(literary) vast; boundless
实事|fact;actual thing;practical matter
实利|advantage;gain;net profit
实力|strength
实名|real-name (registration etc);non-anonymous
实地|on-site
实女|female suffering absence or atresia of vagina (as birth defect)
实干|to work industriously;to get things done
实心|sincere;solid
实情|the actual situation; the truth
实意|sincere;real meaning
实战|real combat;actual combat
实数|real number (math.);actual value
实时|(in) real time;instantaneous
实木|solid wood
实业|industry;commercial enterprise
实物|material object;concrete object;original object;in kind
实用|to apply in practice;practical; functional; pragmatic; applied (science)
实相|actual situation;the ultimate essence of things (Buddhism)
实线|solid line;continuous line
实行|to implement;to carry out;to put into practice
实词|(linguistics) content word
实话|truth
实变|(math.) real variable
实体|entity;substance;thing that has a material existence (as opposed to a conceptual, virtual or online existence);the real thing (as …
宁化|see 寧化縣，宁化县[Ning2 hua4 Xian4]
宁南|see 寧南縣，宁南县[Ning2 nan2 Xian4]
宁可|preferably;one would prefer to...(or not to...);would rather;(would) be better to
宁国|see 寧國市，宁国市[Ning2 guo2 Shi4]
宁城|see 寧城縣，宁城县[Ning2 cheng2 Xian4]
宁安|see 寧安市，宁安市[Ning2 an1 Shi4]
宁德|see 寧德市，宁德市[Ning2 de2 Shi4]
宁明|see 寧明縣，宁明县[Ning2 ming2 Xian4]
宁武|see 寧武縣，宁武县[Ning2 wu3 Xian4]
宁江|see 寧江區，宁江区[Ning2 jiang1 Qu1]
宁波|see 寧波市，宁波市[Ning2 bo1 Shi4]
宁海|see 寧海縣，宁海县[Ning2 hai3 Xian4]
宁县|Ning County or Ningxian, a county in Qingyang City 慶陽市，庆阳市[Qing4 yang2 Shi4], Gansu
宁边|Yongbyon (Ryeongbyeon), site of North Korean nuclear reactor
宁阳|see 寧陽縣，宁阳县[Ning2 yang2 Xian4]
审判|a trial;to try sb
写字|to write (by hand);to practice calligraphy
宝物|treasure
宝藏|precious mineral deposits;hidden treasure;(fig.) treasure;(Buddhism) the treasure of Buddha's law
宝贝|treasured object;treasure;darling;baby
将来|in the future;future;the future
将军|(common place name)
寻找|to seek; to look for
对上|to fit one into the other;to bring two things into contact
对内|internal;national;domestic (policy)
对口|(of two performers) to speak or sing alternately;to be fit for the purposes of a job or task;(of food) to suit sb's taste
对合|a profit equal to the amount one invested;(math.) involution
对地|targeted (e.g. attacks)
对外|external;foreign;pertaining to external or foreign (affairs)
对子|pair of antithetical phrases;antithetical couplet
对家|partner (in four person game);family of proposed marriage partner
对工|proper
对心|congenial;to one's liking
对战|to do battle (with sb)
对手|opponent;rival;competitor;(well-matched) adversary
对打|to fight (one against one)
对数|(math.) logarithm
对方|the other person; the other side; the other party
对日|(policy etc) towards Japan
对本|(a return) equal to the capital
对比|to contrast;contrast;ratio
对流|convection
对火|to use the tip of another person’s lit cigarette to light one's own
对生|(botany) opposite leaf arrangement;paired leaf arrangement
对白|dialogue (in a movie or a play)
对眼|to squint;to one's liking
对美|(policy etc) towards America
对华|(policy etc) towards China
对号|tick;check mark (✓);number for verification (serial number, seat number etc);(fig.) two things match up
对角|opposite angle
对词|(of actors) to practice lines together; to rehearse a dialogue
对话|to talk (with sb);dialogue; conversation
对调|to swap places;to exchange roles
对路|suitable;to one's liking
对过|across;opposite;the other side
对表|to set or synchronize a watch
对门|the building or room opposite
对开|running in opposite direction (buses, trains, ferries etc)
对面|opposite; across (the street etc);directly in front of one; up ahead;face to face
对头|correct;normal;to be on good terms with;on the right track
对马|Tsushima Island, between Japan and South Korea
小三|mistress;the other woman (coll.);grade 3 in elementary school
小事|trifle;trivial matter
小二|waiter
小人|person of low social status (old);I, me (used to refer humbly to oneself);nasty person;vile character
小传|sketch biography;profile
小儿|young child;(humble) my son
小包|packet
小区|housing estate; community; neighborhood;(telecommunications) cell
小可|small;unimportant;(polite) my humble person
小名|pet name for a child;childhood name
小品|short, simple literary or artistic creation;essay;skit
小城|small town
小报|tabloid newspaper
小女|my daughter (humble)
小子|(literary) youngster;(old) young fellow (term of address used by the older generation);(old) I, me (used in speaking to one's elde…
小孩|child
小学|elementary school; primary school
小小|very small;very few;very minor
小巴|minibus
小心|to be careful;to take care
小数|small figure;small amount;the part of a number to the right of the decimal point (or radix point);fractional part of a number
小时|hour
小本|small capital;on a shoestring
小林|Kobayashi (Japanese surname)
小民|ordinary people;commoner;civilian
小气|stingy;miserly;narrow-minded;petty
小河|creek; stream; brook
小波|wavelet (math.)
小球|sports such as ping-pong and badminton that use small balls;see also 大球[da4 qiu2]
小病|minor illness;indisposition
小白|(slang) novice; greenhorn;(old) (slang) fool; idiot;abbr. for 小白臉，小白脸[xiao3 bai2 lian3], pretty boy
小管|young squid (Tw)
小节|a minor matter;trivia;bar (music)
小米|Xiaomi, Chinese electronics company founded in 2010
小声|in a low voice;(speak) in whispers
小花|(coll.) popular young actress
小菜|appetizer;small side dish;easy job;piece of cake
小号|trumpet;small size (clothes etc);(coll.) a number one; a piss;(humble) our store
小解|to urinate;to empty one's bladder
小说|novel;fiction
小调|xiaodiao, a Chinese folk song genre;(music) minor key
小路|minor road; lane; pathway; trail
小车|small model car;mini-car;small horse-cart;barrow
小转|to turn right (Shanghainese)
小过|little mistake;minor offense;slightly too much
小道|bypath;trail;bribery as a means of achieving a goal;minor arts (Confucian reference to agriculture, medicine, divination, and othe…
小量|a small quantity
小金|see 小金縣，小金县[Xiao3 jin1 Xian4]
小开|(dialect) boss's son;rich man's son;young master
小头|the smaller part or share of sth
小马|colt;pony
小黄|(Tw) (coll.) taxicab
小龙|snake (as one of the 12 Chinese zodiac animals 生肖[sheng1 xiao4])
尾巴|tail;colloquial pr. [yi3 ba5]
居然|unexpectedly;to one's surprise;go so far as to
屋子|house;room
山下|Yamashita (Japanese surname)
山包|(dialect) hill
山区|mountain area
山南|see 山南市[Shan1 nan2 Shi4]
山口|Yamaguchi (Japanese surname, prefecture, and city)
山地|mountainous region;hilly area;hilly country
山城|see 山城區，山城区[Shan1 cheng2 Qu1]
山子|rock garden;rockery
山形|Yamagata (prefecture and city in Japan)
山本|Yamamoto (Japanese surname)
山东|see 山東省，山东省[Shan1 dong1 Sheng3]
山林|wooded mountain; mountain forest
山水|Sansui, Japanese company
山河|mountains and rivers;the whole country
山海|mountains and seas
山火|wildfire;forest fire
山神|mountain god
山行|mountain hike
山西|see 山西省[Shan1 xi1 Sheng3]
山谷|valley;ravine
山路|mountain road
山门|monastery main gate (Buddhism);monastery
山阿|a nook in the mountains
山阳|see 山陽區，山阳区[Shan1 yang2 Qu1];see 山陽縣，山阳县[Shan1 yang2 Xian4]
山头|mountain top, esp. one occupied by a mountain stronghold;(fig.) clique; power base
山体|form of a mountain
屹立|to tower;to stand straight (of person's bearing)
峻峭|high and steep
崎岖|rugged;craggy
嶙峋|bony (of people);craggy;rugged (of terrain);upright (of people)
州长|governor (of a province or colony);(US) state governor;(Australian) state premier
巡视|to inspect (a site); (of a dignitary) to visit; to go on an inspection tour;to survey (a scene); to scan with one's eyes
工事|defensive structure;military fortifications;(Tw) construction works;civil engineering works
工人|worker
工作|to work;(of a machine) to operate;job;work
工分|work point (measure of work completed in a rural commune in the PRC during the planned economy era)
工口|erotic (loanword mimicking the shape of Japanese katakana エロ, pronounced "ero")
工商|industry and commerce
工单|work order; job ticket;(IT, customer service) service ticket
工地|construction site
工学|engineering;industrial science
工厂|factory
工房|workshop;temporary housing for workers;workers' living quarters
工时|man-hour
工会|labor union; trade union
工期|project duration; construction period
工业|industry
工科|engineering as an academic subject
工号|employee number
工行|ICBC (Industrial and Commercial Bank of China);abbr. for 工商銀行，工商银行[Gong1 Shang1 Yin2 hang2]
工装|work clothes; workwear
工头|foreman
工体|for 北京工人體育場，北京工人体育场[Bei3 jing1 Gong1 ren2 Ti3 yu4 chang3], Workers Stadium
已经|already
巴中|see 巴中市[Ba1 zhong1 Shi4]
巴利|the Pali language or, more broadly, the scriptural and literary tradition of Theravada Buddhism
巴力|Baal, god worshipped in many ancient Middle Eastern communities
巴南|see 巴南區，巴南区[Ba1 nan2 Qu1]
巴士|bus (loanword);motor coach
巴山|Mt Ba in eastern Sichuan
巴州|East Sichuan and Chongqing;also abbr. for Bayingolin Mongol Autonomous Prefecture in Xinjiang;abbr. for 巴音郭楞蒙古自治州[Ba1 yin1 guo1 le…
巴巴|(suffix) very;extremely
巴斯|Bath city in southwest England
巴新|Papua New Guinea (abbr. for 巴布亞新幾內亞，巴布亚新几内亚[Ba1 bu4 ya4 Xin1 Ji3 nei4 ya4])
巴东|see 巴東縣，巴东县[Ba1 dong1 Xian4]
巴林|Bahrain
巴特|Barth or Barthes (name);Roland Barthes (1915-1980), French critic and semiotician
巴生|Klang (city in Malaysia)
巴县|Ba county in Chongqing 重慶市，重庆市, Sichuan
巴西|Brazil
巴解|Palestine Liberation Organization (PLO) (abbr. for 巴勒斯坦解放組織，巴勒斯坦解放组织[Ba1 le4 si1 tan3 Jie3 fang4 Zu3 zhi1])
巴里|Bari (Puglia, Italy)
巴金|Ba Jin (1904–2005), novelist, author of the trilogy 家春秋[Jia1 Chun1 Qiu1]
巴阿|Pakistan-Afghan
巴青|see 巴青縣，巴青县[Ba1 qing1 Xian4]
巴马|see 巴馬瑤族自治縣，巴马瑶族自治县[Ba1 ma3 Yao2 zu2 Zi4 zhi4 xian4]
市中|see 市中區，市中区[Shi4 zhong1 Qu1]
市内|inside the city
市分|fen (Chinese unit of length equal to ⅓ centimeter)
市制|Chinese units of measurement
市北|see 市北區，市北区[Shi4 bei3 Qu1]
市区|urban district;downtown;city center
市南|see 市南區，市南区[Shi4 nan2 Qu1]
市场|marketplace; market; bazaar;(economics) market
市民|city resident; townspeople
市县|towns and counties
市里|li (Chinese unit of length equal to 500 meters)
市长|mayor
市电|utility power; mains electricity
市面|the marketplace (i.e. the world of business and commerce)
布下|to arrange;to lay out
布城|Putrajaya, federal administrative territory of Malaysia, south of Kuala Lumpur city 吉隆坡市
布林|Boolean (math.) (Tw)
布尔|(math.) Boolean
布线|wiring
布草|hotel linens
希望|to hope;a hope; a wish
师傅|master;qualified worker;respectful form of address for older men
带上|to take along with one
带来|to bring;(fig.) to bring about; to produce
带儿|erhua variant of 帶，带[dai4]
带动|to spur; to provide impetus; to drive
带回|to bring back; to take back with one
带大|(coll.) to raise (a child or animal) to adulthood; to bring up
带子|belt; band; ribbon; strap; girdle;(coll.) audio or video tape;Farrer's scallop (Chlamys farreri);comb pen shell (Atrina pectinata)
带有|to have as a feature or characteristic; to have an element of (confidence, sweetness, malevolence etc); to carry (a pathogen, conn…
带气|carbonated (drink);sparkling (mineral water);to display annoyance;to be dissatisfied
带病|to be suffering from an illness (often implying "in spite of being sick");to carry the causative agent of an infectious disease
带调|to have a tone mark
带路|to lead the way; to guide; to show the way;(fig.) to instruct
带过|to give sth only cursory attention;to treat sth as not very significant
带电|to be electrified; to be charged; to be live
带头|to take the lead; to be the first; to set an example
带鱼|ribbonfish;hairtail;beltfish;cutlassfish (family Trichiuridae)
常常|frequently; often
帽子|hat;cap;(fig.) label;bad name
帮助|assistance; aid;to help; to assist
平人|ordinary person;common people
平信|ordinary mail (as opposed to air mail etc)
平分|to divide evenly;to bisect (geometry);deuce (tennis);tied score
平利|see 平利縣，平利县[Ping2 li4 Xian4]
平南|see 平南縣，平南县[Ping2 nan2 Xian4]
平原|field;plain
平反|to redress (an injustice); to rehabilitate (sb whose reputation was unjustly sullied)
平和|see 平和縣，平和县[Ping2 he2 Xian4]
平地|to level the land;level ground;plain
平城|see 平城區，平城区[Ping2 cheng2 Qu1]
平安|see 平安區，平安区[Ping2 an1 Qu1]
平定|see 平定縣，平定县[Ping2 ding4 Xian4]
平实|simple and unadorned;plain;(of land) level;even
平山|see 平山縣，平山县[Ping2 shan1 Xian4];see 平山區，平山区[Ping2 shan1 Qu1]
平平|average;mediocre
平年|common year
平度|see 平度市[Ping2 du4 Shi4]
平成|Heisei, Japanese era name, corresponding to the reign (1989-2019) of emperor Akihito 明仁[Ming2 ren2]
平房|see 平房區，平房区[Ping2 fang2 Qu1]
平手|(sports) draw;tie
平方|square (as in square foot, square mile, square root)
平日|ordinary day;everyday;ordinarily;usually
平明|(literary) dawn;daybreak;impartial and astute
平时|ordinarily;in normal times;in peacetime
平月|February of a common year
平板|slab; flat board; (engineering) surface plate;flat; level;(fig.) dull; monotonous;tablet computer (abbr. for 平板電腦，平板电脑[ping2 ban3 …
平果|see 平果市[Ping2 guo3 Shi4]
平乐|see 平樂縣，平乐县[Ping2 le4 Xian4]
平武|see 平武縣，平武县[Ping2 wu3 Xian4]
平民|ordinary people; commoner (contrasted with the privileged);civilian (contrasted with the military)
平江|see 平江縣，平江县[Ping2 jiang1 Xian4]
平生|all one's life
平白|for no reason;gratuitously
平空|variant of 憑空，凭空[ping2 kong1]
平米|square meter (abbr. for 平方米[ping2 fang1 mi3])
平罗|see 平羅縣，平罗县[Ping2 luo2 Xian4]
平声|level or even tone;first and second tones in modern Mandarin
平台|platform;terrace;flat-roofed building
平行|parallel (in a spatial or geometric sense, or figuratively);on an equal footing; on the same level;simultaneous; concurrent
平装|paperback;paper-cover
平角|(math.) straight angle
平话|storytelling dramatic art dating back to Song and Yuan periods, single narrator without music, often historical topics with commen…
平身|(old) to stand up (after kowtowing);You may rise.
平阳|see 平陽縣，平阳县[Ping2 yang2 Xian4]
平静|calm; tranquil; serene
平面|(geometry) plane;flat surface;flat; two-dimensional
平头|closely cropped hair; crew cut;(of people) common; ordinary
年上|(slang) the older person in a romantic relationship; an older partner
年下|(slang) the younger person in a romantic relationship; a younger partner
年中|within the year;in the middle of the year;mid-year
年事|years of age;age
年代|a decade of a century (e.g. the Sixties);age;era;period
年来|this past year;over the last years
年内|during the current year
年前|by the end of the year;at the end of the year; shortly before New Year
年报|annual report; annual publication
年年|year after year; yearly; every year; annually
年度|year (e.g. school year, fiscal year);annual
年成|the year's harvest
年会|annual meeting
年月|months and year;time;days of one's life
年节|the New Year festival
年老|aged
年华|years;time;age
年号|reign title;era name (name for either the entire reign of an emperor or one part of it);year number (such as 2016 or 甲子)
年表|timeline;chronology;annals;financial year
年轻|young
年过|over (a certain age)
年金|annuity;pension;superannuation
年长|senior
年关|end of the year
年青|youthful
年头|start of the year;whole year;a particular year;period
幸福|happiness;happy;blessed
干事|administrator;executive secretary
干流|main stream (of a river)
干线|main line;trunk line
干练|capable and experienced
干话|(Tw) (slang) remark that sounds like it makes sense but is actually nonsense
干道|arterial road;main road;main watercourse
幽暗|gloom
幽邃|profound and unfathomable
幽静|quiet;secluded;isolated;peaceful
几乎|almost; nearly; practically
底细|inside information;the ins and outs of the matter;how things stand;what's up
度外|outside the sphere of one's consideration
度数|number of degrees;reading (on a meter);strength (alcohol, lenses etc)
度日|to pass one's days;to scratch out a difficult, meager existence
度过|to pass;to spend (time);to survive;to get through
度量|measure;tolerance;breadth;magnanimity
座儿|rickshaw seat (Beijing dialect);patron (of teahouse, cinema);passenger (in taxi, rickshaw etc)
座子|pedestal;plinth;saddle
座机|fixed-line phone; landline;private plane
座号|seat number
座车|(railway) carriage
广袤|vast
建立|to establish;to set up;to found
建造|to construct; to build
式子|posture;(math.) expression; formula
弓箭|bow and arrow
弟子|disciple; follower
弟弟|younger brother
形上|metaphysics
形制|form;shape;structure;design
形同|tantamount to;to be like
形式|outer appearance;form;shape;formality
形成|to form; to take shape
形神|body and soul;physical and spiritual;material form and internal spirit
形声|ideogram plus phonetic (one of the Six Methods 六書，六书 of forming Chinese characters);also known as phonogram, phonetic compound or …
形色|shape and color;appearance;facial expression
形变|deformation; bending
形体|figure;physique;form and structure
彪悍|tough as nails;formidable;kick-ass;plucky
彷徨|to pace back and forth, not knowing which way to turn; to hesitate; to waver
后事|future events;and what happened next... (in fiction);funeral arrangements
后人|later generation
后代|descendant; progeny;posterity; later ages; later generations
后来|afterwards; later;newly arrived
后传|sequel
后儿|the day after tomorrow
后加|postposition (grammar)
后台|backstage area;behind-the-scenes supporter;(computing) back-end;background
后天|the day after tomorrow;life after birth (the period in which one develops through experiences, contrasted with 先天[xian1 tian1]);ac…
后学|junior scholar or pupil in imperial China
后年|the year after next
后心|middle of the back
后手|defensive position (in chess);room for maneuver; a way of escape
后文|the text below; the following text;(fig.) what happened next; later developments
后方|the rear;far behind the front line
后日|the day after tomorrow;from hence;from now;from now on
后期|late stage;later period
后果|consequences; aftermath
后海|Houhai, a lake and the area surrounding it in central Beijing
后生|young generation;youth;young man
后者|the latter
后制|postproduction
后话|something to be taken up later in speech or writing
后调|(perfumery) base note
后路|escape route;retreat route;communication lines to the rear;alternative course of action
后边|the back; the rear; the last bit;behind; near the end; at the back;later; afterwards
后金|Later Jin dynasty (from 1616-);Manchu Khanate or kingdom that took over as Qing dynasty in 1644
后门|back door; back gate;(fig.) back-door influence; under-the-table dealings;anus;(computing) backdoor
后面|the back; the rear; the last bit;behind; near the end; at the back;later; afterwards
后头|behind;the back;the rear;later
徒弟|apprentice;disciple
得中|moderate; appropriate; suitable
得主|recipient (of an award);winner (in a competition)
得来|to come by; to obtain through some means
得出|to obtain (a result); to arrive at (a conclusion)
得分|to score a point (in a competition, test etc);score; rating; grade
得利|to benefit (from sth)
得到|to get; to obtain; to receive
得力|able;capable;competent;efficient
得名|to get one's name;named (after sth)
得意|proud of oneself;pleased with oneself;complacent
得手|to go smoothly; to come off; to succeed
得数|(math.) numerical answer;solution
得文|Devon (county of southwest England)
得气|"to obtain qi", the sensation of electrical tingling, numbness, soreness etc at the meridian where accupuncture needle is inserted
得法|(doing sth) in the right way;suitable;properly
得无|(literary) isn't it that...?
得病|to fall ill;to contract a disease
得空|to have leisure time
得色|pleased with oneself
得起|(verb complement indicating ability to afford or bear the cost or consequences of doing sth)
得道|to achieve the Dao;to become an immortal
得体|appropriate to the occasion;fitting
徘徊|to pace back and forth;to dither; to hesitate;(of sales figures etc) to fluctuate
从来|always;at all times;never (if used in negative sentence)
从前|previously;formerly;once upon a time
微笑|smile;to smile
征兆|omen;sign (that sth is about to happen);warning sign
德三|Nazi Germany;Third Reich (shorthand for 第三帝國，第三帝国[Di4 san1 Di4 guo2])
德保|see 德保縣，德保县[De2 bao3 Xian4]
德化|see 德化縣，德化县[De2 hua4 Xian4]
德国|Germany
德城|see 德城區，德城区[De2 cheng2 Qu1]
德士|(Singapore, Malaysia) taxi (loanword)
德安|see 德安縣，德安县[De2 an1 Xian4]
德州|see 德州市[De2 zhou1 Shi4];Texas (abbr. for 德克薩斯州，德克萨斯州[De2 ke4 sa4 si1 Zhou1])
德干|Deccan (India)
德式|German-style
德性|moral integrity
德文|German (language)
德格|see 德格縣，德格县[De2 ge2 Xian4]
德比|(sports) (loanword) derby (contest between local rivals)
德江|see 德江縣，德江县[De2 jiang1 Xian4]
德清|see 德清縣，德清县[De2 qing1 Xian4]
德行|morality and conduct;Taiwan pr. [de2 xing4]
德语|German (language)
德里|Delhi;New Delhi, capital of India;same as 新德里[Xin1 De2 li3]
德阳|see 德陽市，德阳市[De2 yang2 Shi4]
彻悟|fully aware;to recognize fully
心下|in mind
心中|central point;in one's thoughts;in one's heart
心事|a load on one's mind;worry
心力|mental and physical efforts
心动|heartbeat; heart rate;(fig.) emotionally affected; aroused (of desire, emotion, interest etc)
心包|pericardium
心口|pit of the stomach;solar plexus;words and thoughts
心土|subsoil
心地|character
心学|School of Mind;Neo-Confucian Idealistic School (from Song to mid-Qing times, c. 1000-1750, typified by the teachings of Wang Yangm…
心安|at ease; reassured
心得|what one has learned (through experience, reading etc);knowledge;insight;understanding
心性|one's nature;temperament
心情|mood; frame of mind
心意|intention;regard; kindly feelings
心战|psychological warfare;(literary) to be inwardly terrorized
心房|heart (as the seat of emotions);cardiac atrium
心机|thinking;scheme
心气|intention;motive;state of mind;ambition
心流|(psychology) flow;being "in the zone"
心理|psychology; mentality
心病|anxiety;sore point;secret worry;mental disorder
心眼|heart;intention;conscience;consideration
心神|mind;state of mind;attention;(Chinese medicine) psychic constitution
心经|the Heart Sutra
心声|heartfelt wish; inner voice; aspiration
心腹|trusted aide; confidant
心脏|heart
心血|heart's blood;expenditure (for some project);meticulous care
心里|chest;heart; mind
心路|scheme;artifice;tolerance;intention
心道|(literary) to think to oneself
心酸|to feel sad
心重|overanxious;neurotic
心音|sound of the heart;heartbeat
心头|one's heart; one's mind
必须|to have to;must;compulsory;necessarily
忐忑|apprehensive; on edge
忖度|to speculate;to surmise;to wonder whether;to guess
忘记|to forget
快乐|happy; joyful
忽然|suddenly; all of a sudden
思忖|to ponder;to reckon;to turn sth over in one's mind
思念|to think of;to long for;to miss
怡然|happy;joyful
急忙|hastily
性事|sex
性交|sexual intercourse
性器|sex organ
性地|innate quality;natural disposition
性子|temper
性学|sexology
性情|nature;temperament
性格|nature;disposition;temperament;character
性乐|sexual pleasure;orgasm
性病|sexually transmitted disease; venereal disease
性行|sexual activity
性转|(slang) to be genderswapped (abbr. for 性別轉換，性别转换[xing4 bie2 zhuan3 huan4])
恍惚|absent-minded;distracted;dazzled;vaguely
恍然|suddenly (perceive);confused; vague; distracted
恐怕|fear;to dread;I'm afraid that...;perhaps
恢复|to reinstate;to resume;to restore;to recover
恩怨|gratitude and grudges;resentment;grudges;grievances
恬淡|quiet and contented;indifferent to fame or gain
悄悄|quiet; making little or no noise;surreptitious; stealthy;anxious; worried;Taiwan pr. [qiao3qiao3]
悚然|frightened;terrified
悲伤|sad; sorrowful
悲恸|mournful
怅然|disappointed and frustrated
情事|circumstances;facts (of a case);case;feelings
情人|lover;sweetheart
情儿|(dialect) mistress; paramour
情分|mutual affection; friendship
情商|emotional intelligence; emotional intelligence quotient (EQ) (abbr. for 情緒商數，情绪商数[qing2 xu4 shang1 shu4]);(Tw) to ask a special fa…
情报|information; intelligence
情场|affairs of the heart;mutual relationship
情定|to exchange vows with (sb);to exchange vows at (a time or place)
情形|circumstances; situation; state of affairs
情意|friendly regard; affection
情愫|sentiment;feeling
情书|love letter
情况|circumstances; state of affairs; situation
情理|reason;sense
情节|circumstances;plot; storyline
情网|snare of love
情色|erotic (of art etc);facial expression (archaic)
情话|terms of endearment;words of love
情谊|friendship; camaraderie
情调|ambience; mood; flavor
情变|loss of love;breakup of a relationship
情面|feelings and sensibilities;sentiment and face;sensitivity to other's feelings
情头|"lovers' avatar" – avatar that matches the avatar of a significant other (e.g. two halves of one image, two images drawn in a simi…
惘然|frustrated;perplexed;irresolute;dazed
想念|to miss;to remember with longing;to long to see again
想法|way of thinking; opinion; notion;to think of a way (to do sth)
想要|to want to;to feel like;to fancy;to care for sb
想起|to recall;to think of;to call to mind
恻隐|compassion;empathetic
愉快|cheerful; happy; pleasant; delighted
意中|according with one's wish or expectation
意图|intent;intention;to intend
意外|unexpected;accident;mishap
意式|Italian-style
意志|will; willpower; determination
意思|idea;opinion;meaning;wish
意会|to sense;to grasp intuitively
意乐|joy;happiness
意义|sense;meaning;significance;importance
意面|pasta (abbr. for 意大利麵，意大利面[yi4 da4 li4 mian4]);(Tw) yi mein, a variety of Cantonese egg noodle
愕然|stunned;amazed
愚蠢|silly;stupid
感冒|to catch cold;(common) cold;(coll.) to be interested in (often used in the negative);(Tw) to detest
感到|to feel; to sense; to perceive
感激|to be grateful;to appreciate;thankful
感谢|to thank; to be grateful
慢慢|slowly; gradually
怂恿|to instigate; to incite; to urge; to encourage
忧愁|to be worried
憨厚|simple and honest;straightforward
应该|ought to; should; must
怀疑|to doubt (sth); to be skeptical of;to have one's doubts; to harbor suspicions; to suspect that
成事|to accomplish the objective;to succeed
成交|to complete a contract;to reach a deal
成人|to reach adulthood;an adult
成全|to help sb accomplish his aim;to help sb succeed;to complete;to make whole
成分|composition; ingredient; element; component;one's social status
成功|to succeed;success;successful; fruitful
成化|Chenghua, reign title of the eighth Ming emperor (reigned 1465-1487)
成名|to make one's name; to become famous
成品|finished goods;a finished product
成员|member
成器|to make sth of oneself;to become a person who is worthy of respect
成报|Sing Pao Daily News
成大|National Cheng Kung University (abbr. for 成功大學，成功大学[Cheng2 gong1 Da4 xue2])
成天|(coll.) all day long;all the time
成安|see 成安縣，成安县[Cheng2 an1 Xian4]
成家|to settle down and get married (of a man);to become a recognized expert
成对|to form a pair
成年|to grow to adulthood;fully grown; adult;the whole year
成形|to take shape;shaping;forming
成心|intentionally; deliberately; on purpose
成性|to become second nature;by nature
成教|adult education (abbr. for 成人教育[cheng2 ren2 jiao4 yu4])
成文|written;statutory
成方|(TCM) set prescription (i.e. medicine specifically prescribed for a definite condition)
成日|all day long;the whole day;the whole time
成书|to finish (writing a book); to appear in book form;a book already in circulation
成本|(manufacturing, production etc) costs
成果|result;achievement;gain;profit
成武|see 成武縣，成武县[Cheng2 wu3 Xian4]
成为|to become; to turn into
成片|(of a large number of things) to form an expanse;to cover an area
成县|Cheng County or Chengxian, a county in Longnan City 隴南市，陇南市[Long3 nan2 Shi4], Gansu
成绩|achievement;performance records;grades
成色|relative purity of silver or gold;purity in carat weight;quality;fineness
成华|see 成華區，成华区[Cheng2 hua2 Qu1]
成行|to embark on a journey
成话|to make sense
成语|Chinese set expression, typically of 4 characters, often alluding to a story or historical quotation; idiom; proverb; saying; adag…
成军|to form an army;to set up (team, group, band, organization etc);to found;opening (ceremony)
成道|to reach illumination (Buddhism)
成长|to mature;to grow;growth
成风|to become a common practice; to become a trend
成骨|bone formation;osteogenesis
成体|adult;fully formed;developed
成龙|Jackie Chan (1954-), kungfu film and Cantopop star
我们|we; us; ourselves; our
或许|perhaps; maybe
战事|war;hostilities;fighting
战力|military strength;military power;military capability
战区|war zone;combat zone;(military) theater of operations
战国|the Warring States period (475-221 BC)
战地|battlefield
战报|battle report; (sports) match summary
战场|battlefield
战士|fighter;soldier;warrior
战后|after the war;postwar
战时|wartime
战书|written war challenge
战机|opportunity in a battle;fighter aircraft;war secret
战死|to die in combat
战法|military strategy
战火|the flames of war; the ravages of war
战争|war; conflict
战线|battle line;battlefront;front
战车|war chariot;tank
战马|warhorse
战斗|to fight;to engage in combat;struggle;battle
戾气|evil tendencies;vicious currents;antisocial behavior
房下|(old) one's wife
房主|landlord;house owner
房事|sexual intercourse;to make love
房卡|room card (in a hotel)
房子|house;building (single- or two-story);apartment;room
房客|tenant
房山|see 房山區，房山区[Fang2 shan1 Qu1]
房市|real estate market
房东|landlord
房县|Fang County or Fangxian, a county in Shiyan City 十堰市[Shi2 yan4 Shi4], Hubei
房车|recreational vehicle
房门|door of a room
房间|room
所以|therefore;as a result;so;the reason why
所有|all;to have; to possess; to own
手下|under one's control or administration;subordinates;(money etc) on hand;sb's financial means
手交|handjob;manual stimulation
手动|manual;manually operated;manual gear-change
手包|handbag
手定|to set down (rules);to institute
手工|handwork;manual
手式|gesture; sign; signal
手心|palm (of one's hand);control (extended meaning from having something in the palm of one's hand)
手性|chiral;chirality (chemistry)
手书|to write personally;personal letter
手机|cell phone; mobile phone
手气|luck (in gambling)
手法|technique;trick;skill
手球|handball (the game or the ball itself);handball (a foul in soccer)
手用|hand-used;hand (tool)
手相|palmistry;features of a palm (in palmistry)
手里|in hand;(a situation is) in sb's hands
手制|to make by hand;handmade
手语|sign language
手边|on hand;at hand
手表|wristwatch
手电|flashlight;torch
手头|on hand;at hand;one's financial situation
打下|to lay (a foundation);to conquer (a city etc);to shoot down (a bird etc)
打中|to hit (a target)
打光|(photography, filmmaking) to set up the lighting; to illuminate a scene;to polish; to buff; to give luster to (a surface, esp. sto…
打入|to penetrate; to break into (a market, social group etc); to infiltrate (enemy ranks etc);to banish to; to relegate to;to insert; …
打分|to grade;to give a mark
打动|to move (to pity);arousing (sympathy);touching
打包|to wrap; to pack;to put leftovers in a doggy bag for take-out;(computing) to package (i.e. create an archive file)
打卡|(of an employee) to clock on (or off); to punch in (or out);(on social media) to check in to a location
打口|(of CDs, videos etc) surplus (or "cut-out") stock from Western countries, sometimes marked with a notch in the disc or its case, s…
打场|to thresh grain (on the floor)
打字|to type (using a keyboard, typewriter or phone etc)
打小|(dialect) from childhood; from a young age
打工|to work a temporary or casual job;(of students) to have a job outside of class time, or during vacation
打成|to beat (sb or sth) into (a certain condition);to denounce (sb) as (sth contemptible)
打手|hired thug
打新|(finance) to participate in an IPO (initial public offering)
打架|to fight;to scuffle;to come to blows
打死|to kill;to beat to death
打气|to inflate; to pump up;(fig.) to encourage; to boost morale
打水|to draw water;to splash water
打法|to play (a card);to make a move in a game
打球|to play ball;to play with a ball
打理|to take care of;to sort out;to manage;to put in order
打发|to dispatch sb to do sth;to make sb leave;to pass (the time);(old) to make arrangements
打眼|to drill or bore a hole;to attract attention;conspicuous
打算|to plan;to intend;to calculate;plan
打网|to net sth;to catch sth with a net
打草|to mow grass;haymaking;to write a rough draft (of an essay etc)
打兰|dram (1⁄16 ounce) (loanword)
打制|to make (by hammering, chipping etc);to forge (silverware, metal implements etc)
打车|to take a taxi (in town);to hitch a lift
打转|to spin;to rotate;to revolve
打通|to open access;to establish contact;to remove a block;to put through (a phone connection)
打酒|to buy liquor
打量|to size sb up;to look sb up and down;to take the measure of;to suppose
打表|to run the meter (in a taxi)
打门|to knock on the door;to take a shot on goal (sports)
打开|to open;to show (a ticket);to turn on;to switch on
打鱼|to fish
打黑|to crack down on illegal activities; to fight organized crime
打点|to bribe;to get (luggage) ready;to put in order;to organize things
批评|to criticize; criticism
找到|to find
承认|to admit;to concede;to recognize;recognition (diplomatic, artistic etc)
抓住|to grab hold of; to capture
折服|to convince;to subdue;to be convinced;to be bowled over
折磨|to torment; to torture
抬头|to raise one's head; to look up;(fig.) to begin to emerge; to show signs of growth;(commerce) account name, or space for writing t…
抱歉|to be sorry;to feel apologetic;sorry!
抽噎|to sob
拉入|to pull into;to draw in
拉力|pulling force;(fig.) allure;(materials testing) tensile strength;(loanword) rally
拉动|to pull;(fig.) to stimulate (economic activity);to motivate (people to do sth)
拉客|to solicit (guests, clients, passengers etc);to importune
拉布|(Hong Kong) to filibuster
拉平|to bring to the same level;to even up;to flare out;to flatten out
拉德|rad (unit of absorbed dose of ionizing radiation) (loanword)
拉手|to hold hands;to shake hands
拉拉|Lala, Philippines
拉新|(marketing) to acquire new users; to bring in new customers
拉比|(loanword) rabbi
拉皮|to have a facelift;facelift
拉管|trombone
拉美|Latin America;abbr. for 拉丁美洲
拉制|drawing (manufacturing process in which hot metal or glass is stretched)
拉话|(dialect) to chat
拉里|lari (currency of Georgia) (loanword)
拉长|to lengthen;to pull sth out longer
拉开|to pull open;to pull apart;to space out;to increase
拉风|trendy; eye-catching; flashy
拉高|to pull up
拉面|pulled noodles;ramen
拉黑|to add sb to one's blacklist (on a cellphone, or in instant messaging software etc);abbr. for 拉到黑名單，拉到黑名单
拒绝|to refuse; to decline; to reject
拮据|hard pressed for money; in financial straits
拼命|to do one's utmost; with all one's might; at all costs; (to work or fight) as if one's life depends on it
拼音|phonetic writing;pinyin (Chinese romanization)
拿起|to pick up
按照|according to; in accordance with; on the basis of
挺拔|tall and straight
排解|to mediate;to reconcile;to make peace;to intervene
接受|to accept (a suggestion, punishment, bribe etc); to acquiesce
提醒|to remind;to call attention to;to warn of
提高|to raise;to increase;to improve
揣测|to guess;to conjecture
摇头|to shake one's head
拥有|to have; to possess; to own
操守|personal integrity
担心|anxious;worried;uneasy;to worry
扩大|to expand;to enlarge;to broaden one's scope
支持|to be in favor of;to support;to back;support
收获|variant of 收穫，收获[shou1 huo4]
改变|to change;to alter;to transform
放下|to lay down; to put down;to let go of; to relinquish; to set aside;to lower (the blinds etc)
放学|to dismiss students at the end of the school day
放心|to feel relieved;to feel reassured;to be at ease
放弃|to renounce; to abandon; to give up
放浪|unrestrained;dissolute;dissipated;unconventional
放开|to let go;to release
政府|government
故事|old practice
敏锐|keen; sharp; acute
教主|founder or leader of a religion or sect;(fig.) revered figure
教化|to enlighten;to civilize;to indoctrinate;to train (an animal)
教区|diocese;parish
教员|teacher;instructor
教唆|to instigate;to incite;to abet
教士|churchman;clergy
教子|to educate one's children;godson
教学|to teach
教安|teach in peace (polite phrase to end a letter to a teacher)
教室|classroom
教书|to work as a teacher; to teach (in a school)
教会|to show;to teach
教本|textbook
教民|adherent to a religion;convert
教法|teaching method;teachings;doctrine
教理|doctrine (religion)
教长|dean;mullah;imam (Islam);see also 伊瑪目，伊玛目[yi1 ma3 mu4]
教头|sporting coach;military drill master (in Song times)
敬仰|to revere;highly esteemed
敌人|enemy
数出|to count out (a sum of money etc)
数字|numeral;digit;number;figure
数学|mathematics
数年|several years;many years
数数|to count;to reckon
数月|several months
数法|method of counting (e.g. decimal or Roman numbers)
数清|to count;to enumerate exactly
数理|mathematical sciences
数词|numeral
数量|amount; quantity;quantitative;(math.) scalar quantity
数点|to count;to itemize
文人|cultivated individual; scholar; literati
文化|culture;civilization;cultural
文员|office worker; clerk
文士|literati;scholar
文字|character;script;writing;written language
文学|literature
文安|see 文安縣，文安县[Wen2 an1 Xian4]
文山|see 文山壯族苗族自治州，文山壮族苗族自治州[Wen2 shan1 Zhuang4 zu2 Miao2 zu2 Zi4 zhi4 zhou1];see 文山區，文山区[Wen2 shan1 Qu1];see 文山市[Wen2 shan1 Shi4]
文成|see 文成縣，文成县[Wen2 cheng2 Xian4]
文教|culture and education
文明|civilized;civilization;culture
文书|document;official correspondence;secretary;secretariat
文本|a text (article, script, contract etc);version of a text (copy, translation, abridged version etc);(computing) text
文武|civil and military
文气|the impact of a piece of writing on the reader;gentle;refined
文水|see 文水縣，文水县[Wen2 shui3 Xian4]
文法|grammar
文火|small flame (when cooking, simmering etc)
文物|cultural relic;historical relic
文理|arts and sciences
文石|aragonite (geology)
文科|liberal arts;humanities
文章|article;essay;literary works;writings
文县|Wen County or Wenxian, a county in Longnan City 隴南市，陇南市[Long3 nan2 Shi4], Gansu
文号|document identifier code (typically including an abbreviation for the name of the issuing organization, the date and a serial numb…
文词|variant of 文辭，文辞[wen2 ci2]
文身|to tattoo;tattoo
文青|young person who adopts an outwardly artistic or intellectual style (abbr. for 文藝青年，文艺青年[wen2 yi4 qing1 nian2])
文面|to tattoo the face;face tattoo;to brand (ancient punishment)
文风|writing style;(used with 鼎盛[ding3 sheng4]) cultural activity
文体|genre of writing;literary form;style;literary recreation and sporting activities
斑斓|gorgeous; brightly colored; multicolored
料峭|spring chill in the air;cold
斡旋|to mediate (a conflict etc)
斯文|refined;educate;cultured;intellectual
新人|newcomer; new recruit; fresh talent;newlywed, esp. new bride;newlywed couple; bride and groom;(paleoanthropology) later-period Hom…
新作|new work (book, movie, video game etc)
新力|Sony (former name of the company used prior to 2009 in some markets including Taiwan, Hong Kong and Singapore, now replaced by 索尼[…
新化|see 新化縣，新化县[Xin1 hua4 Xian4];see 新化區，新化区[Xin1 hua4 Qu1]
新北|see 新北區，新北区[Xin1 bei3 Qu1];see 新北市[Xin1 bei3 Shi4]
新和|see 新和縣，新和县[Xin1 he2 Xian4]
新土|freshly dug up earth
新城|see 新城區，新城区[Xin1 cheng2 Qu1]
新安|see 新安縣，新安县[Xin1 an1 Xian4]
新宁|see 新寧縣，新宁县[Xin1 ning2 Xian4]
新山|Johor Bahru (city in Malaysia)
新市|see 新市區，新市区[Xin1 shi4 Qu1]
新平|see 新平彝族傣族自治縣，新平彝族傣族自治县[Xin1 ping2 Yi2 zu2 Dai3 zu2 Zi4 zhi4 xian4]
新年|New Year
新干|see 新幹縣，新干县[Xin1 gan4 Xian4]
新式|new style; latest type
新意|new idea
新房|brand new house;bridal chamber
新手|new hand;novice;raw recruit
新拉|New Latin
新教|Protestantism
新星|(astronomy) nova;(fig.) new star; rising star
新会|see 新會區，新会区[Xin1 hui4 Qu1]
新月|new moon;crescent
新林|see 新林區，新林区[Xin1 lin2 Qu1]
新乐|see 新樂市，新乐市[Xin1 le4 Shi4]
新正|see 正月[Zheng1 yue4]
新民|see 新民市[Xin1 min2 Shi4]
新河|see 新河縣，新河县[Xin1 he2 Xian4]
新生|new;newborn;emerging;nascent
新县|Xin County or Xinxian, a county in Xinyang City 信陽市，信阳市[Xin4 yang2 Shi4], Henan
新罗|Silla, Korean kingdom that existed between 57 BC – 935 AD, one of the Three Kingdoms of Korea, later allied with Tang China to def…
新闻|news
新华|Xinhua (New China), the name of various businesses, products and organizations, notably the Xinhua News Agency 新華社，新华社[Xin1 hua2 s…
新词|new expression; neologism
新军|New Armies (modernized Qing armies, trained and equipped according to Western standards, founded after Japan's victory in the Firs…
新风|new trend;new custom
新马|Singapore and Malaysia (abbr. for 新加坡[Xin1 jia1 po1] + 馬來西亞，马来西亚[Ma3 lai2 xi1 ya4])
新高|new high
新龙|see 新龍縣，新龙县[Xin1 long2 Xian4]
方城|see 方城縣，方城县[Fang1 cheng2 Xian4]
方士|alchemist;necromancer
方子|prescription (medicine)
方家|learned person;expert in a certain field;abbr. for 大方之家[da4 fang1 zhi1 jia1]
方山|see 方山縣，方山县[Fang1 shan1 Xian4]
方式|way; method; manner; mode; pattern (of behavior etc)
方形|square;square-shaped
方格|checked pattern;square box character (in Chinese text) indicating an illegible character
方正|see 方正縣，方正县[Fang1 zheng4 Xian4]
方法|method; way; technique; procedure
方物|produced locally;local product (with distinctive native features)
方面|respect;aspect;field;side
方音|dialectal accent
方头|square headed
旁边|side; adjacent place
旋即|soon after;shortly
族人|clansman;clan members;relatives;ethnic minority
族长|clan elder
旖旎|(literary) charming; enchanting; picturesque
日中|Japan-China
日人|Japanese person; the Japanese
日来|in the past few days;lately
日光|sunlight
日内|in a few days;one of these days
日出|sunrise
日前|the other day;a few days ago
日化|household chemicals (cleaning products etc) and toiletries (abbr. for 日用化學製品，日用化学制品[ri4 yong4 hua4 xue2 zhi4 pin3]);(linguistics) …
日土|see 日土縣，日土县[Ri4 tu3 Xian4]
日报|daily newspaper
日场|daytime show;matinee
日子|day;a (calendar) date;days of one's life
日式|Japanese style
日后|sometime;someday (in the future)
日文|Japanese (language)
日新|in constant progress
日方|the Japanese side or party (in negotiations etc)
日日|every day
日月|the sun and moon;day and month;every day and every month;season
日期|date
日本|Japan
日流|the spread of Japanese cultural products (anime, pop music etc) to other countries
日用|daily expenses;of everyday use
日神|the Sun God;Apollo
日经|Nikkei, abbr. for Nikkei Shimbun 日本經濟新聞，日本经济新闻[Ri4 ben3 Jing1 ji4 Xin1 wen2];abbr. for Nikkei 225 index 日經指數，日经指数[Ri4 jing1 zhi3 s…
日美|Japan and the US; Japan-US
日里|daytime;during the day
日语|Japanese language
日军|Japanese army;Japanese troops
日电|NEC (Nippon Electronic Company);abbr. for 日電電子，日电电子
日头|sun (dialect);daytime;date
早上|early morning
明代|the Ming dynasty (1368-1644)
明光|see 明光市[Ming2 guang1 Shi4]
明儿|(coll.) tomorrow;one of these days;some day
明和|Minghe, rail station in South Taiwan;Meiwa (Japanese reign name 1764-1772);Meiwa (common name for Japanese companies or schools)
明报|Ming Pao newspaper (Hong Kong)
明天|tomorrow
明媚|bright and beautiful
明子|see 松明[song1 ming2]
明山|see 明山區，明山区[Ming2 shan1 Qu1]
明年|next year
明德|highest virtue;illustrious virtue
明手|dummy (in bridge)
明教|Manichaeism
明文|to state in writing (laws, rules etc)
明日|tomorrow
明明|obviously;plainly;undoubtedly;definitely
明星|star; celebrity
明月|bright moon;refers to 夜明珠, a legendary pearl that can glow in the dark
明水|see 明水縣，明水县[Ming2 shui3 Xian4]
明清|the Ming (1368-1644) and Qing (1644-1911) dynasties
明火|flame;open fire
明理|sensible;reasonable;an obvious reason, truth or fact;to understand the reason or reasoning
明白|clear; obvious; unequivocal;sensible; reasonable;to understand; to realize
明达|reasonable; of good judgment
明里|publicly; outwardly; professedly
明体|Mincho;Song font
星光|starlight
星名|star name
星图|star atlas
星家|astrologist (in former times)
星座|constellation;astrological sign
星星|(coll.) a star; the stars in the sky
星月|the moon and the stars
星期|week;day of the week;Sunday
星火|spark;meteor trail (mostly used in expressions like 急如星火[ji2 ru2 xing1 huo3])
星球|celestial body (e.g. planet, satellite etc); heavenly body
星盘|(astronomy) astrolabe;(astrology) horoscope;astrological chart
星相|astrology and physiognomy
星空|starry sky; the star-studded heavens
星号|asterisk * (punct.)
星表|star catalog
星马|Singapore and Malaysia (abbr. for 新加坡[Xin1 jia1 po1], aka 星洲[Xing1 zhou1] + 馬來西亞，马来西亚[Ma3 lai2 xi1 ya4])
星体|(astronomy) celestial body (e.g. planets, moons)
春节|Spring Festival (Chinese New Year)
昨天|yesterday
昭雪|to exonerate;to clear (from an accusation);to rehabilitate
时下|at present;right now
时事|current trends; the present situation; how things are going
时人|(literary) people of that time; contemporaries
时代|Time, US weekly news magazine
时候|time;length of time;moment;period
时光|time (esp. as sth that passes)
时分|time;period during the day;one of the 12 two-hour periods enumerated by the earthly branches 地支
时刻|time;juncture;moment;period of time
时区|time zone
时报|"Times" (newspaper, e.g. New York Times)
时式|fashionable style;(linguistics) tense
时文|(historical) imperial examination essay; eight-legged essay 八股文[ba1 gu3 wen2];current-affairs article; topical commentary (esp. as…
时日|time;auspicious time;time and date;long period of time
时时|often;constantly
时期|period;phase
时机|opportunity; opportune moment
时空|time and place;world of a particular locale and era;(physics) space-time
时节|season; time
时菜|seasonal vegetable
时装|fashion;fashionable clothes
时调|regional folk song popular during a certain period of time
时运|circumstances;fate
时长|duration
时间|(concept of) time;(duration of) time;(point in) time
时点|point of time (in time-based systems)
晚上|evening;night;in the evening
晚安|Good night!;Good evening!
晦暗|dark and gloomy
晦涩|difficult to understand;cryptic
暂时|temporary; provisional; for the time being
更加|more (than sth else);even more
书信|letter;epistle
书包|schoolbag;satchel;bookbag
书名|name of a book;reputation as calligrapher
书报|papers and books
书店|bookstore
书房|study (room);studio
书会|calligraphy society;village school (old);literary society (old)
书本|book (chiefly used to refer to a plurality of books or books in general)
书板|(writing) tablet
书法|calligraphy;handwriting;penmanship
书生|scholar;intellectual;egghead
书皮|book cover;book jacket
书经|the Book of History, one of the Five Classics of Confucianism 五經，五经[Wu3 jing1], a compendium of documents which make up the oldest…
书号|book number (esp. ISBN)
书角|corner of a page
书面|in writing; written
书风|calligraphic style
书香|literary reputation
书体|style of Chinese script
曾经|once;already;former;previously
最后|final; last; ultimate;finally; in the end
会儿|(coll.) a short while; a moment
会合|to meet;to rendezvous;to merge;to link up
会同|see 會同縣，会同县[Hui4 tong2 Xian4]
会员|member
会商|to confer;to consult;to negotiate;to hold a conference
会场|meeting place;place where people gather
会士|member of religious order;penitent;frater;translation of French agregé (holder of teaching certificate)
会子|(coll.) a moment;a while
会安|Hoi An (in Vietnam)
会客|to receive a visitor
会宁|see 會寧縣，会宁县[Hui4 ning2 Xian4]
会心|knowing (of a smile, look etc)
会意|combined ideogram (one of the Six Methods 六書，六书[liu4 shu1] of forming Chinese characters);Chinese character that combines the mean…
会战|(military) to meet for a decisive battle;(military) battle;(fig.) large-scale concerted effort
会期|the duration of a conference;the period over which a conference (or expo etc) is held;session;the date of a meeting
会东|see 會東縣，会东县[Hui4 dong1 Xian4]
会水|to be able to swim
会理|see 會理市，会理市[Hui4 li3 Shi4]
会话|(language learning) conversation;dialog;to converse (in a non-native language);(computing) session
会议|meeting;conference
会车|(of two vehicles traveling in opposite directions) to pass by each other
会长|president of a club, committee etc
会门|main entrance;secret society
会面|to meet with;meeting
月中|the middle of the month;(Tw) (coll.) postpartum care center (abbr. for 月子中心[yue4 zi5 zhong1 xin1])
月事|menses;menstruation;a woman's periods
月亮|the moon
月份|month
月信|(old) menstruation;period
月光|moonlight
月分|variant of 月份[yue4 fen4]
月利|monthly interest
月城|semicircular defensive enclosure around city gates;crescent-shaped barbican
月报|monthly (used in names of publications);monthly bulletin
月子|traditional one-month confinement period following childbirth; puerperium
月工|worker employed by the month
月度|monthly
月月|every month
月海|lunar mare
月球|the moon
月相|phase of the moon
月经|menstruation;a woman's period
月老|(Chinese folk religion) the god of matchmaking;(fig.) matchmaker
月台|railway platform
月色|moonlight
月华|moonlight
月黑|moonless (night)
有事|to be occupied with sth;to have sth on one's mind;there is something the matter
有些|some;somewhat; rather; a bit
有人|someone;people;anyone;there is someone there
有利|advantageous; favorable
有力|powerful;forceful;vigorous
有加|extremely (placed after verb or adjective)
有名|famous;well-known
有年|for years
有形|material; tangible; visible;shapely
有后|to have a descendant; to have a son to continue one's lineage
有心|to have a mind to;to intend to;deliberately;considerate
有情|to be in love;sentient beings (Buddhism)
有意|to intend;intentionally;interested in
有成|(literary) to achieve success
有数|to have kept count; to know how many; (fig.) to know exactly how things stand; to know the score;not many; only a few
有方|to do things right;to use the correct method
有时|sometimes; now and then
有机|organic
有水|supplied with water (of a house)
有无|to have or have not;surplus and shortfall;tangible and intangible;corporeal and incorporeal
有理|reasonable;justified;right;(math.) rational
有用|useful
有病|to be ill;(coll.) to be not right in the head
有空|to have time (to do sth)
有节|segmented
有线|wired;cable (television)
有色|colored;non-white;non-ferrous (metals)
有解|(of a problem, equation etc) to have a solution; to be solvable
有道|to have attained the Way;(of a government or a ruler) enlightened;wise and just
有关|to have sth to do with;to relate to;related to;to concern
有电|electric (apparatus);electrified;having electricity supply (of a house)
有风|windy
有点|a little
朋友|friend
朝廷|court;imperial household;dynasty
期中|interim;midterm
期房|forward delivery apartment;unfinished housing to be paid for in advance by the buyer and then completed within certain time frame
期间|period of time;time;time period;period
朦胧|(literary) (of moonlight) dim;(literary) murky; indistinct
木下|Kinoshita (Japanese surname)
木器|wooden articles
木工|woodwork;carpentry;woodworker;carpenter
木星|Jupiter (planet)
木板|slab;board;plank
木然|stupefied
木片|flat piece of wood;wood chip
木球|cricket (ball game);also called 板球[ban3 qiu2]
木节|gnarl;knag
木兰|see 木蘭縣，木兰县[Mu4 lan2 Xian4];see 花木蘭，花木兰[Hua1 Mu4 lan2]
木制|wooden
木讷|wooden and slow of speech;slow-speeched;inarticulate;unsophisticated
木里|see 木里藏族自治縣，木里藏族自治县[Mu4 li3 Zang4 zu2 Zi4 zhi4 xian4]
木头|wood; log (CL:塊，块[kuai4],根[gen1]);(fig.) blockhead; dolt
木香|costus root (medicinal herb);aucklandia;Saussurea costus;Dolomiaea souliei
木马|wooden horse;rocking horse;vaulting horse (gymnastics);trojan horse (computing)
木鱼|mokugyo;wooden fish (percussion instrument)
未来|future;tomorrow;approaching;coming
本事|source material;original story
本人|I; me; myself;oneself; yourself; himself; herself; the person concerned
本来|original;originally;at first;it goes without saying
本分|(to play) one's part;one's role;one's duty;(to stay within) one's bounds
本利|principal and interest;capital and profit
本名|original name; real name;(of foreigners) first name; given name
本国|one's own country
本土|one's native country;native;local;metropolitan territory
本地|local;this locality
本报|this newspaper
本士|(loanword) pence;penny
本子|book;notebook;Japanese-style self-published comic (esp. an erotic one), aka "dōjinshi";edition
本字|original form of a Chinese character
本家|a member of the same clan;a distant relative with the same family name
本州|Honshū, the main island of Japan
本市|this city;our city
本性|natural instincts;nature;inherent quality
本意|original idea;real intention;etymon
本文|this text;article;the main body of a book
本日|today
本月|this month;the current month
本期|the current period;this term (usually in finance)
本本|notebook computer (diminutive);laptop
本业|business in which a company has traditionally engaged (e.g. before diversifying);original business;core business;(literary) agricu…
本相|original form
本科|undergraduate course;undergraduate (attributive)
本经|classic book;sutra
本台|this radio station
本色|inherent qualities;natural qualities;distinctive character;true qualities
本草|a book on Chinese (herbal) medicine;Chinese materia medica
本行|one's line;one's own profession
本身|itself;in itself;per se
本金|capital;principal
本体|main part;torso;the thing in itself;noumenon (object of purely intellectual perception according to Kant)
村庄|village;hamlet
束缚|to bind; to tie up; to fetter; to shackle
东主|owner (e.g. of a shop)
东亚|East Asia
东光|see 東光縣，东光县[Dong1 guang1 Xian4]
东加|Tonga, South Pacific archipelago kingdom (Tw)
东北|Northeast China; Manchuria
东区|Dong District or Dongqu, a district of Panzhihua City 攀枝花市[Pan1 zhi1 hua1 Shi4], Sichuan
东南|southeast
东台|see 東台市，东台市[Dong1 tai2 Shi4]
东土|the East;China
东城|see 東城區，东城区[Dong1 cheng2 Qu1]
东大|(slang) China
东安|see 東安縣，东安县[Dong1 an1 Xian4];see 東安區，东安区[Dong1 an1 Qu1]
东家|master (i.e. employer);landlord;boss
东宁|see 東寧市，东宁市[Dong1 ning2 Shi4]
东山|see 東山縣，东山县[Dong1 shan1 Xian4];see 東山區，东山区[Dong1 shan1 Qu1]
东平|see 東平縣，东平县[Dong1 ping2 Xian4]
东德|East Germany (1945-1990);German Democratic Republic 德意志民主共和國，德意志民主共和国[De2 yi4 zhi4 Min2 zhu3 Gong4 he2 guo2]
东方|the East; the Orient;two-character surname Dongfang
东明|see 東明縣，东明县[Dong1 ming2 Xian4]
东东|(coll.) thing;item;stuff
东江|Dongjiang River
东河|see 東河區，东河区[Dong1 he2 Qu1]
东海|East China Sea;East Sea (Chinese mythology and ancient geography)
东经|east longitude
东兰|see 東蘭縣，东兰县[Dong1 lan2 Xian4]
东西|east and west
东道|host
东边|east;east side;eastern part;to the east of
东阿|see 東阿縣，东阿县[Dong1 e1 Xian4]
东阳|see 東陽市，东阳市[Dong1 yang2 Shi4]
东面|east side (of sth)
东风|easterly wind;spring breeze;(fig.) revolutionary momentum; favorable circumstances
板主|variant of 版主[ban3 zhu3]
板报|see 黑板報，黑板报[hei1 ban3 bao4]
板子|board;plank;bamboo or birch for corporal punishment
板房|temporary housing built with wooden planks or other makeshift materials
板书|to write on the blackboard;writing on the blackboard
板板|solemn
板油|leaf fat;leaf lard
板球|cricket (ball game)
板皮|slab
板眼|measure in traditional Chinese music;orderliness
板车|handcart; flatbed cart; flatbed tricycle
板面|pan mee, aka banmian, a Hakka noodle soup dish, popular in Malaysia
林区|region of forest
林卡|transliteration of Tibetan lingka: garden
林口|see 林口縣，林口县[Lin2 kou3 Xian4];see 林口區，林口区[Lin2 kou3 Qu1]
林地|woodland
林场|forestry station;forest management area
林子|woods;grove;forest
林学|forestry
林州|see 林州市[Lin2 zhou1 Shi4]
林木|forest;forest tree
林业|forest industry;forestry
林火|forest fire
林县|Lin county in Henan
林西|see 林西縣，林西县[Lin2 xi1 Xian4]
果干|dried fruit
果品|fruit
果报|karma;preordained fate (Buddhism)
果子|fruit;variant of 餜子，馃子[guo3 zi5]
果实|fruit (produced by a plant);(fig.) fruits (of success etc);results;gains
果期|the fruiting season
果木|fruit tree
果然|really;sure enough;as expected;if indeed
果皮|(fruit) peel
果盘|fruit plate; fruit platter
果肉|the flesh of a fruit; pulp
果酒|fruit wine
枯萎|to wilt;to wither;wilted;withered
根据|according to;based on;basis;foundation
格力|Gree (brand)
格外|especially; particularly; even more than usual;extra; additional
格子|lattice;check (pattern of squares)
格式|form;specification;format
格拉|Gera (city in Germany)
格林|Green or Greene (name)
格格|variant of 咯咯[ge1 ge1]
格机|(coll.) to factory-reset a phone (or other device)
格物|to study the underlying principles, esp. in neo-Confucian rational learning 理學，理学[li3 xue2];word for Western natural sciences duri…
格网|(math.) lattice
格调|style (of art or literature);form;one's work style;moral character
案件|case;instance
桌子|table;desk
桎梏|(literary) shackles
条件|condition; circumstance; term; factor;requirement; prerequisite; qualification;situation; state; condition
森林|forest
椅子|chair
业主|owner;proprietor
业内|(within) the industry; the profession
业力|(Buddhism) karma
业大|part-time college (abbr. for 業餘大學，业余大学[ye4 yu2 da4 xue2])
业海|sea of evil;endless crime
业经|already
业者|dealer;trader;person or company engaged in some industry or trade
业龙|evil dragon
极其|extremely
枪支|a gun;guns in general
乐事|Lay's (brand)
乐儿|see 樂子，乐子[le4 zi5]
乐器|musical instrument
乐土|happy place; paradise; haven
乐天|Lotte (South Korean conglomerate)
乐子|fun;pleasure;laughing matter
乐安|see 樂安縣，乐安县[Le4 an1 Xian4]
乐山|see 樂山市，乐山市[Le4 shan1 Shi4]
乐平|see 樂平市，乐平市[Le4 ping2 Shi4]
乐意|to be willing to do sth;to be ready to do sth;to be happy to do sth;content
乐手|instrumental performer
乐东|Ledong Lizu autonomous county, Hainan
乐业|see 樂業縣，乐业县[Le4 ye4 Xian4]
乐清|see 樂清市，乐清市[Yue4 qing1 Shi4]
乐理|music theory
乐经|Book of Music, said to be one of the Six Classics lost after Qin's burning of the books in 212 BC, but may simply refer to Book of…
乐色|(slang) trash; garbage (pun on the Taiwan pr. of 垃圾[la1 ji1])
乐道|to take delight in talking about sth;to find pleasure in following one's convictions
乐音|musical note;tone
乐高|Lego, Danish brand of plastic building blocks
楼上|upstairs;(Internet slang) previous poster in a forum thread
楼下|downstairs
样子|appearance;manner;pattern;model
树林|Shulin city in New Taipei City 新北市[Xin1 bei3 shi4], Taiwan
树枝|branch;twig
机制|mechanism
机动|locomotive;motorized;power-driven;adaptable
机器|machine
机场|airport; airfield;(slang) service provider for Shadowsocks or similar software for circumventing Internet censorship
机子|machine;device
机房|machine room;engine room;computer room
机会|opportunity;chance;occasion
机油|engine oil
机理|mechanism
机变|improvisation;flexible;adaptable;pragmatic
机身|body of a vehicle or machine;fuselage of a plane
机车|locomotive; train engine car;(coll.) motorcycle;(Tw) scooter; motorcycle;(Tw) (slang) hard to get along with; annoying
机运|chance and opportunity
机长|(aviation) pilot-in-command; captain
机关|mechanism; gear;machine-operated;office; agency; organ; organization; establishment; institution; body;stratagem; scheme; intrigue…
机电|machinery and power-generating equipment;electromechanical
机头|the front (nose) of a plane etc
机体|organism (biology);airframe (aeronautics)
台子|desk;(pool etc) table
台布|tablecloth
台面|tabletop;countertop;(fig.) public view;plain sight
欣然|gladly;cheerfully
欺骗|to deceive; to cheat
钦佩|to admire;to look up to;to respect sb greatly
欢迎|to welcome;welcome
正中|middle;center;right in the middle or center;nub
正主|central figure;rightful owner;(slang) idol of a fan
正事|one's proper business
正交|orthogonality
正人|upstanding person;upright person
正传|main subject of long novel;true biography
正化|normalization;to normalize
正反|positive and negative;pros and cons;inside and outside
正名|to replace the current name or title of sth with a new one that reflects its true nature;rectification of names (a tenet of Confuc…
正品|certified goods;quality product;normal product;A-class goods
正在|to be in the process of (doing sth); to be currently ...-ing
正好|just (in time);just right;just enough;to happen to
正子|positron;also called 正電子，正电子[zheng4 dian4 zi3]
正字|to correct an erroneously written character;regular script (calligraphy);standard form (of a character or spelling)
正安|see 正安縣，正安县[Zheng4 an1 Xian4]
正定|see 正定縣，正定县[Zheng4 ding4 Xian4]
正宁|see 正寧縣，正宁县[Zheng4 ning2 Xian4]
正对|directly facing
正式|formal; official
正德|Zhengde Emperor, reign name of eleventh Ming emperor Zhu Houzhao 朱厚照[Zhu1 Hou4 zhao4] (1491-1521), reigned 1505-1521, temple name …
正意|sense (in DNA)
正房|central building (in a traditional house);primary wife
正教|true religion;orthodox religion;orthodox Christianity;Islam (in the writing of Chinese or Hui theologians)
正数|positive number
正文|main text (as opposed to footnotes);main body (of a book)
正方|the side in favor of the proposition (in a formal debate)
正日|the day (of a festival, ceremony etc)
正时|timing (of an engine)
正书|regular script (Chinese calligraphic style)
正月|first month of the lunar year
正本|original (of a document);reserved copy (of a library book)
正业|one's regular job
正正|neat;orderly;just in time
正比|direct ratio;directly proportional
正气|healthy atmosphere; moral spirit;unyielding integrity; probity;(TCM) vital energy (resistance to diseases)
正法|to execute;the law
正然|in the process of (doing something or happening);while (doing)
正生|starring male role in a Chinese opera
正用|correct usage
正眼|facing directly (with one's eyes);(to look sb) in the eyes
正经|decent;honorable;proper;serious
正色|stern;grim;resolute;firm
正号|(math.) plus sign (+)
正装|formal dress
正角|positive angle
正解|right solution; correct understanding
正路|(lit. and fig.) the right way; the correct path; the proper course
正道|the correct path;the right way (Buddhism)
正门|main entrance;main gate;portal
正阳|see 正陽縣，正阳县[Zheng4 yang2 Xian4]
正电|positive charge (electricity)
正面|front;obverse side;right side;positive
正音|standard pronunciation;to correct sb's pronunciation
正骨|bonesetting;Chinese osteopathy
正体|standard form (of a Chinese character);plain font style (as opposed to bold or italic);printed style (as opposed to cursive);(Tw) …
正点|(of a train etc) on time; punctual;(slang) awesome;(Tw) on the hour
此外|besides; in addition; moreover; furthermore
武力|military force
武功|see 武功縣，武功县[Wu3 gong1 Xian4]
武器|weapon;arms
武城|see 武城縣，武城县[Wu3 cheng2 Xian4]
武士|warrior;samurai
武安|see 武安市[Wu3 an1 Shi4]
武定|Wuding reign name (543–550) during Eastern Wei of the Northern Dynasties 東魏，东魏[Dong1 Wei4];see 武定縣，武定县[Wu3 ding4 Xian4]
武宁|see 武寧縣，武宁县[Wu3 ning2 Xian4]
武山|see 武山縣，武山县[Wu3 shan1 Xian4]
武平|see 武平縣，武平县[Wu3 ping2 Xian4]
武德|ethics (in the military or the martial arts)
武打|acrobatic fighting in Chinese opera or dance
武林|martial arts (social) circles
武水|the Wu river in Hunan and Guangdong;formerly Shuang river 瀧水，泷水
武江|see 武江區，武江区[Wu3 jiang1 Qu1]
武清|Wuqing rural district in Tianjin 天津[Tian1 jin1]
武生|male military role in a Chinese opera
武装|arms;equipment;to arm;military
历史|history
死亡|to die;death
死人|dead person;(coll.) to die; (of a death) to happen
死信|lost letter;letter containing news of sb's death
死区|dead zone;blind spot
死城|ghost town
死士|person willing to sacrifice his life (for a good cause)
死定|to be screwed; to be toast
死后|after death;posthumous
死心|to give up;to admit failure;to drop the matter;to reconcile oneself to loss
死战|to fight to the death
死期|time of death;limited to a fixed period of time;fixed term
死板|rigid;inflexible
死机|to crash (of a computer)
死死|rigid;unwavering;unbendable;firm (hold on sth)
死水|stagnant water;backwater
死海|the Dead Sea
死球|(ball sports) dead ball
死生|life or death;critical (event)
死皮|dead skin
死神|mythological figure (such as the Grim Reaper) in charge of taking the souls of those who die;(fig.) death
死节|to die or be martyred for a noble cause;to be faithful unto death
死线|deadline (loanword)
死者|the dead;the deceased
死角|gap in coverage;gap in protection or defenses;neglected or overlooked area;dead end
死路|dead end;(fig.) the road to disaster
死面|unleavened dough
死点|see 止點，止点[zhi3 dian3]
殒命|to die;to perish
母亲|mother
每个|each; every
每天|every day
每年|every year;each year;yearly
每次|every time
毒辣|cruel;sinister;vicious
比亚|Bia, daughter of Pallas and Styx in Greek mythology, personification of violence
比作|to liken to;to compare to
比来|lately;recently
比分|score (of a game or competition)
比利|(HK, Sg, Tw) Pelé (1940–2022), Edson Arantes Do Nascimento, Brazilian football star
比如|see 比如縣，比如县[Bi3 ru2 Xian4]
比安|Bienne, Switzerland
比对|comparison;to verify by comparing
比干|Bi Gan (Chinese god of wealth)
比年|(literary) every year; year after year;(literary) in recent years;Taiwan pr. [bi4 nian2]
比心|(Internet slang) to form a hand heart using one's thumb and forefinger (or by using both hands)
比数|score (of a game or competition)
比方|analogy; illustrative example;for instance
比武|martial arts competition;tournament;to compete in a contest
比热|specific heat
比尔|Bill (name)
比特|bit (binary digit) (loanword)
比赛|competition (sports etc);match;to compete
比起|compared with
比重|proportion;(physics) specific gravity
比量|to measure roughly (with the hand, a stick, string etc)
毛利|gross profit
毛南|Maonan ethnic group
毛口|metal filings (e.g. from a drill or lathe);burr
毛子|hairy fellow;foreigner;Russian (derog.);bandit (old)
毛拉|Mullah (religious leader in Islam)
毛毛|(pet name for a baby or small child)
毛片|pornographic film;rushes (of a movie);(old) fur color
毛病|fault;defect;shortcomings;ailment
毛皮|fur;pelt
毛线|knitting wool;wool yarn
毛色|(of an animal) appearance or color of coat
毛边|(textiles, papermaking etc) raw edge; rough edge
毛重|gross weight
毛发|hair
民主|democracy;democratic
民事|civil case;agricultural affairs;civil
民和|see 民和回族土族自治縣，民和回族土族自治县[Min2 he2 Hui2 zu2 Tu3 zu2 Zi4 zhi4 xian4]
民品|product for civilian use
民国|Republic of China (1912-1949);used in Taiwan as the name of the calendar era (e.g. 民國六十年，民国六十年 is 1971, the 60th year after 1911)
民女|woman from an ordinary family
民家|minka;commoner's house;Bai ethnic group
民工|migrant worker (who moved from a rural area of China to a city to find work);temporary worker enlisted on a public project
民心|popular sentiment
民情|circumstances of the people;popular sentiment;the mood of the people;popular customs
民意|public opinion;popular will;public will
民房|private house
民族|nationality; ethnic group
民乐|see 民樂縣，民乐县[Min2 le4 Xian4]
民法|civil law
民生|people's livelihood;people's welfare
民用|(for) civilian use
民科|pseudoscientist;crank;crackpot (abbr. for 民間科學家，民间科学家)
民调|opinion poll
民变|mass uprising;popular revolt;civil commotion
民运|civil transport;movement aimed at the masses;democracy movement (abbr.)
民风|popular customs;folkways;the character of the people of a nation (or region etc)
气人|to anger;to annoy
气力|strength;energy;vigor;talent
气动|pneumatic
气化|to vaporize;evaporation;carburetion;氣，气[qi4] transformation in TCM (i.e. transformation of yin yang vital breath)
气口|location on wrist over the radial artery where pulse is taken in TCM
气场|qi field (in qigong or feng shui);vibe (of a person or place); aura; atmosphere
气度|bearing;manner;presence
气数|fate;destiny;one's lot
气死|to infuriate;to be furious;to die from an excess of anger
气流|stream of air;airflow;slipstream;draft
气焰|arrogance; haughtiness
气球|balloon
气管|windpipe;trachea;respiratory tract;air duct
气节|moral integrity;unflinching righteousness
气色|complexion
气血|qi and blood (two basic bodily fluids of Chinese medicine)
气话|angry words;sth said in the moment of anger
气道|flue;air duct;air passage;respiratory tract
气量|(lit. quantity of spirit);moral character;degree of forbearance;broad-mindedness or otherwise
气门|valve (esp. tire valve);accelerator (obsolete term for 油門，油门);stigma (zool.);spiracle
气体|gas (i.e. gaseous substance)
氤氲|(literary) (of smoke, mist) dense; thick
水上|on water;aquatic
水下|under the water;submarine
水分|moisture content;(fig.) overstatement; padding
水利|water conservancy;irrigation works
水力|hydraulic power
水化|to hydrate
水原|Suweon City, capital of Gyeonggi province 京畿道[Jing1 ji1 dao4], South Korea
水合|hydration reaction
水单|receipt; itemized bill; transaction record
水土|water and soil;surface water;natural environment (extended meaning);climate
水城|see 水城區，水城区[Shui3 cheng2 Qu1]
水基|water-based
水客|smuggler, esp. of electronic goods from Macao or Hong Kong to Guangdong;boatman;fisherman;itinerant trader
水平|horizontal; level;a standard; a level (of ability, development etc)
水性|swimming ability;characteristics of a body of water (depth, currents etc);aqueous;water-based (paint etc)
水手|sailor; seaman; mariner
水文|hydrology
水族|Shui ethnic group
水星|(astronomy) Mercury
水果|fruit
水气|water vapor;steam
水波|wave;(water) ripple
水流|river;stream
水球|water polo
水生|aquatic (plant, animal)
水相|aqueous solution
水神|river God
水管|water pipe
水花|spray of water; splash;(dialect) chickenpox
水草|aquatic plants;water and grass (i.e. favorable foraging land for livestock or wild animals);(Malaysia) (coll.) drinking straw
水华|algal bloom; water bloom
水表|water meter;indicator of water level
水解|hydrolysis (chemical reaction with water)
水路|waterway
水军|(archaic) navy;person employed to post messages on the Internet (abbr. for 網絡水軍，网络水军[Wang3 luo4 shui3 jun1])
水运|waterborne transport
水道|watercourse (river, canal, drain etc);water route;lane (in a swimming pool)
水边|edge of the water;waterside;shore (of sea, lake or river)
水量|volume of water;quantity of flow
水门|water valve; sluice gate;(aviation) water salute
水电|hydroelectric power;plumbing and electricity
水面|water surface
水马|water-filled barrier
水体|body of water
水龙|hose;pipe;fire hose;(botany) water primrose (Jussiaea repens)
永远|forever;eternal
江北|see 江北區，江北区[Jiang1 bei3 Qu1];Chongqing's main airport
江南|region of China immediately south of the lower Yangtze River, including Shanghai and adjoining parts of Jiangsu, Anhui, Jiangxi an…
江口|see 江口縣，江口县[Jiang1 kou3 Xian4]
江城|see 江城區，江城区[Jiang1 cheng2 Qu1];see 江城哈尼族彝族自治縣，江城哈尼族彝族自治县[Jiang1 cheng2 Ha1 ni2 zu2 Yi2 zu2 Zi4 zhi4 xian4]
江安|see 江安縣，江安县[Jiang1 an1 Xian4]
江宁|see 江寧區，江宁区[Jiang1 ning2 Qu1]
江山|see 江山市[Jiang1 shan1 Shi4]
江州|see 江州區，江州区[Jiang1 zhou1 Qu1]
江平|Jiang Ping (1920-), academic lawyer, writer on ethnicity and legal systems
江心|middle of a river
江水|river water
江河|Yangtze and Yellow rivers
江油|see 江油市[Jiang1 you2 Shi4]
江流|river;river flow;current
江海|see 江海區，江海区[Jiang1 hai3 Qu1]
江湖|rivers and lakes;all corners of the country; remote areas to which hermits retreat;section of society operating independently of m…
江米|polished glutinous rice
江华|see 江華瑤族自治縣，江华瑶族自治县[Jiang1 hua2 Yao2 zu2 Zi4 zhi4 xian4]
江西|see 江西省[Jiang1 xi1 Sheng3]
江达|see 江達縣，江达县[Jiang1 da2 Xian4]
江边|river bank
江门|see 江門市，江门市[Jiang1 men2 Shi4]
江阳|see 江陽區，江阳区[Jiang1 yang2 Qu1]
江青|Jiang Qing (1914-1991), Mao Zedong's fourth wife and leader of the Gang of Four
江面|the surface of the river
决定|to decide; to determine; to make up one's mind;decision (CL:個，个[ge4],項，项[xiang4])
沉吟|to mutter to oneself irresolutely
沉稳|steady;calm;unflustered
沙包|sandbag;punching bag (trad. filled with sand);sand dune;footbag; hacky sack
沙国|Saudi Arabia (Tw), abbr. for 沙烏地阿拉伯王國，沙乌地阿拉伯王国
沙土|sandy soil
沙地|sandy beach or river bank;sand dune;sandy land
沙场|sandpit;battleground;battlefield
沙士|(loanword) sarsaparilla (carbonated soft drink);(HK) (loanword) SARS (severe acute respiratory syndrome)
沙子|sand;grit
沙巴|Sabah, state of Malaysia in north Borneo 婆羅洲，婆罗洲
沙市|see 沙市區，沙市区[Sha1 shi4 Qu1]
沙拉|(loanword) salad
沙林|sarin (loanword)
沙果|Chinese pearleaf crabapple (Malus asiatica)
沙沙|rustle
沙河|see 沙河市[Sha1 he2 Shi4]
沙特|Saudi;abbr. for Saudi Arabia
沙发|(loanword) sofa (CL:條，条[tiao2],張，张[zhang1]);(Internet slang) first reply to a forum post
沙盘|sand table (military);sand tray (on which to write characters)
沙眼|trachoma
沙石|sand and stones
沙县|see 沙縣區，沙县区[Sha1 xian4 Qu1]
沙门|monk (Sanskrit: Sramana, originally refers to north India);Buddhist monk
沙鱼|variant of 鯊魚，鲨鱼[sha1 yu2]
沙龙|salon (loanword)
河内|Hanoi, capital of Vietnam
河北|see 河北省[He2 bei3 Sheng3]
河南|see 河南省[He2 nan2 Sheng3];see 河南蒙古族自治縣，河南蒙古族自治县[He2 nan2 Meng2 gu3 zu2 Zi4 zhi4 xian4]
河口|see 河口區，河口区[He2 kou3 Qu1];see 河口瑤族自治縣，河口瑶族自治县[He2 kou3 Yao2 zu2 Zi4 zhi4 xian4]
河工|river conservancy works (dike maintenance, dredging etc);river conservancy worker
河心|middle of the river
河东|Hedong district of Linyi city 臨沂市，临沂市[Lin2 yi2 shi4], Shandong
河水|river water
河沙|river sand
河流|river
河神|river god
河西|land west of the Yellow river;Shaanxi, Qinghai and Gansu provinces
河运|river transport
河道|river course;river channel
河边|river bank
河面|surface of a river
河马|hippopotamus
河鱼|freshwater fish
油光|glossy;gleaming;shiny (due to greasiness);slick
油子|dense and sticky substance;(dialect) wily old fox
油布|tarpaulin
油气|oil and gas
油水|grease;profit;ill-gotten gains
油油|oily
油管|(coll.) YouTube
油花|grease or fat blobs at the surface of a liquid;tricky and dissolute
油菜|oilseed rape (Brassica napus);rape greens; leafy greens of certain Brassica species;(dialect) bok choy
油车|(coll.) gasoline vehicle
油酸|oleic acid
油门|accelerator (pedal);gas pedal;throttle
油黑|glossy black
法事|religious ceremony;ritual
法人|legal person;corporation;see also 自然人[zi4 ran2 ren2]
法克|fuck (loanword)
法儿|way;method;means;Taiwan pr. [fa1 r5]
法制|legal system and institutions
法力|magic power
法名|name in religion (of Buddhist or Daoist within monastery);same as 法號，法号[fa3 hao4]
法商|"legal quotient" (LQ), a measure of one's awareness and knowledge of the law and one's standard of honorable conduct
法国|France
法场|execution ground
法外|outside the law; beyond the law; extrajudicial
法子|way;method;Taiwan pr. [fa2 zi5]
法学|law;legal studies
法定|statutory; law-based; legal
法家|the Legalist school of political philosophy, which rose to prominence in the Warring States period (475–221 BC) (The Legalists bel…
法度|(a) law
法式|French-style
法律|law
法拉|farad, SI unit of electrical capacitance (loanword)
法文|French language
法会|(Buddhist) religious assembly
法海|Fahai, name of the evil Buddhist monk in Tale of the White Snake 白蛇傳，白蛇传[Bai2 she2 Zhuan4]
法王|Sakyamuni
法理|legal principle;jurisprudence
法眼|discerning eye
法网|French Open (tennis tournament)
法线|(geometry) normal line
法老|pharaoh (loanword)
法兰|flange (loanword)
法号|name in religion (of Buddhist or Daoist within monastery)
法术|magic
法语|French (language)
法军|French army
法门|gate to enlightment (Buddhism);Buddhism;way;method
法马|variant of 砝碼，砝码[fa3 ma3]
波光|gleaming reflection of waves in sunlight
波动|to undulate;to fluctuate;wave motion;rise and fall
波卡|burqa (loanword)
波形|wave form
波德|Johann Elert Bode (1747-1826), German astronomer
波数|wave number (reciprocal of frequency)
波斯|Persia
波比|burpee (loanword)
波河|Po River, longest river in Italy
波特|(loanword) baud (computing);porter (beer)
波罗|Polo (car made by Volkswagen)
波兰|Poland
波语|Polish language
波长|wavelength
波面|wave front
波音|Boeing (aerospace company)
波黑|Bosnia and Herzegovina (abbr. for 波斯尼亞和黑塞哥維那，波斯尼亚和黑塞哥维那[Bo1 si1 ni2 ya4 he2 Hei1 sai4 ge1 wei2 na4])
波点|polka dot (abbr. for 波爾卡圓點，波尔卡圆点[bo1 er3 ka3 yuan2 dian3])
泥土|earth; soil; mud; clay
注意|to take note of; to pay attention to
流布|to spread; to circulate; to disseminate
流传|to spread; to circulate; to hand down
流入|to flow into; inflow
流出|to flow out; to issue; to leak
流利|fluent
流动|to flow; to circulate; to move about; mobile; (of assets) liquid
流年|fleeting time;horoscope for the year
流形|manifold (math.)
流明|lumen (unit of light flux) (loanword)
流星|meteor; shooting star;meteor hammer (abbr. for 流星錘，流星锤[liu2 xing1 chui2])
流民|refugee
流水|running water;(business) turnover
流沙|quicksand;(patisserie) (usu. attributive) semi-liquid filling (typically custard); lava
流片|to tape out (in semiconductor manufacturing)
流球|variant of 琉球[Liu2 qiu2], Ryūkyū, e.g. the Ryūkyū Islands 琉球群島，琉球群岛[Liu2 qiu2 Qun2 dao3] stretching from Japan to Taiwan
流网|drift net (fishing)
流线|streamline (physics)
流血|to bleed;to shed blood
流行|(of a contagious disease etc) to spread; to propagate;(of a style of clothing, song etc) popular; fashionable
流调|epidemiological survey (abbr. for 流行病學調查，流行病学调查[liu2 xing2 bing4 xue2 diao4 cha2])
流变|to flow and change;development and change (of society)
流转|to be on the move;to roam or wander;to circulate (of goods or capital)
流通|to circulate; to distribute;circulation; distribution
流量|flow rate; throughput of passengers; volume of traffic;(hydrology) discharge;data traffic; network traffic; website traffic; mobil…
流离|homeless and miserable;forced to leave home and wander from place to place;to live as a refugee
流体|fluid
浩劫|calamity;catastrophe;apocalypse
浩瀚|vast (of ocean);boundless
海上|maritime
海事|maritime affairs;accident at sea
海信|Hisense (brand)
海内|the whole world;throughout the land;everything under the sun
海北|see 海北藏族自治州[Hai3 bei3 Zang4 zu2 Zi4 zhi4 zhou1]
海南|see 海南省[Hai3 nan2 Sheng3];see 海南島，海南岛[Hai3 nan2 Dao3];see 海南區，海南区[Hai3 nan2 Qu1];see 海南藏族自治州[Hai3 nan2 Zang4 zu2 Zi4 zhi4 zhou1]
海原|see 海原縣，海原县[Hai3 yuan2 Xian4]
海口|see 海口市[Hai3 kou3 Shi4]
海员|sailor; mariner
海地|Haiti
海城|see 海城市[Hai3 cheng2 Shi4];see 海城區，海城区[Hai3 cheng2 Qu1]
海报|poster;playbill;notice
海外|overseas; abroad
海子|(dialect) wetlands;lake
海安|see 海安市[Hai3 an1 Shi4]
海宁|see 海寧市，海宁市[Hai3 ning2 Shi4]
海州|see 海州區，海州区[Hai3 zhou1 Qu1]
海市|(lit. and fig.) mirage
海带|kelp
海战|sea warfare; naval battle
海斯|(name) Hayes
海日|(literary) the sun over the sea
海星|starfish;sea star
海东|see 海東市，海东市[Hai3 dong1 Shi4];(also can refer to Liaodong, the Korean Peninsula, Bohai or Japan, depending on the historical contex…
海林|see 海林市[Hai3 lin2 Shi4]
海水|seawater
海沙|sea sand
海河|Hai He (a system of five waterways around Tianjin, flowing into Bohai 渤海 at Dagukou 大沽口)
海法|Haifa (city in Israel)
海波|hypo (loanword);sodium thiosulfate Na2S2O3 used in fixing photos (formerly hyposulfite);wave (sea)
海尔|Haier (PRC household appliance brand);Hale (name)
海王|Poseidon, Greek god of the sea;Neptune, Roman god of the sea;Aquaman, DC comic book superhero;(slang) womanizer
海相|marine facies (geology)
海神|Emperor of the Sea;Neptune
海米|dried shrimps
海草|seagrass
海西|see 海西蒙古族藏族自治州[Hai3 xi1 Meng3 gu3 zu2 Zang4 zu2 Zi4 zhi4 zhou1]
海角|cape;promontory
海军|navy
海运|shipping by sea
海边|coast; seaside; seashore; beach
海里|nautical mile
海量|(courteous) magnanimity;great capacity for alcohol;(attributive) enormous quantity; massive volume
海门|see 海門區，海门区[Hai3 men2 Qu1]
海关|customs (i.e. border crossing inspection)
海阳|see 海陽市，海阳市[Hai3 yang2 Shi4]
海面|the surface of the sea; ocean surface
海风|sea breeze
海马|(zoology) sea horse;(anatomy) hippocampus (abbr. for 海馬體，海马体[hai3 ma3 ti3])
海鱼|saltwater fish
消息|(piece of) news; information;message
涵养|to cultivate (personal qualities);(of forests etc) to support; to provide a suitable environment for the replenishment of (natural…
凄清|somber; cheerless
泪水|teardrop;tears
淡泊|living a simple life
沦落|to degenerate;impoverished;to fall (into poverty);to be reduced (to begging)
深邃|deep (valley or night);abstruse;hidden in depth
清人|Qing dynasty person
清代|Qing dynasty (1644-1911)
清原|see 清原滿族自治縣，清原满族自治县[Qing1 yuan2 Man3 zu2 Zi4 zhi4 xian4]
清单|list of items
清城|see 清城區，清城区[Qing1 cheng2 Qu1]
清场|to clear (a place);to evacuate
清州|Cheongju, capital of North Chungcheong Province, South Korea 忠清北道[Zhong1 qing1 bei3 dao4]
清新|see 清新區，清新区[Qing1 xin1 Qu1]
清明|Qingming or Pure Brightness, 5th of the 24 solar terms 二十四節氣，二十四节气[er4 shi2 si4 jie2 qi5] 5th-19th April;Pure Brightness Festival …
清楚|clear;distinct;to understand thoroughly;to be clear about
清正|upright and honorable
清水|see 清水縣，清水县[Qing1 shui3 Xian4];Shimizu (Japanese surname and place name)
清江|Qingjiang river in Hubei
清河|see 清河縣，清河县[Qing1 he2 Xian4];see 清河區，清河区[Qing1 he2 Qu1]
清油|vegetable cooking oil
清流|see 清流縣，清流县[Qing1 liu2 Xian4]
清火|to clear internal heat (Chinese Medicine)
清热|to alleviate fever (medicine);to clear internal heat (Chinese medicine)
清理|to clear up;to tidy up;to dispose of
清白|pure;innocent
清盘|liquidation
清空|to clear;to empty
清华|for 清華大學，清华大学[Qing1 hua2 Da4 xue2]
清军|the Qing army
清道|to clean the street;to clear the road (i.e. get rid of people for passage of royalty or VIP)
清酒|sake (Japanese rice wine)
清关|customs clearance
清音|(phonetics) voiceless sound
清风|cool breeze;fig. pure and honest
清香|sweet scent;fragrant odor
清高|noble and virtuous;aloof from politics and material pursuits
清点|to check;to make inventory
减少|to lessen; to decrease; to reduce; to lower
准备|preparation;to prepare;to intend;to be about to
溘然|suddenly
温度|temperature
温暖|warm
温润|gentle;kindly;mild and humid (climate)
漂亮|pretty; beautiful
漂泊|(of a boat) to float; to drift; to lie at anchor;(fig.) to roam; to lead a wandering existence
汉字|Chinese character(s)
汉语|Chinese language
渐渐|gradually
泼辣|shrewish;pungent;forceful;bold and vigorous
潦倒|down on one's luck; in straitened circumstances; disappointed; frustrated
洒脱|free and at ease; natural; unconstrained
火光|flame;blaze
火儿|fire;fury;angry
火力|fire;firepower
火化|to cremate;to incinerate
火器|gunpowder weapon (esp. firearm)
火场|the scene of a fire
火大|to get mad; to be very angry
火山|volcano
火成|(geology) igneous; volcanic (rock)
火星|Mars (planet)
火机|see 打火機，打火机[da3 huo3 ji1]
火气|anger;internal heat (TCM)
火油|(dialect) kerosene
火海|a sea of flames
火热|fiery;burning;fervent;ardent
火球|fireball
火眼|pinkeye
火石|flint
火神|god of fire
火红|fiery;blazing
火线|FireWire (IEEE 1394 data-transfer interface)
火色|(dialect) intensity of the fire (in cooking, kiln firing etc)
火花|spark;sparkle
火车|train
火电|thermal power
火龙|a lantern or torchlight procession (resembling a fiery dragon)
灼热|burning hot; scorching
灾难|disaster; catastrophe
为了|for; for the purpose of; in order to
无上|supreme
无不|none lacking;none missing;everything is there;everyone without exception
无人|unmanned;uninhabited
无利|no profit;not profitable;a hindrance;(to lend money) at no interest
无力|to lack strength; to feel weak;to lack the ability or power (to do sth)
无可|can't
无名|nameless;obscure
无品|fretless (stringed instrument)
无垠|boundless;vast
无宁|variant of 毋寧，毋宁[wu2 ning4]
无干|to have nothing to do with
无度|immoderate;excessive;not knowing one's limits
无形|incorporeal;virtual;formless;invisible (assets)
无后|(literary) to have no descendants; to have no son to continue one's lineage
无心|unintentionally;not in the mood to
无性|sexless;asexual (reproduction)
无情|pitiless;ruthless;merciless;heartless
无意|inadvertent;accidental;to have no intention of (doing sth)
无成|achieving nothing
无数|countless;numberless;innumerable
无明|avidya (Buddhism);ignorance;delusion
无期|unspecified period;in the indefinite future;no fixed time;indefinite sentence (i.e. life imprisonment)
无业|unemployed;jobless;out of work
无机|inorganic (chemistry)
无比|incomparable; matchless
无毛|hairless
无水|anhydrous (chemistry);waterless;dehydrated
无法|unable to; incapable of
无物|nothing;empty
无理|irrational;unreasonable
无用|useless;worthless
无线|wireless
无声|soundless; silent
无色|colorless
无解|to have no solution
无语|to remain silent;to have nothing to say;(coll.) speechless;dumbfounded
无论|no matter what or how;regardless of whether...
无道|tyrannical;brutal (regime)
无边|without boundary;not bordered
无量|measureless;immeasurable
无关|unrelated;having nothing to do (with sth else)
无双|incomparable;matchless;unique
焦急|anxiety;anxious
然后|then; after that; afterwards
煎熬|to suffer;to torture;to torment;ordeal
煞气|to vent one's anger on (an innocent party);to take it out on (sb)
照顾|to take care of;to show consideration;to attend to;to look after
烦恼|to be worried;to be distressed;worries
热中|variant of 熱衷，热衷[re4 zhong1]
热力|heat
热土|homeland;hot piece of real estate
热天|hot day
热带|the tropics;tropical
热度|level of heat;(fig.) zeal;fervor;(coll.) a temperature (i.e. abnormally high body heat)
热心|enthusiastic; ardent; zealous
热情|cordial;enthusiastic;passion;passionate
热战|hot war
热机|heat engine
热气|steam;heat
热水|hot water
热河|Rehe, Qing dynasty province abolished in 1955 and divided among Hebei, Liaoning and Inner Mongolia;refers to the Qing imperial res…
热病|fever;pyrexia
热管|heat pipe
热线|hotline (communications link)
热血|hot blood;warm-blooded (animal);endothermic (physiology)
热解|thermal cleavage (i.e. sth splits when heated)
热词|buzzword
热身|to warm up (sports);(fig.) to prepare;to get in condition
热量|heat;quantity of heat;calorific value
热门|popular; hot; in vogue
热电|pyroelectric
热点|hot spot;point of special interest
炽热|red-hot;glowing;blazing;(fig.) passionate
爪牙|pawn;lackey;accomplice (in crime);collaborator
争吵|to quarrel;dispute
父亲|father;also pr. [fu4 qin5]
爸爸|(coll.) father; dad
尔来|(literary) recently; lately; hitherto
尔后|henceforth;thereafter;subsequently
尔德|Eid (Islam)
尔格|erg (physics) (loanword)
片中|in the movie
片儿|sheet;thin film
片刻|short period of time;a moment
片名|movie title
片商|movie production company;film distributor
片场|filming location; film set
片子|film;movie;film reel;phonograph record
片时|a short time;a moment
片花|trailer (for a movie)
片语|phrase
片长|length (duration) of a film
片面|unilateral;one-sided
片头|leader (blank section at the beginning or end of a reel of film)
牛奶|cow's milk
物主|owner
物事|(literary) affair; matter; business;(dialect) item; thing; stuff
物力|physical resources (as opposed to labor resources)
物化|to objectify;(literary) to die
物品|articles; goods
物业|property;real estate;abbr. for 物業管理，物业管理[wu4 ye4 guan3 li3], property management
物流|distribution (business);logistics
物理|physics;physical; relating to the material world
物管|property management (abbr. for 物業管理，物业管理[wu4 ye4 guan3 li3])
物色|to look for; to seek out; to choose
物语|monogatari;epic narrative (Japanese literary form)
物体|object; body; substance
特来|to come with a specific purpose in mind
特出|outstanding;prominent
特别|unusual; special;very; especially; particularly;expressly; for a specific purpose;(often followed by 是[shi4]) in particular
特利|(name) Terry
特化|specialization
特区|special administrative region;abbr. for 特別行政區，特别行政区
特地|specially;for a special purpose
特大|exceptionally big
特定|special; specific; designated; particular
特工|secret service;special service;secret service agent;special agent
特性|property;characteristic
特意|specially;intentionally
特有|specific (to);characteristic (of);distinctive
特色|a characteristic; a distinctive feature or quality
特制|specially made; custom-made
特解|particular solution (to a math. equation)
特调|special blend; house blend
特起|to appear on the scene;to arise suddenly
特长|personal strength;one's special ability or strong points
特点|characteristic; trait; feature
犀利|sharp;incisive;penetrating
狐狸|fox; (fig.) sly or crafty person
狠狠|resolutely;firmly;ferociously;ruthlessly
狡诈|crafty;cunning;deceitful
狡黠|crafty;astute
狮子|Leo (star sign);Shihtzu township in Pingtung County 屏東縣，屏东县[Ping2 dong1 Xian4], Taiwan
独自|alone
获得|to obtain; to receive; to get
献媚|to ingratiate oneself with;to pander to
玄妙|mysterious;profound;abstruse
王公|princes and dukes;aristocrat
王力|Wang Li (1900-1986), one of the pioneers of modern Chinese linguistics
王化|beneficial influence of the sovereign
王后|queen
王国|kingdom;realm
王子|prince;son of a king
王家|princely
王平|Wang Ping (1962-2013), PRC crosstalk actor
王座|throne
王明|Wang Ming (1904-1974), Soviet-trained Chinese communist, Comintern and Soviet stooge and left adventurist in the 1930s, fell out w…
王水|Aqua regia
王法|the law;the law of the land;the law of a state (in former times);criterion
王者|king; emperor;(fig.) the best; champion
王道|the Way of the King;statecraft;benevolent rule;virtuous as opposed to the Way of Hegemon 霸道
玩耍|to play (as children do);to amuse oneself
珠宝|pearls;jewels;precious stones
现在|now; at present; currently
球员|(ball sports) player; team member
球场|stadium;sports ground;court;pitch
球座|tee (golf)
球形|spherical; ball-shaped
球手|(ball sports) player
球星|sports star (ball sport)
球会|(HK) ball sports club (soccer, basketball etc)
球台|table (for games using balls)
球网|net (for ball games)
球路|(sports) trajectory of the ball;method of dispatching the ball (e.g. in baseball: curveball, slider, fastball etc)
球道|fairway (golf);lane (ten-pin bowling)
球门|goalmouth (in soccer)
球面|sphere
球体|spheroid
理事|member of council;(literary) to take care of matters
理光|Ricoh, Japanese imaging and electronics company
理儿|reason
理化|physics and chemistry;(archaic) governance and education
理学|School of Principle;Neo-Confucian Rationalistic School (from Song to mid-Qing times, c. 1000-1750, typified by the teachings of Ch…
理工|science and engineering as academic subjects
理性|reason;rationality;rational
理想|an ideal;a dream;ideal;perfect
理会|to understand;to pay attention to;to take notice of
理气|(TCM) to rectify 氣，气[qi4]
理清|to disentangle (wiring etc);(fig.) to clarify (one's thoughts etc)
理科|the sciences (as opposed to the humanities 文科[wen2 ke1])
理县|Li County or Lixian, a county in Ngawa Tibetan and Qiang Autonomous Prefecture 阿壩藏族羌族自治州，阿坝藏族羌族自治州[A1 ba4 Zang4 zu2 Qiang1 zu2 Zi4…
理解|to comprehend; to understand
理路|logical thinking
理头|to have a haircut;to cut sb's hair
理发|to get a haircut; to have one's hair done;to cut (sb's) hair; to give (sb) a haircut
璀璨|bright;resplendent
环境|environment;circumstances;surroundings;ambient
环顾|to look around;to survey
生下|to give birth to
生事|to make trouble
生人|stranger;living person;to give birth;to be born (in a certain time or place)
生来|from birth;by one's nature
生光|to emit light
生出|to give birth;to grow (whiskers etc);to generate;to produce
生分|estranged
生前|(of a deceased) during one's life;while living
生动|(of descriptions, writing etc) vivid; lively
生化|biochemistry
生命|life (as the characteristic of living beings);living being; creature (CL:條，条[tiao2])
生员|scholar preparing for imperial examinations (in former times)
生土|(agr.) immature soil;virgin soil
生子|to give birth to a child or children
生字|new character (in textbook);character that is unfamiliar or not yet studied
生平|life (a person's whole life);in one's entire life
生性|natural disposition
生意|life force;vitality
生成|to generate; to produce; to form; to be formed; to come into being;to be born with; to be blessed with
生手|novice;new hand;sb new to a job
生教|(Tw) student conduct and life-guidance group (a unit within the student affairs office 學務處，学务处[xue2 wu4 chu4]) (abbr. for 生活教育組，生活…
生日|birthday
生机|opportunity to live; hope of success;vigor; vitality
生死|life or death
生气|to get angry; to be furious;vitality; liveliness
生水|unboiled water
生活|to live;life;livelihood
生火|to make a fire; to light a fire
生热|to generate heat
生物|organism; living creature; life form;(attributive) biological; bio-
生理|physiology
生病|to fall ill
生发|to emerge and grow;to develop
生皮|pelt;raw hide
生管|production control; production management (abbr. for 生產管理，生产管理[sheng1 chan3 guan3 li3])
生米|coarse rice;uncooked rice
生肉|raw meat
生菜|lettuce;raw fresh vegetables;greens
生词|new word (in textbook);word that is unfamiliar or not yet studied
生路|a way to make a living;a way to survive;a way out of a predicament
生长|to grow;to grow up;to be brought up
产品|goods;merchandise;product
用人|servant;to employ sb for a job;to manage people;to be in need of staff
用作|to use for the purpose of;to serve as
用来|to be used for
用光|out of (supply);spent;exhausted (used up);depleted
用力|to exert oneself physically
用品|articles for use;products;goods
用场|use; application
用字|to use letters;to use words;diction
用家|(HK) user
用工|to employ workers
用度|expense
用心|motive;intention;to be diligent or attentive;careful
用意|intention;purpose
用法|usage
用词|usage (of a term);wording;phrasing
用语|choice of words;wording;phraseology;term
用量|quantity used; usage; consumption; dose
田野|field;open land
男人|a man;a male;men
留下|to leave behind;to stay behind;to remain;to keep
毕竟|after all;all in all;when all is said and done;in the final analysis
画画|to draw; to paint
当然|only natural;as it should be;certainly;of course
病人|sick person;patient;invalid
病原|cause of disease;pathogen
病员|sick personnel;person on the sick list;patient
病家|a patient and his family
病情|state of an illness;patient's condition
病房|ward (of a hospital);sickroom
病机|interpretation of the cause;onset and process of an illness;pathogenesis
病死|to fall ill and die;to die of illness
病理|pathology
病者|sick person; patient
病号|sick personnel;person on the sick list;patient
病变|pathological changes;lesion;diseased (kidney, cornea etc)
病重|seriously ill
痛苦|pain;suffering;painful
发交|to issue and deliver (to people)
发布|variant of 發布，发布[fa1 bu4]
发作|to flare up; to break out
发信|to post a letter
发光|to emit light; to shine; to glow; to glisten; to be luminous
发出|to issue (an order, decree etc); to send out; to dispatch;to produce (a sound); to let out (a laugh)
发力|to exert oneself; to apply force;(of an enterprise etc) to gain momentum; to perform strongly
发动|to start;to launch;to unleash;to mobilize
发包|to put out to contract
发卡|to issue a card;(slang) to reject a guy or a girl;to chuck
发回|to send back;to return
发报|to send a message
发家|to lay down a family fortune;to get rich;to become prosperous
发情|(zoology) (of a female) to be in heat; (of a male) to be in rut
发文|to issue a document;document issued by an authority;outgoing messages;(Internet) to post an article online
发明|to invent;an invention
发毛|to rant and rave;to be scared, upset (Beijing dialect)
发气|to get angry
发水|to flood
发火|to catch fire;to ignite;to detonate;to get angry
发热|to have a high temperature;feverish;unable to think calmly;to emit heat
发烧|to have a high temperature (from illness); to have a fever;(fig.) to be fascinated with; to obsess over;(fig.) flourishing; thrivi…
发现|to notice; to become aware of;to discover; to find; to detect;a discovery
发球|(tennis etc) to serve;(golf) to tee off
发生|to happen; to occur; to take place; to break out
发病|(of an illness) to occur;(of a person) to get sick; to fall ill;onset (of a medical condition)
发白|to turn pale;to lose color;to go white
发红|to turn red;to blush;to flush
发声|to produce a sound; to vocalize;to give voice; to articulate views or demands
发自|to evolve from
发行|to publish; to issue; to release; to distribute
发表|to issue;to publish
发起|to originate;to initiate;to launch (an attack, an initiative etc);to start
发车|departure (of a coach or train);to dispatch a vehicle
发运|(of goods) to dispatch;shipment;shipping
发达|well-developed; flourishing;to develop; to promote; to expand;(literary) to achieve fame and fortune; to prosper
发电|to generate electricity;to send a telegram
发音|to pronounce;pronunciation;to emit sound
发面|to leaven dough;to make bread
白事|funeral;to explain (literary)
白人|white man or woman; Caucasian
白区|White area (territory controlled by the KMT during the Second Revolutionary War, 1927–1937)
白城|see 白城市[Bai2 cheng2 Shi4]
白天|daytime;during the day;day
白子|white Go chess piece;bee pupa;albino
白字|Chinese character incorrectly written or read aloud in place of another character
白山|see 白山市[Bai2 shan1 Shi4]
白布|plain white cloth;calico
白带|leukorrhea
白文|the text of an annotated book;an unannotated edition of a book;intagliated characters (on a seal)
白族|Bai ethnic group
白日|daytime;sun;time
白板|whiteboard;tabula rasa;blank slate
白果|ginkgo
白毛|white hair (of animals);see also 白髮，白发[bai2 fa4]
白水|see 白水縣，白水县[Bai2 shui3 Xian4]
白沙|see 白沙黎族自治縣，白沙黎族自治县[Bai2 sha1 Li2 zu2 Zi4 zhi4 xian4]
白河|see 白河縣，白河县[Bai2 he2 Xian4]
白海|White Sea
白热|white heat;incandescence
白白|in vain;to no purpose;for nothing;white
白眼|to give sb a dirty look; to cast a supercilious glance;a disdainful look
白米|(polished) rice
白线|white line (road markings)
白肉|plain boiled pork;white meat (fish, poultry etc)
白色|white;fig. reactionary;anti-communist
白菜|Chinese cabbage, esp. napa cabbage (Brassica rapa subsp. pekinensis);sometimes used to refer to bok choy (Brassica rapa subsp. chi…
白话|spoken language;vernacular
白起|Bai Qi (-258 BC), famous general of Qin 秦國，秦国, the victor at 長平，长平 in 260 BC;same as 公孫起，公孙起
白军|White Guard or White Movement, anti-communist troops fighting against the Bolsheviks during the Russian Civil War (1917-1922)
白道|(astronomy) the moon's path around the earth;legitimate, lawful activities (contrasted with 黑道[hei1 dao4]);law-abiding citizenry
白酒|baijiu, a spirit usually distilled from sorghum;(Tw) white wine (abbr. for 白葡萄酒[bai2 pu2 tao5 jiu3])
白金|platinum;silver;white gold;(Singapore) money gift at a funeral
白电|white goods (abbr. for 白色家電，白色家电[bai2 se4 jia1 dian4])
白头|hoary head;old age
白骨|bones of the dead
白体|lean type
白发|white or gray hair
白鱼|whitefish
白面|wheat flour;flour;heroin
百姓|common people
的确|really;indeed
皇后|empress;imperial consort
皇宫|imperial palace
皇帝|emperor
皮下|under the skin;subcutaneous (injection)
皮儿|wrapper;cover
皮包|handbag;briefcase
皮卡|(loanword) pickup truck
皮子|skin;fur
皮实|(of things) durable;(of people) sturdy; tough
皮山|see 皮山縣，皮山县[Pi2 shan1 Xian4]
皮带|strap;leather belt
皮星|picosatellite
皮毛|fur;fur clothing;skin and hair;superficial
皮尔|Pierre, capital of South Dakota
皮球|ball (made of rubber, leather etc)
皮肉|skin and flesh; the physical body;(fig.) the superficial layer; surface aspects
皮肤|skin
皮草|fur clothing
皮重|tare weight
皮面|outer skin;surface;leather cover (of a book);drum skin
皮黄|Beijing opera (or styles of song in);abbr. for 西皮二黃，西皮二黄
盔甲|armor;body armor and helmet
监狱|prison
盘古|Pangu (creator of the universe in Chinese mythology)
盘子|tray;plate;dish
盘山|see 盤山縣，盘山县[Pan2 shan1 Xian4]
盘州|see 盤州市，盘州市[Pan2 zhou1 Shi4]
盘带|(soccer) to dribble
盘桓|to pace;to linger;to stay over;to spiral
盘球|(sports) to dribble
盘盘|twisting and turning
盘石|variant of 磐石[pan2 shi2]
盘管|coil in still (used for distilling)
盘道|twining mountain road
盘头|to coil hair into a bun;hair worn in bun;turban;hair ornament
盘香|incense coil
盘点|to make an inventory;to take stock
盘龙|see 盤龍區，盘龙区[Pan2 long2 Qu1]
目光|gaze; (fig.) attention;expression in one's eyes; look;(lit. and fig.) sight; vision
目前|at the present time;currently
目的|purpose; aim; goal; target; objective
直到|until
相中|to find to one's taste;to pick (after looking at);Taiwan pr. [xiang4 zhong4]
相交|(of roads, lines etc) to intersect;(of people) to associate with one another; to become friends
相似|similar; alike
相保|to guard each other
相信|to believe; to be convinced; to accept as true
相传|to pass on;to hand down;tradition has it that ...;according to legend
相公|lord;master;young gentleman;male prostitute
相加|to add up (numbers);(fig.) to put together (several things of the same type, e.g. skills)
相反|opposite;contrary
相合|to conform to;to fit with;to be compatible with
相同|identical; same
相国|prime minister (in ancient China)
相图|phase diagram (math.);phase portrait
相城|see 相城區，相城区[Xiang4 cheng2 Qu1]
相士|fortune-teller who uses the subject's face for his prognostication
相好|to be intimate;close friend;paramour
相对|relatively;opposite;to resist;to oppose
相山|see 相山區，相山区[Xiang4 shan1 Qu1]
相干|relevant;to have to do with;(physics) (of light etc) coherent
相会|to meet together
相机|camera (abbr. for 照相機，照相机[zhao4 xiang4 ji1]);at the opportune moment;as the circumstances allow
相比|to compare
相片|image;photograph
相生|to engender one another
相聚|to meet together;to assemble
相声|comic dialogue;sketch;crosstalk
相角|photo corner (used to mount a photo in an album);(math.) phase angle
相通|interlinked;connected;communicating;in communication
相关|related;relevant;pertinent;to be interrelated
相面|fortune telling based on the subject's face
省钱|to save money
看到|to see
看病|to visit a doctor;to see a patient
看见|to see; to catch sight of
真的|really; truly; indeed;real; true; genuine;(math.) proper
真相|the truth about sth; the actual facts
眷恋|to miss;to long for;to remember with longing;yearning
眺望|to survey the scene from an elevated position
眼下|now; at present;(anatomy) subocular
眼中|in (sb's) eyes
眼光|gaze;insight;foresight;vision
眼前|before one's eyes;now;at present
眼力|eyesight;strength of vision;the ability to make discerning judgments
眼动|eye movement
眼房|camera oculi;aqueous chamber of the eye
眼时|(dialect) now; at present
眼格|see 眼界[yan3 jie4]
眼气|(dialect) to envy; to be jealous
眼波|fluid glance
眼泪|tear; teardrop
眼热|to covet;envious
眼球|eyeball;(fig.) attention
眼生|unfamiliar;strange-looking
眼病|eye disease
眼白|white of the eye
眼皮|eyelid
眼睛|eye
眼神|expression or emotion showing in one's eyes;meaningful glance;wink;eyesight (dialect)
眼科|(department of) ophthalmology
眼红|to covet;envious;jealous;green with envy
眼线|informer;snitch;spy;scout
眼色|signal made with one's eyes;meaningful glance
眼花|dimmed eyesight;blurred;vague and unclear vision
眼角|outer or inner corner of the eye; canthus
眼风|eye signal;meaningful glance
眼高|haughty;contemptuous;to have high expectations
眼点|eyespot (in lower creatures)
睡觉|to go to bed;to sleep
睥睨|(literary) to look disdainfully out of the corner of one's eye; to look askance at
瞥见|to glimpse
瞬息|in a flash;twinkling;ephemeral
矗立|to tower;standing tall and upright (of large building)
知识|knowledge;intellectual
知道|to know; to become aware of;also pr. [zhi1dao5]
短信|text message;SMS
石作|masonry workshop
石化|to petrify;petrochemical industry
石台|see 石台縣，石台县[Shi2 tai2 Xian4]
石器|stone tool;stone implement
石城|see 石城縣，石城县[Shi2 cheng2 Xian4]
石女|female suffering absence or atresia of vagina (as birth defect)
石子|small stone; gravel
石工|stonemasonry;stonemason
石板|slab;flagstone;slate
石林|Stone Forest, notable set of limestone formations in Yunnan
石油|oil;petroleum
石火|(literary) a spark struck from flint
石片|slab
石门|see 石門縣，石门县[Shi2 men2 Xian4]
石青|azurite;copper azurite 2CuCO3-Cu(OH)2;azure blue
石头|stone
石龙|see 石龍區，石龙区[Shi2 long2 Qu1]
破坏|destruction;damage;to wreck;to break
确定|definite;certain;fixed;to fix (on sth)
确实|indeed;really;reliable;real
神交|soul brothers;friends in spirit who have never met;to commune with
神人|God;deity
神仙|Daoist immortal;supernatural entity;(in modern fiction) fairy, elf, leprechaun etc;fig. lighthearted person
神作|(slang) masterpiece
神入|(psychology) empathy;to empathize with
神力|occult force;the power of a God or spirit
神化|to make divine;apotheosis
神器|magical object;object symbolic of imperial power;fine weapon;very useful tool
神女|The Goddess, 1934 silent film about a Shanghai prostitute, directed by 吳永剛，吴永刚[Wu2 Yong3 gang1]
神学|theological;theology
神山|sacred mountain
神州|old name for China
神性|divinity
神情|look; expression
神明|deities;gods
神木|see 神木市[Shen2 mu4 Shi4]
神格|Godhead
神气|expression;manner;vigorous;impressive
神经|nerve;mental state;(coll.) unhinged;nutjob
神色|expression;look
神话|legend;fairy tale;myth;mythology
神通|remarkable ability;magical power
神道|Shinto (Japanese religion)
神马|mythical horse;Internet slang for 什麼，什么[shen2 me5]
神体|Godhead
福气|good fortune;a blessing
科克|Cork, city in Ireland
科名|rank obtained in the imperial examinations;scholarly honors
科学|science;scientific knowledge;scientific;rational
科教|science and education;science education
科林|Colin (name)
科比|(name) Coby; Colby; Kirby;Kobe Bryant (1978–2020), US basketball player
科尔|Kohl (name);Helmut Kohl (1930-2017), German CDU politician, Chancellor 1982-1998
科长|section chief
秘密|secret; private; confidential; clandestine;a secret
种子|seed
究竟|to go to the bottom of a matter;after all;when all is said and done;(in an interrogative sentence) finally
空中|in the sky;in the air
空儿|spare time;free time
空前|unprecedented
空口|incomplete meal of a single dish;meat or vegetable dish without rice or wine;rice without meat or vegetables
空名|vacuous reputation;name without substance;in name only;so-called
空地|air-to-surface (missile)
空子|gap;unoccupied space or time;fig. gap;loophole
空客|Airbus (abbr. for 空中客車，空中客车[Kong1 zhong1 Ke4 che1])
空心|hollow;(of vegetables) to become hollow or spongy inside;(of a basketball) to swish through (not touching the hoop)
空性|emptiness
空战|air war;air warfare
空手|empty-handed;unarmed;(painting, embroidery etc) without following a model;(abbr. for 空手道[kong1 shou3 dao4]) karate
空日|day that is named but not numbered (on ethnic calendar)
空格|blank;blank space on a form;space;囗 (indicating missing or illegible character)
空气|air;atmosphere
空白|blank space
空空|empty;vacuous;nothing;vacant
空号|disconnected phone number;unassigned phone number
空话|empty talk;bunk;malicious gossip
空调|air conditioning;air conditioner (including units that have a heating mode)
空身|empty handed (carrying nothing);alone
空军|air force;(slang) to fail to catch anything (on a fishing trip); to get skunked
空运|air transport
空头|phony;so-called;armchair (expert);vain (promise)
穿过|to pass through
突然|sudden; abrupt; unexpected
窈窕|(literary) (of a woman) graceful and refined; comely; (esp.) slender; slim;(literary) (of a bower, a mountain stream or a boudoir …
窗户|window
窘境|awkward situation;predicament
窘迫|poverty-stricken;very poor;hard-pressed;in a predicament
立刻|immediately; at once; right away
立即|immediately
竟然|unexpectedly;to one's surprise;in spite of everything;in that crazy way
端倪|boundary;clue;indication;to obtain clues
端详|full details;full particulars
等待|to wait; to wait for
等等|et cetera;and so on ...;wait a minute!;hold on!
答应|to answer; to respond;to answer positively; to agree; to accept; to promise
答案|answer;solution
管保|to guarantee;assuredly
管制|to control;to restrict;(PRC law) non-custodial sentence with specified restrictions on one's activities for up to 3 years (e.g. no…
管城|see 管城回族區，管城回族区[Guan3 cheng2 Hui2 zu2 Qu1]
管子|Guanzi or Guan Zhong 管仲 (-645 BC), famous politician of Qi 齊國，齐国 of Spring and Autumn period;Guanzi, classical book containing wri…
管家|(old) butler; steward;manager; administrator; housekeeper;to manage a household
管工|plumber;pipe-worker
管座|to mount an electronic valve;to plug in a bulb
管情|to guarantee
管教|to discipline;to teach;to guarantee
管理|to supervise;to manage;to administer;management
管用|efficacious;useful
管线|pipeline;general term for pipes, cables etc
管路|piping (for water, oil, etc);conduit
管道|tubing;pipeline;(fig.) channel;means
节制|to control;to restrict;to moderate;to temper
节子|gnarl;knot
节日|holiday;festival
节期|festival season
节本|abridged version
节气|solar term
节水|to save water
节油|to economize on gasoline;fuel-efficient
节流|to control flow;to choke;weir valve;a throttle
节节|step by step;little by little
节电|to save electricity;power saving
节点|node
简单|simple; not complicated
米制|metric system
米国|United States;name of a country that formerly existed near Samarkand
米拉|Mira (red giant star, Omicron Ceti)
米东|see 米東區，米东区[Mi3 dong1 Qu1]
米林|see 米林市[Mi3 lin2 Shi4]
米果|rice cracker
米格|MiG;Russian Aircraft Corporation;Mikoyan
米线|rice-flour noodles
米罗|Joan Miró (1893-1983), Spanish surrealist painter
米色|beige
米兰|Milano;Milan (Italy)
米酒|rice wine
米高|(HK) (name) Michael
米面|rice and noodles;rice flour;rice-flour noodles
米黄|cream-colored; beige
粲然|clear and bright;with a big smile
精明|astute; shrewd; smart
精神|spirit;mind;consciousness;thought
红人|a favorite of sb in power;a celebrity;American Indian
红利|bonus; dividend
红包|money wrapped in red as a gift;bonus payment;kickback;bribe
红原|see 紅原縣，红原县[Hong2 yuan2 Xian4]
红古|see 紅古區，红古区[Hong2 gu3 Qu1]
红土|red soil;laterite
红场|Red Square (in Moscow)
红尘|the world of mortals (Buddhism);human society;worldly affairs
红外|infrared (ray)
红学|"Redology", academic field devoted to the study of A Dream of Red Mansions
红安|see 紅安縣，红安县[Hong2 an1 Xian4]
红客|"honker", Chinese hacker motivated by patriotism, using one's skills to protect domestic networks and work in national interest
红山|see 紅山區，红山区[Hong2 shan1 Qu1]
红心|heart ♥ (in card games);red, heart-shaped symbol;bullseye
红日|sun
红星|red star;five pointed star as symbol or communism or proletariat;hot film star
红木|red wood;mahogany;rosewood;padauk
红果|haw fruit
红机|red phone, a telephone in the secure internal phone system used by the CCP elite
红河|Red River, principal river of northern Vietnam, originating in Yunnan (southwestern China)
红油|chili oil
红海|Red Sea
红火|prosperous
红盘|(of a stock price or market index) currently higher than at the previous day's close
红眼|to become infuriated;to see red;envious;jealous
红线|red line
红肉|red meat
红色|red (color);revolutionary
红花|safflower (Carthamus tinctorius)
红装|variant of 紅妝，红妆[hong2 zhuang1]
红军|Red Army (1928-1937), predecessor of the PLA;(Soviet) Red Army (1917-1946)
红通|(Interpol) red notice;abbr. for 紅色通緝令，红色通缉令[hong2 se4 tong1 ji1 ling4]
红运|good luck
红酒|red wine
终于|at last;in the end;finally;eventually
结束|to end; to finish; to conclude
结果|to bear fruit
绝对|absolute; unconditional
绚烂|splendid;gorgeous;dazzling
经传|classic work (esp. Confucian classics)
经商|to trade;to carry out commercial activities;in business
经学|study of the Confucian classics
经常|frequently; constantly; regularly; often;day-to-day; everyday; daily
经年|for years;year after year
经度|longitude
经手|(lit.) to pass through one's hands; (fig.) to handle; to deal with
经文|scripture;scriptures
经书|classic books in Confucianism;scriptures;sutras
经期|menstrual period
经理|manager;director
经管|to be in charge of
经线|warp;line of longitude;meridian (geography)
经血|menstruation (TCM)
经行|to perform walking meditation
经过|to pass;to go through;process;course
网上|online
网下|(of an activity) off-line (not done over the Internet)
网传|(of video clips, rumors etc) to circulate on the Internet
网卡|network adapter card (computing)
网安|cybersecurity (abbr. for 網絡安全，网络安全[wang3 luo4 an1 quan2])
网布|(textiles) mesh fabric
网文|online literature, esp. web novels (abbr. for 網絡文學，网络文学[wang3 luo4 wen2 xue2])
网格|grid;mesh;lattice
网民|netizen; Internet user; online community member
网片|mesh;netting
网特|anonymous state-sponsored Internet commentator (abbr. for 網絡特工，网络特工[wang3 luo4 te4 gong1])
网球|tennis;tennis ball
网盘|online storage space;cloud file storage
网眼|mesh
网站|website
网管|network management;webmaster
网红|Internet celebrity; influencer;(attributive) popular on the Internet
网络|network;Internet
网罗|net for fishing or bird catching;(fig.) fetters;to snare (a valuable new team member etc);to bring together under the one umbrella
网语|Internet slang; netspeak; cyberspeak
网路|(Tw) network;(Tw) Internet
网军|internet troll army; online propaganda army
网通|China Netcom (CNC), former telecommunication service provider in PRC
网关|network router;gateway (to Internet or between networks)
网页|web page
网点|branch; service outlet (of a bank, retail store etc);(printing) halftone dot;(computing) network node
绵延|(esp. of a mountain range) to be continuous; to stretch long and unbroken
紧张|nervous;keyed up;intense;tense
线上|online
线下|offline;below the line
线人|spy;informer
线图|line drawing;diagram;line graph
线报|tip-off
线性|linear;linearity
线路|(electricity) line; circuit; wire;(traffic) road; track; route
线香|incense stick
缘分|fate or chance that brings people together;predestined affinity or relationship;(Budd.) destiny
萦绕|to linger on;to hover;to encircle
县名|name of county
县地|county seat;county town
县城|county seat; county town
县长|county's head commissioner
纵横|warp and weft in weaving; vertically and horizontal;length and breadth;criss-crossed;able to move unhindered
缥缈|variant of 飄渺，飘渺[piao1 miao3]
总之|in a word;in short;in brief
总算|at long last;finally;on the whole
总结|to sum up;to conclude;summary;résumé
缭绕|(of smoke from a chimney) to curl upward;(of a sound) to linger on
继续|to continue; to proceed with; to go on with
缱绻|(literary) in love and inseparable
缠绵|touching (emotions);lingering (illness)
缺点|weak point;fault;shortcoming;disadvantage
罹难|to die in an accident or disaster;to be killed
罗利|Raleigh, capital of North Carolina
罗口|rib collar;rib top of socks
罗城|see 羅城仫佬族自治縣，罗城仫佬族自治县[Luo2 cheng2 Mu4 lao3 zu2 Zi4 zhi4 xian4]
罗定|see 羅定市，罗定市[Luo2 ding4 Shi4]
罗山|see 羅山縣，罗山县[Luo2 shan1 Xian4]
罗布|to display;to spread out;to distribute;old spelling of 盧布，卢布[lu2 bu4], ruble
罗平|see 羅平縣，罗平县[Luo2 ping2 Xian4]
罗拉|roller (loanword)
罗文|Roman Tam (1945–2002), Canto-pop singer
罗斯|(name) Ross; Rose; Roth;Rus' (as in Kievan Rus' 基輔羅斯，基辅罗斯[Ji1 fu3 Luo2 si1])
罗格|Logue or Rogge (name);Jacques Rogge, president of International Olympic Committee (IOC)
罗水|name of a river, the northern tributary of Miluo river 汨羅江，汨罗江[Mi4 luo2 jiang1]
罗江|see 羅江區，罗江区[Luo2 jiang1 Qu1]
罗盘|compass
罗经|compass;same as 羅盤，罗盘
罗网|net;fishing net;bird net
罗兰|Roland (name)
罗语|Romanian language
罗马|Rome, capital of Italy;(historical) Ancient Rome
羁绊|trammels;fetters;yoke;to restrain
美中|US-China
美事|a fine thing;a wonderful thing
美人|beautiful woman; belle
美分|one cent (United States coin)
美加|US and Canada (abbr.)
美化|to make more beautiful;to decorate;embellishment
美名|good name; good reputation
美国|United States; USA; US
美女|beautiful woman
美好|beautiful;fine
美学|aesthetics
美工|art design;art designer
美巴|America and Pakistan;America and Brazil;America and Panama
美式|American-style
美德|USA and Germany
美心|Maxine (name)
美意|goodwill; kindness
美日|the US and Japan; US-Japan
美乐|Merlot (grape type)
美白|to whiten (the skin or teeth)
美石|precious stone;jewel
美神|goddess of beauty (typically used in reference to Venus 維納斯，维纳斯[Wei2 na4 si1] or Aphrodite 阿佛洛狄忒[A1 fu2 luo4 di2 te4])
美网|US Open (tennis tournament)
美声|bel canto
美色|charm;loveliness (of a woman)
美兰|see 美蘭區，美兰区[Mei3 lan2 Qu1]
美制|American made
美语|American English
美军|US army;US armed forces
美酒|good wine;fine liquor
美金|American dollar; US dollar
美发|hairdressing;to give sb's hair a cut or other beauty treatment;beautiful hair
美丽|beautiful
义气|spirit of loyalty and self-sacrifice;code of brotherhood;also pr. [yi4 qi5]
翅膀|wing
习惯|habit;custom;usual practice;to be used to
翩跹|spry and lively (of dancing and movements)
翻译|to translate;to interpret;translator;interpreter
老中|(slang) Chinese people; we Chinese (often self-referential, ironic); China; the Chinese side
老二|second-eldest child in a family;(euphemism) penis
老人|old man or woman;the elderly;one's aged parents or grandparents
老儿|father;husband;old man
老公|(coll.) husband
老化|(of a person, population or material) to age;(of knowledge) to become outdated
老土|old-fashioned; unstylish
老城|old town;old district of a city
老外|(coll.) foreigner (esp. non Asian person);layman;amateur
老大|old age;very;eldest child in a family;leader of a group
老天|God;Heavens
老子|Laozi or Lao-tze (c. 500 BC), Chinese philosopher, the founder of Taoism;the sacred book of Daoism, 道德經，道德经[Dao4 de2 jing1] by Lao…
老客|peddler;old or regular customer
老家|native place;place of origin;home state or region
老实|honest; sincere;well-behaved;naive; gullible
老小|the old and the young;the youngest member of the family
老师|teacher
老年|elderly;old age;autumn of one's years
老式|old-fashioned;old type;outdated
老成|mature;experienced;sophisticated
老手|experienced person;an old hand at sth
老本|capital;assets;savings;nest egg
老板|variant of 老闆，老板[lao3 ban3]
老死|to die of old age
老生|venerable middle-aged or elderly man, usually wearing an artificial beard (in Chinese opera)
老美|(coll.) an American; person from the United States
老老|variant of 姥姥[lao3 lao5]
老者|old man; elderly man
老花|presbyopia
老虎|tiger
老表|(coll.) male cousin through a female relative;(coll.) friendly form of address between men of similar age;(coll.) nickname for a p…
老话|an old saying
老路|old road;familiar way;beaten track;conventional behavior
老边|see 老邊區，老边区[Lao3 bian1 Qu1]
老酒|wine, esp. Shaoxing wine
老头|old fellow;old man;father;husband
老面|sourdough starter
老黑|(coll.) black person
考试|to take an exam;exam
者流|(after a personal attribute) people who have that attribute; people of that type
而且|(not only ...) but also;moreover; in addition; furthermore
耳朵|ear;handle (on a cup)
耳目|eyes and ears;sb's attention or notice;information;knowledge
聪明|intelligent; clever; bright;acute (of sight and hearing)
声卡|sound card
声名|reputation;declaration
声场|(physics) acoustic field; sound field;soundstage
声学|acoustics
声带|vocal cords;vocal folds;(motion picture) soundtrack
声明|to state;to declare;statement;declaration
声乐|vocal music
声气|voice;tone;information
声波|sound wave
声线|voice (as sth that may be described as husky 沙啞，沙哑[sha1 ya3] or deep 低沉[di1 chen2] etc);(physics) sound ray
声调|tone;note;a tone (on a Chinese syllable)
声道|sound track;audio channel
声门|glottis
声音|sound; voice
职员|office worker;staff member
听到|to hear
肃然|respectful;solemn;awed
肉干|dried meat; jerky
肉商|meat merchant;butcher
肉果|fleshy fruit; sarcocarp;nutmeg
肉片|meat slice
肉皮|pork skin
肉眼|naked eye;layman's eyes
肉身|corporeal body
肉体|physical body
肩膀|shoulder
肯定|to be certain; to be positive;assuredly; definitely;to give recognition; to affirm;affirmative (answer)
背叛|to betray
胳膊|arm
胸襟|lapel of jacket;heart;aspiration;vision
能够|to be capable of;to be able to;can
胆小|cowardice;timid
胆识|courage and insight
自主|to act independently; to be autonomous; to be in control of one's own affairs
自来|from the beginning;always;to come of one's own accord
自保|to defend oneself;self-defense;self-preservation
自信|to have confidence in oneself;self-confidence
自传|autobiography
自制|to maintain self-control;self-control
自动|automatic;voluntarily
自反|to introspect;to self-reflect;(math.) reflexive
自古|(since) ancient times;(from) time immemorial
自大|arrogant
自学|self-study;to study on one's own
自家|oneself;one's own family
自小|since childhood; from a young age
自己|oneself; (attributive) one's own
自带|to bring one's own;BYO;(of software) preinstalled
自得|contented;pleased with one's position
自打|(coll.) since
自新|to reform oneself;to mend one's ways and start life anew
自有|(I, they etc) of course have (a plan, a way etc);one's own (apartment, brand etc)
自比|to liken oneself to (sb or sth)
自然|nature;natural;naturally
自热|to heat up by itself; (attributive) self-heating (esp. of meal kits heated with a water-activated pack)
自理|to take care of oneself;to provide for oneself
自用|to have (sth) for one's own use;(literary) to be opinionated
自发|spontaneous
自白|confession;to make clear one's position or intentions;to brag
自相|mutual;each other;one another;self-
自经|(literary) to hang oneself
自行|voluntary;autonomous;by oneself;self-
自装|self-loading (weapon, tape deck etc)
自语|to talk to oneself
自身|itself;oneself;one's own
自转|(of a celestial body) to rotate on its own axis
自重|to conduct oneself with dignity;to be dignified;deadweight
自高|to be proud of oneself
自黑|(slang) to self-deprecate; to make fun of oneself
至多|up to the maximum;upper limit;at most
至少|at least;(to say the) least
台上|on stage
台地|tableland;mesa
台基|stylobate (architecture)
台大|for 臺灣大學，台湾大学[Tai2 wan1 Da4 xue2]
台本|script (of a play, movie, or television program)
台海|for 台灣海峽，台湾海峡, Taiwan Strait
台词|an actor's lines; dialogue;Taiwanese word
台风|stage presence, poise
举起|to heave;to lift;to raise up;to uphold
舒服|comfortable;feeling well
色光|colored light
色子|dice (used in gambling)
色度|saturation (color theory)
色情|pornography;sex
色拉|(loanword) salad
色相|coloration;hue;sex;sex appeal
色号|shade (of lipstick etc); color option
色调|hue;tone
色达|see 色達縣，色达县[Se4 da2 Xian4]
色酒|colored wine (made from grapes or other fruit, as opposed to a rice wine etc)
色长|head of a division of the music academy of the imperial court
芥蒂|an obstruction;barrier;ill-feeling;grudge
花光|to spend all one's money
花儿|style of folk song popular in Gansu, Qinghai and Ningxia
花名|name of a person on the household register (old);name on a roster;professional name of a prostitute;pseudonym
花商|florist
花子|beggar (old term)
花山|see 花山區，花山区[Hua1 shan1 Qu1]
花布|printed cloth;calico
花式|fancy; showy; elaborate;(HK, Tw) (sports) fancy-style; freestyle (as in 花式溜冰[hua1 shi4 liu1 bing1] "figure skating");(Tw) floral f…
花心|fickle in love; unfaithful;heart of a flower (pistil and stamen)
花房|greenhouse
花会|flower fair or festival
花期|the flowering season
花木|flowers and trees;plants;flora
花海|sea of flowers; expanse of flowers
花火|firework
花生|peanut
花用|to spend (money)
花白|grizzled (hair)
花石|marble
花红|Chinese pearleaf crabapple (Malus asiatica);gift for a wedding or other happy occasion;bonus (extra pay, typically given at year-e…
花台|flower bed;flower terrace;flower stand
花色|variety;design and color;suit (cards)
花草|flowers and plants
花菜|cauliflower
花语|the language of flowers; symbolic meaning associated with a flower
花车|car festooned for celebration
花边|lace;decorative border
花酒|drinking party with female entertainers
花头|trick;pattern;novel idea;knack
花香|fragrance of flowers
花黄|yellow flower (cosmetic powder used on women's forehead in former times)
苗头|first signs;development (of a situation)
英国|United Kingdom (UK); Britain
英文|English (language)
英气|heroic spirit
英语|English (language)
茫然|blankly;vacantly;at a loss
草包|bag made of woven straw;bag filled with straw;(fig.) a good-for-nothing;clumsy oaf
草原|grassland;prairie
草图|a sketch;rough drawing
草地|lawn;meadow;sod;turf
草场|pastureland
草山|Grassy Hill (hill in Hong Kong)
草书|grass script; cursive script (Chinese calligraphic style)
草木|vegetation;plants
草本|herbaceous;original draft (of a manuscript etc)
草果|black cardamom;(dialect) strawberry
草民|the grass roots;the hoi polloi
草海|Caohai Lake, Guizhou
草皮|turf;sward;sod
草草|carelessly;hastily
草酸|oxalic acid C2H2O4
草体|see 草書，草书[cao3 shu1]
草鱼|grass carp
荒凉|desolate
荒芜|left to return to unchecked growth;overgrown;grown wild
菜品|culinary dish
菜单|menu
菜地|vegetable field
菜场|food market
菜市|food market
菜式|dish (food prepared according to a specific recipe)
菜心|choy sum;Chinese flowering cabbage;stem of any Chinese cabbage
菜板|chopping board; cutting board
菜油|rapeseed oil; canola oil
菜色|dish;lean and hungry look (resulting from vegetarian diet);emaciated look (from malnutrition)
菜花|cauliflower;gonorrhea
菜头|(Tw) radish, esp. white radish 白蘿蔔，白萝卜[bai2 luo2 bo5]
华中|central China
华人|ethnic Chinese person or people
华北|North China
华南|Southern China
华安|see 華安縣，华安县[Hua2 an1 Xian4]
华宁|see 華寧縣，华宁县[Hua2 ning2 Xian4]
华山|Mt Hua in Shaanxi, western mountain of the Five Sacred Mountains 五嶽，五岳[Wu3 yue4]
华州|see 華州區，华州区[Hua2 zhou1 Qu1]
华教|Chinese language education (for people living outside China, esp. the children of overseas Chinese communities)
华文|Chinese language;Chinese script
华族|noble family;of Chinese ancestry
华东|East China
华林|Hualinbu, Ming dynasty theatrical troupe in Nanjing
华沙|Warsaw, capital of Poland
华特|Walt (name)
华美|magnificent;gorgeous;ornate
华表|marble pillar (ornamental column in front of places, tombs)
华西|West China (region in the upper reaches of Yangtze River and Sichuan Province)
华语|Chinese language
华里|li (Chinese unit of distance)
华发|(literary) gray hair
华龙|see 華龍區，华龙区[Hua4 long2 Qu1]
万物|all things;all that exists
落魄|down and out;in dire straits;unrestrained;unconventional
叶子|leaf (CL:片[pian4]);(slang) marijuana
着急|to worry; to feel anxious;to feel a sense of urgency; to be in a hurry;Taiwan pr. [zhao1ji2]
蒙冤|to be wronged;to be subjected to an injustice
苍凉|desolate;bleak
苍穹|the blue dome of heaven
苍茫|boundless;vast;hazy (distant horizon)
萧然|desolate;empty
萧瑟|to rustle in the air;to rustle;to sough;bleak
萧索|bleak;desolate;melancholy
兰交|close friendship;a meeting of minds
兰克|Rank (name);Leopold von Ranke (1795-1886), important German historian
兰学|Dutch studies (study of Europe and the world in premodern Japan)
兰山|see 蘭山區，兰山区[Lan2 shan1 Qu1]
兰州|see 蘭州市，兰州市[Lan2 zhou1 Shi4]
兰斯|Reims (city in France)
兰新|Lanzhou and Xinjiang
兰特|Rand or Randt (name)
兰科|Orchidaceae
兰花|cymbidium;orchid
兰西|see 蘭西縣，兰西县[Lan2 xi1 Xian4]
处理|to handle; to deal with;to punish;to treat sth by a special process; to process;to sell at reduced prices
号外|(newspaper) extra;special number (of a periodical)
号子|work chant;prison cell;type;sort
号手|trumpeter;military bugler
号数|number in a sequence;ordinal number;serial number
号角|bugle horn
号音|bugle call
号头|number;serial number
蜿蜒|(of a snake) to wriggle along;(of a river etc) to zigzag; to meander; to wind
虫子|insect;bug;worm
蜡烛|candle
血口|bloody mouth (from devouring freshly killed prey)
血性|brave;staunch;unyielding
血战|bloody battle
血族|blood relations;one's own flesh and blood;kin
血书|letter written in one's own blood, expressing determination, hatred, last wishes etc
血月|blood moon
血本|hard-earned capital
血气|blood and vital breath;bloodline (i.e. parentage);valor
血水|blood;bloody fluid; blood-tinged liquid
血流|blood flow
血清|serum;blood serum
血球|blood corpuscle;hemocyte
血管|vein;artery
血肉|flesh
血色|color (of one's skin, a sign of good health);red of cheeks
血路|desperate getaway (from a battlefield);to cut a bloody path out of a battlefield
行事|to execute;to handle;behavior;action
行人|pedestrian;traveler on foot;passer-by;official responsible for arranging audiences with the emperor
行动|operation;action;to move about;mobile
行员|(Tw) staff; clerk; employee (of a bank 銀行，银行[yin2 hang2] or commercial firm 商行[shang1 hang2])
行商|traveling salesman;itinerant trader;hawker;peddler
行好|to be charitable; to do a good deed
行客|visitor;traveler
行家|connoisseur; expert; veteran
行市|quotation on market price
行情|market price;quotation of market price;the current market situation
行房|euphemism for sexual intercourse;to go to bed with sb
行文|writing style (formal);to send an official written communication
行星|planet
行书|running script; semicursive script (Chinese calligraphic style)
行会|ExCo; Executive Council of Hong Kong (abbr. for 行政會議，行政会议[Xing2 zheng4 Hui4 yi4])
行期|departure date
行板|andante;at a walking pace
行业|trade; profession; industry; business
行经|to pass by;menstruation
行者|pedestrian;walker;itinerant monk
行草|semicursive script
行号|(computing) (text file) line number; (data table or spreadsheet) row number;(Tw) unincorporated firm (typically a smaller business…
行装|clothes and other items packed for traveling;baggage;luggage
行话|jargon;language of the trade
行语|slang;jargon;cant;lingo
行路|to travel;transport
行车|to drive a vehicle;movement of vehicles
行军|(of troops) to march
行道|path; road
行长|bank president
行头|(archaic) leader of a troop of soldiers;(archaic) guild leader
行体|see 行書，行书[xing2 shu1]
街道|street;subdistrict;residential district
衣服|clothes
表单|form (document)
表土|topsoil
表报|statistical tables and reports
表字|literary name (an alternative name of a person stressing a moral principle);courtesy name
表带|watchband; watch strap
表情|(facial) expression;to express one's feelings
表意|to express meaning;ideographic
表扬|to praise;to commend
表明|to make clear;to make known;to state clearly;to indicate
表格|form; table
表白|to explain oneself;to express;to reveal one's thoughts or feelings;declaration
表皮|epidermis;cuticle
表盘|meter dial;watch face
表里|the outside and the inside;one's outward show and inner thoughts;exterior and interior
表语|predicative
表达|to express; to convey
表面|surface;face;outside;appearance
表音|phonetic;phonological;transliteration
袅娜|slim and graceful
袅袅|rising in spirals
里面|variant of 裡面，里面[li3 mian4]
装作|to pretend;to feign;to act a part
装入|to load
装出|to assume (an air of)
装成|to pretend
装有|fitted with
装机|to install;installation
装死|to play dead
装病|to feign illness;to malinger
装车|to load onto a vehicle
装运|to ship;shipment
装点|to decorate;to dress up;to deck
里外|inside and out;or so
里子|lining;(fig.) substance (as opposed to outward appearance)
里带|inner tube (of tire)
里手|expert;left-hand side (of a machine);left-hand side (driver's side) of a vehicle
里海|Caspian Sea
里边|inside
里头|inside; interior
制作|to make; to manufacture
制品|products;goods
制图|(cartography) to make a map;(architecture etc) to draft; to draw (blueprints);(graphic design) to create graphics
制成|to manufacture;to turn out (a product)
制油|to extract (vegetable) oil; oil extraction
制热|to produce heat (to warm up a room etc)
制片|to produce a film; to make a movie;assistant producer;(Tw) film producer
制表|to tabulate;tabulation;scheduling;watchmaking
制造|to manufacture; to make
复杂|complicated; complex
裤子|trousers; pants
西亚|Southwest Asia
西北|Northwest China (Shaanxi, Gansu, Qinghai, Ningxia, Xinjiang)
西区|Xi District or Xiqu, a district of Panzhihua City 攀枝花市[Pan1 zhi1 hua1 Shi4], Sichuan
西南|southwest
西和|see 西和縣，西和县[Xi1 he2 Xian4]
西单|Xidan neighborhood of central Beijing
西城|see 西城區，西城区[Xi1 cheng2 Qu1]
西外|for 西安外國語大學，西安外国语大学[Xi1 an1 Wai4 guo2 yu3 Da4 xue2]
西大|(Internet slang) the United States (contrasted with China 東大，东大[Dong1 da4]);(informal) abbreviation for certain university names, …
西天|the Western Paradise (Buddhism)
西子|another name for Xishi 西施[Xi1 shi1]
西学|Western learning (intellectual movement in the late Qing);also called 洋務運動，洋务运动
西安|see 西安市[Xi1 an1 Shi4];see 西安區，西安区[Xi1 an1 Qu1]
西宁|see 西寧市，西宁市[Xi1 ning2 Shi4]
西山|see 西山區，西山区[Xi1 shan1 Qu1]
西工|see 西工區，西工区[Xi1 gong1 Qu1]
西市|see 西市區，西市区[Xi1 shi4 Qu1]
西平|see 西平縣，西平县[Xi1 ping2 Xian4]
西式|Western style
西德|West Germany;German Federal Republic 德意志聯邦共和國，德意志联邦共和国[De2 yi4 zhi4 Lian2 bang1 Gong4 he2 guo2]
西打|cider (loanword)
西拉|Syrah (grape type)
西文|Spanish;Western language;foreign languages (in Qing times)
西方|the West;the Occident;Western countries
西林|see 西林縣，西林县[Xi1 lin2 Xian4]
西江|Xijiang River
西沙|see 西沙區，西沙区[Xi1 sha1 Qu1];see 西沙群島，西沙群岛[Xi1 sha1 Qun2 dao3]
西海|Yellow Sea (Korean term)
西皮|one of the two chief types of music in Chinese opera;see also 二黃，二黄[er4 huang2]
西米|sago
西经|west longitude
西华|see 西華縣，西华县[Xi1 hua2 Xian4]
西装|suit;Western-style clothes
西西|cubic centimeter (cc) (loanword)
西语|western language;Spanish (language)
西边|west;west side;western part;to the west of
西门|two-character surname Ximen
西青|Xiqing suburban district of Tianjin municipality 天津市[Tian1 jin1 shi4]
西面|west side;west
西点|see 西點軍校，西点军校[Xi1 dian3 Jun1 xiao4]
见面|to meet; to see each other
规则|rule; regulation;regular; orderly; fixed
规矩|compass and set square;fig. established standard;rule;customs
亲自|personally;in person;oneself
觉得|to think that ...; to feel that ...;to feel (uncomfortable etc)
观察|to observe; to watch; to survey
角力|to wrestle;(fig.) to lock horns; to tussle; to wrangle;Taiwan pr. [jiao3li4]
角口|(literary) to quarrel;also pr. [jiao3kou3]
角回|angular gyrus (convolution of the brain)
角子|one Jiao coin (Mao, one-tenth of yuan)
角度|angle;(fig.) point of view
角球|corner kick (in soccer);free strike in hockey
角色|role; part (in a play or movie etc);also pr. [jiao3se4]
角落|corner (of a room, courtyard etc);(fig.) remote spot; nook
角门|corner gate
角头|gang leader;mafia boss
角马|gnu;wildebeest
角龙|ceratopsian
解出|to figure out
解包|to unpack (computing)
解和|to mediate (in a conflict);to pacify
解手|to relieve oneself (i.e. use the toilet);to solve
解数|talent;ability;capability;martial arts technique
解气|to assuage one's anger;gratifying (esp. to see sb get their comeuppance)
解决|to solve; to resolve; to settle (a problem);to eliminate; to wipe out (an enemy, bandits etc)
解法|solution (to a math problem);method of solving
解热|to relieve fever
解理|cleavage (splitting of minerals such as slate along planes)
解调|demodulation;to demodulate
解酒|to dissipate the effects of alcohol
解释|explanation;to explain;to interpret;to resolve
解开|to untie;to undo;to solve (a mystery)
解体|to break up into components;to disintegrate;to collapse;to crumble
计划|plan;project;program;to plan
讨厌|to dislike;to loathe;disagreeable;troublesome
讨论|to discuss; to talk over
记住|to remember;to bear in mind;to learn by heart
记得|to remember
许多|many;a lot of;much
词人|writer of 詞，词[ci2] (a kind of Classical Chinese poem);person of literary talent
词典|dictionary
词干|word stem (in linguistics)
词形|form of words (e.g. inflection, conjugation);morphology (linguistics)
词性|part of speech (noun, verb, adjective etc);lexical category
词意|meaning of word;sense
词族|word family (cognate words within a given language)
词法|morphology (linguistics);word formation and inflection
词眼|key word
词话|form of writing novels that comprise lots of poetry in the body of the text, popular in the Ming Dynasty
词语|word (general term including monosyllables through to short phrases);term (e.g. technical term);expression
词头|prefix;headword (in a dictionary)
话卡|calling card (telephone)
话本|Song and Yuan literary form based on vernacular folk stories
话语|words;speech;utterance;discourse
话音|one's speaking voice;tone;implication
话头|subject (under discussion);thread (of an argument)
认为|to believe; to think; to consider; to feel
认真|conscientious;earnest;serious;to take seriously
认识|to know;to recognize;to be familiar with;to get acquainted with sb
语意|meaning;content of speech or writing;semantic
语文|literature and language;(PRC) Chinese (as a school subject)
语族|language branch
语气|tone;manner of speaking;mood
语法|grammar;(computing) syntax
语流|(linguistics) flow of speech
语病|faulty wording;mispronunciation due to a speech defect
语者|(linguistics) speaker
语声|spoken language;sound of speaking
语言|language
语词|word;phrase;(old) (grammar) function word;predicate
语调|intonation;tone of voice
语音|speech sounds;pronunciation;colloquial (rather than literary) pronunciation of a Chinese character;phonetic
说明|to explain;to illustrate;to indicate;to show
说话|to speak;to say;to talk;to gossip
课本|textbook
调停|to reconcile;to mediate;to bring warring parties to agreement;to arbitrate
调入|to bring in;to call in;to transfer (a person, data);(computing) to call
调制|to modulate; modulation
调动|to transfer;to maneuver (troops etc);movement of personnel;to mobilize
调包|to steal sb's valuable item and substitute a similar-looking but worthless item; to sell a fake for the genuine article; to palm o…
调和|harmonious;to mediate; to reconcile;mediation;to compromise
调子|tune;melody;tuning;cadence
调干|to reassign a cadre;to choose a worker to be promoted to cadre
调度|to dispatch (vehicles, staff etc);to schedule;to manage;dispatcher
调式|(musical) mode
调性|(music) tonality;(of an actor, company, magazine etc) style; image; tone; voice; character
调情|to flirt
调教|to instruct;to teach;to train;to raise (livestock)
调查|investigation;inquiry;to investigate;to survey
调理|to nurse one's health;to recuperate;to take care of;to look after
调用|to transfer (for a specific purpose);to allocate;(computing) to invoke (a command, an application etc)
调发|to requisition;to dispatch
调皮|naughty;mischievous;unruly
调相|phase modulation
调节|to adjust;to regulate;to harmonize;to reconcile (accountancy etc)
调色|to blend colors;to mix colors
调号|tone mark on a Chinese syllable (i.e. accents on ā á ǎ à);(music) key signature
调解|to mediate;to bring parties to an agreement
调变|modulation;to modulate (electronics)
调转|to reassign sb to a different job;to turn around;to change direction;to make a U turn
调酒|to mix drinks;cocktail
调门|melody;pitch or key (music);tone;style
调音|to tune (a musical instrument)
调头|variant of 掉頭，掉头[diao4 tou2]
谄媚|to flatter
谢谢|to thank;thanks;thank you
证据|evidence;proof;testimony
警告|to warn;to admonish
警察|police; police officer
护士|nurse
读书|to read a book;to study;to attend school
变作|to change into;to turn into;to become
变分|variation (calculus);deformation
变动|to change;to fluctuate;change;fluctuation
变化|(intransitive) to change; to vary;change; variation
变回|to revert;to change back into
变天|to have a change of weather (esp. for the worse);(fig.) to experience a major upheaval; to undergo sweeping change
变工|to exchange labor;labor exchange (system of sharing workforce resources)
变形|to become deformed; to change shape; to morph
变得|to become
变心|to cease to feel a sense of loyalty (or gratitude etc) to sb or sth;to fall out of love with sb
变性|to denature;denaturation;to have a sex change;transsexual
变成|to change into;to turn into;to become
变数|variable factor; uncertainties;(math.) a variable
变文|a popular form of narrative literature flourishing in the Tang Dynasty (618-907) with alternate prose and rhymed parts for recitat…
变星|variable star
变格|case change (in grammar)
变法|to change the laws;political reform;unconventional method
变相|in disguised form;covert
变节|betrayal;defection;turncoat;to change sides politically
变红|to redden
变老|to grow old;to age;aging
变声|voice change (at puberty);to alter one's voice (deliberately);to sound different (when angry etc)
变色|to change color;to discolor;to change countenance;to become angry
变装|to change clothes;to dress up; to put on a costume; to cosplay;to cross-dress
变调|tone sandhi;modified tone;(music) to change key;modulation
变身|to undergo a transformation; to morph; to turn into;transformed version of sb or sth; new incarnation
变通|pragmatic;flexible;to act differently in different situations;to accommodate to circumstances
变道|to change lanes
变量|variable (math.)
变电|power transformation
变音|change in sound; altered pronunciation;(music) chromatic alteration of pitch; altered note; accidental;(linguistics) phonological …
变体|variant
变黑|to darken
谶语|prophecy; prophetic remark
豁达|optimistic;sanguine;generous;magnanimous
豪气|heroic spirit;heroism
赚钱|to earn money;moneymaking
起亚|Kia (Motors)
起来|to stand up; to get up;also pr. [qi3lai2]
起初|originally; at first; at the outset
起动|to start up (a motor);to launch (a computer application)
起名|to name;to christen;to take a name
起士|(Tw) (loanword) cheese
起子|baking soda (used to leaven bread);screwdriver;bottle opener
起家|to start out by;to grow an enterprise beginning with;to begin one's career by
起小|since childhood
起床|to get out of bed; to get up
起意|to conceive a scheme;to devise a plan
起手|to set about (doing sth)
起毛|fluff;lint;to feel nervous
起火|to catch fire;to cook;to get angry
起球|(of a sweater, fabric etc) to pill
起用|to promote;to reinstate (in a position or job)
起皮|(of skin) to peel
起眼|to catch one's eye (usu. used in the negative)
起色|a turn for the better;to pick up;to improve
起草|to make a draft;to draw up (plans)
起号|(slang) to build up a social media account (from scratch)
起身|to get up;to leave;to set forth
起运|variant of 啟運，启运[qi3 yun4]
起重|to lift (sth heavy) using a crane or other mechanical means
起开|(dialect) to step aside; Get out of the way!
起头|to start;at first;beginning
起点|starting point
超市|supermarket (abbr. for 超級市場，超级市场[chao1 ji2 shi4 chang3])
超过|to surpass;to exceed;to outstrip
赶快|quickly; at once
赶紧|hurriedly;without delay
跟随|to follow
路上|on the road;on the way; en route
路亚|(loanword) lure fishing
路人|passer-by;stranger
路加|Luke;St Luke the evangelist
路北|see 路北區，路北区[Lu4 bei3 Qu1]
路南|see 路南區，路南区[Lu4 nan2 Qu1]
路口|crossing;intersection (of roads)
路基|(civil engineering) roadbed
路子|method;way;approach
路得|(Protestantism) Ruth
路德|Luther (name);Martin Luther (1483-1546), reformation protestant minister
路数|stratagem; method; approach;(martial arts) movement;social connections;(sb's) background story
路线|itinerary;route;political line (e.g. right revisionist road)
路过|to pass by; to pass through
路边|curb; roadside; wayside
路面|road surface
跳舞|to dance
踉跄|to stagger; to walk falteringly
踟蹰|to waver; to hesitate
踱步|to pace; to stroll
蹉跎|(literary) to slip;(of looks etc) to fade away;(of time) to slip away;to squander (time, opportunities); to dillydally
蹊跷|odd; queer; strange; fishy
蹒跚|to walk unsteadily; to stagger; to lurch; to hobble; to totter
踌躇|to hesitate;(literary) to pace back and forth;(literary) self-satisfied
身上|on the body;at hand;among
身分|variant of 身份[shen1 fen4]
身子|body;pregnancy;health
身家|oneself and one's family;family background;pedigree;one's property
身形|figure (esp. a woman's)
身后|the time after one's death;a place behind sb;(fig.) one's social background
身心|body and mind;mental and physical
身手|skill;talent;agility
身教|to teach by example
身板|body;physique;physical condition
身法|pose or motion of one's body in martial arts
身边|at one's side;on hand
身量|height (of a person); stature;(fig.) reputation; standing
身长|height (of person);length of clothing from shoulders to bottom (tailor or dressmaker's measure)
身体|the body;one's health
身高|(a person's) height
躲开|to stay out of (hot water, trouble, awkward situation etc);to avoid (sb)
车主|vehicle owner
车前|Chinese plantain (Plantago asiatica), perennial herb used in TCM
车子|car or other vehicle (bicycle, truck etc)
车工|lathe work;lathe operator
车带|(vehicle) tire
车房|garage;carport;(old) rickshaw room
车手|racing driver (in a car race); rider (in a motorcycle or bicycle race);(Tw) low-level operative in a scam syndicate
车机|(automotive) head unit; infotainment system
车流|traffic;rate of traffic flow
车皮|wagon;freight car
车号|vehicle number (license plate number, taxi number, bus number, train car number)
车行|car-related business;car dealership;taxi company;(commercial) garage
车身|the body of a vehicle; (bicycle) frame
车道|traffic lane;driveway
车门|car door;door of bus, railway carriage etc
车马|vehicles and horses
车龙|long queue of slow-moving traffic;tram
军事|military affairs; (attributive) military
军人|serviceman;soldier;military personnel
军力|military power
军区|geographical area of command;(PLA) military district
军品|product for military use
军士|soldier;noncommssioned officer (NCO)
军工|defense industry (abbr. for 軍事工業，军事工业[jun1 shi4 gong1 ye4])
军心|(military) troop morale;(fig.) team morale
军情|military situation;military intelligence
军方|military
军乐|military music
军机|military aircraft;secret plan;Privy Council during the Qing dynasty
军民|army-civilian;military-masses;military-civilian
军法|martial law
军火|weapons and ammunition;munitions;arms
军用|(for) military use;military application
军号|bugle
军装|military uniform
军车|military vehicle
军队|armed forces; troops
军马|warhorse; cavalry horse;troops
军体|military sports;military fitness (curriculum etc);abbr. for 軍事體育，军事体育
轻轻|lightly; softly
轻松|light;gentle;relaxed;effortless
辗转|to toss about in bed;from person to person;indirectly;to wander
转交|to pass on to sb;to carry and give to sb else
转作|(agriculture) to switch to growing a different crop
转入|to change over to; to shift to; to switch to
转动|to turn sth around;to swivel
转包|to subcontract (to another party)
转化|to change; to turn; to convert;(genetics) to transform;(chemistry) isomerization
转口|entrepot;transit (of goods);(coll.) to deny;to go back on one's word
转台|to change the channel (TV)
转回|to turn back;to put back;reversal;melodic inversion (in music)
转天|the following day; next day
转好|improvement;turnaround (for the better)
转子|(electricity) rotor
转学|(of a student) to change schools; to transfer from one school to another
转年|the following year; next year
转干|to become a cadre (e.g. a promotion from shopfloor)
转性|to change one's character or nature
转战|to fight in one place after another
转手|to pass on;to resell;to change hands
转文|to parade by interspersing one's speech or writing with literary allusions;Taiwan pr. [zhuan3 wen2]
转会|to transfer to another club (professional sports)
转业|to change one's profession;to transfer to civilian work
转机|(to take) a turn for the better;to change planes
转正|to transfer to full membership;to obtain tenure
转生|reincarnation (Buddhism)
转用|to adapt for use for another purpose
转发|to transmit;to forward (mail, SMS, packets of data);to pass on;to republish (an article from another publication)
转盘|turntable;rotary (traffic)
转眼|in a flash;in the blink of an eye;to glance
转瞬|in the twinkling of an eye;in a flash;to turn one's eyes
转科|to change major (at college);to take up a new specialist subject;to transfer to a different medical department
转行|to change profession
转制|to convert; to reprocess; to turn (sth) into
转角|bend in a street;corner;to turn a corner
转调|(music) to change key;modulation;(of an employee) to be transferred to another post
转变|to change;to transform;shift;transformation
转身|(of a person) to turn round;to face about;(of a widow) to remarry (archaic)
转车|to transfer;to change trains, buses etc
转转|to go for a stroll
转运|to forward; to transfer; to transship;to have luck turn in one's favor
转道|to make a detour;to go by way of
转达|to pass on;to convey;to communicate
转门|revolving door;turnstile
转头|to turn one's head;to change direction;U-turn;volte face
转体|to roll over;to turn over (one's body)
办法|way of handling sth; means; measure; (practical) solution to a problem
农村|rural area;village
迎接|to welcome; to greet
迤逦|meandering;winding
迷蒙|misty
迷离|blurred;hard to make out distinctly
逃跑|to flee from sth;to run away;to escape
通人|learned person; person of wide knowledge and sound scholarship
通信|to correspond (by letter, email etc);to send or receive messages through telecommunications
通力|to cooperate;concerted effort
通化|see 通化市[Tong1 hua4 Shi4];see 通化縣，通化县[Tong1 hua4 Xian4]
通同|to collude;to gang up on
通名|common noun;generic term;to introduce oneself
通商|(of nations) to have trade relations; to engage in trade
通城|see 通城縣，通城县[Tong1 cheng2 Xian4]
通报|to inform;to notify;to announce;circular
通学|to attend school as a day student
通山|see 通山縣，通山县[Tong1 shan1 Xian4]
通州|see 通州區，通州区[Tong1 zhou1 Qu1]
通明|brightly lit
通书|almanac
通气|ventilation;aeration;to keep each other informed;to release information
通水|to have running water (in a house etc)
通江|see 通江縣，通江县[Tong1 jiang1 Xian4]
通河|see 通河縣，通河县[Tong1 he2 Xian4]
通海|see 通海縣，通海县[Tong1 hai3 Xian4]
通用|to use anywhere, anytime (card, ticket etc);to be used by everyone (language, textbook etc);(of two or more things) interchangeabl…
通病|common problem;common failing
通盘|across the board;comprehensive;overall;global
通红|very red;red through and through;to blush (deep red)
通经|conversant with the Confucian classics;to stimulate menstrual flow (TCM)
通县|Tong county in Beijing
通草|rice-paper plant (Tetrapanax papyriferus)
通菜|see 空心菜[kong1 xin1 cai4]
通行|to go through; to pass through;to be in general use
通话|to hold a conversation;to talk over the telephone;phone call
通路|thoroughfare;passage;pathway;channel
通车|to open to traffic (e.g. new bridge, rail line etc);(of a locality) to have a transportation service;(Tw) to commute
通通|all;entire;complete
通过|to pass through; to get through;to adopt (a resolution); to pass (legislation);to pass (a test);by means of; through; via
通道|(communications) channel;thoroughfare;passage
通达|to understand clearly;to be sensible or reasonable;understanding
通量|flux
通关|to clear customs;(gaming) to finish (a game, a level, a stage, etc)
通电|to set up an electric circuit;to electrify;to switch on;to be connected to an electricity grid
通风|airy;ventilation;to ventilate;to disclose information
通体|(of sb or sth) whole or entire body
造化|(literary) Nature; the Creator
造诣|level of mastery (of a skill or area of knowledge);(archaic) to pay a visit to sb
逡巡|to draw back;to move back and forth;to hesitate;in an instant
连忙|promptly; at once
周末|weekend
进来|to come in
逶迤|(literary) (of roads, rivers, mountain ranges etc) long and winding; meandering
遇见|to meet
运交|to consign;to send (goods to customers);shipping;delivery
运作|to operate;operations;workings;activities (usu. of an organization)
运出|shipment;to dispatch;to ship out;to send
运力|transport capacity
运动|to move;to exercise;sports;exercise
运单|way bill;transport charge
运城|see 運城市，运城市[Yun4 cheng2 Shi4]
运数|one's fortune;destiny
运气|luck (good or bad)
运河|see 運河區，运河区[Yun4 he2 Qu1]
运球|to dribble (basketball, soccer etc)
运用|to use;to put to use
运神|to concentrate;to think what you're doing
运科|(Tw) sports science (abbr. for 運動科學，运动科学[yun4 dong4 ke1 xue2])
运行|(of celestial bodies etc) to move along one's course;(fig.) to function; to be in operation;(of a train service etc) to operate; t…
运转|to work;to operate;to revolve;to turn around
运道|fortune;luck;fate
运量|volume of freight
过人|to surpass others; outstanding;(basketball, soccer etc) to get past an opponent
过来|to come over;to manage;to handle;to be able to take care of
过分|excessive; undue;unduly; overly
过去|(in the) past; former; previous;to go over; to pass by
过场|interlude;to cross the stage;to do sth as a mere formality;to go through the motions
过多|too many; excessive
过客|passing traveler;transient guest;sojourner
过年|to celebrate the Chinese New Year
过度|excessive;over-;excess;going too far
过后|after the event
过得|How are you getting by?;How's life?;contraction of 過得去，过得去, can get by;tolerably well
过房|to adopt;to give for adoption (usually to a childless relative)
过时|old-fashioned;out of date;to be later than the time stipulated or agreed upon
过期|to be overdue;to exceed the time limit;to expire (as in expiration date)
过气|past one's prime;has-been
过河|to cross a river
过火|to go too far; to go overboard (in words or actions);over the top; excessive;burned
过热|too hot;(fig.) (economics) overheated;(physics) to superheat
过生|to celebrate a birthday
过节|to celebrate a festival;after the celebrations (i.e. once the festival is over)
过路|see 路過，路过[lu4 guo4]
过身|to die; to pass away
过道|passageway;corridor;aisle
过重|overweight (luggage)
过量|excessive
过门|to pass through a doorway;(of a woman) to marry;orchestral music interlude in an opera
过关|to cross a barrier;to get through (an ordeal);to pass (a test);to reach (a standard)
过头|to overdo it;to overstep the limit;excessively;above one's head
过高|too high
道人|Taoist devotee (honorific)
道光|reign name of Qing emperor (1821-1850)
道出|to speak;to tell;to voice
道地|authentic;original
道场|Taoist or Buddhist rite;abbr. for 菩提道場，菩提道场[Pu2 ti2 dao4 chang3]
道士|Daoist priest
道外|see 道外區，道外区[Dao4 wai4 Qu1]
道学|Confucian study of ethics;study of Daoism;school for Daoism in Tang and Song times;Daoist magic
道家|Daoist School of the Warring States Period (475-221 BC), based on the teachings of Laozi or Lao-tze 老子[Lao3 zi3] (c. 500 BC-) and …
道德|virtue;morality;ethics
道教|Taoism; Daoism
道理|reason;argument;sense;principle
道白|spoken lines in opera
道县|Dao County or Daoxian, a county in Yongzhou City 永州市[Yong3 zhou1 Shi4], Hunan
道台|(Ming and Qing dynasties) daotai (title for an official responsible for supervising a circuit 道，道[dao4]), aka taotai and circuit i…
道行|skills acquired through religious practice;(fig.) ability;skill;Taiwan pr. [dao4 hang5]
道里|see 道裡區，道里区[Dao4 li3 Qu1]
道路|road;path;way
道长|Taoist priest;Daoist priest
达人|(coll.) expert; connoisseur; guru; enthusiast; geek (influenced by Japanese 達人 "tatsujin" c. 2000);(literary) sensible person; per…
达卡|Dhaka, capital of Bangladesh;(Tw) Dakar, capital of Senegal
达州|see 達州市，达州市[Da2 zhou1 Shi4]
达意|to express or convey one's ideas
达成|to reach (an agreement);to accomplish
达日|see 達日縣，达日县[Da2 ri4 Xian4]
迟钝|slow in one's reactions;sluggish (in movement or thought)
选择|to select; to pick;choice; option; alternative
辽阔|vast; extensive
边儿|side;edge;margin;border
边区|border area
边卡|border checkpoint
边地|border district;borderland
边城|border town;remote town
边民|people living on the frontiers;inhabitants of a border area
边线|sideline;foul line
边声|outlandish sounds (wind blowing on frontier, wild horses neighing etc)
边角|edges and corners
边路|sidewalk;side road;shoulder (of a road);wing (soccer)
边长|(geometry) side length
边门|side door;wicket door
边关|border station;strategic defensive position on frontier
边音|lateral consonant (phonetics)
边头|the end;border;just before the end
邮件|mail;post;email
邮箱|mailbox;post office box;email;email inbox
乡村|rustic;village;countryside
酒保|barman;bartender
酒力|capacity for alcohol;ability to hold drink
酒单|wine list (in a restaurant etc)
酒器|drinking vessel;wine cup
酒家|restaurant;bartender;(old) wineshop;tavern
酒后|after drinking;under the influence of alcohol
酒德|good manners in drinking;drinking as personality test
酒意|tipsy feeling
酒会|drinking party;wine reception
酒水|alcoholic and non-alcoholic beverages (e.g. on a menu)
酒神|Bacchus (the Greek god of wine), aka Dionysus
酒色|wine and women;color of wine;drunken expression
酒花|hops
酒菜|food and drink;food to accompany wine
酒量|capacity for liquor;how much one can drink
酷暑|intense heat;extremely hot weather
酸性|acidity
酸民|(Tw) (Internet) troll
酸菜|pickled vegetables, especially Chinese cabbage
醒来|to waken
医生|doctor; medical practitioner
医院|hospital
释怀|to get over (a traumatic experience, misgivings etc)
释然|relieved;at ease;feel relieved
里人|person from the same village, town or province;peasant (derog.);(of a school of thought etc) follower
里加|Riga, capital of Latvia
里拉|(loanword) lira (currency of Turkey)
里尔|Lille (city in France)
重来|to start over;to do sth all over again
重光|to recover one's sight;(fig.) to recover (lost territories)
重利|high interest;huge profit;to value money highly
重力|gravity
重卡|heavy truck (abbr. for 重型卡車，重型卡车)
重合|to match up;to coincide
重名|to have the same name
重器|treasure
重回|to return
重地|location of political, economic, military, or cultural importance (usu. not open to the general public); sensitive area
重大|great;important;major;significant
重子|baryon (physics)
重工|heavy industry
重度|serious;severe
重心|focus; emphasis; priority;(physics) center of gravity;(geometry) centroid
重文|repetitious passage;multiple variants of Chinese characters
重新|again; once more; re-
重水|heavy water (chemistry)
重油|(petrochemistry) heavy oil;fuel oil
重物|heavy object
重生|to be reborn;rebirth
重用|to put in an important position
重病|serious illness
重者|more serious case;in extreme cases
重装|(computing) to reinstall
重制|to make a copy;to reproduce;to remake (a movie)
重要|important; significant; major
重话|harsh words
重重|layer upon layer;one after another
重量|weight
重金|large sum of money
重开|to reopen
重阳|Double Ninth or Yang Festival
重音|accent (of a word);stress (on a syllable)
重头|anew;from the beginning;(in poetry and song) repetition of a melody or rhythm
重点|to recount (e.g. results of election);to re-evaluate
野兽|beast;wild animal
量力|to estimate one's strength
量化|to quantify; quantification; quantitative;to quantize; quantization
量器|measuring vessel;measuring apparatus
量子|(physics) quantum
量度|to measure;measurement
量表|gauge;meter;scale
量词|classifier (in Chinese grammar);measure word
量变|quantitative change
量身|to take sb's measurements;to measure sb up
金主|financial backer;bankroller
金代|Jin Dynasty (1115-1234), founded by the Jurchen 女真[Nu:3 zhen1] people of North China, a precursor of the Mongol Yuan Dynasty
金子|Kaneko (Japanese surname)
金字|gold lettering;gold characters
金安|see 金安區，金安区[Jin1 an1 Qu1]
金山|Jinshan suburban district of Shanghai;Jinshan or Chinshan township in New Taipei City 新北市[Xin1 bei3 shi4], Taiwan
金州|see 金州區，金州区[Jin1 zhou1 Qu1]
金工|metalworking
金币|gold coin
金平|see 金平區，金平区[Jin1 ping2 Qu1];see 金平苗族瑤族傣族自治縣，金平苗族瑶族傣族自治县[Jin1 ping2 Miao2 zu2 Yao2 zu2 Dai3 zu2 Zi4 zhi4 xian4]
金文|inscription in bronze;bell-cauldron inscription
金星|Venus (planet)
金东|see 金東區，金东区[Jin1 dong1 Qu1]
金林|see 金林區，金林区[Jin1 lin2 Qu1]
金毛|blond fur; golden hair;(coll.) golden retriever
金水|see 金水區，金水区[Jin1 shui3 Qu1]
金沙|see 金沙縣，金沙县[Jin1 sha1 Xian4]
金石|metal and stone;fig. hard objects;inscription on metal or bronze
金红|reddish-gold (color)
金县|King County
金台|see 金臺區，金台区[Jin1 tai2 Qu1]
金色|golden;gold (color)
金华|see 金華市，金华市[Jin1 hua2 Shi4]
金兰|profound friendship;sworn brotherhood
金边|Phnom Penh, capital of Cambodia
金酒|gin
金门|Kinmen or Quemoy islands off the Fujian coast, administered by Taiwan;Jinmen county in Quanzhou 泉州[Quan2 zhou1], Fujian, PRC
金阳|see 金陽縣，金阳县[Jin1 yang2 Xian4]
金发|blond;blonde;fair-haired
金鱼|goldfish
金黄|golden yellow; golden
银子|money;silver
银行|bank
铭记|to engrave in one's memory
锋芒|tip (of pencil, spear etc);sharp point;cutting edge;spearhead
错误|mistaken; false; wrong;error; mistake
镜子|mirror
钥匙|key
长三|(old) high-class prostitute
长出|to sprout (leaves, buds, a beard etc)
长城|the Great Wall
长多|good prospects in the long term (finance)
长大|to grow up
长女|eldest daughter
长子|see 長子縣，长子县[Zhang3 zi3 Xian4]
长安|Chang'an (ancient name of Xi'an 西安[Xi1 an1]), capital of several Chinese dynasties from 202 BC to 907 CE;see 長安區，长安区[Chang2 an1 Qu…
长宁|Changning County in Yibin 宜賓，宜宾[Yi2 bin1], Sichuan;Changning District in Shanghai
长平|Changping, place name in Gaoping County 高平縣，高平县, southern Shanxi, the scene of the great battle of 262-260 BC between Qin and Zhao
长年|all the year round
长度|length
长得|to look (pretty, the same etc)
长情|to have an enduring and faithful love for sb or sth
长成|to grow up
长期|long-term; for a protracted period
长板|longboard
长乐|see 長樂區，长乐区[Chang2 le4 Qu1];Princess Changle of Western Wei of the Northern Dynasties 西魏[Xi1 Wei4], given in marriage c. 545 to Bu…
长机|(military) lead aircraft
长武|see 長武縣，长武县[Chang2 wu3 Xian4]
长毛|(derog.) the Longhairs (Taiping rebels of the 19th century)
长江|Yangtze River, or Chang Jiang
长沙|see 長沙市，长沙市[Chang2 sha1 Shi4];see 長沙縣，长沙县[Chang2 sha1 Xian4]
长河|long river; (fig.) long flow of time
长波|longwave (radio)
长海|see 長海縣，长海县[Chang2 hai3 Xian4]
长清|see 長清區，长清区[Chang2 qing1 Qu1]
长片|feature-length film
长物|(literary) things other than the bare necessities of life;item of some value;Taiwan pr. [zhang4 wu4]
长生|long life
长白|see 長白朝鮮族自治縣，长白朝鲜族自治县[Chang2 bai2 Chao2 xian3 zu2 Zi4 zhi4 xian4]
长相|appearance;looks;profile;countenance
长眠|(euphemism) to rest eternally; to lie buried in (one's final resting place)
长眼|to have eyes;(fig.) to look where one is going; to watch one's step; to be cautious
长石|(mineralogy) feldspar
长空|(literary) the vast sky;(finance) eventual downturn;poor prospects in the long term
长线|long term
长老|elder;term of respect for a Buddhist monk
长者|an elder; a senior
长肉|to put on weight
长号|trombone
长达|to extend as long as;to lengthen out to
长开|to grow into one's looks; (of a young person) to develop more attractive facial features as one grows older
长阳|see 長陽土家族自治縣，长阳土家族自治县[Chang2 yang2 Tu3 jia1 zu2 Zi4 zhi4 xian4]
长青|(literary) evergreen; enduring (friendship etc)
长高|to grow taller
长发|long hair
长龙|long queue;long line (of cars, people etc)
门人|disciple;follower;hanger-on (at an aristocrat's home)
门前|in front of the door
门卡|keycard
门口|doorway;gate
门地|variant of 門第，门第[men2 di4]
门外|outside the door
门子|door;doorman (old);hanger-on of an aristocrat;social influence
门客|hanger-on;visitor (in a nobleman's house)
门对|couplet (hung on each side of the door frame)
门巴|Monba ethnic group
门市|retail sales;retail outlet; store
门房|gatehouse;lodge;gatekeeper;porter
门派|sect;school (group of followers of a particular doctrine)
门球|croquet;goal ball (served by the goal keeper)
门生|disciple;student (of a famous master)
门神|door god
门罗|Monroe (name);James Monroe (1758-1831), fifth US president
门号|door number;(Tw) mobile phone number
门路|way of doing sth;the right social connection
门道|doorway;gateway
门面|shop front;facade;prestige
门风|family tradition;family principles
闪电|lightning
开交|(used with negative) to conclude;(impossible) to end;(can't) finish
开光|eye-opening ceremony for a religious idol (Buddhism);to consecrate;to bless;transparent
开动|to start;to set in motion;to move;to march
开化|to become civilized;to be open-minded;(of ice) to thaw
开原|see 開原市，开原市[Kai1 yuan2 Shi4]
开口|to open one's mouth;to start to talk
开合|to open and close
开单|to bill;to open a tab
开国|to found a state;to open a closed country
开地|to clear land (for cultivation);to open up land
开城|Kaesong or Gaeseong city in southwest North Korea, close to the border with South Korea and a special economic zone for South Kore…
开场|to begin;to open;to start;beginning of an event
开外|over and above (some amount);beyond (budget)
开始|to begin; to start;beginning; start
开学|(of a student) to start school;(of a semester) to begin;(old) to found a school;the start of a new term
开山|to cut into a mountain (to open a mine);to open a monastery
开州|see 開州區，开州区[Kai1 zhou1 Qu1]
开工|to begin work (of a factory or engineering operation);to start a construction job
开市|(of a store, stock market etc) to open for trading;to make the first transaction of the day
开平|see 開平市，开平市[Kai1 ping2 Shi4];see 開平區，开平区[Kai1 ping2 Qu1]
开年|beginning of a year
开心|to feel happy;to rejoice;to have a great time;to make fun of sb
开战|to start a war;to make war;to battle against
开房|see 開房間，开房间[kai1 fang2 jian1]
开打|(of a sports competition or match) to commence;(of a war or battle) to break out;to perform acrobatic or choreographed fighting (i…
开方|(medicine) to write out a prescription;(math.) to extract a root from a given quantity
开明|enlightened;open-minded;enlightenment
开会|to hold a meeting;to attend a meeting
开本|book format based on how a full printing sheet is cut or folded (often abbreviated to 開，开[kai1] after a numeral, e.g. 16-kai and 3…
开业|to open a business;to open a practice;open (for business)
开机|to start an engine;to boot up (a computer);to press Ctrl-Alt-Delete;to begin shooting a film or TV show
开水|boiled water;boiling water
开江|see 開江縣，开江县[Kai1 jiang1 Xian4]
开河|to open a river;to dig a canal;to thaw (of river)
开火|to open fire; to start shooting;to light the flame (for cooking)
开球|open ball (math.);to start a ball game;to kick off (soccer);to tee off (golf)
开发|to exploit (a resource); to open up (for development); to develop
开盘|to commence trading (stock market)
开眼|to open one's eyes;to widen one's horizons
开线|to come unsewn;to split at the seam
开罗|Cairo, capital of Egypt
开台|start of play;opening of theatrical performance
开花|to bloom; to blossom; to flower;(fig.) to burst; to split open;(fig.) to burst with joy;(fig.) to spring up everywhere; to flouris…
开行|(of a bus, a train, a boat) to start off
开解|to straighten out;to explain;to ease sb's anxiety
开路|to open up a path;to make one's way through;to construct a road;(electricity) open circuit
开车|to drive a car (or train etc);(slang) to post sexual content online; to make a sexual joke
开通|to open (a new road or railway line); to set up (a hotline); to launch (a service); to subscribe to (a members-only service)
开道|to clear the way
开金|carated gold (alloy containing stated proportion of gold)
开门|(lit. and fig.) to open a door;to open for business
开关|power switch;gas valve;to open the city (or frontier) gate;to open and close
开阳|Mizar; Zeta Ursae Majoris in the Big Dipper;see 開陽縣，开阳县[Kai1 yang2 Xian4]
开头|beginning;to start
开黑|(slang) (online gaming) to team up with friends in a coordinated private group (黑[hei1] indicates private, team-only chat)
关上|to close (a door);to turn off (light, electrical equipment etc)
关中|Guanzhong Plain in Shaanxi
关内|the region inside the major mountain passes of ancient China
关公|Lord Guan (i.e. 關羽，关羽[Guan1 Yu3])
关卡|checkpoint (for taxation, security etc);(fig.) barrier; hurdle; red tape;Taiwan pr. [guan1ka3]
关口|pass;gateway;(fig.) juncture
关员|customs officer
关城|defensive fort over border post
关外|beyond the pass, i.e. the region north and east of Shanhai Pass 山海關，山海关[Shan1 hai3 guan1] or the region west of Jiayu Pass 嘉峪關，嘉峪关…
关子|climax (in a story)
关山|fortresses and mountains (along the Great Wall);one's hometown
关心|to be concerned about; to care about
关文|official document sent to an agency (or an official) of equal rank (in imperial times)
关于|pertaining to;concerning;with regard to;about
关东|Northeast China;Manchuria;lit. east of Shanhai Pass 山海關，山海关[Shan1 hai3 guan1];Kantō region of Japan
关格|blocked or painful urination, constipation and vomiting (Chinese medicine)
关机|to turn off (a machine or device);to finish shooting a film
关白|to inform;to notify
关节|joint (physiology);key point;critical phase
关西|Kansai region, Japan;Guanxi or Kuanhsi town in Hsinchu County 新竹縣，新竹县[Xin1 zhu2 Xian4], northwest Taiwan
关金|see 關金券，关金券[guan1 jin1 quan4]
关键|crucial point;crux;key;crucial
关门|to close a door;to lock a door;(of a shop etc) to close (for the night or permanently)
关头|juncture;moment
阿三|(derog.) an Indian
阿来|Alai (1959-), ethnic Tibetan Chinese writer, awarded Mao Dun Literature Prize in 2000 for his novel 塵埃落定，尘埃落定[Chen2 ai1 luo4 ding4…
阿公|(old) grandfather;polite address for an elderly man, or a woman's father-in-law;(Taiwanese) grandfather
阿卡|Acre, city in Israel, also known as Akko
阿土|country bumpkin;redneck (derog)
阿城|see 阿城區，阿城区[A1 cheng2 Qu1]
阿家|husband's mother
阿拉|Allah (Arabic name of God)
阿明|Al-Amin
阿比|(name) Abby; Abi
阿片|(loanword) opium
阿兰|Alan, Allen, Allan, Alain etc (name);A-lan (Chinese female name)
阿谀|to flatter;to toady
阿里|(name) Ali;Ali (c. 600–661), the fourth caliph of Islam;Alibaba, e-commerce company (abbr. for 阿里巴巴[A1 li3 ba1 ba1]);see 阿里地區，阿里地区…
阿门|(loanword) amen
附近|nearby; neighboring;(in the) vicinity (of); neighborhood
陡峭|precipitous
陡然|suddenly;unexpectedly;abruptly;precipitously
除了|apart from; besides; in addition to (used to exclude, as in 除了他，誰也沒來，除了他，谁也没来[chu2 le5 ta1 , shei2 ye3 mei2 lai2] "apart from him,…
除非|only if (..., or otherwise, ...);only when;only in the case that;unless
陪伴|to accompany
阴险|treacherous;sinister
阴霾|haze
阳信|see 陽信縣，阳信县[Yang2 xin4 Xian4]
阳光|sunshine;(of personality) upbeat; energetic;transparent (open to public scrutiny)
阳原|see 陽原縣，阳原县[Yang2 yuan2 Xian4]
阳台|variant of 陽臺，阳台[yang2 tai2]
阳城|see 陽城縣，阳城县[Yang2 cheng2 Xian4]
阳山|see 陽山縣，阳山县[Yang2 shan1 Xian4]
阳平|evenly rising tone, the second tone of putonghua
阳性|positive;masculine
阳文|characters cut in relief
阳新|see 陽新縣，阳新县[Yang2 xin1 Xian4]
阳明|see 陽明區，阳明区[Yang2 ming2 Qu1]
阳东|see 陽東區，阳东区[Yang2 dong1 Qu1]
阳江|see 陽江市，阳江市[Yang2 jiang1 Shi4]
阳物|penis
阳西|see 陽西縣，阳西县[Yang2 xi1 Xian4]
阳道|penis
阳关|Yangguan or Southern Pass on the south Silk Road in Gansu, 70 km south of Dunhuang 敦煌
阳电|positive electric charge
阳高|see 陽高縣，阳高县[Yang2 gao1 Xian4]
际遇|circumstance(s) encountered in one's life (favorable or otherwise);stroke of luck;opportunity
随便|as one wishes;as one pleases;at random;negligent
随时|at any time; at all times;at the right time; whenever necessary
险峻|(of terrain) mountainous; rugged;(of a situation) precarious; daunting
隐忍|to suffer in silence; to endure hardship or injustice without complaint; to swallow one's grievances
隐情|sth one wishes to keep secret;ulterior motive;a subject best avoided
隐瞒|to conceal;to hide (a taboo subject);to cover up the truth
隐约|vague; faint; indistinct
虽然|although; even though (often used correlatively with 可是[ke3 shi4] or 但是[dan4 shi4] etc)
双人|two-person;double;pair;tandem
双北|for Taipei City 臺北市，台北市[Tai2 bei3 Shi4] and New Taipei City 新北市[Xin1 bei3 Shi4] (Tw)
双城|see 雙城區，双城区[Shuang1 cheng2 Qu1]
双子|Gemini (star sign)
双工|(telecommunications) duplex
双手|both hands
双打|doubles (in sports)
双数|even number
双方|bilateral;both sides;both parties involved
双星|double star
双江|see 雙江拉祜族佤族布朗族傣族自治縣，双江拉祜族佤族布朗族傣族自治县[Shuang1 jiang1 La1 hu4 zu2 Wa3 zu2 Bu4 lang3 zu2 Dai3 zu2 Zi4 zhi4 xian4]
双流|Shuangliu county in Chengdu 成都[Cheng2 du1], Sichuan;Chengdu's main airport
双清|see 雙清區，双清区[Shuang1 qing1 Qu1]
双生|twin (attributive);twins
双眼|the two eyes
双管|double-barreled
双节|combined Mid-Autumn Festival and National Day (occurring when the Mid-Autumn Festival 中秋節，中秋节[Zhong1 qiu1 jie2] falls on October 1…
双号|even number (on a ticket, house etc)
双语|bilingual
双边|bilateral
双重|double
双开|to strip sb of their Party membership and government job (開除黨籍，开除党籍[kai1 chu2 dang3 ji2] + 開除公職，开除公职[kai1 chu2 gong1 zhi2]);(compu…
双关|pun;play on words
双阳|see 雙陽區，双阳区[Shuang1 yang2 Qu1]
双双|both; together (used to indicate that two people or things do the same thing simultaneously)
双面|double-sided;two-faced;double-edged;reversible
双鱼|Pisces (star sign)
杂志|magazine
鸡蛋|(chicken) egg;hen's egg
离开|to depart; to leave
难受|to feel unwell;to suffer pain;to be difficult to bear
难过|to feel sad;to feel unwell;(of life) to be difficult
电信|telecommunications
电传|to send information using electronic means (such as fax, telegram, telex etc);a message transmitted using electronic means;telex;t…
电光|light produced by electricity; (esp.) lightning flash;(textiles) glossy finish
电力|electrical power;electricity
电动|electric-powered;(Tw) video game
电商|e-commerce (abbr. for 電子商務，电子商务[dian4 zi3 shang1 wu4]);(old) to negotiate by telegram or telephone
电器|(electrical) appliance;device
电报|telegram;cable;telegraph
电场|electric field
电子|electronic;electron (particle physics)
电学|electrical engineering
电工|electrician;electrical engineering;electrical work (in a house)
电教|multimedia education (abbr. for 電化教育，电化教育)
电木|bakelite (early plastic);also written 膠木，胶木[jiao1 mu4]
电机|electrical machinery
电死|to electrocute;to die from an electric shock
电气|electricity;electric;electrical
电波|electric wave;alternating current
电流|an electric current;(old) current intensity
电热|electrical heating
电白|see 電白區，电白区[Dian4 bai2 Qu1]
电眼|beautiful, expressive eyes
电石|calcium carbide
电网|electricity grid; power grid;electrified wire netting
电线|wire;power cord
电脑|computer
电台|transmitter-receiver;broadcasting station;radio station
电表|power meter;ammeter;amperemeter;wattmeter
电解|electrolysis;electrolytic
电话|telephone;phone call;phone number
电路|electric circuit
电车|tram; streetcar;trolleybus;electric car;e-bike
电量|quantity of electric charge
电门|electric switch
电音|electronic music (genre)
需要|to need; to want; to demand; to require;needs
震慑|to awe; to intimidate
霍然|suddenly;quickly
灵气|spiritual influence (of mountains etc);cleverness;ingeniousness
灵魂|soul;spirit
青原|see 青原區，青原区[Qing1 yuan2 Qu1]
青天|clear sky;blue sky;upright and honorable (official)
青山|see 青山區，青山区[Qing1 shan1 Qu1]
青州|see 青州市[Qing1 zhou1 Shi4]
青工|young worker (esp of the CCP)
青年|youth;youthful years;young person;the young
青木|Aoki (Japanese surname)
青果|Chinese olive (Canarium album);green unripe fruit;(Tw) fresh fruits
青河|see 青河縣，青河县[Qing1 he2 Xian4]
青海|see 青海省[Qing1 hai3 Sheng3]
青发|amobarbital (drug) (Tw)
青白|Qingbaijiang district of Chengdu city 成都市[Cheng2 du1 shi4], Sichuan
青眼|(to look) with a direct gaze;(fig.) respect; favor
青石|bluestone;limestone (colloquial)
青神|see 青神縣，青神县[Qing1 shen2 Xian4]
青县|Qing County or Qingxian, a county in Cangzhou City 滄州市，沧州市[Cang1 zhou1 Shi4], Hebei
青色|cyan;blue-green
青花|blue and white (porcelain)
青草|grass
青菜|green vegetables;Chinese cabbage
青阳|see 青陽縣，青阳县[Qing1 yang2 Xian4]
青鱼|black carp (Mylopharyngodon piceus);herring;mackerel
青黄|greenish yellow;sallow (of complexion)
青龙|Azure Dragon, one of the Four Symbols of the Chinese constellations, representing the east and the spring season;see 青龍滿族自治縣，青龙满族自…
静谧|(literary) quiet; calm; still; tranquil
非常|very; really;unusual; extraordinary
面交|to deliver personally;to hand over face-to-face
面儿|cover;outside
面前|in front of;facing;(in the) presence (of)
面单|(logistics) shipping label; waybill
面基|(slang) (of online friends) to meet up in person
面子|outer surface; the outside of sth;social prestige; face
面对|to face; to confront
面市|to hit the market (of a new product)
面带|to wear (on one's face)
面形|shape of face
面板|panel;faceplate
面生|(of a person) to look unfamiliar
面皮|cheek;face;leather covering (for handbags etc)
面相|facial features;appearence;physiognomy
面色|complexion
面面|multiple viewpoints
韬略|military strategy;military tactics;originally refers to military classics Six Secret Teachings 六韜，六韬[Liu4 tao1] and Three Strategi…
音信|message
音名|names of the notes of a musical scale (e.g. C, D, E or do, re, mi)
音带|audio tape
音乐|music
音波|sound wave
音管|pipe (of an organ)
音节|syllable
音色|tone;timbre;sound color
音调|pitch of voice (high or low);pitch (of a musical note);tone
音变|phonetic change
音量|loudness;volume
音长|sound duration;length of a musical note
音高|pitch (music);tone
顷刻|instantly;in no time
须臾|in a flash;in a jiffy
预兆|omen;sign (of sth yet to occur);prior indication;to foreshadow
顿悟|a flash of realization;the truth in a flash;a moment of enlightenment (usually Buddhist)
顿时|immediately; suddenly
领导|lead;leading;to lead;leadership
头一|the first
头上|overhead;above
头儿|leader
头名|first place;leader (of a race)
头回|for the first time;on the previous occasion;last time (something occurred)
头大|to have a big head;(fig.) to get a headache;one's head is swimming
头天|yesterday; previous day;first day
头子|boss;gang leader
头家|organizer of a gambling party who takes a cut of the winnings;banker (gambling);preceding player (in a game);(dialect) boss
头座|headstock;turning head of a screw, drill, lathe etc
头球|(soccer) header
头疼|headache
头皮|scalp
头号|first rate;top rank;number one
头角|youngster's talent;brilliance of youth
头路|clue;thread (of a story);mate;first class
头道|first time;first (round, course, coat of paint etc)
头里|in front;in advance of the field
头重|disequilibrium;top-heavy;heaviness in the head (medical condition)
头面|head ornament (in former times);(literary) head;face;looks
头头|head;chief
头风|headache (Chinese medicine)
头香|the first stick of incense placed in the censer (believed to bring good luck esp. during festivities);(slang) (Tw) the first reply…
头骨|skull
头发|hair (on the head)
愿意|to wish;to want;ready;willing (to do sth)
颠沛|to fall over; to stumble;(fig.) to suffer hardship; to be in desperate straits
风干|to air-dry;to season (timber etc);air-dried;air-drying
风传|it is rumored that
风光|scene;view;sight;landscape
风力|wind force;wind power
风化|decency;public morals;to weather (rocks);wind erosion
风口|air vent;drafty place;wind gap (geology);tuyere (furnace air nozzle)
风土|natural conditions and social customs of a place;local conditions
风城|the Windy City, nickname for Chicago 芝加哥[Zhi1 jia1 ge1], Wellington, New Zealand 惠靈頓，惠灵顿[Hui4 ling2 dun4] and Hsinchu, Taiwan 新竹[X…
风场|wind farm
风度|elegance (for men);elegant demeanor;grace;poise
风情|mien;bearing;grace;amorous feelings
风成|produced by wind;eolian
风月|romance;beautiful scenery;small or petty (of talk etc)
风格|style
风机|fan;ventilator
风气|general mood;atmosphere;common practice
风水|feng shui;geomancy
风沙|sand blown by wind;sandstorm
风波|disturbance;crisis;disputes;restlessness
风流|distinguished and accomplished;outstanding;talented in letters and unconventional in lifestyle;romantic
风物|scenery;sights
风球|(HK) typhoon warning signal
风声|sound of the wind;rumor;talk;news
风华|magnificent
风行|to become fashionable;to catch on;to be popular
风调|character (of a person, verse, object etc);style
风车|pinwheel;windmill
风电|wind power
风头|wind direction;the way the wind blows;fig. trend;direction of events
风骨|strength of character;vigorous style (of calligraphy)
食物|food
饭店|restaurant;hotel
饭馆|restaurant
餐厅|dining hall;dining room;restaurant
首都|capital (city)
首领|head; boss; chief
香干|smoked bean curd
香包|a small bag full of fragrance used on Dragon boat Festival
香客|Buddhist pilgrim;Buddhist worshipper
香会|a company of pilgrims
香木|incense wood
香气|fragrance;aroma;incense
香水|perfume;cologne
香河|see 香河縣，香河县[Xiang1 he2 Xian4]
香油|sesame oil;perfumed oil
香波|shampoo (loanword);see 洗髮皂，洗发皂[xi3 fa4 zao4]
香火|incense burning in front of a temple;burning joss sticks
香片|jasmine tea;scented tea
香肉|(dialect) dog meat
香花|fragrant flower;fig. beneficial (of artworks etc)
香草|aromatic herb;vanilla;alternative name for Eupatorium fortunei;(fig.) loyal and dependable person (old)
香菜|coriander;cilantro;Coriandrum sativum
马上|at once;right away;immediately;on horseback (i.e. by military force)
马来|Malaya;Malaysia
马克|Mark (name)
马公|Makung city in Penghu county 澎湖縣，澎湖县[Peng2 hu2 xian4] (Pescadores Islands), Taiwan
马利|Mali (Tw)
马力|horsepower
马国|Malaysia
马大|Martha (biblical name)
马子|bandit; brigand;gambling chip;chamber pot;(slang) girl; chick; babe
马山|see 馬山縣，马山县[Ma3 shan1 Xian4]
马年|Year of the Horse (e.g. 2002)
马房|horse stable
马拉|Marat (name);Jean-Paul Marat (1743-1793), Swiss scientist and physician
马会|horse racing organization; jockey club; turf club (abbr. for 賽馬會，赛马会[sai4 ma3 hui4] or 賽馬公會，赛马公会[sai4 ma3 gong1 hui4])
马球|polo
马眼|male's pee hole
马科|Equidae;horse family
马经|form (horse racing)
马兰|Malan military base and atomic test site in Bayingolin Mongol Autonomous Prefecture 巴音郭楞蒙古自治州[Ba1 yin1 guo1 leng2 Meng3 gu3 Zi4 zh…
马表|stopwatch
马路|street;road
马车|cart;chariot;carriage;buggy
马达|(loanword) motor
马边|see 馬邊彝族自治縣，马边彝族自治县[Ma3 bian1 Yi2 zu2 Zi4 zhi4 xian4]
马里|Mali
马关|see 馬關縣，马关县[Ma3 guan1 Xian4]
马面|Horse-Face, one of the two guardians of the underworld in Chinese mythology
马头|old variant of 碼頭，码头[ma3 tou5]
马龙|see 馬龍區，马龙区[Ma3 long2 Qu1]
骇然|overwhelmed with shock, horror or amazement;dumbstruck;aghast
蓦然|suddenly;sudden
惊讶|amazed;astonished;to surprise;amazing
骤然|suddenly;abruptly
骨力|(Chinese calligraphy) vigor of brushstrokes;fortitude; toughness; spine
骨化|to ossify;ossification
骨器|bone tool (archaeology)
骨子|ribs;frame
骨干|diaphysis (long segment of a bone);fig. backbone
骨气|unyielding character;courageous spirit;integrity;moral backbone
骨法|bone structure and physiognomy;the strength observed in brushstrokes (Chinese calligraphy)
骨片|spicule
骨病|osteopathy
骨盘|pelvis (Tw)
骨科|orthopedics;orthopedic surgery
骨节|joint (of the skeleton)
骨肉|blood relation;kin;one's flesh and blood
骨血|flesh and blood;one's offspring
骨头|bone;moral character;bitterness;Taiwan pr. [gu2 tou5]
体内|within the body; in vivo
体制|system;organization
体力|physical strength;physical power
体外|outside the body; in vitro
体式|(of characters) form; style (cursive, printed etc);(of a literary work) form; style; genre
体形|figure;bodily form
体性|disposition
体会|to know from experience;to learn through experience;to realize;understanding
体格|bodily health;one's physical state;physique
体毛|body hair
体表|surface of the body;periphery of the body;body thermometer;(literary) a person's appearance
体重|body weight
体量|overall volume or size (of a building etc); scale; quantity
体长|body length
体面|dignity; prestige; face;honorable; creditable;(of sb's appearance) presentable; respectable
体香|pleasant body scent
高下|relative superiority (better or worse, stronger or weaker, above or below etc)
高中|senior high school (abbr. for 高級中學，高级中学[gao1 ji2 zhong1 xue2])
高人|very able person
高光|highlight (in a photo or painting);(cosmetics) highlighter
高出|to be higher (than the stated amount) by ...
高分|high marks;high score
高利|high interest rate;usurious
高原|plateau
高反|altitude sickness (abbr. for 高原反應，高原反应[gao1 yuan2 fan3 ying4])
高台|see 高台縣，高台县[Gao1 tai2 Xian4]
高名|renown;fame
高地|highland;upland
高大|tall; lofty; towering
高安|see 高安市[Gao1 an1 Shi4]
高小|upper primary school (abbr. for 高級小學，高级小学[gao1 ji2 xiao3 xue2])
高山|high mountain; alpine mountain
高州|see 高州市[Gao1 zhou1 Shi4]
高工|senior engineer (abbr. for 高級工程師，高级工程师[gao1 ji2 gong1 cheng2 shi1]);(Tw) industrial vocational high school (abbr. for 高級工業職業學校，高级工…
高平|see 高平市[Gao1 ping2 Shi4]
高年|old;aged
高干|high cadre;top party member
高度|height;altitude;elevation;high degree
高手|expert;past master;dab hand
高教|higher education (abbr. for 高等教育[gao1 deng3 jiao4 yu4])
高数|further math;advanced mathematics (school subject, abbr. for 高等數學，高等数学)
高斯|Carl Friedrich Gauss (1777-1855), German mathematician
高明|see 高明區，高明区[Gao1 ming2 Qu1]
高木|Takagi (Japanese surname)
高清|high definition (television etc);high fidelity (audio)
高热|(medicine) high fever;(physics) high heat
高球|(sports) high ball; lob;(Tw, HK) golf (abbr. for 高爾夫球，高尔夫球[gao1 er3 fu1 qiu2]);highball (cocktail)
高发|(of diseases, accidents) to occur with a high incidence;(old) to score highly in the imperial exams
高空|high altitude
高管|senior executive; senior manager (abbr. for 高級管理人員，高级管理人员[gao1 ji2 guan3 li3 ren2 yuan2])
高县|Gao County or Gaoxian, a county in Yibin City 宜賓市，宜宾市[Yi2 bin1 Shi4], Sichuan
高声|aloud;loud;loudly
高兴|happy;glad;willing (to do sth);in a cheerful mood
高调|high-sounding speech;bombast;high-profile
高起|to rise high; to spring up
高达|Gundam, Japanese animation franchise;(Tw) Gouda (cheese)
高阳|Gao Yang (1926-1992), Taiwanese historical novelist
高青|see 高青縣，高青县[Gao1 qing1 Xian4]
高音|high pitch;soprano;treble
高头|higher authority;the bosses;on top of
发小|(dialect) close childhood friend whom one grew up with;a couple who grew up as childhood friends
发带|headband
发式|hairstyle;coiffure;hairdo
发网|hairnet
发菜|long thread moss (Nostoc flagelliforme), an edible algae;also called faat choy or hair moss
发量|hair volume
魁梧|tall and sturdy
魔法|enchantment;magic
魔鬼|devil
鱼干|dried fish
鱼台|see 魚台縣，鱼台县[Yu2 tai2 Xian4]
鱼子|fish eggs; roe
鱼水|fish and water (metaphor for an intimate relationship or inseparability)
鱼油|fish oil
鱼片|fish fillet;slice of fish meat
鱼生|sliced raw fish
鱼网|variant of 漁網，渔网[yu2 wang3]
鱼线|fishing line
鱼肉|flesh of fish;fish and meat;(fig.) victims of oppression;(fig.) to cruelly oppress (i.e. to treat like flesh to be carved up)
鱼花|fry;newly hatched fish
鱼头|fish head;fig. upright and unwilling to compromise
鱼香|yuxiang, a seasoning of Chinese cuisine that typically contains garlic, scallions, ginger, sugar, salt, chili peppers etc (Althoug…
鱼骨|fish bone
鱼龙|ichthyosaur
凤凰|see 鳳凰縣，凤凰县[Feng4 huang2 Xian4]
面包|bread
面线|misua; wheat vermicelli (very thin variety of wheat noodles used esp. in Fujian)
面体|noodles
面点|pastry
黄信|Huang Xin, character in The Water Margin
黄南|see 黃南藏族自治州，黄南藏族自治州[Huang2 nan2 Zang4 zu2 Zi4 zhi4 zhou1]
黄土|loess (yellow sandy soil typical of north China)
黄山|Huangshan, mountain range in Anhui province
黄州|see 黃州區，黄州区[Huang2 zhou1 Qu1]
黄平|see 黃平縣，黄平县[Huang2 ping2 Xian4]
黄教|Yellow hat or Gelugpa school of Tibetan Buddhism;also written 格魯派，格鲁派[Ge2 lu3 pai4]
黄书|pornographic book
黄河|Yellow River or Huang He
黄油|butter
黄海|Yellow Sea
黄片|adult movie;pornographic movie
黄皮|wampee (Clausena lansium)
黄石|see 黃石市，黄石市[Huang2 shi2 Shi4]
黄色|yellow;vulgar; lewd; pornographic
黄花|yellow flowers (of various types);chrysanthemum;cauliflower;(yellow) daylily
黄华|Huang Hua (1913-2010), PRC foreign minister (1976-1982) and vice premier (1980-1982)
黄道|(astronomy) the ecliptic
黄酒|"yellow wine" (mulled rice wine, usually served warm)
黄金|gold;golden (opportunity);prime (time)
黄体|corpus luteum (glands in female mammals producing progesterone)
黄鱼|yellow croaker (fish)
黄龙|see 黃龍縣，黄龙县[Huang2 long2 Xian4]
黑人|black person;an illegal
黑信|blackmail
黑化|to blacken;(slang) to undergo a transformation to a malevolent personality (often, precipitated by intense psychological stress)
黑卡|a fraudulently used credit card
黑天|night; nightfall
黑子|black piece (in Chinese chess); black stone (in Go);(astronomy) sunspot
黑客|(computing) (loanword) hacker
黑山|Montenegro (country);see 黑山縣，黑山县[Hei1 shan1 Xian4]
黑市|black market
黑心|ruthless and lacking in conscience;vicious mind full of hatred and jealousy;black core (flaw in pottery)
黑手|(fig.) malign agent who manipulates from behind the scenes;hidden hand;(Tw) mechanic;blue-collar worker
黑板|blackboard
黑水|see 黑水縣，黑水县[Hei1 shui3 Xian4]
黑河|see 黑河市[Hei1 he2 Shi4]
黑海|Black Sea
黑特|(Internet slang) (loanword) hate
黑白|black and white;right and wrong;monochrome
黑管|clarinet
黑色|black
黑话|argot;bandits' secret jargon;malicious words
黑车|unlicensed or unofficial taxi;unlicensed motor vehicle
黑道|dark road;unlawful activities (contrasted with 白道[bai2 dao4]);the underworld; criminal gangs
黑马|dark horse;fig. unexpected winner
黑体|sans-serif typeface (for Chinese characters);(physics) black body
黑发|black hair
黑鱼|northern snakehead (Channa argus)
点交|to hand over (bought goods etc)
点儿|erhua variant of 點，点[dian3]
点出|to point out;to indicate
点化|magic transformation performed by Daoist immortal;fig. to reveal;to enlighten
点名|roll call;to mention sb by name;(to call or praise or criticize sb) by name
点单|to place an order; to order
点大|(of a child etc) small as a mite;minuscule
点子|spot;point;dot;speck
点字|braille
点心|light refreshments;pastry;dim sum (in Cantonese cooking);dessert
点数|to count and check;to tally;points (collected in some bonus scheme etc)
点明|to point out
点水|to skim;lightly touching the water (as the dragonfly in the idiom 蜻蜓點水，蜻蜓点水);skin-deep
点火|to ignite;to light a fire;to agitate;to start an engine
点球|penalty kick
点发|to fire in bursts;shooting intermittently
点菜|to order dishes (in a restaurant)
点号|punctuation mark
点军|see 點軍區，点军区[Dian3 jun1 Qu1]
点开|(computing) to open (a link, file etc) by clicking or tapping
点头|to nod
点点|Diandian (Chinese microblogging and social networking website)
黯淡|variant of 暗淡[an4 dan4]
黯然|dim;sad
鼓励|to encourage
鼻子|nose
龙人|Dragon Man, the nickname of the individual whose fossilized cranium was discovered in Heilongjiang in 1933, thought to be a Deniso…
龙利|sole;right-eyed flounder;flatfish;see also 鰈，鲽[die2]
龙南|see 龍南市，龙南市[Long2 nan2 Shi4]
龙口|see 龍口市，龙口市[Long2 kou3 Shi4]
龙城|see 龍城區，龙城区[Long2 cheng2 Qu1]
龙安|see 龍安區，龙安区[Long2 an1 Qu1]
龙山|see 龍山縣，龙山县[Long2 shan1 Xian4];see 龍山區，龙山区[Long2 shan1 Qu1]
龙州|see 龍州縣，龙州县[Long2 zhou1 Xian4]
龙年|Year of the Dragon (e.g. 2000, 2012, etc)
龙文|see 龍文區，龙文区[Long2 wen2 Qu1]
龙江|see 龍江縣，龙江县[Long2 jiang1 Xian4]
龙沙|see 龍沙區，龙沙区[Long2 sha1 Qu1]
龙海|see 龍海區，龙海区[Long2 hai3 Qu1]
龙王|Dragon King (mythology)
龙眼|longan fruit;dragon eye fruit;Dimocarpus longan (botany)
龙华|see 龍華區，龙华区[Long2 hua2 Qu1];Longhua, the name of numerous streets, railway stations, temples etc, notably Longhua Temple 龍華寺，龙华寺[L…
龙车|imperial chariot
龙里|see 龍里縣，龙里县[Long2 li3 Xian4]
龙门|see 龍門縣，龙门县[Long2 men2 Xian4];see 龍門石窟，龙门石窟[Long2 men2 Shi2 ku1];see 龍門山，龙门山[Long2 men2 Shan1];Dragon Gate, mythical gate at the c…
龙阳|place in Shanghai;(coll.) male homosexual
龙头|faucet; tap;bicycle handlebar;chief; boss (esp. of a gang);(referring to a company) leader; front-runner
龙骨|"dragon bones" (fossilized animal bones or teeth, used in TCM);breastbone (of a bird);keel (of a ship)
龙体|emperor's body; emperor's physical condition
一刹那|a moment;an instant;in a flash
中学生|middle-school student;high school student
互联网|Internet
公交车|public transport vehicle;town bus
出租车|taxi;(Tw) rental car
图书馆|library
大学生|university student; college student
对不起|I'm sorry; excuse me; I beg your pardon;to let (sb) down; to disappoint
小学生|primary school student;schoolchild;(fig.) beginner
工程师|engineer
幼儿园|kindergarten;nursery school
怎么样|how?;how about?;how was it?;how are things?
没问题|no problem
没关系|it doesn't matter
火车站|train station
为什么|why?;for what reason?
研究生|graduate student;postgraduate student;research student
办公室|office; business premises
中山区|Zhongshan or Chungshan District of Taipei City 臺北市，台北市[Tai2 bei3 Shi4], Taiwan;Zhongshan District of Dalian 大連市，大连市[Da4 lian2 shi4…
中山市|Zhongshan, prefecture-level city in Guangdong Province 廣東省，广东省[Guang3 dong1 Sheng3]
市中区|Shizhong, a district of Jinan City 濟南市，济南市[Ji3 nan2 Shi4], Shandong;Shizhong, a district of Zaozhuang City 棗莊市，枣庄市[Zao3 zhuang1 Sh…
白山市|Baishan, prefecture-level city in Jilin Province 吉林省[Ji2 lin2 Sheng3]
白水县|Baishui, a county in Weinan City 渭南市[Wei4 nan2 Shi4], Shaanxi
白头山|Baekdu or Changbai mountains 長白山，长白山, volcanic mountain range between Jilin province and North Korea, prominent in Manchu and Kore…
白花花|shining white
花山区|Huashan, a district of Ma'anshan City 馬鞍山市，马鞍山市[Ma3 an1 shan1 Shi4], Anhui
人性化|(of a system or product etc) adapted to human needs;people-oriented;user-friendly
人头马|Rémy Martin cognac
大化县|see 大化瑤族自治縣，大化瑶族自治县[Da4 hua4 Yao2 zu2 Zi4 zhi4 xian4]
马山县|Mashan, a county in Nanning City 南寧市，南宁市[Nan2 ning2 Shi4], Guangxi
中心区|central district
市中心|city center;downtown
大安区|Da'an, a district of Zigong City 自貢市，自贡市[Zi4 gong4 Shi4], Sichuan;Daan, a district of Taipei City 臺北市，台北市[Tai2 bei3 Shi4], Taiwan;…
大安市|Da'an, a county-level city in Baicheng City 白城市[Bai2 cheng2 Shi4], Jilin
安化县|Anhua, a county in Yiyang City 益陽市，益阳市[Yi4 yang2 Shi4], Hunan
海安市|Hai'an, a county-level city in Nantong City 南通市[Nan2 tong1 Shi4], Jiangsu
地中海|Mediterranean Sea
地区性|regional;local
上海市|Shanghai municipality (short name 滬，沪[Hu4])
心上人|sweetheart;one's beloved
地面水|surface water
市面上|on the market
白面儿|heroin
面人儿|dough figurine
大白天|in broad daylight
天山区|Tianshan, a district of Ürümqi City 烏魯木齊市，乌鲁木齐市[Wu1 lu3 mu4 qi2 Shi4], Xinjiang
天心区|Tianxin, a district of Changsha City 長沙市，长沙市[Chang2 sha1 Shi4], Hunan
天水市|Tianshui, prefecture-level city in Gansu Province 甘肅省，甘肃省[Gan1 su4 Sheng3]
大气儿|erhua variant of 大氣，大气[da4 qi4]
气头上|(in) a fit of anger; (in) a foul mood
上城区|Shangcheng, a district of Hangzhou City 杭州市[Hang2 zhou1 Shi4], Zhejiang
城中区|Chengzhong, a district of Liuzhou City 柳州市[Liu3 zhou1 Shi4], Guangxi;Chengzhong, a district of Xining City 西寧市，西宁市[Xi1 ning2 Shi4]…
城市化|urbanization
大城市|major city; metropolis
大城县|Dacheng, a county in Langfang City 廊坊市[Lang2 fang2 Shi4], Hebei
山城区|Shancheng, a district of Hebi City 鶴壁市，鹤壁市[He4 bi4 Shi4], Henan
水城区|Shuicheng, a district of Liupanshui City 六盤水市，六盘水市[Liu4 pan2 shui3 Shi4], Guizhou
海城区|Haicheng, a district of Beihai City 北海市[Bei3 hai3 Shi4], Guangxi
海城市|Haicheng, a county-level city in Anshan City 鞍山市[An1 shan1 Shi4], Liaoning
白城市|Baicheng, prefecture-level city in Jilin Province 吉林省[Ji2 lin2 Sheng3]
发小儿|erhua variant of 髮小，发小[fa4 xiao3]
山地车|mountain bike
小金县|Xiaojin, a county in Ngawa Tibetan and Qiang Autonomous Prefecture 阿壩藏族羌族自治州，阿坝藏族羌族自治州[A1 ba4 Zang4 zu2 Qiang1 zu2 Zi4 zhi4 zhou1]…
金大中|Kim Dae-jung (1926-2009), South Korea politician, president 1998-2003, Nobel peace prize laureate 2000
金安区|Jin'an, a district of Lu'an City 六安市[Lu4 an1 Shi4], Anhui
金山区|Jinshan suburban district of Shanghai
金水区|Jinshui, a district of Zhengzhou City 鄭州市，郑州市[Zheng4 zhou1 Shi4], Henan
中小学|middle and elementary school
化学家|chemist
化学性|chemical
大学城|university city
生化学|biochemistry
白开水|plain boiled water
开化县|Kaihua, a county in Quzhou City 衢州市[Qu2 zhou1 Shi4], Zhejiang
开城市|Kaesong or Gaeseong city in southwest North Korea, close to the border with South Korea and a special economic zone for South Kore…
开发区|development zone
开花儿|erhua variant of 開花，开花[kai1 hua1]
开车人|driver;person driving a vehicle
不体面|to not appear to be decent or respectful;shameful
大体上|overall;in general terms
海马体|(anatomy) hippocampus
中国人|Chinese person
中国化|to sinicize;to take on Chinese characteristics
中国城|Chinatown
中国海|the China Seas (the seas of the Western Pacific Ocean, around China: Bohai Sea, Yellow Sea, East China Sea, South China Sea)
天长市|Tianchang, a county-level city in Chuzhou City 滁州市[Chu2 zhou1 Shi4], Anhui
子长市|Zichang, a county-level city in Yan'an City 延安市[Yan2 an1 Shi4], Shaanxi
安国市|Anguo, a county-level city in Baoding City 保定市[Bao3 ding4 Shi4], Hebei
长子县|Zhangzi, a county in Changzhi City 長治市，长治市[Chang2 zhi4 Shi4], Shanxi
长安区|Chang'an, a district of Xi'an City 西安市[Xi1 an1 Shi4], Shaanxi;Chang'an, a district of Shijiazhuang City 石家莊市，石家庄市[Shi2 jia1 zhuang…
长海县|Changhai, a county in Dalian City 大連市，大连市[Da4 lian2 Shi4], Liaoning
长白山|Changbai or Baekdu mountains 白頭山，白头山, volcanic mountain range between Jilin province and North Korea, prominent in Manchu and Kore…
长白县|see 長白朝鮮族自治縣，长白朝鲜族自治县[Chang2 bai2 Chao2 xian3 zu2 Zi4 zhi4 xian4]
出家人|monk; nun (Buddhist or Daoist)
出生地|birthplace
地下城|dungeon (in video games or fantasy settings etc)
地下水|groundwater
安平区|Anping, a district of Tainan 臺南市，台南市[Tai2 nan2 Shi4], Taiwan
安平县|Anping, a county in Hengshui City 衡水市[Heng2 shui3 Shi4], Hebei
平地机|land grader;road grader
平城区|Pingcheng, a district of Datong City 大同市[Da4 tong2 Shi4], Shanxi
平天下|to pacify the country
平安区|Ping'an, a district of Haidong City 海東市，海东市[Hai3 dong1 Shi4], Qinghai
平山区|Pingshan, a district of Benxi City 本溪市[Ben3 xi1 Shi4], Liaoning
平山县|Pingshan, a county in Shijiazhuang City 石家莊市，石家庄市[Shi2 jia1 zhuang1 Shi4], Hebei
气不平|angry at unfairness
水平面|horizontal plane;level surface;water level
海平面|sea level
金平区|Jinping, a district of Shantou City 汕頭市，汕头市[Shan4 tou2 Shi4], Guangdong
金平县|see 金平苗族瑤族傣族自治縣，金平苗族瑶族傣族自治县[Jin1 ping2 Miao2 zu2 Yao2 zu2 Dai3 zu2 Zi4 zhi4 xian4]
开平区|Kaiping, a district of Tangshan City 唐山市[Tang2 shan1 Shi4], Hebei
开平市|Kaiping, a county-level city in Jiangmen City 江門市，江门市[Jiang1 men2 Shi4], Guangdong
一下儿|erhua form of 一下[yi1 xia4]
一下子|once; one time;(following a verb) for a moment; briefly;for a little while; in no time; almost immediately;all at once; all of a s…
一家人|the whole family;(lit. and fig.) members of the same family
一家子|the whole family
一水儿|(coll.) of the same type;identical
一体化|to integrate; to unify
上高县|Shanggao, a county in Yichun City 宜春市[Yi2 chun1 Shi4], Jiangxi
高中生|senior high school student
高大上|(slang) high-end, elegant, and classy;abbr. for 高端大氣上檔次，高端大气上档次
高安市|Gao'an, a county-level city in Yichun City 宜春市[Yi2 chun1 Shi4], Jiangxi
高山区|alpine district
高平市|Gaoping, a county-level city in Jincheng City 晉城市，晋城市[Jin4 cheng2 Shi4], Shanxi;Cao Bang, a city in northern Vietnam
高高手|Please do not be too severe on me!
打下手|to act in a supporting role;fig. to play second fiddle
打出手|to fling back weapons hurled at one by attackers (acrobatic performance in Chinese opera);to come to blows;to start a fight
打天下|to seize power;to conquer the world;to establish and expand a business;to carve out a career for oneself
中南海|Zhongnanhai, palace adjacent to the Forbidden City, now the central headquarters of the Communist Party and the State Council
南城县|Nancheng, a county in Fuzhou City 撫州市，抚州市[Fu3 zhou1 Shi4], Jiangxi
南安市|Nan'an, a county-level city in Quanzhou City 泉州市[Quan2 zhou1 Shi4], Fujian
南山区|Nanshan, a district of Shenzhen City 深圳市[Shen1 zhen4 Shi4], Guangdong;Nanshan, a district of Hegang City 鶴崗市，鹤岗市[He4 gang3 Shi4], …
南平市|Nanping, prefecture-level city in Fujian Province 福建省[Fu2 jian4 Sheng3]
南海区|Nanhai, a district of Foshan City 佛山市[Fo2 shan1 Shi4], Guangdong
南海子|Nanhaizi, name used to refer to various places, including 草海[Cao3 hai3], 南苑[Nan2 yuan4] and the Nanhaizi Wetland in Baotou, Inner …
南开区|Nankai, a district of Tianjin 天津市[Tian1 jin1 Shi4]
安南区|Annan district of Tainan City 臺南市，台南市[Tai2 nan2 shi4], Taiwan
安南子|see 胖大海[pang4 da4 hai3]
山南市|Lhoka, prefecture-level city in Tibet Autonomous Region 西藏自治區，西藏自治区[Xi1 zang4 Zi4 zhi4 qu1]
市南区|Shinan, a district of Qingdao City 青島市，青岛市[Qing1 dao3 Shi4], Shandong
平南县|Pingnan, a county in Guigang City 貴港市，贵港市[Gui4 gang3 Shi4], Guangxi
海南区|Hainan, a district of Wuhai City 烏海市，乌海市[Wu1 hai3 Shi4], Inner Mongolia
上西天|(Buddhism) to go to the Western Paradise;(fig.) to die
中西区|Central and Western district of Hong Kong
城西区|Chengxi, a district of Xining City 西寧市，西宁市[Xi1 ning2 Shi4], Qinghai
大西国|Atlantis
西城区|Xicheng, a district of central Beijing
西安区|Xi'an, a district of Mudanjiang City 牡丹江市[Mu3 dan1 jiang1 Shi4], Heilongjiang;Xi'an, a district of Liaoyuan City 遼源市，辽源市[Liao2 yua…
西安市|Xi'an, sub-provincial city and capital of Shaanxi Province 陝西省，陕西省[Shan3 xi1 Sheng3]
西山区|Xishan, a district of Kunming City 昆明市[Kun1 ming2 Shi4], Yunnan
西市区|Xishi, a district of Yingkou City 營口市，营口市[Ying2 kou3 Shi4], Liaoning
西平县|Xiping, a county in Zhumadian City 駐馬店市，驻马店市[Zhu4 ma3 dian4 Shi4], Henan
人力车|rickshaw
水力学|hydraulics
生力面|instant noodles (old)
南天门|South Gate to Heaven, the name a gate constructed on various mountains, most notably on Mount Tai 泰山[Tai4 Shan1];(mythology) south…
天安门|Tiananmen Gate, entrance of the Imperial City in Beijing
天门市|Tianmen sub-prefecture level city in Hubei
海门区|Haimen, a district of Nantong City 南通市[Nan2 tong1 Shi4], Jiangsu
西门子|Siemens (company name)
金门县|Kinmen County, Taiwan (the Kinmen or Quemoy islands off the Fujian coast);Jinmen county in Quanzhou 泉州[Quan2 zhou1], Fujian
上下文|(textual) context
人文学|humanities
天城文|Devanagari alphabet used in India and Nepal
天文学|astronomy
文化城|city of culture
文学家|writer;man of letters
文安县|Wen'an, a county in Langfang City 廊坊市[Lang2 fang2 Shi4], Hebei
文山区|Wenshan District in Taipei 臺北市，台北市[Tai2 bei3 Shi4], Taiwan
文山市|Wenshan, a county-level city in Wenshan Zhuang and Miao Autonomous Prefecture 文山壯族苗族自治州，文山壮族苗族自治州[Wen2 shan1 Zhuang4 zu2 Miao2 zu2…
文水县|Wenshui, a county in Lüliang City 呂梁市，吕梁市[Lu : 3 liang2 Shi4], Shanxi
法国人|Frenchman;French person
法学家|jurist;member of the pre-Han legalist school
发电机|electricity generator;dynamo
电化学|electrochemistry
电子人|cyborg
电子学|electronics
电气化|electrification; to convert to electrical power (esp. for railways, factories or other infrastructure)
电白区|Dianbai, a district of Maoming City 茂名市[Mao4 ming2 Shi4], Guangdong
电马儿|(dialect) electric bicycle
中阳县|Zhongyang, a county in Lüliang City 呂梁市，吕梁市[Lu : 3 liang2 Shi4], Shanxi
南阳市|Nanyang, prefecture-level city in Henan Province 河南省[He2 nan2 Sheng3]
南阳县|Nanyang county in Henan
城阳区|Chengyang, a district of Qingdao City 青島市，青岛市[Qing1 dao3 Shi4], Shandong
安阳市|Anyang, prefecture-level city in Henan Province 河南省[He2 nan2 Sheng3]
安阳县|Anyang, a county in Anyang City 安陽市，安阳市[An1 yang2 Shi4], Henan
山阳区|Shanyang, a district of Jiaozuo City 焦作市[Jiao1 zuo4 Shi4], Henan
山阳县|Shanyang, a county in Shangluo City 商洛市[Shang1 luo4 Shi4], Shaanxi
平阳县|Pingyang, a county in Wenzhou City 溫州市，温州市[Wen1 zhou1 Shi4], Zhejiang
海阳市|Haiyang, a county-level city in Yantai City 煙台市，烟台市[Yan1 tai2 Shi4], Shandong
金阳县|Jinyang, a county in Liangshan Yi Autonomous Prefecture 涼山彝族自治州，凉山彝族自治州[Liang2 shan1 Yi2 zu2 Zi4 zhi4 zhou1], Sichuan
长阳县|see 長陽土家族自治縣，长阳土家族自治县[Chang2 yang2 Tu3 jia1 zu2 Zi4 zhi4 xian4]
开阳县|Kaiyang, a county in Guiyang City 貴陽市，贵阳市[Gui4 yang2 Shi4], Guizhou
阳城县|Yangcheng, a county in Jincheng City 晉城市，晋城市[Jin4 cheng2 Shi4], Shanxi
阳山县|Yangshan, a county in Qingyuan City 清遠市，清远市[Qing1 yuan3 Shi4], Guangdong
阳西县|Yangxi, a county in Yangjiang City 陽江市，阳江市[Yang2 jiang1 Shi4], Guangdong
阳电子|positron;also called 正電子，正电子[zheng4 dian4 zi3]
阳高县|Yanggao, a county in Datong City 大同市[Da4 tong2 Shi4], Shanxi
高阳县|Gaoyang, a county in Baoding City 保定市[Bao3 ding4 Shi4], Hebei
一口气|one breath;in one breath;at a stretch
人口学|demography
出口气|to take one's revenge;to score off sb
出气口|gas or air outlet;emotional outlet
出水口|water outlet;drainage outlet
城口县|Chengkou, a county in Chongqing 重慶，重庆[Chong2 qing4]
海口市|Haikou, prefecture-level city and capital of Hainan Province 海南省[Hai3 nan2 Sheng3]
开口子|a dike breaks;fig. to provide facilities (for evil deeds);to open the floodgates
不安分|restless;unsettled
大分子|macromolecule (chemistry)
高分子|macromolecule;polymer
中石化|China Petroleum & Chemical Corporation (Sinopec Corp.)
石南花|heather (Ericaceae)
石城县|Shicheng, a county in Ganzhou City 贛州市，赣州市[Gan4 zhou1 Shi4], Jiangxi
石子儿|erhua form of 石子[shi2 zi3]
石门县|Shimen, a county in Changde City 常德市[Chang2 de2 Shi4], Hunan
金石学|epigraphy
电气石|tourmaline
人行区|pedestrian precinct
发行人|publisher;issuer
一会儿|a moment;a while;in a moment;now...now...
不一会|soon
国会山|Capitol Hill, Washington, D.C.
天地会|Tiandihui (Chinese fraternal organization)
学生会|student union
家长会|parent-teacher conference;parents' association
会不会|(posing a question: whether sb, something) can or cannot?;is able to or not
开小会|to whisper and chat (instead of listening during a meeting or lecture)
一点不|not at all
一点儿|erhua variant of 一點，一点[yi1 dian3]
一点点|a little bit
中心点|center;central point;focus
出发点|starting point;(fig.) basis; motive
出点子|to express an opinion;to offer advice
小不点|tiny;very small;tiny thing;small child
花点子|trickery;scam
点金石|philosopher's stone
手拉手|to join hands;hand in hand
手拉车|cart
拉山头|to start a clique;to form a faction
马拉地|Marathi language of west India
公安县|Gong'an, a county in Jingzhou City 荊州市，荆州市[Jing1 zhou1 Shi4], Hubei
公开化|to make public; to bring into the open
大公国|grand duchy
气不公|indignant
马公市|Makung city in Penghu county 澎湖縣，澎湖县[Peng2 hu2 xian4] (Pescadores Islands), Taiwan
下水道|underground drain; sewer
不人道|inhuman
不儿道|(dialect) contracted form of 不知道[bu4 zhi1 dao4]
人行道|sidewalk
地下道|underground passage; underpass
平安道|P'yong'ando Province of Joseon Korea, now divided into South Pyong'an Province 平安南道[Ping2 an1 nan2 dao4] and North Pyong'an Provin…
行人道|(dialect) sidewalk
车行道|roadway;carriageway
化州市|Huazhou, a county-level city in Maoming City 茂名市[Mao4 ming2 Shi4], Guangdong
安州区|Anzhou, a district of Mianyang City 綿陽市，绵阳市[Mian2 yang2 Shi4], Sichuan
文山州|see 文山壯族苗族自治州，文山壮族苗族自治州[Wen2 shan1 Zhuang4 zu2 Miao2 zu2 Zi4 zhi4 zhou1]
海南州|see 海南藏族自治州[Hai3 nan2 Zang4 zu2 Zi4 zhi4 zhou1]
海州区|Haizhou, a district of Lianyungang City 連雲港市，连云港市[Lian2 yun2 gang3 Shi4], Jiangsu;Haizhou, a district of Fuxin City 阜新市[Fu4 xin1 S…
海西州|see 海西蒙古族藏族自治州[Hai3 xi1 Meng3 gu3 zu2 Zang4 zu2 Zi4 zhi4 zhou1]
金州区|Jinzhou, a district of Dalian City 大連市，大连市[Da4 lian2 Shi4], Liaoning
开州区|Kaizhou, a district of Chongqing 重慶，重庆[Chong2 qing4]
高州市|Gaozhou, a county-level city in Maoming City 茂名市[Mao4 ming2 Shi4], Guangdong
分水线|watershed
地平线|horizon
大地线|a geodesic (curve)
平行线|parallel lines
文山线|Taipei Metro Wenshan Line (known as the Muzha Line 木柵線，木栅线[Mu4 zha4 xian4] prior to October 8, 2009)
光化学|photochemistry
光山县|Guangshan, a county in Xinyang City 信陽市，信阳市[Xin4 yang2 Shi4], Henan
光电子|photoelectron
中江县|Zhongjiang, a county in Deyang City 德陽市，德阳市[De2 yang2 Shi4], Sichuan
南江县|Nanjiang, a county in Bazhong City 巴中市[Ba1 zhong1 Shi4], Sichuan
平江县|Pingjiang, a county in Yueyang City 岳陽市，岳阳市[Yue4 yang2 Shi4], Hunan
江南区|Jiangnan, a district of Nanning City 南寧市，南宁市[Nan2 ning2 Shi4], Guangxi
江口县|Jiangkou, a county in Tongren City 銅仁市，铜仁市[Tong2 ren2 Shi4], Guizhou
江城区|Jiangcheng, a district of Yangjiang City 陽江市，阳江市[Yang2 jiang1 Shi4], Guangdong
江城县|see 江城哈尼族彝族自治縣，江城哈尼族彝族自治县[Jiang1 cheng2 Ha1 ni2 zu2 Yi2 zu2 Zi4 zhi4 xian4]
江安县|Jiang'an, a county in Yibin City 宜賓市，宜宾市[Yi2 bin1 Shi4], Sichuan
江山市|Jiangshan, a county-level city in Quzhou City 衢州市[Qu2 zhou1 Shi4], Zhejiang
江州区|Jiangzhou, a district of Chongzuo City 崇左市[Chong2 zuo3 Shi4], Guangxi
江海区|Jianghai, a district of Jiangmen City 江門市，江门市[Jiang1 men2 Shi4], Guangdong
江门市|Jiangmen, prefecture-level city in Guangdong Province 廣東省，广东省[Guang3 dong1 Sheng3]
江阳区|Jiangyang, a district of Luzhou City 瀘州市，泸州市[Lu2 zhou1 Shi4], Sichuan
金城江|see 金城江區，金城江区[Jin1 cheng2 jiang1 Qu1]
开江县|Kaijiang, a county in Dazhou City 達州市，达州市[Da2 zhou1 Shi4], Sichuan
阳江市|Yangjiang, prefecture-level city in Guangdong Province 廣東省，广东省[Guang3 dong1 Sheng3]
天老儿|albino (human)
老人家|polite term for old woman or man
老公公|old man;husband's father;father-in-law;court eunuch
老城区|Laocheng, a district of Luoyang City 洛陽市，洛阳市[Luo4 yang2 Shi4], Henan
老头儿|see 老頭子，老头子[lao3 tou2 zi5]
老头子|(coll.) old man;(said of an aging husband) my old man
长老会|Presbyterianism
中国风|Chinese style;chinoiserie
出风口|air vent; air outlet
出风头|to push oneself forward;to seek fame;to be in the limelight;same as 出鋒頭，出锋头[chu1 feng1 tou5]
风化区|see 紅燈區，红灯区[hong2 deng1 qu1]
马上风|death during sexual intercourse
不动点|fixed point (of a map) (math.)
动不动|(typically followed by 就[jiu4]) apt to (lose one's temper, catch a cold etc);at the drop of a hat
动力学|dynamics (math.);kinetics
天平动|(astronomy) libration
打电动|(Tw) to play video games
机动性|flexibility
机动车|motor vehicle
发动力|motive power
发动机|engine; motor
电动机|electric motor
电动车|electric vehicle (commonly refers to e-bikes, scooters or electric cars)
大新县|Daxin, a county in Chongzuo City 崇左市[Chong2 zuo3 Shi4], Guangxi
安新县|Anxin, a county in Baoding City 保定市[Bao3 ding4 Shi4], Hebei
新中国|New China (post-1949 China)
新出生|newly born
新化县|Xinhua, a county in Loudi City 婁底市，娄底市[Lou2 di3 Shi4], Hunan
新城区|Xincheng, a district of Hohhot City 呼和浩特市[Hu1 he2 hao4 te4 Shi4], Inner Mongolia;Xincheng, a district of Xi'an City 西安市[Xi1 an1 Sh…
新天地|Xintiandi (shopping, eating and entertainment district of Shanghai)
新安县|Xin'an, a county in Luoyang City 洛陽市，洛阳市[Luo4 yang2 Shi4], Henan
新市区|Xinshi District of Ürümqi, Xinjiang;Sinshih District of Tainan, Taiwan
新平县|see 新平彝族傣族自治縣，新平彝族傣族自治县[Xin1 ping2 Yi2 zu2 Dai3 zu2 Zi4 zhi4 xian4]
新会区|Xinhui, a district of Jiangmen City 江門市，江门市[Jiang1 men2 Shi4], Guangdong
新生儿|newborn baby;neonate
新金县|Xinjin county in Liaoning
开发者|developer
阳新县|Yangxin, a county in Huangshi City 黃石市，黄石市[Huang2 shi2 Shi4], Hubei
拉力器|chest expander (exercise equipment)
新石器|Neolithic
机器人|robot; android
大小眼|one eye bigger than the other
天龙人|(Tw) (slang) privileged people oblivious to the hardships of others; Taipei residents or urban dwellers who consider themselves su…
天龙国|(Tw) (slang) nickname for Taipei (implying that the residents are privileged, having access to abundant resources)
安龙县|Anlong, a county in Qianxinan Buyei and Miao Autonomous Prefecture 黔西南布依族苗族自治州[Qian2 xi1 nan2 Bu4 yi1 zu2 Miao2 zu2 Zi4 zhi4 zhou1…
小心眼|narrow-minded;petty
心眼儿|one's thoughts;mind;intention;willingness to accept new ideas
心眼大|magnanimous;considerate;thoughtful;able to think of everything that needs to be thought of
心眼小|see 小心眼[xiao3 xin1 yan3]
新龙县|Xinlong, a county in Garzê Tibetan Autonomous Prefecture 甘孜藏族自治州[Gan1 zi1 Zang4 zu2 Zi4 zhi4 zhou1], Sichuan
水龙头|faucet;tap
石龙区|Shilong, a district of Pingdingshan City 平頂山市，平顶山市[Ping2 ding3 shan1 Shi4], Henan
石龙子|skink;lizard
老花眼|presbyopia
电子眼|electronic eye; bionic eye;surveillance camera; (esp.) traffic enforcement camera
马龙区|Malong, a district of Qujing City 曲靖市[Qu3 jing4 Shi4], Yunnan
龙南市|Longnan, a county-level city in Ganzhou City 贛州市，赣州市[Gan4 zhou1 Shi4], Jiangxi
龙口市|Longkou, a county-level city in Yantai City 煙台市，烟台市[Yan1 tai2 Shi4], Shandong
龙城区|Longcheng, a district of Chaoyang City 朝陽市，朝阳市[Chao2 yang2 Shi4], Liaoning
龙安区|Long'an, a district of Anyang City 安陽市，安阳市[An1 yang2 Shi4], Henan
龙山区|Longshan, a district of Liaoyuan City 遼源市，辽源市[Liao2 yuan2 Shi4], Jilin
龙山县|Longshan, a county in Xiangxi Tujia and Miao Autonomous Prefecture 湘西土家族苗族自治州[Xiang1 xi1 Tu3 jia1 zu2 Miao2 zu2 Zi4 zhi4 zhou1], H…
龙州县|Longzhou, a county in Chongzuo City 崇左市[Chong2 zuo3 Shi4], Guangxi
龙文区|Longwen, a district of Zhangzhou City 漳州市[Zhang1 zhou1 Shi4], Fujian
龙江县|Longjiang, a county in Qiqihar City 齊齊哈爾市，齐齐哈尔市[Qi2 qi2 ha1 er3 Shi4], Heilongjiang
龙海区|Longhai, a district of Zhangzhou City 漳州市[Zhang1 zhou1 Shi4], Fujian
龙门山|Mt Longmen, the northwest boundary of the Sichuan basin, an active geological fault line;Mt Longmen in Shandong;Mt Longmen in Hena…
龙门县|Longmen, a county in Huizhou City 惠州市[Hui4 zhou1 Shi4], Guangdong
打工人|worker
打长工|to work as long-term hired hand
水电工|plumbing and electrical work;tradesman who does both plumbing and electrical work
西工区|Xigong, a district of Luoyang City 洛陽市，洛阳市[Luo4 yang2 Shi4], Henan
人工河|canal;man-made waterway
公有化|to nationalize;to take over as communal property
国有化|nationalization
城子河|see 城子河區，城子河区[Cheng2 zi5 he2 Qu1]
天河区|Tianhe, a district of Guangzhou City 廣州市，广州市[Guang3 zhou1 Shi4], Guangdong
新河县|Xinhe, a county in Xingtai City 邢臺市，邢台市[Xing2 tai2 Shi4], Hebei
有一手|to have a skill;to have a lot on the ball;to have an affair
有一点|a little; somewhat
有心人|resolute person;person with aspirations;people who feel;people who use their heads
有心眼|to have good sense; to be quick-witted; to be shrewd
有机体|organism
有眼光|to have good taste
有点儿|slightly;a little;somewhat
河南县|see 河南蒙古族自治縣，河南蒙古族自治县[He2 nan2 Meng2 gu3 zu2 Zi4 zhi4 xian4]
河口区|Hekou, a district of Dongying City 東營市，东营市[Dong1 ying2 Shi4], Shandong
河口县|see 河口瑤族自治縣，河口瑶族自治县[He2 kou3 Yao2 zu2 Zi4 zhi4 xian4]
河西区|Hexi district of Tianjin municipality 天津市[Tian1 jin1 shi4]
白河县|Baihe, a county in Ankang City 安康市[An1 kang1 Shi4], Shaanxi
石河子|Shihezi, sub-prefecture-level city in Northern Xinjiang
老河口|see 老河口市[Lao3 he2 kou3 Shi4]
金口河|see 金口河區，金口河区[Jin1 kou3 he2 Qu1]
体重器|scale for measuring body weight; bathroom scale
不合法|illegal
合山市|Heshan, a county-level city in Laibin City 來賓市，来宾市[Lai2 bin1 Shi4], Guangxi
合气道|aikido (Japanese martial art);hapkido (Korean martial art)
合水县|Heshui, a county in Qingyang City 慶陽市，庆阳市[Qing4 yang2 Shi4], Gansu
合江县|Hejiang, a county in Luzhou City 瀘州市，泸州市[Lu2 zhou1 Shi4], Sichuan
合法化|to legalize;to make legal;legalization
合法性|legitimacy
合阳县|Heyang, a county in Weinan City 渭南市[Wei4 nan2 Shi4], Shaanxi
外国人|foreigner
外地人|stranger;outsider
道外区|Daowai, a district of Harbin City 哈爾濱市，哈尔滨市[Ha1 er3 bin1 Shi4], Heilongjiang
不一定|not necessarily;maybe
安定化|stabilization
安定区|Anding, a district of Dingxi City 定西市[Ding4 xi1 Shi4], Gansu
安定器|(Tw) electrical ballast
安定门|Andingmen neighborhood of Beijing
定南县|Dingnan, a county in Ganzhou City 贛州市，赣州市[Gan4 zhou1 Shi4], Jiangxi
定安县|Ding'an county, Hainan
定州市|Dingzhou, county-level city directly administered by Hebei Province
定海区|Dinghai, a district of Zhoushan City 舟山市[Zhou1 shan1 Shi4], Zhejiang
定西市|Dingxi, prefecture-level city in Gansu Province 甘肅省，甘肃省[Gan1 su4 Sheng3]
平定县|Pingding, a county in Yangquan City 陽泉市，阳泉市[Yang2 quan2 Shi4], Shanxi
不道德|immoral
公德心|civility; public spirit
化德县|Huade, a county in Ulanqab City 烏蘭察布市，乌兰察布市[Wu1 lan2 cha2 bu4 Shi4], Inner Mongolia
安德海|An Dehai (-1869), the Qing equivalent of Rasputin, all-powerful court eunuch with the dowager empress Cixi 慈禧太后[Ci2 xi3 tai4 hou4]…
德化县|Dehua, a county in Quanzhou City 泉州市[Quan2 zhou1 Shi4], Fujian
德国人|German person or people
德城区|Decheng, a district of Dezhou City 德州市[De2 zhou1 Shi4], Shandong
德安县|De'an, a county in Jiujiang City 九江市[Jiu3 jiang1 Shi4], Jiangxi
德州市|Dezhou, prefecture-level city in Shandong Province 山東省，山东省[Shan1 dong1 Sheng3]
德拉门|Drammen (city in Buskerud, Norway)
德江县|Dejiang, a county in Tongren City 銅仁市，铜仁市[Tong2 ren2 Shi4], Guizhou
德阳市|Deyang, prefecture-level city in Sichuan Province 四川省[Si4 chuan1 Sheng3]
有德行|virtuous
道德家|Daoist
中子数|neutron number
人口数|population
分数线|horizontal line (in a fraction);minimum passing score
小数点|decimal point
打分数|to grade (a student's work); to rate (sb's performance); to give a score
数不上|not to deserve to be mentioned; not to qualify; below par
数学家|mathematician
定日县|Tingri, a county in Shigatse City 日喀則市，日喀则市[Ri4 ka1 ze2 Shi4], Tibet
小日子|simple life;(Internet slang) euphemistic substitute for 日本[Ri4 ben3] or 日本人[Ri4 ben3 ren2]
海水鱼|saltwater fish
自动化|to automate
自动车|automobile
自家人|sb with whom one is on familiar terms;sb from the same place (same house, same town etc);one of us
自行车|bicycle; bike
台山市|Taishan, a county-level city in Jiangmen City 江門市，江门市[Jiang1 men2 Shi4], Guangdong
台州市|Taizhou, prefecture-level city in Zhejiang Province 浙江省[Zhe4 jiang1 Sheng3]
台东市|Taitung city in southeast Taiwan, capital of Taitung county
台东县|Taitung County in southeast Taiwan
台江区|Taijiang, a district of Fuzhou City 福州市[Fu2 zhou1 Shi4], Fujian
台江县|Taijiang, a county in Qiandongnan Miao and Dong Autonomous Prefecture 黔東南苗族侗族自治州，黔东南苗族侗族自治州[Qian2 dong1 nan2 Miao2 zu2 Dong4 zu2 Z…
城东区|Chengdong, a district of Xining City 西寧市，西宁市[Xi1 ning2 Shi4], Qinghai
大东区|Dadong, a district of Shenyang City 瀋陽市，沈阳市[Shen3 yang2 Shi4], Liaoning
天台山|Mt Tiantai near Shaoxing 紹興，绍兴[Shao4 xing1] in Zhejiang, the center of Tiantai Buddhism 天台宗[Tian1 tai2 zong1]
天台县|Tiantai, a county in Taizhou City 台州市[Tai1 zhou1 Shi4], Zhejiang
天文台|astronomical observatory
手工台|workbench
会东县|Huidong, a county in Liangshan Yi Autonomous Prefecture 涼山彝族自治州，凉山彝族自治州[Liang2 shan1 Yi2 zu2 Zi4 zhi4 zhou1], Sichuan
东光县|Dongguang, a county in Cangzhou City 滄州市，沧州市[Cang1 zhou1 Shi4], Hebei
东台市|Dongtai, a county-level city in Yancheng City 鹽城市，盐城市[Yan2 cheng2 Shi4], Jiangsu
东城区|Dongcheng, a district of central Beijing
东安区|Dong'an, a district of Mudanjiang City 牡丹江市[Mu3 dan1 jiang1 Shi4], Heilongjiang
东安县|Dong'an, a county in Yongzhou City 永州市[Yong3 zhou1 Shi4], Hunan
东山区|Dongshan, a district of Hegang City 鶴崗市，鹤岗市[He4 gang3 Shi4], Heilongjiang
东山县|Dongshan, a county in Zhangzhou City 漳州市[Zhang1 zhou1 Shi4], Fujian
东平县|Dongping, a county in Tai'an City 泰安市[Tai4 an1 Shi4], Shandong
东河区|Donghe, a district of Baotou City 包頭市，包头市[Bao1 tou2 Shi4], Inner Mongolia
东海县|Donghai, a county in Lianyungang City 連雲港市，连云港市[Lian2 yun2 gang3 Shi4], Jiangsu
东西德|East and West Germany;refers to the German Democratic Republic (East Germany) and the Federal Republic of Germany (West Germany)
东道国|host country; host state
东阳市|Dongyang, a county-level city in Jinhua City 金華市，金华市[Jin1 hua2 Shi4], Zhejiang
东风区|Dongfeng, a district of Jiamusi City 佳木斯市[Jia1 mu4 si1 Shi4], Heilongjiang
台安县|Tai'an, a county in Anshan City 鞍山市[An1 shan1 Shi4], Liaoning
河东区|Hedong district of Tianjin municipality 天津市[Tian1 jin1 shi4];Hedong district of Linyi city 臨沂市，临沂市[Lin2 yi2 shi4], Shandong
海东市|Haidong, prefecture-level city in Qinghai Province 青海省[Qing1 hai3 Sheng3]
石台县|Shitai, a county in Chizhou City 池州市[Chi2 zhou1 Shi4], Anhui
老东西|(derog.) old fool;old bastard
台中市|Taichung, a city in central Taiwan
台南市|Tainan city in Tainan county 臺南縣，台南县[Tai2 nan2 xian4], Taiwan
金东区|Jindong, a district of Jinhua City 金華市，金华市[Jin1 hua2 Shi4], Zhejiang
金台区|Jintai, a district of Baoji City 寶雞市，宝鸡市[Bao3 ji1 Shi4], Shaanxi
阳东区|Yangdong, a district of Yangjiang City 陽江市，阳江市[Yang2 jiang1 Shi4], Guangdong
台风眼|the eye of a typhoon
高台县|Gaotai, a county in Zhangye City 張掖市，张掖市[Zhang1 ye4 Shi4], Gansu
鱼台县|Yutai, a county in Jining City 濟寧市，济宁市[Ji3 ning2 Shi4], Shandong
中心语|qualified word
口头语|pet phrase;regularly used expression;manner of speaking
外国语|foreign language
打手语|to use sign language
语数外|Chinese, math & English (school subjects)
中国红|vermilion
安道尔|Andorra
拉合尔|Lahore (city in Pakistan)
海拉尔|see 海拉爾區，海拉尔区[Hai3 la1 er3 Qu1]
红外线|infrared ray
红安县|Hong'an, a county in Huanggang City 黃岡市，黄冈市[Huang2 gang1 Shi4], Hubei
红山区|Hongshan, a district of Chifeng City 赤峰市[Chi4 feng1 Shi4], Inner Mongolia
红河州|see 紅河哈尼族彝族自治州，红河哈尼族彝族自治州[Hong2 he2 Ha1 ni2 zu2 Yi2 zu2 Zi4 zhi4 zhou1]
红河县|Honghe, a county in Honghe Hani and Yi Autonomous Prefecture 紅河哈尼族彝族自治州，红河哈尼族彝族自治州[Hong2 he2 Ha1 ni2 zu2 Yi2 zu2 Zi4 zhi4 zhou1], …
金红石|(mineralogy) rutile
开尔文|Lord Kelvin 1824-1907, British physicist (William Thomson);Kelvin (temperature scale)
开门红|a good beginning
儿化音|(Chinese phonetics) erhua (the sound of the r-coloring of a syllable final)
有气音|aspirated consonant (in phonetics)
发音体|sound producing object (soundboard, vibrating string, membrane etc)
语音学|phonetics
打火机|lighter;cigarette lighter
打火石|flint
火山口|volcanic crater
火山学|volcanology
火车头|train engine;locomotive
电火花|electric spark
三人行|(slang) threesome
三分头|regular men's haircut;short back and sides
三台县|Santai, a county in Mianyang City 綿陽市，绵阳市[Mian2 yang2 Shi4], Sichuan
三合一|three in one;triple
三合会|triad, Chinese crime gang;triad society, anti-Manchu secret society in Qing-dynasty China
三文鱼|salmon (loanword)
三水区|Sanshui, a district of Foshan City 佛山市[Fo2 shan1 Shi4], Guangdong
三江县|see 三江侗族自治縣，三江侗族自治县[San1 jiang1 Dong4 zu2 Zi4 zhi4 xian4]
三河市|Sanhe, a county-level city in Langfang City 廊坊市[Lang2 fang2 Shi4], Hebei
三门县|Sanmen, a county in Taizhou City 台州市[Tai1 zhou1 Shi4], Zhejiang
三点水|name of "water" radical 氵[shui3] in Chinese characters (Kangxi radical 85)
马三家|Masanjia town in Yuhong District 于洪區，于洪区[Yu2 hong2 Qu1] in Liaoning, known for its re-education through labor camp
大流行|major epidemic;pandemic
小人书|children's picture story book
小红书|REDnote (Chinese social networking platform);(historical) Little Red Book, nickname for 毛主席語錄，毛主席语录[Mao2 zhu3 xi2 Yu3 lu4]
书法家|calligrapher
书面语|written language
流动性|flowing; shifting;fluidity; mobility;liquidity (of funds)
流口水|to drool; to salivate;(fig.) to covet; to lust after
流水线|assembly line;(computing) pipeline
流行性|qualities that make sth popular or fashionable;(of a disease) epidemic
流行语|popular jargon;catchword
自白书|confession
电子书|electronic book;e-book;e-book reader
利州区|Lizhou, a district of Guangyuan City 廣元市，广元市[Guang3 yuan2 Shi4], Sichuan
动物学|zoological;zoology
动物性|animacy
化合物|chemical compound
化学物|chemicals
大利拉|(Protestantism) Delilah
小人物|nonentity;a nobody
平利县|Pingli, a county in Ankang City 安康市[An1 kang1 Shi4], Shaanxi
有机物|organic substance;organic matter
水利家|water manager;hydraulic engineer
水合物|hydrate;hydrated compound
法拉利|Ferrari, Italian luxury sports car manufacturer
生物学|biology
生物性|biological
生物体|organism
三手病|repetitive strain injury (resulting from frequent use of one's thumb, wrist etc)
新城病|Newcastle disease
流行病|epidemic disease
白化病|albinism
红眼病|pinkeye;envy;jealousy
高山病|altitude sickness;acute mountain sickness
一大通|(coll.) a whole lot of ...; an endless stream of ... (used in relation to excessive or tedious amounts of talk, explanations, comp…
中国通|China watcher;an expert on China;an old China hand
利通区|Litong, a district of Wuzhong City 吳忠市，吴忠市[Wu2 zhong1 Shi4], Ningxia
南通市|Nantong, prefecture-level city in Jiangsu Province 江蘇省，江苏省[Jiang1 su1 Sheng3]
大通区|Datong, a district of Huainan City 淮南市[Huai2 nan2 Shi4], Anhui
大通县|see 大通回族土族自治縣，大通回族土族自治县[Da4 tong1 Hui2 zu2 Tu3 zu2 Zi4 zhi4 xian4]
大黄鱼|Croceine croaker (Pseudosciaena crocea), a fish popular in Cantonese cooking
小黄车|yellow bicycle (nickname for bicycles provided by the Ofo bike-sharing company, active 2014–2020)
打不通|cannot get through (on phone)
红通通|variant of 紅彤彤，红彤彤[hong2 tong1 tong1]
行不通|won't work;will get (you) nowhere
通化市|Tonghua, prefecture-level city in Jilin Province 吉林省[Ji2 lin2 Sheng3]
通化县|Tonghua, a county in Tonghua City 通化市[Tong1 hua4 Shi4], Jilin
通城县|Tongcheng, a county in Xianning City 咸寧市，咸宁市[Xian2 ning2 Shi4], Hubei
通山县|Tongshan, a county in Xianning City 咸寧市，咸宁市[Xian2 ning2 Shi4], Hubei
通州区|Tongzhou, a district of Beijing;Tongzhou, a district of Nantong City 南通市[Nan2 tong1 Shi4], Jiangsu
通心面|macaroni
通气会|briefing
通江县|Tongjiang, a county in Bazhong City 巴中市[Ba1 zhong1 Shi4], Sichuan
通河县|Tonghe, a county in Harbin City 哈爾濱市，哈尔滨市[Ha1 er3 bin1 Shi4], Heilongjiang
通海县|Tonghai, a county in Yuxi City 玉溪市[Yu4 xi1 Shi4], Yunnan
通道县|see 通道侗族自治縣，通道侗族自治县[Tong1 dao4 Dong4 zu2 Zi4 zhi4 xian4]
通风口|air vent;opening for ventilation
黄南州|see 黃南藏族自治州，黄南藏族自治州[Huang2 nan2 Zang4 zu2 Zi4 zhi4 zhou1]
黄山区|Huangshan, a district of Huangshan City 黃山市，黄山市[Huang2 shan1 Shi4], Anhui
黄山市|Huangshan, prefecture-level city in Anhui Province 安徽省[An1 hui1 Sheng3]
黄州区|Huangzhou, a district of Huanggang City 黃岡市，黄冈市[Huang2 gang1 Shi4], Hubei
黄平县|Huangping, a county in Qiandongnan Miao and Dong Autonomous Prefecture 黔東南苗族侗族自治州，黔东南苗族侗族自治州[Qian2 dong1 nan2 Miao2 zu2 Dong4 zu2 …
黄海道|former Hwanghae Province of northwest Korea, divided into North and South Hwanghae Province of North Korea in 1954
黄石公|Huang Shigong, also known as Xia Huanggong 夏黃公，夏黄公[Xia4 Huang2 gong1] (dates of birth and death uncertain), Daoist hermit of the Q…
黄石市|Huangshi, prefecture-level city in Hubei Province 湖北省[Hu2 bei3 Sheng3]
黄花鱼|yellow croaker (fish);corvina
黄鱼车|croaker car;flatbed tricycle;delivery tricycle
黄龙病|huanglongbing, citrus greening disease
黄龙县|Huanglong, a county in Yan'an City 延安市[Yan2 an1 Shi4], Shaanxi
白色体|leucoplast
老三色|the three plain colors used for clothing in the PRC in the 1960s: black, gray and blue
金黄色|gold color
一年生|(botany) (of a plant) annual
中老年|middle and old age
主人公|hero (of a novel or film); main protagonist
主日学|Sunday School
公主病|(neologism c. 1997) (coll.) self-entitlement
公主车|ladies bicycle
大地主|a large landowner
小公主|little princess;fig. spoiled girl;female version of 小皇帝[xiao3 huang2 di4]
山道年|santonin (loanword)
年头儿|erhua variant of 年頭，年头[nian2 tou2]
有年头|for donkey's years;for ages
东道主|host;official host (e.g. venue for games or a conference)
老年人|old people; the elderly
小日本|(derog.) Japanese person;Jap
山本头|(Tw) "Yamamoto haircut", similar to a butch cut, but with even length (no tapering on the sides and back), said to be named after …
巴中市|Bazhong, prefecture-level city in Sichuan Province 四川省[Si4 chuan1 Sheng3]
巴利文|Pali, language of Theravad Pali canon
巴力门|parliament (loanword) (old)
巴南区|Banan, a district of Chongqing 重慶，重庆[Chong2 qing4]
巴州区|Bazhou, a district of Bazhong City 巴中市[Ba1 zhong1 Shi4], Sichuan
巴巴拉|Barbara (name)
巴德尔|Baldr or Baldur, god in Norse mythology;Andreas Baader (1943-1977), leader of Red Army Faction, a.k.a. the Baader-Meinhof group
巴东县|Badong, a county in Enshi Tujia and Miao Autonomous Prefecture 恩施土家族苗族自治州[En1 shi1 Tu3 jia1 zu2 Miao2 zu2 Zi4 zhi4 zhou1], Hubei
巴马县|see 巴馬瑤族自治縣，巴马瑶族自治县[Ba1 ma3 Yao2 zu2 Zi4 zhi4 xian4]
日本人|Japanese person
日本学|Japanology
日本海|Sea of Japan
有本事|to have what it takes;(coll.) (often followed by 就[jiu4]) (used to challenge sb) if you're so clever, ..., if she's so tough, ... …
本国人|natives of one's own country
本地人|native person (of a country)
本地化|localization;adaptation (to foreign environment)
眼巴巴|waiting anxiously;impatient
台巴子|(derog.) Taiwanese; person from Taiwan
一字儿|erhua form of 一字[yi1 zi4]
一字马|the splits (in gymnastics, dance or martial arts)
一年多|more than a year
合体字|a Chinese character formed by combining existing elements - i.e. a combined ideogram 會意，会意 or radical plus phonetic 形聲，形声
多多马|Dodoma, capital of Tanzania
多工化|to multiplex
多工器|multiplexer
多平台|multi-platform (computing)
多年生|(botany) (of a plant) perennial
多水分|juicy
多发病|frequently reoccurring disease
多重性|multiplicity
多面手|multitalented person; versatile person; all-rounder
多面体|polyhedron
多音字|character with two or more readings
大多数|(great) majority
安多县|Amdo, a county in Nagqu City 那曲市[Na4 qu3 Shi4], Tibet
心眼多|to have unfounded doubts;overconcerned
打字机|typewriter
数字化|to digitize
文字学|philology
新字体|shinjitai, simplified Japanese character used since 1946
无人不|no man is not...
无人区|uninhabited region
无人机|drone; unmanned aerial vehicle
无机物|inorganic compound
无线电|radio; wireless (i.e. the technology used in radio telecommunication);a radio
头文字|initial;first letter of word (in Latin script)
点字机|braille typewriter
三分球|(basketball) three-point shot
三明市|Sanming, prefecture-level city in Fujian Province 福建省[Fu2 jian4 Sheng3]
光明区|Guangming, a district of Shenzhen City 深圳市[Shen1 zhen4 Shi4], Guangdong
南明区|Nanming, a district of Guiyang City 貴陽市，贵阳市[Gui4 yang2 Shi4], Guizhou
文明化|civilize
文明病|lifestyle diseases
明光市|Mingguang, a county-level city in Chuzhou City 滁州市[Chu2 zhou1 Shi4], Anhui
明山区|Mingshan, a district of Benxi City 本溪市[Ben3 xi1 Shi4], Liaoning
明水县|Mingshui, a county in Suihua City 綏化市，绥化市[Sui2 hua4 Shi4], Heilongjiang
明眼人|perspicacious person;sb with a discerning eye;sighted person (as opposed to blind)
东明县|Dongming, a county in Heze City 菏澤市，菏泽市[He2 ze2 Shi4], Shandong
发明人|inventor
发明家|inventor
发明者|inventor
发球区|teeing ground (golf)
阳明区|Yangming, a district of Mudanjiang City 牡丹江市[Mu3 dan1 jiang1 Shi4], Heilongjiang
阳明山|Mt Yangming in Hunan;Mt Yangming in north Taiwan, near Taibei
高明区|Gaoming, a district of Foshan City 佛山市[Fo2 shan1 Shi4], Guangdong
不名数|abstract number
主机名|hostname (of a networked computer)
名山区|Mingshan, a district of Ya'an City 雅安市[Ya3 an1 Shi4], Sichuan
大名县|Daming, a county in Handan City 邯鄲市，邯郸市[Han2 dan1 Shi4], Hebei
小清新|hipster
德清县|Deqing, a county in Huzhou City 湖州市[Hu2 zhou1 Shi4], Zhejiang
数不清|countless; innumerable
清一色|(mahjong) flush; a complete hand where all tiles are of the same suit;(fig.) uniformly; each and every one
清城区|Qingcheng, a district of Qingyuan City 清遠市，清远市[Qing1 yuan3 Shi4], Guangdong
清州市|Cheongju, capital of North Chungcheong Province, South Korea 忠清北道[Zhong1 qing1 bei3 dao4]
清新区|Qingxin, a district of Qingyuan City 清遠市，清远市[Qing1 yuan3 Shi4], Guangdong
清水河|see 清水河縣，清水河县[Qing1 shui3 he2 Xian4]
清水县|Qingshui, a county in Tianshui City 天水市[Tian1 shui3 Shi4], Gansu
清河区|Qinghe, a district of Tieling City 鐵嶺市，铁岭市[Tie3 ling3 Shi4], Liaoning
清河县|Qinghe, a county in Xingtai City 邢臺市，邢台市[Xing2 tai2 Shi4], Hebei
清河门|see 清河門區，清河门区[Qing1 he2 men2 Qu1]
清流县|Qingliu, a county in Sanming City 三明市[San1 ming2 Shi4], Fujian
长清区|Changqing, a district of Jinan City 濟南市，济南市[Ji3 nan2 Shi4], Shandong
不成文|unwritten (rule)
合成器|synthesizer (musical instrument)
合成数|composite number (i.e. not prime, has a factorization)
合成法|(chemical) synthesis
合成物|compound;composite;cocktail
成安县|Cheng'an, a county in Handan City 邯鄲市，邯郸市[Han2 dan1 Shi4], Hebei
成年人|adult person
成年者|adult
成文法|statute
文成县|Wencheng, a county in Wenzhou City 溫州市，温州市[Wen1 zhou1 Shi4], Zhejiang
金日成|Kim Il Sung (1912-1994) Great Leader of North Korea
公事包|(Tw) briefcase
公文包|briefcase;attaché case
包工头|chief labor contractor
包河区|Baohe, a district of Hefei City 合肥市[He2 fei2 Shi4], Anhui
包头市|Baotou, prefecture-level city in Inner Mongolia Autonomous Region 內蒙古自治區，内蒙古自治区[Nei4 meng3 gu3 Zi4 zhi4 qu1]
小面包|bread roll;bun
拉包尔|Rabaul, port city and capital of New Britain, island of northeast Papua New Guinea
气包子|quick-tempered person
病包儿|a person who is always falling ill;chronic invalid
面包心|crumb (soft interior of a loaf of bread)
面包机|bread making machine; bread maker
面包车|van for carrying people;taxi minibus
黄包车|rickshaw
一方面|on the one hand
一路上|along the way;the whole way;(fig.) the whole time
中方县|Zhongfang, a county in Huaihua City 懷化市，怀化市[Huai2 hua4 Shi4], Hunan
公有制|public ownership
公路车|racing bicycle (abbr. for 公路自行車，公路自行车[gong1 lu4 zi4 xing2 che1])
分头路|part (in one's hair)
制动器|brake
制高点|(military) high ground;vantage point (providing a good view); commanding position (providing strategic advantage)
地方性|local
多方面|many-sided;in many aspects
大方县|Dafang, a county in Bijie City 畢節市，毕节市[Bi4 jie2 Shi4], Guizhou
学分制|credit system;grading system (in schools, universities etc)
家长制|patriarchal system
成方儿|erhua form of 成方[cheng2 fang1]
方城县|Fangcheng, a county in Nanyang City 南陽市，南阳市[Nan2 yang2 Shi4], Henan
方山县|Fangshan, a county in Lüliang City 呂梁市，吕梁市[Lu : 3 liang2 Shi4], Shanxi
方文山|Vincent Fang (1969-), Taiwanese multi-Golden Melody Award lyricist
方法学|methodology
东方市|Dongfang City, Hainan
东方红|The East is Red, north Shaanxi folk song
东西方|east and west;east to west
老地方|same place as before;usual place;stomping ground
自制力|self-control
西方人|Westerner;Occidental
路南区|Lunan, a district of Tangshan City 唐山市[Tang2 shan1 Shi4], Hebei
路德会|Lutheran church
路西法|Lucifer (Satan's name before his fall in Jewish and Christian mythology)
长方体|cuboid
马路口|intersection (of roads)
大后天|three days from now
大后年|three years from now;year after year after next year
后天性|acquired (characteristic etc)
开后门|to open the back door;fig. under the counter;to do a secret or dishonest deal;to let sth in by the back door
三角学|trigonometry
三角法|trigonometry (math.)
三角龙|triceratops
分角器|a protractor (device to divide angles)
分角线|(Tw) angle bisector
名角儿|erhua variant of 名角[ming2 jue2]
外眼角|outer corner of the eye
多角体|polyhedron
多面角|solid angle
大眼角|inner corner of the eye
小眼角|outer corner of the eye
平面角|plane angle
拉巴特|Rabat, capital of Morocco
特发性|idiopathic
角化病|(medicine) keratosis
金三角|Golden Triangle (Southeast Asia)
长三角|Yangtze River Delta (abbr. for 長江三角洲，长江三角洲[Chang2 jiang1 San1 jiao3 zhou1])
克山县|Keshan, a county in Qiqihar City 齊齊哈爾市，齐齐哈尔市[Qi2 qi2 ha1 er3 Shi4], Heilongjiang
克拉克|(name) Clark or Clarke
克拉通|craton (loanword)
克东县|Kedong, a county in Qiqihar City 齊齊哈爾市，齐齐哈尔市[Qi2 qi2 ha1 er3 Shi4], Heilongjiang
克尔白|Ka'aba, sacred building in Mecca
台克球|(loanword) teqball
巴拉克|Barack, Barak, Ballack (name)
马克龙|Emmanuel Macron (1977-), president of France from 2017
不合理|unreasonable
主理人|(coll.) person in charge, manager (originally, chiefly in Hong Kong, Macau); (esp.) creative director or founder of a boutique bra…
公理法|the axiomatic method
合理化|to rationalize;to make compatible;to streamline;rationalization
合理性|reason;rationality;rationale;reasonableness
地理学|geography
大理州|see 大理白族自治州[Da4 li3 Bai2 zu2 Zi4 zhi4 zhou1]
大理市|Dali, a county-level city in Dali Bai Autonomous Prefecture 大理白族自治州[Da4 li3 Bai2 zu2 Zi4 zhi4 zhou1], Yunnan
大理石|marble
大理花|dahlia (loanword)
大道理|major principle;general truth;sermon (reproof);bombastic talk
安理会|(United Nations) Security Council
心理学|psychology
数理化|mathematics, physics and chemistry (abbr. for 數學，数学[shu4 xue2] + 物理[wu4 li3] + 化學，化学[hua4 xue2])
会理市|Huili, a county-level city in Liangshan Yi Autonomous Prefecture 涼山彝族自治州，凉山彝族自治州[Liang2 shan1 Yi2 zu2 Zi4 zhi4 zhou1], Sichuan
有理数|rational number (i.e. fraction of two integers, math.)
有道理|to make sense; reasonable
流理台|kitchen counter (generally including sink, food preparation area and gas range) (Tw)
无理数|irrational number
物理学|physics
理事会|council
理事长|director general
理学家|scholar of the rationalist school of Neo-Confucianism 理學，理学[Li3 xue2]
理发器|hair clippers
生理学|physiology
生理性|physiological
病理学|pathology
一头热|one-sided enthusiasm (abbr. for 剃頭挑子一頭熱，剃头挑子一头热[ti4 tou2 tiao1 zi5 yi1 tou2 re4])
三克油|thank you (humorous phonetic rendering of the English phrase)
中海油|China National Offshore Oil Corporation
动物油|animal fat
化油器|carburetor
大热天|scorcher; very hot day
安地斯|the Andes mountains
巴克斯|Bacchus, Greek god of wine
巴斯克|Basque;the Basque Country
巴斯德|Louis Pasteur (1822-1895), French chemist and microbiologist
拉巴斯|La Paz, administrative capital of Bolivia
文化热|cultural fever;cultural craze
明斯克|Minsk, capital of Belarus
江油市|Jiangyou, a county-level city in Mianyang City 綿陽市，绵阳市[Mian2 yang2 Shi4], Sichuan
油光光|glossy;gleaming;shiny (due to greasiness);slick
法西斯|fascist (loanword)
热中子|thermal neutron
热力学|thermodynamics
热气球|hot air balloon
热水器|water heater
特克斯|see 特克斯縣，特克斯县[Te4 ke4 si1 Xian4]
特斯拉|Nikola Tesla (1856–1943), Serbian inventor and engineer;Tesla, an American electric vehicle and clean energy company
白热化|to turn white-hot;to intensify;to reach a climax
老油子|(coll.) wily old fox;crafty fellow
色拉油|salad oil
马斯克|Elon Musk (1971–), entrepreneur, CEO of Tesla and SpaceX
马斯河|Maas or Meuse River, Western Europe
马尔斯|Mars (Roman God of War)
高热病|fever;high fever
黄热病|yellow fever
包书皮|book cover
南皮县|Nanpi, a county in Cangzhou City 滄州市，沧州市[Cang1 zhou1 Shi4], Hebei
书皮儿|erhua variant of 書皮，书皮[shu1 pi2]
白皮书|white paper (e.g. containing proposals for new legislation);white book
皮克斯|Pixar Animation Studios
皮山县|Pishan, a county in Hotan City 和田市[He2 tian2 Shi4], Xinjiang
眼皮子|eyelid
重眼皮|double eyelid;epicanthal fold of upper eyelid (characteristic of Asian people)
面包皮|crust
三合星|(astronomy) triple star system
中子星|neutron star
外星人|space alien; extraterrestrial
大角星|Arcturus (brightest star in the constellation Boötes 牧夫座[Mu4 fu1 zuo4])
小行星|asteroid;minor planet
星巴克|Starbucks, US coffee shop chain
流星体|meteoroid
火星人|Martian
火星子|(coll.) spark; ember
火星文|Martian language;fig. Internet slang used to communicate secret messages that the general public or government can't understand
火流星|(astronomy) bolide;fireball
单方面|unilateral
单眼皮|single eyelid
单行本|single volume edition;offprint
单行线|one-way road
单行道|one-way street
大力神|Heracles (Greek mythology);Hercules (Roman mythology)
白名单|whitelist
神学家|theologian
红名单|whitelist
大美人|gorgeous-looking woman
美中台|US-China-Taiwan
美人鱼|mermaid
美国人|American;American person;American people
三不管|of undetermined status;unregulated
下水管|drainpipe
水管工|plumber
水管面|tube pasta (e.g. penne, rigatoni, ziti);macaroni
管城区|Guangcheng Hui District of Zhengzhou City 鄭州市，郑州市[Zheng4 zhou1 Shi4], Henan
管子工|plumber;pipe-fitter
管理人|supervisor; manager; administrator
管理学|management studies
通风管|ventilation duct
电子管|valve (electronics);vacuum tube
中正区|Zhongzheng District of Taipei 台北市[Tai2 bei3 Shi4] or Keelung 基隆市[Ji1 long2 Shi4]
方正县|Fangzheng, a county in Harbin City 哈爾濱市，哈尔滨市[Ha1 er3 bin1 Shi4], Heilongjiang
正字法|orthography
正字通|Zhengzitong, Chinese character dictionary with 33,549 entries, edited by Ming scholar Zhang Zilie 張自烈，张自烈[Zhang1 Zi4 lie4] in 17th…
正安县|Zheng'an, a county in Zunyi City 遵義市，遵义市[Zun1 yi4 Shi4], Guizhou
正定县|Zhengding, a county in Shijiazhuang City 石家莊市，石家庄市[Shi2 jia1 zhuang1 Shi4], Hebei
正方体|a rectangular parallelepiped
正长石|orthoclase KAlSi3O8 (rock-forming mineral, type of feldspar)
正阳县|Zhengyang, a county in Zhumadian City 駐馬店市，驻马店市[Zhu4 ma3 dian4 Shi4], Henan
正电子|positron (antiparticle of the electron)
正体字|standard form of a Chinese character;(Tw) traditional (i.e. unsimplified) characters
重正化|to renormalize;renormalization
金正日|Kim Jong-il (1942-2011), Dear Leader of North Korea 1982-2011
上林县|Shanglin, a county in Nanning City 南寧市，南宁市[Nan2 ning2 Shi4], Guangxi
人工林|planted forest
克林德|Clemens von Ketteler (1853–1900), German diplomat killed during the Boxer Rebellion 義和團運動，义和团运动[Yi4 he2 tuan2 Yun4 dong4]
斯大林|Joseph Stalin (1879-1953), Soviet dictator
新林区|Xinlin, a district of Daxing'anling Prefecture 大興安嶺地區，大兴安岭地区[Da4 xing1 an1 ling3 Di4 qu1], Heilongjiang
林口县|Linkou, a county in Mudanjiang City 牡丹江市[Mu3 dan1 jiang1 Shi4], Heilongjiang
林州市|Linzhou, a county-level city in Anyang City 安陽市，安阳市[An1 yang2 Shi4], Henan
林西县|Linxi, a county in Chifeng City 赤峰市[Chi4 feng1 Shi4], Inner Mongolia
海林市|Hailin, a county-level city in Mudanjiang City 牡丹江市[Mu3 dan1 jiang1 Shi4], Heilongjiang
皮克林|Pickering (name)
石林县|see 石林彝族自治縣，石林彝族自治县[Shi2 lin2 Yi2 zu2 Zi4 zhi4 xian4]
西林县|Xilin, a county in Baise City 百色市[Bai3 se4 Shi4], Guangxi
金林区|Jinlin, a district of Yichun City 伊春市[Yi1 chun1 Shi4], Heilongjiang
马林巴|(loanword) marimba
三相点|triple point (thermodynamics)
人相学|physiognomy (judgment of a person's fate, character etc, based on facial features)
星相学|astrology
星相家|astrologer
白相人|(dialect) rogue;hoodlum
相城区|Xiangcheng, a district of Suzhou City 蘇州市，苏州市[Su1 zhou1 Shi4], Jiangsu
相山区|Xiangshan, a district of Huaibei City 淮北市[Huai2 bei3 Shi4], Anhui
相平面|phase plane (math., ordinary differential equations)
车头相|photo attached to the front of a hearse in a funeral procession
一转眼|in the blink of an eye
三得利|Suntory, Japanese beverage company
不得不|have no choice or option but to;cannot but;have to;can't help it
南木林|see 南木林縣，南木林县[Nan2 mu4 lin2 Xian4]
我|I;me;my
你|you
他|he;him
她|she;her
它|it
人|person;people;human
家|home;family;house
路|road;path;way
桥|bridge
河|river
江|river (big);the Yangtze
湖|lake
海|sea;ocean
山|mountain;hill
风|wind
云|cloud
雨|rain
雪|snow
雷|thunder
火|fire
水|water
树|tree
花|flower
草|grass
根|root
龙|dragon
鸟|bird
鱼|fish
蛇|snake
狼|wolf
马|horse
牛|ox;cow
羊|sheep;goat
狗|dog
猫|cat
鸡|chicken
猪|pig
话|word;speech
想|think;want;miss
爱|love
恨|hate
讲|speak;tell
说|say;speak
问|ask
看|look;see;watch
望|gaze;look far
瞧|look
走|walk;go;leave
跑|run
跳|jump
站|stand
坐|sit
躺|lie down
爬|climb;crawl
飞|fly
游|swim
来|come
去|go
到|arrive;reach;go to
回|return;go back
进|enter
出|go out;come out
上|go up;on;up
下|go down;under;down
开|open;drive;start
关|close;shut;turn off
打|hit;beat;fight;call
杀|kill
死|die;death
活|live;alive
生|birth;raw;life
长|grow;long;elder
吃|eat
喝|drink
笑|laugh;smile
哭|cry;weep
喊|shout;yell
叫|call;shout;be called
握|hold;grasp
摸|touch;feel
拍|pat;clap;shoot
推|push
拉|pull;drag
抬|lift;raise
搬|move;carry
拿|take;hold;carry
给|give
送|send;give;escort
用|use
买|buy
卖|sell
做|do;make
干|do;work
写|write
读|read
记|remember;record
好|good;fine;well
坏|bad;broken
对|right;correct;toward
错|wrong;mistake
真|real;true;really
假|false;fake
大|big;large;great
小|small;little
多|many;much;more
少|few;little;less
高|tall;high
矮|short (height)
低|low
短|short
宽|wide
窄|narrow
厚|thick
薄|thin;flimsy
深|deep
浅|shallow;light (color)
重|heavy;weight
轻|light (weight)
快|fast;quick
慢|slow
早|early
晚|late
新|new
旧|old;used
老|old;aged
丑|ugly
帅|handsome;cool
强|strong;powerful
弱|weak
难|difficult;hard
脏|dirty
热|hot;heat
冷|cold
温|warm;temperature
凉|cool;cold
暖|warm
饱|full (stomach)
饿|hungry
渴|thirsty
累|tired
困|sleepy
疼|pain;ache;hurt
痛|pain;ache
病|ill;sick;illness
药|medicine;drug
伤|wound;injury;hurt
嘴|mouth
脸|face
头|head
手|hand
脚|foot
腿|leg
汗|sweat
血|blood
鞋|shoes
钱|money
饭|meal;rice;food
菜|dish;vegetable
肉|meat
茶|tea
酒|wine;alcohol
香|fragrant;delicious smell
甜|sweet
苦|bitter
酸|sour
辣|spicy;hot
咸|salty
书|book
信|letter
纸|paper
笔|pen;writing brush
床|bed
门|door
灯|lamp;light
刀|knife;blade
剑|sword
箭|arrow
盾|shield
船|boat;ship
鬼|ghost;spirit
神|god;deity
佛|Buddha;buddhism
魔|demon;devil
道|way;Tao;road
天|sky;heaven;day
地|earth;ground
当|when;as
而|and;while;whereas
并|and;also (emphatic)
都|all;both;even
也|also;too
还|still;also;yet
又|again;also;moreover
再|again;once more
就|then;just;at once
却|but;yet;however
才|only then;just;barely
每|every;each
各|each;every;various
从|from;since;through
向|toward;to;face
往|toward;go
朝|toward;facing;dynasty
跟|with;follow;and
和|and;with
与|and;with
同|same;with;together
比|than;compare;ratio
被|by (passive)
把|(ba-construction);handle`,
idioms: `一心一意|wholeheartedly;with one heart and mind;专心致志
一针见血|hit the nail on the head;一针见血，直指要害
一石二鸟|kill two birds with one stone
一见钟情|love at first sight
一鸣惊人|amaze the world with a single feat;一举成名
一诺千金|a promise is weightier than gold;言出必行
一清二楚|as clear as day;清清楚楚
一目了然|be clear at a glance;一看就明白
一帆风顺|smooth sailing;一切顺利
一往无前|press forward with indomitable courage;勇往直前
一马当先|take the lead;身先士卒
一丝不苟|meticulous;with extreme care;毫不马虎
一视同仁|treat all equally;不偏不倚
一成不变|fixed and unchangeable;僵化不变
一事无成|achieve nothing;一事无成
一气呵成|do something in one breath;从头到尾不停顿
一败涂地|suffer a crushing defeat;惨败
一面之词|one-sided statement;片面之词
一家之言|one's own view;独到之见
入木三分|penetrating;刻画深刻
人山人海|huge crowds of people;人非常多
人云亦云|follow others blindly;随声附和
九牛一毛|a drop in the bucket;微不足道
三心二意|be of two minds;犹豫不决
三言两语|in a few words;三言两语说清
亡羊补牢|mend the fold after a sheep is lost;出了问题及时补救
五颜六色|colorful;色彩繁多
井井有条|in perfect order;条理分明
从天而降|fall from the sky;突然出现
天长地久|enduring as the universe;forever;永恒不变
天翻地覆|earth-shaking;巨大变化
心花怒放|burst with joy;高兴极了
心急如焚|burning with anxiety;万分焦急
心安理得|feel at ease and justified;问心无愧
心甘情愿|be perfectly willing;发自内心愿意
恍然大悟|suddenly realize the truth;茅塞顿开
手忙脚乱|be in a flurry;慌乱无措
手舞足蹈|dance for joy;高兴得手舞足蹈
打草惊蛇|act rashly and alert the enemy;打草惊蛇，打草不捉蛇
拔苗助长|spoil things by excessive enthusiasm;急于求成反坏事
画蛇添足|ruin the effect by adding sth. superfluous;多此一举
自以为是|be opinionated;自以为正确
自相矛盾|contradict oneself;言行互相抵触
虎头蛇尾|a tiger's head and a snake's tail;有始无终
见多识广|experienced and knowledgeable;见识广博
见义勇为|act bravely for a just cause;见到正义之事挺身而出
目瞪口呆|dumbfounded;惊得说不出话
狼吞虎咽|wolf down;吃相贪婪快速
狐假虎威|bully people by flaunting one's powerful connections;仗势欺人
画龙点睛|add the finishing touch;点睛之笔
胸有成竹|have a well-thought-out plan;心中有数
苦口婆心|advise earnestly and patiently;再三恳切劝告
草木皆兵|mistake every bush for an enemy;风声鹤唳，疑神疑鬼
视而不见|turn a blind eye to;装作没看见
锦上添花|add brilliance to what is already beautiful;好上加好
雪中送炭|provide timely help;危难中及时援助
半途而废|give up halfway;做事有始无终
守株待兔|wait for gains without hard work;心存侥幸
对牛弹琴|cast pearls before swine;对不懂的人讲道理
望梅止渴|quench thirst by thinking of plums;空想安慰自己
乐不思蜀|be too happy to think of home;乐而忘返
坐井观天|have a very narrow view;眼界狭小
叶公好龙|profess love for what one actually fears;表面爱好实际惧怕
掩耳盗铃|deceive oneself;自欺欺人
朝三暮四|blow hot and cold;反复无常
杯弓蛇影|be extremely suspicious;疑神疑鬼
浑水摸鱼|fish in troubled waters;趁乱捞好处
画饼充饥|feed on illusions;画饼充饥，空想安慰
惊弓之鸟|a bird startled by the mere twang of a bowstring;受过惊吓，胆怯多疑
杯水车薪|an utterly inadequate measure;力量太小无济于事
缘木求鱼|do the impossible;方向方法错误
病入膏肓|be past all cure;病情危重无法医治
刻舟求剑|take measures without regard to change;墨守成规
破釜沉舟|burn one's boats;下定决心，一拼到底
背水一战|fight with one's back to the river;决一死战
鞠躬尽瘁|bend one's back to the task until death;竭尽全力效劳
卧薪尝胆|endure hardship to accomplish a goal;刻苦自励，发愤图强
愚公移山|persistence will overcome any difficulty;不畏艰难坚持到底
持之以恒|persevere in doing sth.;坚持下去
水滴石穿|constant dropping wears away a stone;滴水穿石，坚持到底
铁杵成针|perseverance will prevail;功夫不负有心人
不耻下问|not feel ashamed to ask and learn from one's subordinates;谦虚好学
温故知新|review the old to learn the new;温习旧知识获得新理解
举一反三|draw inferences from one example;触类旁通
融会贯通|achieve mastery through comprehensive study;透彻理解
触类旁通|comprehend by analogy;由此及彼理解同类事物
事半功倍|get twice the result with half the effort;效率极高
事倍功半|get half the result with twice the effort;费力不讨好
全力以赴|spare no effort;竭尽全力
精益求精|strive for perfection;不断追求更好
尽善尽美|perfect;extremely good
独一无二|unique;unparalleled;唯一无二
举世无双|matchless;世上独一无二
少见多怪|ignorant people are easily surprised;见识少而大惊小怪
习以为常|be used to sth.;成为习惯习见不怪
屡见不鲜|common occurrence;见得多了不觉得新奇
不计其数|countless;数也数不清
数不胜数|too numerous to count;不计其数
寥寥无几|very few;数量极少
屈指可数|can be counted on one's fingers;数目很少
应有尽有|have everything one could wish for;一应俱全
一应俱全|complete in every detail;应有尽有
完好无损|in perfect condition;完整无缺
安然无恙|safe and sound;平安无事
相安无事|live in peace with each other;彼此和睦无冲突
国泰民安|the country is prosperous and the people at peace;天下太平
安居乐业|live and work in peace;生活安定，乐于从事自己的职业
丰衣足食|be well-fed and well-clothed;生活富足
繁荣昌盛|thriving and prosperous;兴旺发达
蒸蒸日上|flourishing more and more;日益发展向上
欣欣向荣|flourishing;prospering;蓬勃发展
日新月异|change with each passing day;发展迅速变化大
突飞猛进|advance rapidly;进步神速
一日千里|at a tremendous pace;进展极快
平步青云|rapidly rise to fame;一朝发迹，官运亨通
功成名就|achieve success and fame;功业建立，名声成就
名扬四海|be known far and wide;声名远播
声名鹊起|rise rapidly to fame;名声迅速提高
家喻户晓|known to every household;人人皆知
脍炙人口|win universal praise;诗文等受人喜爱传诵
众所周知|as everyone knows;大家都知道
显而易见|obviously;clearly evident;明摆着的事
不言而喻|self-evident;无需多言
一目十行|read ten lines at a glance;阅读速度极快
走马观花|glance over things hurriedly;粗略地观察事物
浮光掠影|skimming over the surface;印象不深
浅尝辄止|stop after getting a little knowledge;稍微尝试就停止
囫囵吞枣|swallow without chewing;不求甚解地笼统接受
生吞活剥|copy mechanically without real understanding;机械照搬
不求甚解|not seek deep understanding;读书只求懂得大意
一知半解|have scanty knowledge;知道得不全面
似懂非懂|not quite understand;好像懂又好像不懂
若无其事|calm and indifferent;好像没那回事
小心翼翼|with great care;非常谨慎小心
糊里糊涂|muddleheaded;头脑不清楚
乱七八糟|in a mess;杂乱无章
干干净净|neat and clean;清洁干净
清清楚楚|clear;distinct;十分清楚
老老实实|honest;well-behaved;规规矩矩
真真切切|real and vivid;真切确实
一心为公|dedicated to the public interest;一心为大家
忠心耿耿|loyal and devoted;忠诚不二
赤胆忠心|utter devotion;绝对忠诚
赴汤蹈火|go through fire and water;不畏艰险
出生入死|risk one's life;冒生命危险
舍己为人|sacrifice oneself for others;牺牲自己帮助别人
救死扶伤|heal the wounded and rescue the dying;救人于危难
助人为乐|find pleasure in helping others;乐于助人
雪中送炭|timely assistance;危难时予以帮助
趁火打劫|rob in the midst of a fire;趁人之危捞好处
落井下石|hit a person when he is down;落井下石，乘人之危
幸灾乐祸|take pleasure in others' misfortune;别人遭难反而高兴
心狠手辣|cruel and ruthless;心肠狠毒手段毒辣
心慈手软|softhearted;心肠仁慈下不了手
目光短浅|short-sighted;缺乏长远眼光
高瞻远瞩|far-sighted;站得高看得远
深谋远虑|think deeply and plan carefully;考虑深远
深思熟虑|think over carefully;反复深入思考
当机立断|decide promptly and opportunely;抓住时机果断决定
优柔寡断|irresolute;犹豫不决
犹豫不决|hesitate;拿不定主意
举棋不定|hesitate;下不了决心
徘徊不前|hesitate and not move forward;止步不前
急中生智|show resourcefulness in an emergency;危急时想出好办法
灵机一动|hit upon a good idea;忽然想出好主意
计上心来|an idea strikes one;计谋涌上心头
将计就计|turn the tables on sb.;利用对方计策反制对方
声东击西|make a feint to the east and attack in the west;虚张声势迷惑对方
调虎离山|lure the tiger away from the mountain;引开对方主力
瞒天过海|cross the sea by a trick;用欺骗手段瞒过对方
顺手牵羊|pick up sth. on the sly;顺手拿走
借刀杀人|kill sb. by another's hand;借他人之手害人
过河拆桥|drop one's benefactor;忘恩负义
卸磨杀驴|get rid of sb. after his service is done;过河拆桥
恩将仇报|return evil for good;以怨报德
以德报怨|return good for evil;用恩惠回报仇恨
以牙还牙|tit for tat;针锋相对
针锋相对|be diametrically opposed;互不相让
旗鼓相当|be well-matched in strength;实力相当
势均力敌|be evenly matched;力量不相上下
不分胜负|end in a draw;分不出输赢
不共戴天|absolutely irreconcilable;仇恨极深势不两立
势不两立|mutually exclusive;不能共存
你死我活|life-and-death struggle;斗争激烈
刀光剑影|fierce fighting;刀剑闪光的激烈场面
血雨腥风|bloody scenes;形容残酷屠杀
尸横遍野|corpses strewn all over the field;尸体满地
血流成河|bloodshed is great;形容伤亡惨重
`,
chars: `一|one;一;单
二|two
三|three
四|four
五|five
六|six
七|seven
八|eight
九|nine
十|ten
百|hundred
千|thousand
万|ten thousand
人|person;people;人类
入|enter;进入;收入
大|big;large;巨大
天|sky;heaven;day;天空
地|earth;ground;大地
土|soil;land;泥土
山|mountain;山
水|water;水流
火|fire;火焰
木|wood;tree;木头
林|forest;树林
森|dense forest;森林
石|stone;rock;石头
田|field;农田
日|sun;day;太阳
月|moon;month;月亮
星|star;星星
光|light;光线;光明
明|bright;明白;明亮
暗|dark;黑暗
阴|shade;overcast;阴天;阴
阳|sun;male;阳
云|cloud;云彩
风|wind;风采
雨|rain;雨水
雪|snow;雪
雷|thunder;雷声
电|electricity;闪电;电
气|air;gas;生气;气息
空|empty;sky;空气
上|up;above;on;上面
下|down;below;under;下面
左|left;左边
右|right;右边
中|middle;center;中国
内|inside;内部
外|outside;外部
前|front;before;前面
后|back;behind;后面
东|east;东方
西|west;西方
南|south;南方
北|north;北方
间|between;room;space;房间
里|inside;within;里面
门|door;gate;入口
口|mouth;opening;人口
窗|window;窗户
户|door;household;户口
房|house;room;房屋
屋|house;room;屋顶
家|home;family;家庭
国|country;state;国家
王|king;国王
主|lord;master;main;主要
子|son;child;名词后缀
女|woman;female;女子
男|man;male;男子
老|old;aged;老人
少|young;few;少年
幼|young;childish;幼小
年|year;年龄
岁|year (of age);年岁
时|time;hour;时间
春|spring;春天
夏|summer;夏天
秋|autumn;秋天
冬|winter;冬天
早|morning;early;早上
午|noon;中午
晚|evening;late;晚上
夜|night;夜晚
今|today;now;今天
明|bright;tomorrow;明亮
昨|yesterday;昨天
头|head;top;头部
发|hair;send;头发
面|face;noodles;surface;脸面
眉|eyebrow;眉毛
目|eye;目;条目
眼|eye;眼睛
耳|ear;耳朵
鼻|nose;鼻子
嘴|mouth;嘴巴
牙|tooth;牙齿
舌|tongue;舌头
颈|neck;颈部
肩|shoulder;肩膀
背|back;后背
腰|waist;腰部
腹|belly;腹部
心|heart;mind;内心
手|hand;手工
足|foot;sufficient;足够
脚|foot;脚
腿|leg;腿部
身|body;身体
骨|bone;骨头
血|blood;血液
皮|skin;leather;皮肤
毛|hair;fur;眉毛/毛发
魂|soul;灵魂
鬼|ghost;鬼魂
神|god;spirit;精神
仙|immortal;仙人
妖|demon;monster;妖怪
魔|devil;magic;魔鬼
佛|Buddha;佛教
道|way;path;speak;道路;道理
法|law;method;法术
术|art;technique;武术
武|martial;military;武功
文|literature;civil;culture;文章
书|book;write;书
画|picture;draw;绘画
字|character;word;文字
言|word;speech;语言
语|language;speech;语言
说|say;speak;说话
话|words;speech;话
讲|speak;explain;讲解
读|read;朗读
写|write;书写
听|listen;听见;听
看|look;see;看
见|see;meet;看见
望|gaze;look;希望
闻|smell;hear;新闻
问|ask;询问
答|answer;回答
想|think;want;miss;想
念|think of;read aloud;思念
知|know;知识
识|know;understand;认识
记|remember;record;记录
忘|forget;忘记
意|meaning;intention;意思
思|think;thought;思考
爱|love;喜爱
恨|hate;仇恨
怕|fear;害怕
惊|surprise;frighten;吃惊
怒|anger;angry;愤怒
喜|joy;like;喜欢
乐|happy;music;快乐
笑|laugh;smile;笑
哭|cry;哭
喊|shout;叫喊
叫|call;shout;喊叫
走|walk;go;走
跑|run;跑
跳|jump;跳
飞|fly;飞
游|swim;travel;游玩
来|come;来
去|go;去
到|arrive;reach;到
回|return;go back;回
进|enter;go into;进
出|go out;出
开|open;start;开
关|close;turn off;关
停|stop;停留
站|stand;station;站
坐|sit;坐
躺|lie;躺下
吃|eat;吃
喝|drink;喝
睡|sleep;睡觉
醒|wake;醒
死|die;死
生|born;life;生
活|living;alive;生活
动|move;action;动
静|quiet;still;安静
行|go;do;walk;行
做|do;make;做
用|use;用
给|give;给
拿|take;hold;拿
打|hit;fight;play;打
杀|kill;杀
放|put;release;放
取|take;get;获取
找|look for;寻找
有|have;there is;有
无|without;no;没有
在|at;be in;存在
是|is;be;正确
不|not;不
很|very;很
都|all;both;都
也|also;too;也
还|still;also;还
就|just;then;就
会|will;can;meeting;会
能|can;able;能
要|want;need;要
好|good;well;好
坏|bad;坏
对|correct;pair;toward;对
错|wrong;mistake;错
真|true;real;真
假|false;fake;假
新|new;新
旧|old;旧
美|beautiful;美
丑|ugly;丑
强|strong;强
弱|weak;弱
多|many;more;多
少|few;young;少
高|tall;high;高
低|low;低
长|long;grow;长
短|short;短
快|fast;happy;快
慢|slow;慢
早|early;morning;早
迟|late;迟
远|far;远
近|near;close;近
深|deep;深
浅|shallow;浅
清|clear;clean;清楚
白|white;white;白
黑|black;黑
红|red;红
黄|yellow;黄
蓝|blue;蓝
绿|green;绿
青|blue-green;青年;青
紫|purple;紫
灰|gray;灰
衣|clothes;衣服
服|clothes;serve;服从
布|cloth;布料
帽|hat;帽子
鞋|shoes;鞋
带|belt;bring;carry;带领
包|bag;wrap;包含
钱|money;钱
金|gold;metal;金
银|silver;银
玉|jade;玉
宝|treasure;宝物
珠|pearl;bead;珠宝
食|food;eat;食物
饭|meal;rice;饭碗
菜|vegetable;dish;菜肴
肉|meat;肉
酒|wine;酒
茶|tea;茶叶
米|rice;大米
面|face;noodles;surface;面粉
油|oil;油
盐|salt;盐
马|horse;马
牛|ox;cow;牛
羊|sheep;羊
狗|dog;狗
猫|cat;猫
鸡|chicken;鸡
猪|pig;猪
鸟|bird;鸟
鱼|fish;鱼
虫|insect;虫子
龙|dragon;龙
虎|tiger;虎
蛇|snake;蛇
车|vehicle;car;车
船|boat;ship;船
路|road;way;道路
桥|bridge;桥梁
城|city;wall;城市
村|village;村庄
店|shop;store;商店
街|street;街道
房|house;room;房屋
厅|hall;大厅
楼|building;floor;楼房
台|platform;stage;舞台
床|bed;床
桌|table;桌子
椅|chair;椅子
灯|lamp;light;灯火
火|fire;火焰
刀|knife;刀
剑|sword;剑
弓|bow;弓箭
箭|arrow;箭
盾|shield;盾牌
军|army;军队
兵|soldier;武器;兵
将|general;will;带领
战|war;fight;战斗
争|contend;fight;争夺
胜|win;victory;胜利
败|defeat;fail;失败
功|merit;achievement;功夫
力|power;force;力量
势|power;situation;形势
气|air;spirit;生气
灵|spirit;clever;灵敏
仙|immortal;仙
`,
zh: `刹那|极短的时间;一瞬间
须臾|极短的时间;片刻
一瞬|一眨眼的工夫;极短时间
转瞬|转眼之间;极短时间
瞬息|一眨眼之间
顷刻|极短的时间;片刻
俄顷|片刻;一会儿
俄而|不久;一会儿
旋即|随即;不久就
顿时|立刻;马上
骤然|突然;忽然
陡然|突然
蓦然|猛然;不经心地
霍然|突然;忽然
倏然|极快地;忽然
倏忽|很快地;转眼之间
恍惚|神志不清;精神不集中;隐约记得
恍然|忽然醒悟;猛然明白
愕然|惊讶的样子
骇然|惊讶害怕的样子
悚然|恐惧的样子
凛然|严肃;令人敬畏
肃然|恭敬严肃的样子
泫然|流泪的样子
潸然|流泪的样子
黯然|情绪低落;阴暗
怅然|失意;不如意
惘然|失意;不知如何是好
茫然|不知所措;一无所知
怡然|安适愉快
欣然|高兴地;愉快地
粲然|笑容灿烂;鲜明发光
嫣然|美好妩媚(多形容笑)
依然|仍旧;照旧
依旧|仍然;照样
依稀|隐约;模模糊糊
隐约|看起来不清楚;感觉不明显
踌躇|犹豫不决;拿不定主意
徘徊|来回走动;犹豫不决
踟蹰|犹豫;徘徊不前
蹒跚|走路不稳;缓慢摇摆
踉跄|走路不稳;跌跌撞撞
蹉跎|虚度光阴;把时间白白耽误
彷徨|走来走去;犹豫不决
忐忑|心神不定;不安
惴惴|恐惧不安的样子
恻隐|同情心;对不幸的怜悯
呢喃|低声细语;燕子的叫声
啜泣|抽抽噎噎地哭
呜咽|低声哭泣;哽咽
哽咽|哭时喉咙堵塞;说不出话
抽噎|一吸一顿地哭泣
呻吟|因痛苦而发出的声音
哀嚎|悲伤地大声喊叫
悲恸|非常悲哀
喟叹|叹息;感慨
沉吟|低声自语;迟疑不快地考虑
思忖|思考;考虑
忖度|推测;揣度
揣测|推测;估计
端详|仔细地看;打量
打量|观察;审视
睥睨|斜着眼睛看;傲视
瞥见|一眼看见
眺望|从高处向远处看
凝望|目不转睛地看
凝视|聚精会神地盯着看
环顾|向四周看
巡视|到处查看
逡巡|徘徊不前;欲进又退
踱步|慢步走来走去
伫立|长时间地站立
矗立|高高地直立
屹立|像山峰一样高耸挺立
匍匐|伏地爬行
蜿蜒|弯弯曲曲地延伸
绵延|延续不断
逶迤|道路弯曲而长
崎岖|道路高低不平
嶙峋|山石突兀重叠;人消瘦露骨
峻峭|山势高而陡
险峻|山势高而险
陡峭|山势陡直
璀璨|光彩夺目
绚烂|光彩耀眼
斑斓|色彩错杂灿烂
氤氲|烟气弥漫的样子
袅袅|烟气缭绕上升;细长柔软
袅娜|姿态柔美
窈窕|女子文静美好
婀娜|姿态轻柔美好
娉婷|女子姿态美好
妩媚|姿态美好可爱
妖娆|娇艳美好
婆娑|盘旋舞动的样子
翩跹|轻快地跳舞
缥缈|隐隐约约;若有若无
朦胧|模糊不清
迷蒙|模糊不清;昏暗
迷离|模糊而难以分辨
静谧|安静;安宁
幽静|清静
幽邃|深远;深奥
深邃|深;深奥
苍茫|空阔辽远;没有边际
浩瀚|水面广大;数量繁多
辽阔|宽广;空旷
广袤|土地广大
无垠|无边无际
苍穹|天空
寥廓|高远空旷
萧瑟|风吹草木的声音;凄凉
萧然|萧条冷落;空寂
荒芜|土地无人耕种;杂草丛生
凋零|草木凋谢零落;衰落
枯萎|干枯萎缩
苍凉|凄凉
凄清|凄凉冷清
冷峻|冷酷严峻;严肃
凌厉|气势凶猛;迅速猛烈
犀利|武器锋利;语言尖锐
敏锐|感觉灵敏;眼光锐利
迟钝|反应慢;不灵敏
木讷|朴实迟钝;不善言辞
憨厚|朴实厚道
狡黠|狡猾机灵
狡诈|奸猾诡诈
阴险|表面和善内心险恶
毒辣|心肠狠毒
刁钻|狡猾怪僻
泼辣|凶悍不讲理;办事有魄力
彪悍|强壮勇猛
魁梧|身材高大强壮
伟岸|魁梧高大
挺拔|直立高耸;坚强有力
俊朗|俊美开朗
儒雅|学识渊博;风度文雅
温润|温和有礼
沉稳|稳重沉着
干练|办事能力强
精明|精细聪明
圆滑|处事圆通;八面玲珑
世故|处世经验多;圆滑
豁达|心胸开阔;气量大
淡泊|不追求名利
恬淡|安静闲适;不慕名利
洒脱|言谈举止自然;不拘束
放浪|放纵;不拘礼法
不羁|不受约束
倔强|性格刚强固执
执拗|固执任性;不听劝
固执|坚持己见;不肯变通
冥顽|愚钝顽固
纵横|竖横交错;随意奔驰
叱咤|怒斥;大声呼喝
怂恿|鼓动别人去做(不好的事)
教唆|怂恿引诱人做坏事
谄媚|讨好奉承
阿谀|谄媚奉承
献媚|讨好巴结
桀骜|性情暴烈倔强
凛冽|寒冷刺骨
料峭|略带寒意(形容春寒)
酷暑|极热的夏天
严寒|极冷
炽热|极热;热烈
灼热|像火烫一样热
阴霾|空气阴沉混沌;气氛压抑
晦暗|昏暗;不明亮
萧索|冷落;凄凉
荒凉|人烟稀少;冷清
寂寥|寂静空旷
幽暗|昏暗
黯淡|暗淡;没有光彩
明媚|鲜明可爱(多形容阳光景色)
和煦|温暖(多形容春风)
旖旎|柔美妩媚(多形容风光)
迤逦|曲折连绵
缠绵|情意深厚;纠缠不已
缱绻|情意缠绵难分
眷恋|深切地留恋
羁绊|束缚;牵制
桎梏|脚镣手铐;比喻束缚人的东西
束缚|捆绑;约束限制
囹圄|监狱
蒙冤|遭受冤枉
昭雪|洗清冤屈
沉冤|积久未雪的冤屈
隐忍|把屈辱藏在心里;忍耐
晦涩|文字艰深难懂
玄妙|深奥难测
奥妙|深奥微妙
造诣|学问技艺达到的程度
涵养|修养;控制情绪的能力
胸襟|胸怀;气量
胆识|胆量和见识
韬略|用兵的谋略;计谋
谶语|预言吉凶的话
凡尘|人间;世俗
红尘|人世间;繁华热闹之地
尘缘|尘世的缘分
宿命|命中注定的命运
孽缘|罪恶的缘分
姻缘|婚姻的缘分
天意|上天的意志
气运|命运;运气
劫难|灾难;祸难
浩劫|大灾难
罹难|遭遇灾祸而死
殒命|丧命
溘然|忽然(多指去世)
长眠|死亡(婉称)
风骨|刚正的气概;雄健的风格
气节|坚持正义;不屈服的品质
操守|道德品行
德望|德行和声望
威仪|使人敬畏的仪容
锋芒|刀剑尖端;比喻锐气
气焰|嚣张的气势
煞气|凶恶之气
戾气|凶暴之气
英气|英俊豪迈的气概
豪气|豪迈的气概
侠气|仗义的气概
义气|重情义而不顾私利的气概
骨气|刚强不屈的气概
傲骨|高傲不屈的性格
傲气|自高自大的神气
时机|有利的机会
契机|事物转化的关键
缘分|人与人间命中注定的遇合
情愫|真实的情意
情谊|相互间的感情和友谊
恩怨|恩惠与仇怨
嫌隙|因猜疑不满产生的隔阂
芥蒂|心中的不快或隔阂
倾慕|仰慕;爱慕
敬仰|尊敬仰慕
钦佩|敬重佩服
叹服|赞叹佩服
折服|使人信服;屈服
震慑|震动使人害怕
心腹|亲信;最信任的人
爪牙|走狗;帮凶
耳目|替人打听消息的人
眼线|暗中侦察的人
奸细|混入内部刺探情报的人
内应|潜伏在内部接应的人
底细|事情的根源;内情
内情|内部情况
隐情|不愿说出的内情
内幕|内部的秘密
蹊跷|奇怪;可疑
端倪|事情的眉目;头绪
苗头|事物发展的征兆
征兆|事前出现的迹象
预兆|预示将发生的事
来龙去脉|事情的经过和底细
前因后果|事情的起因和结果
报应|善恶的回报
造化|命运;福气;创造化育
际遇|遭遇;机遇
厄运|不幸的遭遇
斡旋|调解纠纷;周旋
调停|调解争执
排解|调解;消除
化解|消除;解除
冰释|像冰融化一样消除(多指误会)
释怀|放下心中的牵挂
释然|疑虑消除;心情放松
了然|明白;清楚
彻悟|彻底觉悟
顿悟|忽然觉悟
铭记|牢记在心
刻骨|感受深切;铭记
萦绕|盘旋缠绕;反复回旋
缭绕|回环旋转
盘桓|逗留;徘徊
辗转|翻来覆去;经过许多地方
漂泊|生活不安定;东奔西走
颠沛|流离困顿
流离|流转离散
沦落|流落;没落
落魄|穷困失意
潦倒|生活困顿;颓丧
困顿|艰难窘迫;疲惫
窘迫|处境困难;为难
拮据|经济不宽裕
窘境|困难的处境
煎熬|长时间受折磨
折磨|使痛苦;使受打击
踌躇满志|心满意足;得意扬扬
期间|某个时间段内
片刻|很短的时间
一刹那|极短的时间
时候|时刻;某段时间
时间|岁月;时刻
时刻|时间点;每时每刻
有时|有时候;偶尔
有些|有一部分;一些
许多|很多;大量
很多|数量大;大量
全部|整个;所有
所有|一切;全部
一切|全部事物
每个|每一个
每次|每一次
大家|所有人;众人
人们|许多人;民众
别人|另外的人;他人
自己|本人;自身
双方|两方;两方面
客人|来访的人;顾客
主人|接待客人的人;物主
朋友|彼此交好的人
家人|家庭成员
孩子|儿童;子女
老人|年长的人
世界|天地万物;人间
地方|区域;场所
样子|模样;情状
声音|物体振动发出的声响
语气|说话时的口气
目光|视线;眼神
想法|意见;念头
主意|办法;主张
办法|处理事情的方法
方法|办法;途径
原因|造成结果的因由
结果|事情的结局
事情|事务;事体
问题|要解答的题目;疑难
消息|音信;新闻
情况|情形;状况
真相|事情的真实情况
忽然|突然;出人意料
突然|骤然;出人意料
马上|立刻;立即
立刻|马上;立即
立即|马上;立刻
赶紧|抓紧时机;赶快
连忙|急忙;赶紧
慢慢|缓慢;逐渐
渐渐|逐步;慢慢
终于|到底;最后
最后|末尾;最终
起初|开始的时候
后来|之后;以后
现在|当前;此刻
以前|从前;过去
以后|之后;将来
曾经|表示从前发生过
正在|表示动作进行中
已经|表示完成或过去
永远|一直;永久
一直|始终;不间断
经常|常常;时常
偶尔|间或;有时候
再次|又一次;再一次
重新|再一次;从头
互相|彼此;相互
一起|一同;一块儿
独自|自己一个人
真的|确实;果真
确实|的确;真实
其实|实际上;说实在的
几乎|差不多;接近于
非常|极;特别
十分|非常;很
特别|格外;与众不同
极其|非常;极端
更加|更;越发
可能|也许;或许
也许|可能;或许
或许|也许;可能
大概|大约;很可能
应该|应当;理所当然
必须|一定要;必要
可以|能够;允许
能够|可以;具备条件
需要|应该有;必须有
想要|希望得到;想要做
希望|盼着;期望
打算|准备;计划
准备|预先安排;预备
开始|从头起;着手
继续|接着做下去
结束|完毕;终止
完成|做完;办好
停止|不再进行
放弃|不再坚持;丢掉
坚持|始终不动摇
努力|尽力量去做
认真|严肃对待;不马虎
仔细|认真细致;细心
注意|把精神集中到;留意
小心|谨慎;当心
放心|安心;不担心
担心|挂念;不放心
害怕|畏惧;担忧
紧张|精神处于高度准备状态;不放松
高兴|愉快;欢喜
开心|快乐;高兴
喜欢|有好感;喜爱
讨厌|惹人厌烦;厌恶
生气|发怒;不高兴
难过|伤心;难受
伤心|悲哀;难过
痛苦|身心很不好受
悲伤|伤心难过
忧愁|忧虑发愁
烦恼|烦闷苦恼
着急|急躁不安
焦急|着急;焦躁
平静|没有波澜;安宁
安静|没有声音;宁静
轻松|不感到有负担;不紧张
愉快|高兴;舒畅
幸福|使人心情舒畅的生活和境遇
温暖|暖和;使人感到亲近
寒冷|气温很低;冷
舒服|身体或精神感到轻松愉快
难受|不舒服;心中不痛快
健康|身体良好;没有疾病
平安|没有事故;安全
安全|没有危险;不受威胁
危险|有遭到损害的可能
重要|意义重大;值得重视
简单|不复杂;容易
复杂|繁多杂乱
清楚|明白;清晰
明白|清楚;懂得
理解|明白;懂得
知道|明白;了解
了解|知道得很清楚
认识|知道;了解;认得
记住|不忘;牢记
忘记|不记得;忽略
想起|记起来;回忆
回忆|回想往事
想念|思念;挂念
思念|想念;怀念
觉得|感到;认为
感到|觉得;感觉到
以为|认为;主观地认为
认为|觉得;持某看法
相信|认为正确;信任
怀疑|不相信;猜测
确定|明确肯定;坚定
决定|拿定主意;决断
改变|变化;改动
变成|成为;变为
成为|变成;转为
离开|走开;离去
回来|从别处回到原地
回去|返回原处
来到|到达;来临
到达|抵达;到了
通过|经过;同意;穿过
经过|路过;通过;经历
穿过|跨越;通过
迎接|到跟前欢迎
告别|辞别;道别
见面|会面;相见
分开|离别;分散
相聚|聚在一起
陪伴|陪着;作伴
跟随|随在后面;跟从
保护|使不受损害
照顾|照料;关心
帮助|援助;帮忙
支持|赞同;给以鼓励
反对|不赞成;抵制
同意|赞成;允许
拒绝|不接受;不答应
答应|同意;应允
允许|许可;同意
警告|提醒告诫
提醒|从旁指点使注意
劝告|劝人接受意见
鼓励|激发;勉励
表扬|公开赞扬
批评|指出缺点错误
感谢|表示谢意
感激|因得到帮助而感动
原谅|谅解;不追究
信任|相信而托付
背叛|背弃;投向敌方
欺骗|用假话使人上当
隐瞒|掩盖真话;藏着不说
承认|表示认可;供认
否认|不承认
解释|说明含义;阐明
说明|解释;讲明白
讨论|就某问题交换意见
商量|交换意见;磋商
战斗|作战;斗争
胜利|达到目的;战胜
失败|没达到目的;受挫
成功|达到预期结果
收获|取得的成果;获得
获得|取得;得到
失去|不再拥有
拥有|持有;占有
保持|维持住;延续
破坏|使损坏;毁坏
恢复|回到原状;复原
建立|成立;创设
增加|增多;加多
减少|使变少;削减
提高|使升高;提升
加强|使更强;增强
扩大|使范围增大
老师|教书的人;教师
学生|在学校学习的人
学校|教育机构
上学|去学校学习
上课|教师授课;学生听讲
下课|结束上课
放学|学校一天的课业结束
同学|同校学习的人
教室|上课的场所
作业|学校布置的功课
考试|检验学业的测验
成绩|考试或工作的结果
课本|教科书
知识|认识与经验
科学|反映客观规律的知识体系
历史|过去的事实;历史学
数学|研究数量与结构的学科
医生|给人治病的人
医院|治病救人的场所
看病|就诊;诊治
病人|生病的人
生病|患病
病房|医院里病人住的房间
护士|护理病人的人员
感冒|受凉引起的呼吸道疾病
发烧|体温升高
头疼|头痛;烦恼的事
办公室|办公的场所
公司|企业单位
工厂|生产产品的场所
职员|机关企业的工作人员
老板|业主;负责人
经理|经营管理的人
员工|工作人员
同事|一起工作的人
上班|到单位去工作
下班|结束一天的工作
出差|到外地办理公事
开会|举行会议
会议|多人聚在一起议事
报告|汇报;讲述;文书
总结|归纳小结
计划|预先拟定的方案
产品|生产出来的物品
商品|用于交换的物品
价格|商品价值的货币表现
便宜|价格低;方便
付款|交付钱款
赚钱|获得利润
省钱|节约开支
银行|经营存贷款等业务的机构
商店|卖货物的场所
超市|大型自选商店
市场|交易场所
饭馆|餐馆
餐厅|供人吃饭的场所
饭店|旅馆;餐馆
手表|戴在手腕上的表
手机|移动电话
电话|通话的设备;通话
电脑|电子计算机
网络|互联网;网状系统
互联网|因特网;国际互联网
网站|互联网上的站点
网页|网络上的页面
邮箱|电子邮箱
邮件|书信;电子邮件
短信|手机短消息
新闻|新近发生事情的报道
报纸|以新闻为主的刊物
杂志|定期出版的刊物
图书|书籍
图书馆|收藏借阅图书的机构
书店|卖书的商店
小说|叙事性的文学体裁
作家|从事文学创作的人
作者|著作的写作者
文章|成篇的文字
故事|叙事性的内容;情节
道理|事理;理由
法律|由国家制定并强制实施的行为规范
警察|维护治安的人员
公安|社会治安;公安人员
监狱|监禁犯人的场所
审判|审理和判决
证据|证明事实的根据
案件|有关诉讼的事件
调查|查明情况
处理|办理;解决
解决|处理使问题完结
管理|负责并安排某项工作
领导|率领并引导;负责人
国家|主权政体;一个政权统辖的区域
政府|国家行政机关
城市|人口集中、工商业发达的地方
农村|以从事农业生产为主的地方
乡村|村落;农村
首都|国家最高政权机关所在地
北京|中国首都
上海|中国的一座大城市
中国|中华人民共和国
美国|美利坚合众国
英国|大不列颠及北爱尔兰联合王国
语言|人类交流思想的工具
中文|汉语;中国的语言文字
英文|英语;英文字母
英语|英国通用的语言
汉语|汉民族的语言
单词|语言中最小的意义单位
句子|语言运用的基本单位
拼音|汉字注音符号
汉字|记录汉语的方块字
字母|拼音文字的最小书写单位
翻译|把一种语言文字转换成另一种
词典|汇集词语并解释的工具书
字典|汇集汉字并解释的工具书
意思|语言文字的含义
意义|价值;含义;作用
内容|事物内部所含的东西
中心|中央;核心
重点|重要的部分
关键|最关紧要的部分
基础|事物发展的根本
条件|影响事物的因素
环境|周围的情况和条件
优点|长处;好的方面
缺点|不足;缺陷
错误|不正确;差错
手中|手里面
中午|白天十二点左右
上午|早晨到正午的一段时间
下午|正午到傍晚的一段时间
周末|星期六和星期日
星期|七天为一周的时间单位
月份|一年分成十二个月
生日|出生纪念日
节日|纪念日;庆祝日
春节|农历新年
新年|新的一年的开始
晚安|晚上道别的用语
再见|离别时说的话
欢迎|高兴地迎接
谢谢|表示感谢的话
对不起|道歉用语
没关系|不要紧;不必介意
没问题|可以;没有障碍
为什么|询问原因或目的
怎么样|如何;怎样
工程师|工程技术人员
火车站|铁路车站
出租车|出租汽车
公交车|公共汽车
小学生|小学阶段的学生
中学生|中学阶段的学生
大学生|大学阶段的学生
研究生|攻读学位的学生
幼儿园|幼儿教育机构
`,
};


/* ---------- 9. 语音朗读 TTSManager（浏览器原生 SpeechSynthesis 封装） ---------- */
class TTSManager {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.voices = [];
    this.rate = 1;
    this.voice = null;      // 当前选择 voiceURI
    this.queue = [];        // [{text, onstart, onend}]
    this.cur = null;
    this._onVoices = [];
    if (this.supported) {
      const load = () => {
        this.voices = speechSynthesis.getVoices() || [];
        for (const fn of this._onVoices) fn(this.voices);
      };
      load();
      speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', load);
    }
  }
  onVoices(fn) {
    this._onVoices.push(fn);
    if (this.voices.length) fn(this.voices);
  }
  setRate(r) { this.rate = clampNum(r, 0.5, 2); }
  setVoice(uri) { this.voice = this.voices.find(v => v.voiceURI === uri) || this.voices.find(v => v.lang && v.lang.toLowerCase().startsWith('zh')) || null; }

  enqueue(text, opts = {}) {
    text = String(text).trim();
    if (!text) { opts.onend && opts.onend(); return; }
    this.queue.push({ text, onstart: opts.onstart, onend: opts.onend });
    this._pump();
  }
  _pump() {
    if (!this.supported) { this.queue = []; return; }
    if (this.cur || this.queue.length === 0) return;
    const item = this.queue.shift();
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = this.rate;
    u.voice = this.voice || null;
    u.lang = u.voice ? u.voice.lang : (this._langFor(item.text) === 'cn' ? 'zh-CN' : 'en-US');
    const done = () => { this.cur = null; item.onend && item.onend(); this._pump(); };
    u.onstart = () => item.onstart && item.onstart();
    u.onend = done;
    u.onerror = (e) => { console.warn('TTS error', e.error); done(); };
    this.cur = u;
    // 部分浏览器长句 15 秒会被掐断: 入队前已按句切分, 这里再防抖一下
    try { speechSynthesis.speak(u); } catch (e) { done(); }
  }
  _langFor(text) { return DictionaryService.detectLang(text); }
  stop() {
    if (!this.supported) return;
    this.queue = [];
    this.cur = null;
    speechSynthesis.cancel();
  }
  pause() { if (this.supported) speechSynthesis.pause(); }
  resume() { if (this.supported) speechSynthesis.resume(); }
  get speaking() { return this.supported && (this.cur != null || this.queue.length > 0 || speechSynthesis.speaking); }
  /** 朗读单段文本（供划词朗读等使用） */
  speakOnce(text, rate, voiceURI, onend) {
    this.setRate(rate); this.setVoice(voiceURI);
    this.enqueue(text, { onend });
  }
}
function clampNum(n, a, b) { return Math.min(b, Math.max(a, n)); }

/* ---------- 10. 排版引擎：断行 + 分页（测量式分页，异步不阻塞 UI） ---------- */
/**
 * LineBreaker: 用 canvas.measureText 按真实宽度断行（中文按字符、英文按单词边界）
 */
class LineBreaker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext ? this.canvas.getContext('2d') : null;
    this._measureCache = new Map(); // 缓存 "font|text" → 宽度（上限控制）
    this._cacheMax = 60000;
  }
  fontString(fontSize, family) { return `${fontSize}px ${family}`; }
  measure(text, font) {
    if (!this.ctx) return null; // 无 canvas 时返回 null → 走估算
    const key = font + '|' + text;
    let w = this._measureCache.get(key);
    if (w == null) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this._measureCache.size >= this._cacheMax) this._measureCache.clear();
      this._measureCache.set(key, w);
    }
    return w;
  }
  /** 估算宽度（无 canvas 兜底）：CJK≈1em, ASCII≈0.55em */
  estimate(text, fontSize) {
    let w = 0;
    for (const ch of text) {
      w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55;
    }
    return w;
  }
  /** 20ms 时间片内让出主线程（异步编程：大章节分页不卡 UI） */
  static async yield() {
    await new Promise(r => setTimeout(r, 0));
  }
  /** 二分查找: 在 [start,len] 内找最大可容纳的断点（≤ maxW） */
  _findBreak(text, start, maxW, font, fontSize) {
    let lo = start + 1;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const w = this.measure(text.slice(start, mid), font) ?? this.estimate(text.slice(start, mid), fontSize);
      if (w <= maxW) lo = mid; else hi = mid - 1;
    }
    if (lo === start) lo = Math.min(text.length, start + Math.max(1, Math.floor(maxW / fontSize)));
    return lo;
  }

  /** 返回行区间数组 [[s,e], ...]（每 80 行让出一次主线程） */
  async breakLines(text, maxW, font, fontSize) {
    const lines = [];
    let start = 0;
    let count = 0;
    while (start < text.length) {
      const end = this._findBreak(text, start, maxW, font, fontSize);
      lines.push([start, end]);
      start = end;
      count++;
      if (count % 80 === 0) await LineBreaker.yield();
    }
    return lines;
  }
}

/**
 * ChapterPager: 把一章的段落排成“页”。
 * 页内数据: { lines: [{p, s, e}], startChar, endChar }
 *  - p: 段落下标  s/e: 该段落内的字符区间（跨页可拆分）
 */
class ChapterPager {
  constructor({ pageW, pageH, vPad, fontSize, lineHeight, fontFamily, breaker }) {
    this.pageW = pageW; this.pageH = pageH; this.vPad = vPad;
    this.fontSize = fontSize; this.lineHeight = lineHeight;
    this.fontFamily = fontFamily;
    this.breaker = breaker;
    this.font = breaker.fontString(fontSize, fontFamily);
    this.lineH = Math.round(fontSize * lineHeight);
    this.availH = Math.max(60, pageH - vPad * 2);
    // 段落底部间距（与 CSS .para margin-bottom:.35em 一致），分页时计入避免最后一行被裁切
    this.paraGap = Math.round(fontSize * 0.35);
    // 纯静态预算（不做任何 DOM 实测）：底部预留「2 行 + 1 段间距」——
    // 1 行兜底分数行高/浏览器断行与估算的偏差，1 行作为每页末尾的空白行，
    // 额外 1 个段间距兜底页首/页尾段落的边距波动，确保最后一行永远放得下
    this.budgetH = Math.max(40, this.availH - this.lineH * 2 - this.paraGap);
    this.maxLines = Math.max(1, Math.floor(this.availH / this.lineH));
  }

  async paginate(paras) {
    const pages = [];
    let group = [];          // 正在填充的页
    let groupStartChar = 0;
    let groupChars = 0;
    let used = 0;            // 当前页已占用的垂直高度(px)
    let charTotal = 0;       // 已排入行的章节字符数（供 percent 用）
    const flush = () => {
      if (!group.length) return;
      pages.push({
        lines: group.slice(),
        startChar: groupStartChar,
        endChar: groupStartChar + groupChars,
        used,                              // 记录该页已占用的行高(px)，供孤行合并校验
      });
      group = [];
      groupChars = 0;
      used = 0;
    };
    let lineCount = 0;
    const maxW = Math.max(80, this.pageW); // pageW 已扣除内边距

    for (let p = 0; p < paras.length; p++) {
      const text = paras[p];
      if (!text) continue;
      let paraLines = [];
      try {
        paraLines = await this.breaker.breakLines(text, maxW, this.font, this.fontSize);
      } catch (e) {
        // 极端情况兜底：整段作为一行
        paraLines = [[0, text.length]];
      }
      for (const [s, e] of paraLines) {
        // 与 CSS 渲染对齐的间距模型：`.para` 的间距是「段末 margin-bottom:.35em」（见 #page-content .para），
        // 只有当「段完整落在本页」时该段的末行才带这段边距；跨页段落（.para.tight）无间距。
        // 旧模型把间距计在段首行，与实际渲染不符——逐词一本书（一行一段）时每行少算 ~.35em，必然底部溢出。
        const fullPara = (s === 0) && (e >= text.length);
        const endPad = fullPara ? this.paraGap : 0;
        const need = this.lineH + endPad;
        if (group.length > 0 && used + need > this.budgetH) {
          flush();
          groupStartChar = charTotal;
        }
        group.push({ p, s, e });
        used += need;
        groupChars += e - s;
        charTotal += e - s;
        lineCount++;
      }
    }
    flush();

    // 最后一页过短时并入前一页（避免孤行）——但要校验前一页剩余高度：
    // 上一页通常是排满的，若无条件把尾页行硬塞进去，实际渲染高度会超出预算，
    // 底部 1~3 行被 overflow:hidden 裁掉（手机端逐词展示时尤其明显）。
    // 仅当放得下时才合并，否则保留为独立尾页（内容完整优先于孤行美观）。
    if (pages.length > 1) {
      const last = pages[pages.length - 1];
      if (last.lines.length <= 2) {
        const prev = pages[pages.length - 2];
        let extra = 0;
        for (const ln of last.lines) {
          const fullPara = (ln.s === 0) && (ln.e >= paras[ln.p].length);
          extra += this.lineH + (fullPara ? this.paraGap : 0);
        }
        if (prev.used + extra <= this.budgetH) {
          prev.lines.push(...last.lines);
          prev.endChar = last.endChar;
          prev.used += extra;
          pages.pop();
        }
      }
    }

    const charCount = paras.reduce((n, t) => n + t.length, 0);
    return { pages, charCount, lineCount };
  }
}

/* ---------- 11. 阅读控制器 Reader ---------- */
class Reader {
  constructor(bus) {
    this.bus = bus;
    this.breaker = new LineBreaker();
    this.book = null;
    this.chapters = null;          // [{index,title,paras,chars}]
    this.chapterIndex = -1;
    this.pageIndex = -1;
    this._pagesCache = new Map();  // chapterIndex -> {pages, charCount, pagerCtx}
    this._metrics = null;
    this.reading = false;
    this.readingMode = 'page';     // page: 页级连续朗读
    this.hotZonesOn = true;

    this.el = {
      root: $('#reader'),
      empty: $('#reader-empty'),
      title: $('#rt-title'),
      pageLabel: $('#rt-page'),
      percent: $('#rt-percent'),
      content: $('#page-content'),
      ttsPlay: $('#tts-play'),
      btnPrev: $('#btn-page-prev'),
      btnNext: $('#btn-page-next'),
      chapPrev: $('#btn-chap-prev'),
      chapNext: $('#btn-chap-next'),
      toc: $('#btn-toc'),
    };
    this.tts = new TTSManager();
    this.savePos = debounce(() => this._persistPosition(), 500);
    this._bindUI();
  }

  /* ---------- 打开 / 关闭 ---------- */
  async openBook(book) {
    this.stopReading();
    this.book = book;
    this.chapters = await this.data.loadChapters(book.id);
    this._pagesCache.clear();
    this.el.root.classList.add('show');
    this.el.empty.style.display = 'none';
    this.el.title.textContent = book.title || I18N.t('untitled');
    this.bus.emit('books:changed');
    // 等待一帧让布局生效后再测量分页
    await new Promise(r => requestAnimationFrame(() => r()));
    await new Promise(r => requestAnimationFrame(() => r()));
    this._refreshMetrics();
    // 恢复上次阅读位置
    const pos = await this.data.getPosition(book.id);
    if (pos && pos.chapterIndex < this.chapters.length) {
      const prefix = this._prefixChars(pos.chapterIndex);
      await this.gotoChapter(pos.chapterIndex, -1, pos.charOffset != null ? pos.charOffset - prefix : -1);
    } else {
      await this.gotoChapter(0, 0);
    }
    this.bus.emit('reader:open', { book });
  }

  closeBook() {
    this.stopReading();
    this.book = null;
    this.chapters = null;
    this.el.root.classList.remove('show');
    this.el.empty.style.display = '';
    this.bus.emit('reader:close');
  }

  /* ---------- 度量与排版 ---------- */
  _refreshMetrics() {
    const content = this.el.content;
    const cs = getComputedStyle(content);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    this._metrics = {
      pageW: content.clientWidth - padL - padR,
      pageH: content.clientHeight - padT - padB,
    };
  }

  _pagerFor() {
    const s = this.settings;
    return new ChapterPager({
      pageW: Math.max(200, this._metrics.pageW),
      pageH: Math.max(200, this._metrics.pageH),
      vPad: 20,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      fontFamily: s.fontFamily,
      breaker: this.breaker,
    });
  }

  async _ensurePages(chapterIndex) {
    if (this._pagesCache.has(chapterIndex)) return this._pagesCache.get(chapterIndex);
    const chapter = this.chapters[chapterIndex];
    const result = await this._pagerFor().paginate(chapter.paras);
    this._pagesCache.set(chapterIndex, result);
    // 只保留最近 3 章的分页缓存，防止内存膨胀
    if (this._pagesCache.size > 3) {
      for (const key of this._pagesCache.keys()) {
        if (key !== this.chapterIndex && key !== this.chapterIndex + 1 && key !== this.chapterIndex - 1) {
          this._pagesCache.delete(key);
        }
      }
    }
    return result;
  }

  _prefixChars(chapterIndex) {
    let n = 0;
    const chars = this.book.chapterChars || [];
    for (let i = 0; i < chapterIndex && i < chars.length; i++) n += chars[i] || 0;
    return n;
  }
  get _totalChars() { return this.book.totalChars || this.book.chapterChars.reduce((n, c) => n + c, 0) || 1; }

  /* ---------- 导航 ---------- */
  async gotoChapter(index, pageIndex = 0, charOffsetInChapter = -1) {
    if (!this.chapters || !this.chapters.length) return;
    index = clampNum(index, 0, this.chapters.length - 1);
    this.chapterIndex = index;
    // 顶部标题只显示章节名（书名由侧栏与状态栏展示）
    this.el.title.textContent = this.chapters[index].title || '';
    const { pages } = await this._ensurePages(index);
    let target = 0;
    if (pageIndex >= 0 && pageIndex < pages.length) {
      target = pageIndex;
    } else if (charOffsetInChapter >= 0 && pages.length > 1) {
      target = this._pageForCharOffset(pages, charOffsetInChapter);
    }
    this.pageIndex = target;
    this._render();
    this._afterNav();
  }

  _pageForCharOffset(pages, offset) {
    let best = 0;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].startChar <= offset) best = i; else break;
    }
    return best;
  }

  async nextPage() {
    if (!this.book) return;
    const { pages } = await this._ensurePages(this.chapterIndex);
    if (this.pageIndex < pages.length - 1) { this.pageIndex++; this._render(); this._afterNav(); }
    else if (this.chapterIndex < this.chapters.length - 1) { await this.gotoChapter(this.chapterIndex + 1, 0); }
    else { toast(I18N.t('lastPage')); }
  }
  async prevPage() {
    if (!this.book) return;
    if (this.pageIndex > 0) { this.pageIndex--; this._render(); this._afterNav(); }
    else if (this.chapterIndex > 0) {
      const { pages } = await this._ensurePages(this.chapterIndex - 1);
      await this.gotoChapter(this.chapterIndex - 1, pages.length - 1);
    } else { toast(I18N.t('firstPage')); }
  }
  async nextChapter() {
    if (this.chapterIndex < this.chapters.length - 1) await this.gotoChapter(this.chapterIndex + 1, 0);
    else toast(I18N.t('lastChapter'));
  }
  async prevChapter() {
    if (this.chapterIndex > 0) await this.gotoChapter(this.chapterIndex - 1, 0);
    else toast(I18N.t('firstChapter'));
  }

  /* 按全书百分比跳转（0~1） */
  async gotoPercent(p) {
    const chars = this.book.chapterChars || [];
    let target = Math.round(p * this._totalChars);
    let ci = 0;
    for (let i = 0; i < chars.length; i++) {
      if (target <= chars[i]) { ci = i; break; }
      target -= chars[i];
      ci = i + 1;
    }
    ci = clampNum(ci, 0, this.chapters.length - 1);
    await this.gotoChapter(ci, -1, target);
  }

  /* ---------- 渲染 ---------- */
  _render() {
    const chapter = this.chapters[this.chapterIndex];
    if (!chapter) return;
    const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [] };
    const page = pages[this.pageIndex] || pages[0];
    const root = this.el.content;
    root.textContent = '';
    if (!page) return;
    const frag = document.createDocumentFragment();
    let cur = null;
    for (let li = 0; li < page.lines.length; li++) {
      const ln = page.lines[li];
      // 隐藏音标/词性时：正文中形如 "/音标/ 词性. " 的前缀一并过滤（仅影响显示；
      // 原文与划词定位(TTS、dataset)不变，词典联动取过滤后的干净词）
      const raw = chapter.paras[ln.p].slice(ln.s, ln.e);
      const text = (this.settings && this.settings.showPhonetic === false)
        ? raw.replace(/\/[^/]*\/\s*[a-z]{1,6}\.\s+/gi, '')
        : raw;
      if (!cur || cur.p !== ln.p) {
        cur = { p: ln.p };
        const el = document.createElement('p');
        el.className = 'para';
        el.dataset.p = ln.p; el.dataset.s = ln.s; el.dataset.e = ln.e;
        el.textContent = text;
        frag.appendChild(el);
      } else {
        const el = frag.lastElementChild;
        el.dataset.e = ln.e;
        el.textContent += text;
      }
    }
    root.appendChild(frag);
    // 中间过渡段落（跨页段落在上/下页有接续）给出更紧凑间距
    this._tightenBoundaryParas(page);
    // 折衷保障（零移行、零重排）：仅一次轻量测量——若本页真实渲染高度超出可视区
    // （浏览器断行/行高与估算的残余偏差），允许页内向下滚动看全最后一行；
    // 正常页不加 can-scroll，外观与交互完全不变
    const c = this.el.content;
    c.scrollTop = 0;
    c.classList.toggle('can-scroll', c.scrollHeight > c.clientHeight + 1);
  }

  /** 跨页段落首行/末行排版微调（可读性） */
  _tightenBoundaryParas(page) {
    const els = this.el.content.querySelectorAll('.para');
    for (const el of els) {
      const p = +el.dataset.p;
      const len = this.chapters[this.chapterIndex].paras[p].length;
      const fullStart = +el.dataset.s === 0;
      const fullEnd = +el.dataset.e >= len;
      if (!fullStart || !fullEnd) el.classList.add('tight');
    }
  }

  _currentBookPercent() {
    const prefix = this._prefixChars(this.chapterIndex);
    const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [{ startChar: 0 }] };
    const page = pages[this.pageIndex] || pages[0];
    return clampNum((prefix + page.startChar) / Math.max(1, this._totalChars), 0, 1);
  }

  _afterNav() {
    const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [] };
    this.el.pageLabel.textContent = `${this.pageIndex + 1} / ${pages.length || 1}`;
    const p = this._currentBookPercent();
    this.el.percent.textContent = Math.round(p * 100) + '%';
    // 手机端专属百分比（位于「上一章«」左侧）与桌面 #rt-percent 同步
    const pm = document.getElementById('rt-percent-m');
    if (pm) pm.textContent = Math.round(p * 100) + '%';
    this.bus.emit('reader:page', {
      bookId: this.book.id,
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      percent: p,
      title: this.chapters[this.chapterIndex].title,
    });
    this.savePos();
  }

  _persistPosition() {
    if (!this.book) return;
    const prefix = this._prefixChars(this.chapterIndex);
    const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [{ startChar: 0 }] };
    const page = pages[this.pageIndex] || pages[0];
    const percent = this._currentBookPercent();
    this.data.savePosition({
      bookId: this.book.id,
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      percent,
      charOffset: prefix + page.startChar,
    });
  }

  /* ---------- 设置应用 ---------- */
  applySettings(settings) {
    this.settings = settings;
    const content = this.el.content;
    content.style.setProperty('--font-size', settings.fontSize + 'px');
    content.style.setProperty('--reader-line-height', settings.lineHeight);
    content.style.fontFamily =
      settings.fontFamily === 'kai' ? '"KaiTi","STKaiti","Kaiti SC",serif' :
      settings.fontFamily === 'sans' ? '"PingFang SC","Microsoft YaHei",sans-serif' :
      '"Songti SC","Noto Serif CJK SC","SimSun",serif';
    content.style.width = settings.pageWidth + '%';
    content.classList.toggle('no-indent', !settings.indent);
    this.hotZonesOn = !!settings.hitZone;
    this.tts.setRate(settings.ttsRate);
    this.tts.setVoice(settings.ttsVoice);
    if (this.book && this._metrics) {
      this._refreshMetrics();
      // 重新分页并按字符偏移恢复位置
      const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [] };
      const page = pages[this.pageIndex] || pages[0];
      const posOffset = page ? page.startChar : 0;
      this._pagesCache.clear();
      this.gotoChapter(this.chapterIndex, -1, posOffset);
    }
  }

  /* ---------- 划词 ---------- */
  /** 由 App 注入: (text, type /* 'translate'|'speak'|'copy' *\/) => void */
  onSelectionAction = null;

  /* ---------- TTS 朗读 ---------- */
  startReading() {
    if (!this.settings) return;
    if (!this.tts.supported) { toast(I18N.t('noTts'), true); return; }
    this.stopReading();
    this.reading = true;
    this._syncTtsUI();
    this._readCurrentPage();
  }
  stopReading() {
    this.reading = false;
    this.tts.stop();
    this.el.content.querySelectorAll('.para-tts').forEach(el => el.classList.remove('para-tts'));
    this._syncTtsUI();
  }
  _syncTtsUI() {
    this.el.ttsPlay.textContent = this.reading ? '⏹' : '▶';
    this.bus.emit('tts:state', { reading: this.reading });
  }

  async _readCurrentPage() {
    if (!this.book || !this.chapters) { toast(I18N.t('noBook')); return this.stopReading(); }
    const chapter = this.chapters[this.chapterIndex];
    const { pages } = this._pagesCache.get(this.chapterIndex) || { pages: [] };
    const page = pages[this.pageIndex];
    if (!page) return this.stopReading();
    // 合并本页段落（跨页段落只读本页部分）
    const groups = [];
    for (const ln of page.lines) {
      const last = groups[groups.length - 1];
      // 朗读内容与正文显示一致：隐藏音标/词性时同样过滤 "/音标/ 词性. " 前缀
      const raw = chapter.paras[ln.p].slice(ln.s, ln.e);
      const text = (this.settings && this.settings.showPhonetic === false)
        ? raw.replace(/\/[^/]*\/\s*[a-z]{1,6}\.\s+/gi, '')
        : raw;
      if (last && last.p === ln.p) last.text += text;
      else groups.push({ p: ln.p, text });
    }
    for (const g of groups) {
      if (!this.reading) return;
      const sentences = splitSentences(g.text);
      for (const s of sentences) {
        if (!this.reading) return;
        await this._speakAndWait(s, g.p);
      }
    }
    if (!this.reading) return;
    if (this.pageIndex < pages.length - 1) {
      this.pageIndex++;
      this._render();
      this._afterNav();
      await this._readCurrentPage();
    } else if (this.chapterIndex < this.chapters.length - 1) {
      await this.gotoChapter(this.chapterIndex + 1, 0);
      await this._readCurrentPage();
    } else {
      toast(I18N.t('bookFinished'));
      this.stopReading();
    }
  }
  _speakAndWait(text, paraIndex) {
    return new Promise(resolve => {
      this.tts.enqueue(text, {
        onstart: () => {
          this.el.content.querySelectorAll('.para-tts').forEach(el => el.classList.remove('para-tts'));
          const el = this.el.content.querySelector(`.para[data-p="${paraIndex}"]`);
          if (el) el.classList.add('para-tts');
          this.bus.emit('tts:state', { reading: true, paraIndex });
        },
        onend: resolve,
      });
    });
  }

  /* ---------- UI 事件 ---------- */
  _bindUI() {
    this.el.btnPrev.onclick = () => this.prevPage();
    this.el.btnNext.onclick = () => this.nextPage();
    this.el.chapPrev.onclick = () => this.prevChapter();
    this.el.chapNext.onclick = () => this.nextChapter();
    this.el.toc.onclick = () => this.bus.emit('reader:toc-open');
    // 播放按钮即开关：未在朗读 → 开始；朗读中 → 停止（按钮图标 ⏹ 提示当前状态）
    this.el.ttsPlay.onclick = () => { this.reading ? this.stopReading() : this.startReading(); };
    // 全局键盘翻页（输入框/弹窗打开时不劫持按键）
    window.addEventListener('keydown', e => this._onKey(e));

    // 点击翻页热区：不用覆盖层（会挡住文本选取、显示手掌光标），
    // 改为正文上的 click 按横坐标判定（左 26% 上页 / 右 26% 下页）
    this.el.content.addEventListener('click', e => {
      // 本次点击用于「关闭弹出的面板」（App 在 pointerdown 关闭时置位）：只关面板、不翻页
      if (this._suppressPageTurn) { this._suppressPageTurn = false; return; }
      if (!this.hotZonesOn || this._hasSelection()) return;
      const r = this.el.content.getBoundingClientRect();
      const rel = (e.clientX - r.left) / Math.max(1, r.width);
      if (rel < 0.26) this.prevPage();
      else if (rel > 0.74) this.nextPage();
    });

    // 触摸滑动
    let tx = 0, ty = 0;
    $('#page-frame').addEventListener('touchstart', e => {
      const t = e.touches[0]; tx = t.clientX; ty = t.clientY;
    }, { passive: true });
    $('#page-frame').addEventListener('touchend', e => {
      const t = e.changedTouches[0];
      const dx = t.clientX - tx, dy = t.clientY - ty;
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4 && !this._hasSelection()) {
        // 本页内容超出可视区（可页内滚动看全）且尚未滚到底时：横向滑动留给查看剩余内容，不翻页
        const c = this.el.content;
        if (c.classList.contains('can-scroll') && c.scrollHeight - c.scrollTop - c.clientHeight > 8) return;
        dx < 0 ? this.nextPage() : this.prevPage();
      }
    }, { passive: true });

    // 划词弹层（移动端：抑制系统菜单，自绘 翻译 / 朗读 / 复制 工具栏）
    this._popupAt = 0;
    this.el.content.addEventListener('mouseup', e => this._maybeShowSelection(e));
    this.el.content.addEventListener('touchend', e => setTimeout(() => this._maybeShowSelection(e), 120), { passive: true });
    // Android 长按会触发 contextmenu：有选区时拦截，改弹自绘工具栏
    this.el.content.addEventListener('contextmenu', e => {
      if (this._hasSelection()) {
        e.preventDefault();
        this._maybeShowSelection({ clientX: e.clientX, clientY: e.clientY });
      }
    });
    document.addEventListener('mousedown', e => {
      // 触摸结束后的“合成 mousedown”会晚于自绘工具栏弹出，忽略该窗口期内的收起
      if (Date.now() - this._popupAt < 450) return;
      if (!$('#sel-popup').contains(e.target)) this._hideSelection();
    });

    window.addEventListener('resize', debounce(() => {
      if (this.book) this.applySettings(this.settings);
    }, 280));
  }
  _hasSelection() { const s = window.getSelection(); return s && s.toString().trim().length > 0; }
  _onKey(e) {
    if (!this.book) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // 有弹窗打开时不翻页
    for (const m of document.querySelectorAll('.modal-backdrop')) {
      if (m.style.display !== 'none') return;
    }
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); this.nextPage(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); this.prevPage(); }
    else if (k === 'Home') { e.preventDefault(); this.gotoChapter(this.chapterIndex, 0); }
    else if (k === 'End') { e.preventDefault(); this.gotoChapter(this.chapterIndex, 1e9); }
  }
  _maybeShowSelection(e) {
    const sel = window.getSelection();
    if (!sel) return;
    const text = sel.toString().trim();
    const anchor = sel.anchorNode;
    if (text.length === 0 || text.length > 500) return this._hideSelection();
    if (anchor && this.el.content.contains(anchor)) {
      const action = (this.settings && this.settings.selAction) || 'popup';
      if (action === 'auto') {
        if (this.onSelectionAction) this.onSelectionAction(text, 'translate', true);
        return;
      }
      const popup = $('#sel-popup');
      popup.innerHTML = '';
      const mk = (label, type) => {
        const b = document.createElement('button');
        b.className = 'sp-btn'; b.textContent = label;
        b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); this._hideSelection(); if (this.onSelectionAction) this.onSelectionAction(text, type); };
        popup.appendChild(b);
      };
      mk(I18N.t('selTranslate'), 'translate');
      mk(I18N.t('selSpeak'), 'speak');
      const sep = document.createElement('span'); sep.className = 'sp-sep'; popup.appendChild(sep);
      mk(I18N.t('selCopy'), 'copy');
      const x = e.clientX || (this.el.content.clientWidth / 2), y = e.clientY || 100;
      popup.style.left = x + 'px';
      popup.style.top = y + 'px';
      popup.classList.add('show');
      this._popupAt = Date.now();
    } else {
      this._hideSelection();
    }
  }
  _hideSelection() {
    $('#sel-popup').classList.remove('show');
    if (typeof window.getSelection === 'function') {
      try { /* 保留选区，仅隐藏弹层 */ } catch (e) { /* noop */ }
    }
  }
}

/** 把长文本切分为句子（用于朗读队列） */
function splitSentences(text) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if ('。！？!?；;…\n'.includes(ch) || cur.length >= 60) { out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  if (!out.length && text) out.push(text);
  return out;
}


/* ---------- 12. 备份管理 BackupManager（迁移：导出 / 导入） ---------- */
const APP_VERSION = '1.0.0';

class BackupManager {
  constructor(data) { this.data = data; }

  /** 导出：打包全部书籍内容 + 进度 + 设置为一个 JSON 文件 */
  async export() {
    const prog = progressUI();
    prog.show(I18N.t('progCollect')); prog.set(0.15); prog.setSub(I18N.t('progReadDb'));
    const data = await this.data.exportAll();
    prog.set(0.7); prog.setSub(I18N.t('progPackJson'));
    const chapters = data.chapters.reduce((n, c) => n + (c.items ? c.items.length : 0), 0);
    const payload = {
      app: 'Offline Novel Reader',
      appVersion: APP_VERSION,
      schema: 1,
      exportedAt: nowStamp(),
      counts: {
        books: data.books.length,
        chapters,
        positions: data.positions.length,
        settings: data.settings.length,
        totalChars: data.books.reduce((n, b) => n + (b.totalChars || 0), 0),
      },
      data,
    };
    await new Promise(r => setTimeout(r, 30)); // 让进度渲染一下
    prog.set(0.9);
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: 'application/json' });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `novel-reader-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    downloadBlob(name, blob);
    prog.done();
    return { name, counts: payload.counts };
  }

  /** 解析备份文件 */
  parse(text) {
    let payload;
    try { payload = JSON.parse(text); } catch (e) { throw new Error(I18N.t('errBackupJson')); }
    if (!payload || payload.schema !== 1 || !payload.data || !Array.isArray(payload.data.books)) {
      throw new Error(I18N.t('errBackupSchema'));
    }
    return payload;
  }

  /** 导入: mode = 'merge'(合并去重) | 'overwrite'(覆盖) */
  async import(payload, mode, onTick) {
    const prog = progressUI();
    prog.show(mode === 'overwrite' ? I18N.t('progOverwrite') : I18N.t('progMerge'));
    prog.set(0.1);
    prog.setSub(I18N.t('progBooks', { n: payload.data.books.length }));
    const report = await this.data.importAll(payload.data, mode, onTick);
    prog.set(1); prog.done();
    return report;
  }

  static summarize(data) {
    return {
      books: (data.books || []).length,
      chapters: (data.chapters || []).reduce((n, c) => n + (c.items ? c.items.length : 0), 0),
      positions: (data.positions || []).length,
    };
  }
}

/* ---------- 13. 应用门面 App（Facade：组装各模块 + 绑定 UI） ---------- */
class App {
  constructor() {
    this.bus = new EventBus();
    this.settings = { ...App.DEFAULT_SETTINGS };
    this._activeBookId = null;
    this._searchTerm = '';
  }

  static get DEFAULT_SETTINGS() {
    return {
      lang: '',           // '' = 跟随浏览器语言自动检测
      theme: 'light',
      fontSize: 18,
      lineHeight: 1.9,
      fontFamily: 'serif',
      pageWidth: 84,
      hitZone: true,
      indent: true,
      selAction: 'popup',
      showPhonetic: true,   // 英译中词条是否显示「音标+词性」前缀（Aa 开关）
      ttsRate: 1,
      ttsVoice: '',
    };
  }

  async init() {
    // ---- 存储层（IndexedDB 优先，localStorage 降级）----
    this.adapter = await App._pickAdapter();
    this.data = new DataManager(this.adapter, this.bus);
    this.data._worker = TextWorker.create();

    // ---- 设置 ----
    for (const key of Object.keys(App.DEFAULT_SETTINGS)) {
      this.settings[key] = await this.data.getSetting(key, App.DEFAULT_SETTINGS[key]);
    }
    // ---- 界面语言（设置优先，未设置时跟随浏览器语言）----
    const detect = () => (navigator.language || navigator.languages?.[0] || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    I18N.lang = (this.settings.lang === 'zh' || this.settings.lang === 'en') ? this.settings.lang : detect();
    if (this.settings.lang !== I18N.lang) {
      this.settings.lang = I18N.lang;
      this.data.setSetting('lang', I18N.lang).catch(() => {});
    }
    I18N.applyStatic();
    this._applySettings();

    // ---- 词典（离线策略注册表 + 自定义词条）----
    const custom = await this.data.getSetting('customDict', []);
    this.dict = new DictionaryService(this.bus);
    await this.dict.init(custom);
    this.backup = new BackupManager(this.data);

    // ---- 阅读器 ----
    this.reader = new Reader(this.bus);
    this.reader.data = this.data;
    this.reader.settings = this.settings;
    this.reader.onSelectionAction = (text, type, auto) => this._handleSelection(text, type, auto);
    this.reader.applySettings(this.settings);

    // ---- 事件与 UI ----
    this._wireBus();
    this._buildDictPanel();
    this._bindUI();
    this._syncPhoneticUI();
    await this.refreshBooks();

    // ---- 状态栏 ----
    $('#st-db').textContent = this.adapter.mode === 'indexeddb' ? I18N.t('stDbIdb') : I18N.t('stDbLs');
    $('#st-worker').textContent = I18N.t('stWorker', { m: I18N.t(this.data._worker.available ? 'workerReady' : 'workerMain') });
    $('#st-book').textContent = I18N.t('noBook');
    this._fillRateSelect('#tts-rate');
    this._fillSettingSelects();
    this._voices = [];
    this.reader.tts.onVoices(voices => { this._voices = voices; this._fillVoiceSelect(voices); });

    // ---- 恢复上次阅读的书籍 ----
    const lastId = await this.data.getSetting('lastBookId', null);
    if (lastId) {
      const book = await this.data.getBook(lastId);
      if (book) await this.openBook(book.id);
    }

    document.body.dataset.ready = '1';
    console.info(`[NovelReader] v${APP_VERSION} 就绪 · 存储: ${this.adapter.mode}`);
  }

  static async _pickAdapter() {
    try {
      const a = new IndexedDBAdapter();
      await a.init();
      return a;
    } catch (e) {
      console.warn('IndexedDB 不可用，降级为 localStorage：', e);
    }
    try {
      return new LocalStorageAdapter();
    } catch (e) {
      toast(I18N.t('noStorage'), true, 6000);
      throw e;
    }
  }

  /* ---------- 设置 ---------- */
  async setSetting(key, value) {
    this.settings[key] = value;
    await this.data.setSetting(key, value);
    // 仅影响阅读排版的设置需要重排页面；其余即时生效即可
    const layoutKeys = new Set(['theme', 'fontSize', 'lineHeight', 'fontFamily', 'pageWidth', 'hitZone', 'indent']);
    if (layoutKeys.has(key)) {
      this._applySettings();
    } else if (key === 'ttsRate') {
      this.reader.tts.setRate(value);
      this._syncSettingsDialog();
    } else if (key === 'ttsVoice') {
      this.reader.tts.setVoice(value);
    } else {
      this._syncSettingsDialog();
    }
  }
  _applySettings() {
    document.body.dataset.theme = this.settings.theme;
    if (this.reader) this.reader.applySettings(this.settings);
    this._syncSettingsDialog();
  }
  _syncSettingsDialog() {
    $('#set-theme').value = this.settings.theme;
    $('#set-fontsize').value = String(this.settings.fontSize);
    $('#set-lineheight').value = String(this.settings.lineHeight);
    $('#set-fontfamily').value = this.settings.fontFamily;
    $('#set-pagewidth').value = String(this.settings.pageWidth);
    $('#set-hitzone').checked = !!this.settings.hitZone;
    $('#set-indent').checked = !!this.settings.indent;
    $('#set-selaction').value = this.settings.selAction;
  }

  /* ---------- 书库 ---------- */
  async refreshBooks() {
    const books = await this.data.listBooks();
    this._books = books;
    this._renderBookList();
  }

  _renderBookList() {
    const ul = $('#book-list');
    const term = this._searchTerm.trim().toLowerCase();
    ul.innerHTML = '';
    for (const b of this._books) {
      if (term && !(b.title || '').toLowerCase().includes(term) && !(b.author || '').toLowerCase().includes(term)) continue;
      const li = document.createElement('li');
      li.className = 'book-item' + (b.id === this._activeBookId ? ' active' : '');
      li.dataset.id = b.id;
      const pct = Math.round((b.percent || 0) * 100);
      const first = (b.title || I18N.t('bookCover')).trim().charAt(0) || I18N.t('bookCover');
      const meta = [
        b.chapterCount ? I18N.t('metaChap', { n: b.chapterCount }) : '',
        I18N.t('metaChars', { n: fmtNum(b.totalChars) }),
        pct > 0 ? I18N.t('metaRead', { p: pct }) : I18N.t('metaUnread'),
        b.lastReadAt ? App._timeAgo(b.lastReadAt) : '',
      ].filter(Boolean).join(' · ');
      li.innerHTML = `
        <div class="cover">${escapeHtml(first)}</div>
        <div class="info">
          <div class="b-title">${escapeHtml(b.title || I18N.t('untitled'))}</div>
          <div class="b-meta">${escapeHtml(meta)}</div>
          <div class="b-progress"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>
        </div>
        <button class="b-del" title="${I18N.t('delBookTitle')}">✕</button>
      `;
      li.onclick = (e) => {
        if (e.target.closest('.b-del')) return;
        this.openBook(b.id);
      };
      li.querySelector('.b-del').onclick = (e) => {
        e.stopPropagation();
        this._deleteBook(b);
      };
      ul.appendChild(li);
    }
    if (!ul.children.length) {
      ul.innerHTML = '<li style="padding:18px 12px;color:var(--muted);font-size:12.5px;line-height:1.8">'
        + (this._searchTerm ? I18N.t('listEmptySearch') : I18N.t('listEmptyHtml'))
        + '</li>';
    }
  }
  static _timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return I18N.t('timeAgoJust');
    if (diff < 3600000) return I18N.t('timeAgoMin', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return I18N.t('timeAgoHour', { n: Math.floor(diff / 3600000) });
    return I18N.t('timeAgoDay', { n: Math.floor(diff / 86400000) });
  }

  async openBook(id) {
    const book = await this.data.getBook(id);
    if (!book) { toast(I18N.t('bookMissing'), true); return; }
    this._activeBookId = id;
    this.data.setSetting('lastBookId', id).catch(() => {});
    this._renderBookList();
    await this.reader.openBook(book);
    // 打开书籍后收起书库面板（移动端抽屉）
    $('#sidebar').classList.remove('open');
    $('#st-book').textContent = book.title;
    this.bus.emit('app:book-open', book);
  }

  async _deleteBook(book) {
    const ok = await confirmDialog({
      title: I18N.t('deleteTitle'),
      message: I18N.t('deleteMsgHtml', { title: escapeHtml(book.title) }),
      okText: I18N.t('deleteOk'), danger: true,
    });
    if (!ok) return;
    await this.data.deleteBook(book.id);
    if (this._activeBookId === book.id) {
      this._activeBookId = null;
      this.reader.closeBook();
      $('#st-book').textContent = I18N.t('noBook');
    }
    await this.refreshBooks();
    toast(I18N.t('deletedMsg', { title: book.title }));
  }

  /* ---------- 导入小说 ---------- */
  async importFiles(files) {
    let lastBook = null;
    const list = [...files].filter(f => /\.(txt|md|text)$/i.test(f.name) || f.type.startsWith('text/'));
    if (!list.length) { toast(I18N.t('noTxtFiles'), true); return; }
    const prog = progressUI();
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      prog.show(I18N.t('importing', { a: i + 1, b: list.length }));
      prog.setSub(f.name);
      prog.set((i) / Math.max(1, list.length));
      try {
        const buf = await f.arrayBuffer();
        const { text, encoding } = decodeTextBytes(buf);
        const title = f.name.replace(/\.(txt|md|text)$/i, '').trim() || I18N.t('untitled');
        const book = await this._importText({ title, sourceName: f.name, text, encoding });
        if (book) lastBook = book;
      } catch (e) {
        console.error(e);
        toast(I18N.t('importFail', { name: f.name, msg: e.message }), true);
      }
    }
    prog.set(1); prog.done();
    await this.refreshBooks();
    if (lastBook) await this.openBook(lastBook.id);
  }

  async _importText({ title, sourceName, text, encoding }) {
    const { duplicate, book } = await this.data.importText({ title, sourceName, text });
    if (duplicate) {
      const ok = await confirmDialog({
        title: I18N.t('dupTitle'),
        message: I18N.t('dupMsgHtml', { title: escapeHtml(book.title) }),
        okText: I18N.t('dupOk'), danger: true,
      });
      if (!ok) return null;
      await this.data.replaceBook({ id: book.id, title, sourceName, text });
      toast(I18N.t('reimported', { title }));
      return { id: book.id, title };
    }
    toast(I18N.t('imported', { title }));
    return { id: book.id, title };
  }

  /* ---------- 划词操作 ---------- */
  _handleSelection(text, type, auto) {
    switch (type) {
      case 'translate':
        this._openDictPanel(text, 'translate', auto);
        break;
      case 'speak':
        this._speakSelection(text);
        break;
      case 'copy':
        navigator.clipboard && navigator.clipboard.writeText(text)
          .then(() => toast(I18N.t('copied')))
          .catch(() => { window.prompt(I18N.t('copyPrompt'), text); });
        break;
    }
  }
  _speakSelection(text) {
    if (!this.reader.tts.supported) { toast(I18N.t('noTts'), true); return; }
    this.reader.stopReading();
    this.reader.tts.speakOnce(text, this.settings.ttsRate, this.settings.ttsVoice, () => {});
    toast(I18N.t('speakingSel'));
  }

  /* ---------- 词典面板 ---------- */
  _renderDictTabs() {
    const tabs = $('#dict-tabs');
    tabs.innerHTML = '';
    for (const d of DictionaryService.DICTS) {
      const b = document.createElement('button');
      b.className = 'tab'; b.dataset.dict = d.id;
      b.textContent = I18N.t('d_' + d.id);
      b.title = I18N.t('d_hint_' + d.id);
      b.onclick = () => { this._dictActive = d.id; this._dictMode = ''; this._renderDict(); };
      tabs.appendChild(b);
    }
    if (!this._dictActive) this._dictActive = 'en2cn';
    $$('#dict-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.dict === this._dictActive));
  }
  _buildDictPanel() {
    this._dictActive = this._dictActive || 'en2cn';
    this._dictQuery = '';
    this._renderDictTabs();
    $('#dict-close').onclick = () => $('#dict-panel').classList.remove('open');
    $('#dict-go').onclick = () => this._runDictQuery($('#dict-input').value);
    $('#dict-input').addEventListener('keydown', e => { if (e.key === 'Enter') this._runDictQuery(e.target.value); });
  }

  /** 界面语言切换（中 / EN） */
  async _switchLang() {
    const next = I18N.lang === 'zh' ? 'en' : 'zh';
    I18N.lang = next;
    this.settings.lang = next;
    try { await this.data.setSetting('lang', next); } catch (e) { /* 设置项保底失败不阻塞切换 */ }
    I18N.applyStatic();
    this._renderBookList();            // 书库空状态 / 元信息文案
    this._renderDictTabs();            // 词典标签
    this._renderDict();                // 当前查询结果文案
    this._fillVoiceSelect(this._voices || []); // 默认发音人
    $('#st-book').textContent = this.reader.book ? this.reader.book.title : I18N.t('noBook');
    $('#st-tts').textContent = this.reader.reading ? I18N.t('stReading') : '';
    if ($('#dlg-chapters').style.display !== 'none') this._openToc();
  }

  _openDictPanel(text, mode, auto) {
    this._dictMode = mode;
    this._dictQuery = text;
    $('#dict-input').value = text;
    $('#dict-panel').classList.add('open');
    const mo = $('#more-overlay'); if (mo) mo.classList.remove('show');
    // 清掉正文残留选区，避免随后触摸再次弹出划词工具栏
    try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (e) { /* noop */ }
    this._renderDict();
  }

  _runDictQuery(text) {
    text = (text || '').trim();
    if (!text) { toast(I18N.t('dictNeedQuery')); return; }
    this._dictMode = '';   // 手动查询：回到「查词/翻译」视图
    this._dictQuery = text;
    this._renderDict();
  }

  /** 「更多功能」面板的低频动作（对应按钮 data-action） */
  _moreAction(action) {
    if (action === 'help') { $('#dlg-help').style.display = 'flex'; }
    else if (action === 'phonetic') { this._togglePhonetic(); }
    else if (action === 'export') { this.exportBackup(); }
    else if (action === 'import-backup') { $('#backup-input').click(); }
    else if (action === 'paste') { $('#dlg-paste').style.display = 'flex'; }
    else if (action === 'import') { $('#file-input').click(); }
    else if (action === 'lang') { this._switchLang(); }
  }

  /** 音标+词性过滤：隐藏时去掉 en2cn 词条开头的 /音标/词性. 前缀 */
  _fmtGloss(gloss) {
    if (this.settings.showPhonetic) return gloss;
    return String(gloss || '').replace(/^\/[^/]*\/\s*[a-z]{1,6}\.\s*/i, '');
  }

  _togglePhonetic() {
    this.settings.showPhonetic = !this.settings.showPhonetic;
    this.data.setSetting('showPhonetic', this.settings.showPhonetic).catch(() => {});
    this._syncPhoneticUI();
    // 词典面板即时刷新（前缀过滤）
    this._renderDict();
    // 正文同样生效：重排重渲染当前章/页，过滤 "/音标/ 词性. " 前缀
    if (this.reader) this.reader.applySettings(this.settings);
    // 即时可见反馈，避免「点了没反应」的观感
    toast(this.settings.showPhonetic ? I18N.t('phOn') : I18N.t('phOff'));
  }

  _syncPhoneticUI() {
    const b = $('#btn-phonetic');
    if (b) b.classList.toggle('off', !this.settings.showPhonetic);
  }

  /** 按当前标签渲染词典结果 */
  _renderDict() {
    const q = (this._dictQuery || '').trim();
    const out = $('#dict-result');
    if (!q) {
      out.innerHTML = `<div class="dict-empty">${I18N.t('dictEmptyHtml')}</div>`;
      return;
    }
    $$('#dict-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.dict === this._dictActive));
    const lang = DictionaryService.detectLang(q);
    const trans = this.dict.translate(q);
    const explain = this.dict.explain(q);

    let html = '';
    // 来源文本
    html += `<div class="dict-src-text"><q>${escapeHtml(q.length > 120 ? q.slice(0, 120) + '…' : q)}</q></div>`;

    // 划词「翻译」按语言方向自动选择词典（中→英 / 英→中）；手动查词按当前标签
    const dictId = this._dictMode === 'translate' ? (trans.lang === 'cn' ? 'cn2en' : 'en2cn') : this._dictActive;
    // 查词视图：按方向/标签给出词典对照表
    if (dictId === 'en2cn') {
        if (trans.lang !== 'en') {
          html += `<div class="dict-empty">${I18N.t('dictEnEmpty')}</div>`;
        } else {
          html += `<div class="dict-title">${I18N.t('dictEnTitle', { hit: trans.segments.filter(s => s.gloss).length, total: trans.segments.length })}</div>`;
          html += trans.segments.filter(s => s.gloss).map(s =>
            `<div class="dict-entry"><span class="w">${escapeHtml(s.txt)}</span><span class="d">${escapeHtml(this._fmtGloss(s.gloss))}</span><span class="dict-tag">en2cn</span></div>`).join('');
          if (trans.unknown.length) html += `<div class="dict-title">${I18N.t('dictUnknown')}</div><p class="muted-text">${escapeHtml(trans.unknown.slice(0, 20).join(' / '))}</p>`;
        }
      } else if (dictId === 'cn2en') {
        if (trans.lang !== 'cn') {
          html += `<div class="dict-empty">${I18N.t('dictCnEmpty')}</div>`;
        } else {
          html += `<div class="dict-title">${I18N.t('dictCnTitle', { hit: trans.segments.filter(s => s.gloss).length, total: trans.segments.length })}</div>`;
          html += trans.segments.filter(s => s.gloss && s.dict === 'cn2en').map(s =>
            `<div class="dict-entry"><span class="w">${escapeHtml(s.txt)}</span><span class="d">${escapeHtml(s.gloss)}</span><span class="dict-tag">cn2en</span></div>`).join('');
        }
      } else if (dictId === 'zh') {
        if (lang !== 'cn') {
          html += `<div class="dict-empty">${I18N.t('dictZhEmpty')}</div>`;
        } else {
          // 用「中文释义」词典对查询做最长匹配，列出中文解释
          const items = [];
          const seen = new Set();
          for (let i = 0; i < q.length && items.length < 60; i++) {
            for (let L = Math.min(4, q.length - i); L >= 1; L--) {
              const w = q.slice(i, i + L);
              if (this.dict.maps.zh.has(w)) {
                if (!seen.has(w)) { seen.add(w); items.push({ w, g: this.dict.maps.zh.get(w) }); }
                break;
              }
            }
          }
          html += `<div class="dict-title">${I18N.t('dictZhTitle', { hit: items.length })}</div>`;
          if (!items.length) html += `<div class="dict-empty">${I18N.t('dictZhNone')}</div>`;
          else html += items.map(it =>
            `<div class="dict-entry"><span class="w">${escapeHtml(it.w)}</span><span class="d">${escapeHtml(it.g)}</span><span class="dict-tag">${I18N.t('tagZh')}</span></div>`).join('');
        }
      } else if (dictId === 'idioms') {
        const items = [];
        if (explain && explain.idiom) items.push(explain.idiom);
        if (q.length > 0) {
          // 在全文中扫描所有成语
          for (let i = 0; i < q.length; i++) {
            for (let L = 4; L >= 3; L--) {
              const w = q.slice(i, i + L);
              if (this.dict.maps.idioms.has(w)) items.push({ word: w, gloss: this.dict.maps.idioms.get(w) });
              if (items.length > 40) break;
            }
          }
        }
        // 去重
        const seen = new Set(); const uniq = items.filter(it => { if (seen.has(it.word)) return false; seen.add(it.word); return true; });
        if (!uniq.length) html += `<div class="dict-empty">${I18N.t('dictNoIdiom')}</div>`;
        else {
          html += `<div class="dict-title">${I18N.t('dictIdiomTitle', { n: uniq.length })}</div>`;
          html += uniq.map(it =>
            `<div class="dict-entry"><span class="w">${escapeHtml(it.word)}</span><span class="d">${escapeHtml(it.gloss)}</span><span class="dict-tag">${I18N.t('tagIdiom')}</span></div>`).join('');
        }
      } else if (dictId === 'chars') {
        if (lang !== 'cn') {
          html += `<div class="dict-empty">${I18N.t('charsCnOnly')}</div>`;
        } else {
          const uniq = [...new Set(q.replace(/\s+/g, '').split(''))];
          const withGloss = uniq.filter(c => this.dict.maps.chars.has(c));
          const without = uniq.filter(c => !this.dict.maps.chars.has(c));
          html += `<div class="dict-title">${I18N.t('charsTitle', { hit: withGloss.length, total: uniq.length })}</div>`;
          html += withGloss.map(c =>
            `<div class="dict-entry"><span class="w">${escapeHtml(c)}</span><span class="d">${escapeHtml(this.dict.maps.chars.get(c))}</span><span class="dict-tag">${I18N.t('tagChar')}</span></div>`).join('');
          if (without.length) html += `<div class="dict-title">${I18N.t('charsMissing')}</div><p class="muted-text">${escapeHtml(without.slice(0, 30).join(' '))}</p>`;
        }
      }
    html += this._renderCustomDict();
    out.innerHTML = html;
  }

  /** 自定义词条（写入 / 删除数据的功能演示） */
  _renderCustomDict() {
    const entries = this.dict.custom;
    let html = `<div class="dict-title">${I18N.t('customTitleHtml')}</div>`;
    html += `<div class="custom-entry">
      <input id="cd-word" placeholder="${I18N.t('cdWordPh')}" autocomplete="off">
      <input id="cd-gloss" placeholder="${I18N.t('cdGlossPh')}" autocomplete="off">
      <button id="cd-add" class="btn ghost" style="padding:6px 10px">${I18N.t('cdAdd')}</button>
    </div>`;
    if (entries.length) {
      html += entries.slice().reverse().map(e =>
        `<div class="custom-entry"><span class="w" style="min-width:80px">${escapeHtml(e.word)}</span><span class="d" style="flex:1">${escapeHtml(e.gloss)}</span><button data-del="${escapeHtml(e.word)}" style="color:var(--danger);font-size:13px;padding:4px 8px">${I18N.t('cdDel')}</button></div>`).join('');
    } else {
      html += `<p class="muted-text" style="font-size:12px">${I18N.t('cdEmpty')}</p>`;
    }
    // 事件在渲染后绑定
    setTimeout(() => this._bindCustomDictUI(), 0);
    return html;
  }
  _bindCustomDictUI() {
    const add = $('#cd-add');
    if (!add) return;
    add.onclick = async () => {
      const w = $('#cd-word').value.trim();
      const g = $('#cd-gloss').value.trim();
      if (!w || !g) { toast(I18N.t('cdFill')); return; }
      await this.dict.addCustomEntry(w, g);
      await this.data.setSetting('customDict', this.dict.custom);
      $('#cd-word').value = ''; $('#cd-gloss').value = '';
      this._renderDict();
      toast(I18N.t('cdAdded'));
    };
    $$('[data-del]').forEach(b => {
      b.onclick = async () => {
        await this.dict.removeCustomEntry(b.dataset.del);
        await this.data.setSetting('customDict', this.dict.custom);
        this._renderDict();
      };
    });
  }

  /* ---------- 备份 ---------- */
  async exportBackup() {
    try {
      const { name, counts } = await this.backup.export();
      toast(I18N.t('exportedMsg', { name, books: counts.books, chapters: counts.chapters, chars: fmtNum(counts.totalChars) }));
    } catch (e) {
      console.error(e);
      toast(I18N.t('exportFail', { msg: e.message }), true);
    }
  }

  async importBackupFile(file) {
    try {
      const text = await file.text();
      const payload = this.backup.parse(text);
      const sum = BackupManager.summarize(payload.data);
      const counts = payload.counts;

      const mode = await App._threeWay({
        title: I18N.t('importTitle'),
        message:
          I18N.t('bkFileHtml', { name: escapeHtml(file.name) }) +
          I18N.t('bkTimeHtml', { t: escapeHtml(payload.exportedAt || '—') }) +
          I18N.t('bkContainsHtml', { books: sum.books, chapters: sum.chapters, positions: sum.positions }) +
          (counts ? I18N.t('bkCharsHtml', { chars: fmtNum(counts.totalChars) }) : '') +
          I18N.t('bkMergeHtml') +
          I18N.t('bkOverwriteHtml'),
        okText: I18N.t('mergeOk'),
        extraText: I18N.t('overwriteExtra'),
      });
      if (!mode) return;
      if (mode === 'extra') {
        const c = await confirmDialog({
          title: I18N.t('confirmOverwriteTitle'),
          message: I18N.t('confirmOverwriteMsgHtml'),
          okText: I18N.t('confirmOverwriteOk'), danger: true,
        });
        if (!c) return;
      }
      const report = await this.backup.import(payload, mode === 'extra' ? 'overwrite' : 'merge');
      // 重新加载
      this._books = null;
      this.reader.closeBook();
      this._activeBookId = null;
      await this.refreshBooks();
      const lastId = await this.data.getSetting('lastBookId', null);
      if (lastId) {
        const book = await this.data.getBook(lastId);
        if (book) await this.openBook(book.id);
      }
      toast(I18N.t('importDone', { books: report.books, chapters: report.chapters, positions: report.positions, skipped: report.skipped }));
    } catch (e) {
      console.error(e);
      toast(I18N.t('importFail', { msg: e.message }), true);
    }
  }

  /** 三按钮选择框：resolve('ok' | 'extra' | false) */
  static _threeWay({ title, message, okText, extraText }) {
    return new Promise(resolve => {
      const dlg = $('#dlg-confirm');
      $('#cf-title').textContent = title;
      $('#cf-message').innerHTML = message;
      $('#cf-ok').textContent = okText;
      $('#cf-ok').className = 'btn primary';
      let extraBtn = $('#cf-extra');
      if (!extraBtn) {
        extraBtn = document.createElement('button');
        extraBtn.id = 'cf-extra';
        $('#cf-cancel').after(extraBtn);
      }
      extraBtn.textContent = extraText;
      extraBtn.className = 'btn danger';
      extraBtn.style.display = '';
      const close = v => {
        dlg.style.display = 'none';
        $('#cf-ok').onclick = $('#cf-cancel').onclick = extraBtn.onclick = null;
        resolve(v);
      };
      $('#cf-ok').onclick = () => close('ok');
      $('#cf-cancel').onclick = () => close(false);
      extraBtn.onclick = () => close('extra');
      dlg.style.display = 'flex';
    });
  }

  /* ---------- 目录 ---------- */
  _openToc() {
    if (!this.reader.book) return;
    const ul = $('#toc-list');
    ul.innerHTML = '';
    const titles = this.reader.book.chapterTitles || this.reader.chapters.map(c => c.title);
    $('#toc-title').textContent = I18N.t('tocTitle') + ' · ' + this.reader.book.title + ' (' + titles.length + ')';
    titles.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="ci">${i + 1}</span>${escapeHtml(t)}`;
      if (i === this.reader.chapterIndex) li.classList.add('current');
      li.onclick = () => {
        $('#dlg-chapters').style.display = 'none';
        this.reader.gotoChapter(i, 0);
      };
      ul.appendChild(li);
    });
    $('#dlg-chapters').style.display = 'flex';
  }

  /* ---------- 事件总线 ---------- */
  _wireBus() {
    this.bus.on('books:changed', () => this.refreshBooks());
    this.bus.on('reader:page', (info) => {
      $('#st-chapter').textContent = (info.title || '').slice(0, 30);
    });
    this.bus.on('reader:toc-open', () => this._openToc());
    this.bus.on('tts:state', (s) => {
      $('#st-tts').textContent = s.reading ? I18N.t('stReading') : '';
    });
    this.bus.on('settings:changed', () => { /* 已经即时应用 */ });
  }

  /* ---------- UI 事件绑定 ---------- */
  _bindUI() {
    // 书库图标 = 原 ☰ 的开关书库功能；菜单按钮已移除
    $('#tb-logo').onclick = () => $('#sidebar').classList.toggle('open');
    // 音标+词性显示开关（Aa）：隐藏时过滤 en2cn 词条中的 /音标/词性. 前缀
    $('#btn-phonetic').onclick = () => this._togglePhonetic();
    $('#btn-import').onclick = () => $('#file-input').click();
    // 粘贴导入 / 帮助弹窗：打开入口已移到「更多功能」面板（data-action），此处仅绑定关闭与点遮罩关闭
    bindModal($('#dlg-paste'));
    bindModal($('#dlg-help'));
    $('#paste-ok').onclick = async () => {
      const title = $('#paste-title').value.trim();
      const text = $('#paste-text').value;
      if (!title) { toast(I18N.t('needTitle')); return; }
      if (!text.trim()) { toast(I18N.t('needText')); return; }
      $('#dlg-paste').style.display = 'none';
      const book = await this._importText({ title, sourceName: I18N.t('pasteSource'), text });
      $('#paste-title').value = ''; $('#paste-text').value = '';
      await this.refreshBooks();
      if (book) await this.openBook(book.id);
    };
    // 导出备份 / 导入备份：入口已移到「更多功能」面板（data-action）
    $('#backup-input').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) this.importBackupFile(f);
      e.target.value = '';
    };
    $('#file-input').onchange = (e) => {
      if (e.target.files && e.target.files.length) this.importFiles(e.target.files);
      e.target.value = '';
    };
    $('#book-search').oninput = debounce((e) => {
      this._searchTerm = e.target.value;
      this._renderBookList();
    }, 180);

    // 设置对话框
    bindModal($('#dlg-settings'), $('#btn-settings'));
    const bindSelect = (id, key) => {
      $(id).onchange = (e) => { this.setSetting(key, e.target.value); };
    };
    bindSelect('#set-theme', 'theme');
    bindSelect('#set-fontsize', 'fontSize');
    bindSelect('#set-lineheight', 'lineHeight');
    bindSelect('#set-fontfamily', 'fontFamily');
    bindSelect('#set-pagewidth', 'pageWidth');
    bindSelect('#set-selaction', 'selAction');
    $('#set-hitzone').onchange = e => this.setSetting('hitZone', e.target.checked);
    $('#set-indent').onchange = e => this.setSetting('indent', e.target.checked);

    // 工具栏语速 / 发音人
    $('#tts-rate').onchange = e => this.setSetting('ttsRate', parseFloat(e.target.value));
    $('#tts-voice').onchange = e => {
      this.setSetting('ttsVoice', e.target.value);
      this.reader.tts.setVoice(e.target.value);
    };

    // 帮助：入口已移到「更多功能」面板（data-action="help"）
    // 目录弹窗
    $('#dlg-chapters').querySelectorAll('[data-close]').forEach(b => {
      b.onclick = () => $('#dlg-chapters').style.display = 'none';
    });
    $('#dlg-chapters').addEventListener('mousedown', e => {
      if (e.target === $('#dlg-chapters')) $('#dlg-chapters').style.display = 'none';
    });

    // 隐藏状态时保存进度（移动端切后台）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reader._persistPosition();
    });
    window.addEventListener('beforeunload', () => {
      try { this.reader._persistPosition(); } catch (e) { /* noop */ }
    });

    // ---------- 「更多」浮层 ----------
    $('#btn-more').onclick = (e) => {
      e.stopPropagation();
      // 每次打开复位为底部贴边（若上次被拖动过）
      const sheet = $('#more-overlay .more-sheet');
      if (sheet) { sheet.style.position = ''; sheet.style.left = ''; sheet.style.top = ''; sheet.style.margin = ''; }
      $('#more-overlay').classList.add('show');
    };
    $('#more-close').onclick = () => $('#more-overlay').classList.remove('show');
    // 遮罩点击关闭统一在下方 document 级 pointerdown 处理（与侧栏/词典面板同路径，并抑制点击翻页）
    // 阅读类按钮：转发到工具栏/阅读器对应控件
    $('#more-overlay').querySelectorAll('[data-for]').forEach(b => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        $('#more-overlay').classList.remove('show');
        const t = document.querySelector(b.dataset.for);
        if (t && typeof t.click === 'function') t.click();
      };
    });
    // 低频功能按钮：顶栏按钮已移除，直接执行动作
    $('#more-overlay').querySelectorAll('[data-action]').forEach(b => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        $('#more-overlay').classList.remove('show');
        this._moreAction(b.dataset.action);
      };
    });
    $('#more-rate').onchange = e => {
      this.setSetting('ttsRate', parseFloat(e.target.value));
      const t = $('#tts-rate'); if (t) t.value = e.target.value;
    };
    $('#more-voice').onchange = e => {
      this.setSetting('ttsVoice', e.target.value);
      this.reader.tts.setVoice(e.target.value);
      const t = $('#tts-voice'); if (t) t.value = e.target.value;
    };

    // ---------- 点击面板以外任意位置自动关闭（侧栏 / 词典面板 / 更多浮层） ----------
    document.addEventListener('pointerdown', e => {
      let closedAny = false;
      const sb = $('#sidebar');
      if (sb.classList.contains('open') && !sb.contains(e.target) && !e.target.closest('.tb-logo')) {
        sb.classList.remove('open'); closedAny = true;
      }
      const dp = $('#dict-panel');
      if (dp.classList.contains('open') && !dp.contains(e.target) && !$('#sel-popup').contains(e.target)) {
        dp.classList.remove('open'); closedAny = true;
      }
      const mo = $('#more-overlay');
      // 点在弹窗面板以外的页面区域（含遮罩自身）→ 关闭，且不触发上一页/下一页
      if (mo.classList.contains('show') && (e.target === mo || !mo.contains(e.target))) {
        mo.classList.remove('show'); closedAny = true;
      }
      // 本次点击用于「关闭弹窗」：置抑制标记——随后同一击的 click 若落到正文阅读区，
      // 只关弹窗、不翻页；700ms 后自动复位，避免触屏滑动残留吞掉后续真实翻页
      if (closedAny && this.reader) {
        this.reader._suppressPageTurn = true;
        clearTimeout(this.__supTurnTimer);
        this.__supTurnTimer = setTimeout(() => { this.reader._suppressPageTurn = false; }, 700);
      }
    }, { passive: true });
    // 兜底：关闭弹窗的那一击若 click 到达正文（浏览器合成 click 的目标差异），在捕获阶段拦下，绝不翻页
    document.addEventListener('click', e => {
      if (this.reader && this.reader._suppressPageTurn
        && e.target && e.target.closest && e.target.closest('#page-content')) {
        this.reader._suppressPageTurn = false;
        e.stopPropagation();
      }
    }, true);

    // ---------- 设置等弹窗可拖动（拖标题栏）；「更多功能」面板同样可拖标题栏 ----------
    for (const m of document.querySelectorAll('.modal-backdrop > .modal')) this._makeDraggable(m);
    this._makeDraggable($('#more-overlay .more-sheet'));
  }

  /** 让弹窗可拖动：按住标题栏拖动（modal-head / more-head 均可作拖动柄） */
  _makeDraggable(modal) {
    if (!modal) return;
    const head = modal.querySelector('.modal-head, .more-head');
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', e => {
      // 关闭按钮（右上角 ✕ 等）不进入拖动：pointer capture 会吞掉它的 click，导致关闭不灵敏
      if (e.target.closest('[data-close]')) return;
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      const r = modal.getBoundingClientRect();
      modal.style.position = 'fixed';
      modal.style.margin = '0';
      modal.style.left = r.left + 'px';
      modal.style.top = r.top + 'px';
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } }
      try { e.preventDefault(); } catch (err) { /* noop */ }
    });
    head.addEventListener('pointermove', e => {
      if (!dragging) return;
      const w = modal.offsetWidth, h = modal.offsetHeight;
      const x = clampNum(ox + (e.clientX - sx), 12 - w + 96, Math.max(12, window.innerWidth - 12));
      const y = clampNum(oy + (e.clientY - sy), 8, Math.max(8, window.innerHeight - 56));
      modal.style.left = x + 'px';
      modal.style.top = y + 'px';
    });
    const stopDrag = () => {
      dragging = false;
      if (head.releasePointerCapture) { try { head.releasePointerCapture(head.pointerId); } catch (err) { /* noop */ } }
    };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);
  }

  _fillRateSelect(idSel) {
    // 桌面工具栏 + 移动端「更多」浮层里的语速下拉同源填充
    for (const id of [idSel, '#more-rate']) {
      const sel = $(id);
      if (!sel) continue;
      sel.innerHTML = '';
      for (const r of ['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2']) {
        const o = document.createElement('option');
        o.value = r; o.textContent = r + 'x';
        sel.appendChild(o);
      }
      sel.value = String(this.settings.ttsRate);
    }
  }
  /** 填充设置里的数值型下拉：字号 / 行距 / 页宽 */
  _fillSettingSelects() {
    this._fillNumSelect('#set-fontsize', [14, 16, 18, 20, 22, 24, 26, 28, 30], String(this.settings.fontSize));
    this._fillNumSelect('#set-lineheight', [1.4, 1.6, 1.8, 1.9, 2.0, 2.2, 2.4], String(this.settings.lineHeight));
    this._fillNumSelect('#set-pagewidth', [60, 70, 80, 84, 90, 100], String(this.settings.pageWidth), '%');
  }
  _fillNumSelect(idSel, values, current, suffix = '') {
    const sel = $(idSel);
    if (!sel) return;
    sel.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = String(v) + suffix;
      sel.appendChild(o);
    }
    // 若当前值不在预设内（如从备份迁移而来），补一项避免下拉空白
    if (!values.map(String).includes(String(current))) {
      const o = document.createElement('option');
      o.value = String(current); o.textContent = String(current) + suffix;
      sel.appendChild(o);
    }
    sel.value = String(current);
  }
  _fillVoiceSelect(voices) {
    // 桌面工具栏 + 移动端「更多」浮层里的发音人下拉同源填充
    const render = (sel) => {
      sel.innerHTML = '<option value="">' + I18N.t('defaultVoice') + '</option>';
      const zh = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
      const rest = voices.filter(v => !(v.lang && v.lang.toLowerCase().startsWith('zh')));
      const add = (sel, v) => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = `${v.name} (${v.lang})`;
        sel.appendChild(o);
      };
      zh.forEach(v => add(sel, v)); rest.forEach(v => add(sel, v));
      sel.value = this.settings.ttsVoice || '';
    };
    const a = $('#tts-voice'), b = $('#more-voice');
    if (a) render(a);
    if (b) render(b);
  }
}

/* ---------- 14. 启动 ---------- */
(function boot() {
  window.addEventListener('error', (e) => {
    console.error('[NovelReader] 全局错误:', e.message, e.filename, e.lineno);
    const db = $('#st-db');
    if (db) db.textContent = I18N.t('runtimeError');
    toast(I18N.t('errToast', { msg: e.message }), true, 4000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[NovelReader] 未处理拒绝:', e.reason);
  });

  const app = new App();
  app.init()
    .then(() => {
      window.__app = app; // 便于控制台调试
    })
    .catch(err => {
      console.error(err);
      toast(I18N.t('initFail', { msg: err.message }), true, 8000);
      document.body.dataset.ready = 'error';
    });
})();

