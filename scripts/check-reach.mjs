#!/usr/bin/env node
// Checks that MVP Org/HR operations are reachable and editable rows map to catalog facts.
// Browser tests cover registered paths; baseline gaps are ratcheted against the base commit.
// Usage: node scripts/check-reach.mjs [--lower]
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { atBase, baselineGrowth } from "./quality/ratchet.mjs";
import { queueDirDefault, retired } from "./backlog-claims.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = new Set(["Entity", "Org", "HR"]);
const OPS = { create: "create", update: "update", end: "lifecycle" };
const NOT_REQUIRED = new Set(["by-design", "n/a"]);
export const pairKey = (record, op) => `${record}·${op}`;
export const laneUnit = (lane) => lane?.match(/^unit: ([a-z0-9]+(?:-[a-z0-9]+)+)(?:\s|$)/)?.[1];
/** A catalog text that is an action (a button's name), not a fact a row edits. */
const ACTION = /\s?(?:추가|삭제|수정|변경|등록|취소|무효화|폐지|폐쇄|정정|기록|보기|올리기|내려받기)$/;

/** MVP Org/HR record-operation pairs that require a UI path. */
export function required(lifecycle) {
  const out = [];
  for (const r of lifecycle.records) {
    if (!r.mvp || !MODULES.has(r.module)) continue;
    for (const [op, cell] of Object.entries(OPS)) {
      const c = r.ops[cell] ?? {};
      if ((c.be ?? []).length > 0 && !NOT_REQUIRED.has(c.st)) out.push({ record: r.id, op });
    }
  }
  return out;
}

