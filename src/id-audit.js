// Static glue audit: every $('#...') / $$('[data-close]') style selector used in
// the inline script must reference an element that exists in index.html markup.
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
// note: script tag has no type attribute in built file? It does: type="module"; match both
const mm = html.match(/<script type="module">([\s\S]*?)<\/script>/) || m;
const js = mm[1];
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]));

let missing = [];
const refs = new Set();
for (const mm2 of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) refs.add(mm2[1]);
for (const mm2 of js.matchAll(/\$\$\('#([A-Za-z0-9_-]+)'\)/g)) refs.add(mm2[1]);
// dynamic creation reference check (created in JS): cd-word, cd-gloss, cd-add, cf-extra handled
const createdInJs = new Set(['cd-word', 'cd-gloss', 'cd-add', 'cf-extra']);
for (const id of refs) {
  if (!ids.has(id) && !createdInJs.has(id)) missing.push(id);
}
console.log('markup ids:', ids.size, '| script refs:', refs.size);
console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'ALL IDS RESOLVED');

// check data attributes used
const dataUsing = new Set();
for (const mm3 of js.matchAll(/querySelector\(`\.([a-z-]+)\[data-([a-z-]+)="\$\{([^}]+)\}"\]`/g)) dataUsing.add(mm3[2]);
for (const mm3 of js.matchAll(/\[data-([a-z-]+)\]/g)) dataUsing.add(mm3[1]);
// pager renders data-p/s/e dynamically, fine
console.log('data attrs referenced:', [...dataUsing]);
