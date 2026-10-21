// Scoped design-doc proof: new copy, local links, append-only authority, owned backlog and golden ordinals.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const design = resolve(process.argv[2] ?? '../CX-ceiling-access-design');
const { checkTerms } = await import(pathToFileURL(`${design}/docs/scripts/check-copy.mjs`));
const files = ['docs/design/ideal/access.md','docs/design/regression/screens/5-roles.md','docs/plans/ideal-backlog.md'];
const markers = ['## Ceiling raise 2026-10','**Ceiling raise 2026-10','## Ceiling raise 2026-10 · access'];
const texts = files.map(f=>readFileSync(f,'utf8'));
const additions = texts.map((s,i)=>{assert(s.includes(markers[i]),`${files[i]} missing ceiling section`);return s.slice(s.indexOf(markers[i])).split(i===1 ? "\n## 5." : "\u0000")[0];});
const entries = additions.flatMap((s,i)=>s.split('\n').filter(line=>/[가-힣]/.test(line)).map((text,j)=>({id:`ceiling.${i}.${j}`,where:files[i],text})));
assert.deepEqual(checkTerms(entries,[]),[],'new quoted Korean copy fails canonical word gate');
assert(checkTerms([{id:'negative',where:'self-check',text:'고치기'}],[]).length>0,'word gate must reject forbidden copy');
assert.deepEqual(checkTerms([{id:'positive',where:'self-check',text:'권한 요청'}],[]),[]);
let links = 0;
const slug = s=>s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s/g,'-');
for (let i=0;i<files.length;i++) for (const [,href] of additions[i].matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  if (/^https?:/.test(href)) continue;
  const [name,hash] = href.split('#');
  const dest = name ? resolve(dirname(files[i]),name) : resolve(files[i]);
  assert(existsSync(dest),`broken local link: ${files[i]} → ${href}`);
  if(hash) {
    const headings = [...readFileSync(dest,'utf8').matchAll(/^#+ (.+)$/gm)].map(m=>slug(m[1]));
    assert(headings.includes(hash),`broken heading link: ${files[i]} → ${href}`);
  }
  links++;
}
for (const i of [0,2]) {
  const base = execFileSync('git',['show',`4293c76d4:${files[i]}`],{encoding:'utf8'});
  // Other ceiling lanes may append on trunk; our base prefix still has to survive intact.
  const original = base.includes(markers[i]) ? base.slice(0,base.indexOf(markers[i])) : base;
  assert(texts[i].startsWith(original),`${files[i]} changed pre-existing authority`);
}
const section = texts[1].split('## 4.')[1].split('## 5.')[0];
const goldens = section.split('\n').filter(s=>s.startsWith('- '));
assert.equal(goldens.filter(s=>s.includes('CE-AC-')).length,24);
const originalGolden = execFileSync('git',['show',`4293c76d4:${files[1]}`],{encoding:'utf8'}).split('## 4.')[1].split('## 5.')[0].split('\n').filter(s=>s.startsWith('- '));
assert.deepEqual(goldens.slice(0,originalGolden.length),originalGolden,'old golden ordinals must remain intact');
for(let n=1;n<=8;n++) {
  const id=`CE-AC-0${n}`;
  assert(additions[0].includes(`### ${id}`));
  const row = additions[2].split('\n').find(s=>s.startsWith(`| ${id} |`));
  assert(row && row.includes('2026-10-09') && /202[67]-\d\d-\d\d/.test(row) && /(ACC|AUD|OPS)/.test(row),`${id} needs owned dated work`);
}
console.log(`access ceiling docs: 8 improvements, 24 preserved-ordinal golden additions, 8 owned dated work items; ${entries.length} copy values, ${links} local links passed; word-gate rejection self-check passed`);