/** The editable-row labels the source names by a literal catalog id, resolved to their Korean text. */
export function editableLabels(files, ko) {
  const out = new Map();
  const shapes = [/<FieldMark\b(?![^>]*kind="lock")[^>]*?\bfield=\{t\("([\w.]+)"\)/g, /<InlineField\b[^>]*?\blabel=\{t\("([\w.]+)"\)/g, /<RowActions\b[^>]*?\bfield=\{t\("([\w.]+)"\)/g, /\brow\(t\("([\w.]+)"\)/g, /\binfo\("(\w+)"/g];
  for (const [file, src] of files)
    for (const re of shapes)
      for (const m of src.matchAll(re)) {
        const id = re.source.startsWith("\\binfo") ? `INFO:${m[1]}` : m[1];
        const text = ko.get(id);
        if (text && !id.endsWith(".sample")) out.set(text, `${file}: ${id}`);
      }
  return out;
}

const counts = (keys) => keys.reduce((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});
/** A shrink-only list against its base (undefined: the base has none yet): new or repeated entries. */
function ratchet(name, keys, base) {
  const repeated = Object.entries(counts(keys)).filter(([, n]) => n > 1).map(([k]) => `${name}: ${k} is listed twice`);
  return [...repeated, ...(base ? baselineGrowth(counts([...new Set(keys)]), counts(base)).map((p) => `${name}: ${p} (new against the base; reach or map it instead)`) : [])];
}

export function check({ lifecycle, reach, baseline, facts, untracked, labels, catalog = new Set(), previous = {}, units }) {
  const problems = [];
  const known = new Set(lifecycle.records.map((r) => r.id));
  const need = new Map(required(lifecycle).map((p) => [pairKey(p.record, p.op), p]));
  const reached = new Set(reach.map((e) => pairKey(e.record, e.op)));
  for (const e of reach) {
    if (!known.has(e.record)) problems.push(`reach: ${e.record} is not a record type in record-lifecycle.json`);
    if (e.via.length < 1 || e.via.length > 2) problems.push(`reach: ${pairKey(e.record, e.op)} takes ${e.via.length} interactions (1–2 allowed)`);
  }
  const listed = new Set();
  for (const b of baseline) {
    const k = pairKey(b.record, b.op);
    listed.add(k);
    const unit = laneUnit(b.lane);
    if (!unit) problems.push(`baseline: ${k} has no lane naming its unit (「unit: <id> …」)`);
    else if (units && !units.has(unit)) problems.push(`baseline: ${k} names unit ${unit}, which is not open in the queue (register it, or name the open unit)`);
    if (reached.has(k)) problems.push(`baseline: ${k} is now reached (REACH has it); remove it (node scripts/check-reach.mjs --lower)`);
    else if (!need.has(k)) problems.push(`baseline: ${k} is no longer required; remove it (node scripts/check-reach.mjs --lower)`);
  }
  for (const k of need.keys()) if (!reached.has(k) && !listed.has(k)) problems.push(`unreachable: ${k} has a backend operation and no UI path from its own page (add it to e2e/record-actions/reach.ts once the UI reaches it)`);
  problems.push(...ratchet("baseline", baseline.map((b) => pairKey(b.record, b.op)), previous.baseline?.map((b) => pairKey(b.record, b.op))));
  problems.push(...ratchet("untracked", untracked, previous.untracked));
  for (const u of untracked) {
    if (labels.has(u) || catalog.has(`${u} 수정`)) continue;
    if (!catalog.has(u)) problems.push(`facts: untracked 「${u}」 is no editable row nor a catalog text; remove it`);
    else if (ACTION.test(u)) problems.push(`facts: untracked 「${u}」 is an action's name, not a fact a row edits; remove it`);
  }
  if (!units && baseline.length) problems.push("baseline: lanes NOT CHECKED: no orchestra queue (set BACKLOG_QUEUE_DIR or the console-orchestra queue-dir pointer)");
  const mapped = new Set([...facts.map((f) => f.label), ...untracked]);
  for (const [label, where] of labels) if (!mapped.has(label)) problems.push(`facts: editable row 「${label}」 (${where}) has no FACTS entry with its surfaces, nor an UNTRACKED line`);
  for (const u of untracked) if (facts.some((f) => f.label === u)) problems.push(`facts: 「${u}」 is in FACTS and UNTRACKED; remove it from UNTRACKED`);
  return problems;
}

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) && !/\.(test|gallery)\./.test(n) ? [p] : []; });

/** The Korean catalog as id → text, plus the workplace fact keys (INFO_LABEL) as INFO:<key>. */
function koCatalog() {
  const ko = new Map();
  const dir = path.join(ROOT, "packages/i18n/src/catalogs/ko");
  for (const f of readdirSync(dir)) for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(/^\s*"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) ko.set(m[1], m[2]);
  const present = readFileSync(path.join(ROOT, "apps/web/src/features/entity/present.ts"), "utf8");
  for (const m of present.matchAll(/^\s*(\w+): \(\) => t\("([\w.]+)"\)/gm)) ko.set(`INFO:${m[1]}`, ko.get(m[2]));
  return ko;
}

function openUnits() {
  const dir = queueDirDefault();
  if (!dir) return undefined;
  const open = (e) => { try { return !retired(readFileSync(e.brief ?? path.join(dir, `${e.id}.md`), "utf8")); } catch { return false; } };
  try {
    return new Set(JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")).filter(open).map((e) => e.id));
  } catch {
    return undefined;
  }
}

async function atBaseOf(base) {
  const json = atBase(ROOT, base, "scripts/reach-baseline.json");
  const facts = atBase(ROOT, base, "e2e/record-actions/facts.ts");
  let untracked;
  if (facts !== undefined) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-")), "facts.ts");
    writeFileSync(file, facts);
    ({ UNTRACKED: untracked } = await import(file));
  }
  return { baseline: json === undefined ? undefined : JSON.parse(json), untracked };
}

async function main() {
  const lifecycle = JSON.parse(readFileSync(path.join(ROOT, "docs/product/record-lifecycle.json"), "utf8"));
  const { REACH } = await import(path.join(ROOT, "e2e/record-actions/reach.ts"));
  const { FACTS, UNTRACKED } = await import(path.join(ROOT, "e2e/record-actions/facts.ts"));
  const basePath = path.join(ROOT, "scripts/reach-baseline.json");
  const baseline = JSON.parse(readFileSync(basePath, "utf8"));
  const files = walk(path.join(ROOT, "apps/web/src")).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")]);
  const ko = koCatalog();
  const tree = { lifecycle, reach: REACH, baseline, facts: FACTS, untracked: UNTRACKED, labels: editableLabels(files, ko), catalog: new Set(ko.values()), units: openUnits() };
  if (process.argv.includes("--lower")) {
    const need = new Set(required(lifecycle).map((p) => pairKey(p.record, p.op)));
    const reached = new Set(REACH.map((e) => pairKey(e.record, e.op)));
    const keep = baseline.filter((b, i) => need.has(pairKey(b.record, b.op)) && !reached.has(pairKey(b.record, b.op)) && baseline.findIndex((x) => pairKey(x.record, x.op) === pairKey(b.record, b.op)) === i);
    writeFileSync(basePath, `${JSON.stringify(keep, null, 1)}\n`);
    return;
  }
  const at = process.argv.indexOf("--base");
  tree.previous = await atBaseOf(at > 0 ? process.argv[at + 1] : (process.env.QUALITY_BASE ?? "dev"));
  const problems = check(tree);
  if (problems.length) {
    console.error(`reach: ${problems.length} problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`reach: ${REACH.length} paths registered, ${baseline.length} baselined gaps, ${tree.labels.size} editable labels mapped`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
