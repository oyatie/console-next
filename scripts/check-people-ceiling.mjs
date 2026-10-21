// Focused design proof: the normal copy gate does not inspect Markdown.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const copyRef = existsSync('docs/design/copy-conventions.md') ? 'HEAD' : 'fe/copy-conventions';
const gate = execFileSync('git',['show',`${copyRef}:scripts/check-copy.mjs`],{encoding:'utf8'});
const definitions = gate.slice(0, gate.indexOf('\nif (process.argv[1]'));
const { TERM_RULES } = await import(`data:text/javascript;base64,${Buffer.from(definitions).toString('base64')}`);
assert.ok(TERM_RULES.length > 20);
const words = text => TERM_RULES.filter(({re})=>re.test(text)).map(r=>r.rule);
assert.ok(words('퇴사').includes('term.퇴직'), 'negative copy probe must refuse noncanonical text');
assert.deepEqual(words('직원 등록 · 마지막 근무일 · 인사카드'),[]);
const slug = s => s.toLowerCase().replace(/[`*_]/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').replace(/\s/g,'-');
const targets = (text) => new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m=>slug(m[1])));
const validLink = (from, href) => {
  const [file, anchor] = href.split('#');
  const dest = path.resolve(path.dirname(from), decodeURIComponent(file || path.basename(from)));
  return existsSync(dest) && (!anchor || targets(readFileSync(dest,'utf8')).has(decodeURIComponent(anchor)));
};
assert.equal(validLink('docs/design/ideal/people.md','missing-ceiling-file.md'),false);
assert.equal(validLink('docs/design/ideal/people.md','people.md#missing-ceiling-anchor'),false);
const files = ['docs/design/ideal/people.md','docs/plans/ideal-backlog.md','docs/design/ideal/people-ceiling-review-2026-10.md','docs/design/regression/screens/2-employee.md'];
for (const file of files) {
  let text = readFileSync(file,'utf8');
  if (file.endsWith('people.md') || file.endsWith('ideal-backlog.md')) {
    const base = execFileSync('git',['show',`4293c76d4:${file}`],{encoding:'utf8'});
    assert.ok(text.startsWith(base), `${file}: existing spec must be preserved verbatim`);
    const marker = file.endsWith('ideal-backlog.md') ? '## Ceiling raise 2026-10 · people' : '## Ceiling raise 2026-10';
    text = text.slice(text.indexOf(marker));
    if (file.endsWith('ideal-backlog.md')) text = text.split('\n## ')[0];
  } else if (file.endsWith('2-employee.md')) {
    text = text.slice(text.indexOf('**Ceiling raise 2026-10'),text.indexOf('## 5.'));
    const old = execFileSync('git',['show',`4293c76d4:${file}`],{encoding:'utf8'}).split('## 4.')[1].split('## 5.')[0].match(/^- .+$/gm);
    const current = readFileSync(file,'utf8').split('## 4.')[1].split('**Ceiling raise')[0].match(/^- .+$/gm);
    assert.deepEqual(current, old, 'existing golden ordinals must remain identical');
  }
  // Links/code contain identifiers, not Korean UI copy. Check prose including quoted Korean labels.
  const prose = text.replace(/`[^`]*`/g,'').replace(/https?:\/\/\S+/g,'');
  assert.deepEqual(words(prose),[],`${file}: noncanonical new copy`);
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) if (!/^https?:/.test(m[1])) assert.ok(validLink(file,m[1]),`${file}: broken local link ${m[1]}`);
}
const review = readFileSync(files[2],'utf8'), standard = readFileSync('docs/design/ideal/lifecycle-standard.md','utf8');
const coverage = new Set();
for (const row of review.split('\n').filter(line=>line.startsWith('| LS-'))) {
  const column = row.split('|')[1];
  let layer;
  for (const m of column.matchAll(/LS-([CRWJ])|(\d+)(?:–(\d+))?/g)) {
    if (m[1]) layer=m[1];
    else for(let n=Number(m[2]);n<=Number(m[3] || m[2]);n++) coverage.add(`${layer}${n}`);
  }
}
for (const id of new Set(standard.match(/LS-[CRWJ]\d+[a-d]?/g))) {
  const [,layer,n] = id.match(/LS-([CRWJ])(\d+)/);
  assert.ok(coverage.has(`${layer}${Number(n)}`),`${id}: missing applicability decision`);
}
const golden = readFileSync(files[3],'utf8');
for (let i=1;i<=18;i++) assert.equal((golden.match(new RegExp(`PPC-G${String(i).padStart(2,'0')}:`,'g'))||[]).length,1);
console.log('people ceiling: append preservation, 18 golden additions, full LS decisions, canonical copy and local links OK');
