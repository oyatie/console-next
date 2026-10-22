#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Checks that MVP Org/HR operations are reachable and editable rows map to catalog facts.
// Browser tests cover registered paths; baseline gaps are ratcheted against the base commit.
// Usage: node scripts/check-reach.mjs [--lower]
import { spawnSync } from "node:child_process";
import ts from "typescript";
import yaml from "js-yaml";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { atBase, baselineGrowth } from "./quality/ratchet.mjs";

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
    else if (units && !units.has(unit)) problems.push(`baseline: ${k} names unit ${unit}, which is not registered in registry/reach-units.json`);
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
  if (!units && baseline.length) problems.push("baseline: lanes NOT CHECKED: no versioned reach-unit registry");
  const mapped = new Set([...facts.map((f) => f.label), ...untracked]);
  for (const [label, where] of labels) if (!mapped.has(label)) problems.push(`facts: editable row 「${label}」 (${where}) has no FACTS entry with its surfaces, nor an UNTRACKED line`);
  for (const u of untracked) if (facts.some((f) => f.label === u)) problems.push(`facts: 「${u}」 is in FACTS and UNTRACKED; remove it from UNTRACKED`);
  return problems;
}

/** Cargo's default feature closure owns which optional REST packages ship. */
export function releasePackages(app) {
  const enabled = new Set(), pending = ["default"];
  while (pending.length) {
    const feature = pending.pop();
    if (enabled.has(feature)) continue;
    enabled.add(feature);
    pending.push(...(app.features[feature] ?? []));
  }
  return new Set(app.dependencies.filter((d) => (d.kind == null) && (!d.optional || enabled.has(`dep:${d.name}`) || enabled.has(d.name) || [...enabled].some((f) => f.startsWith(`${d.name}/`)))).map((d) => d.name));
}

/** Only executable call expressions count; types, cache prefixes and test fixtures cannot reach an op. */
export function operationGaps({ spec, files, crates, releaseCrates }) {
  const ops = Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item).filter((m) => /^(get|post|put|patch|delete|head|options|trace)$/.test(m)).map((m) => ({ key: `${m.toUpperCase()} ${p}`, method: m.toUpperCase(), path: p })));
  const reached = new Set();
  for (const [file, src] of files) {
    if (!/^(apps\/web\/|packages\/)/.test(file) || /\.(test|spec|gallery)\.|\.d\.ts$|\/(?:__tests__|e2e|pending)\//.test(file)) continue;
    const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const constants = new Map();
    const literal = (n) => {
      if (!n) return undefined;
      if (ts.isStringLiteralLike(n)) return n.text;
      if (ts.isIdentifier(n)) return constants.get(n.text);
      if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => (literal(s.expression) ?? "*") + s.literal.text).join("");
      return undefined;
    };
    const literals = (n) => n && ts.isConditionalExpression(n) ? [...literals(n.whenTrue), ...literals(n.whenFalse)] : [literal(n)];
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const value = literal(n.initializer);
        if (value !== undefined) constants.set(n.name.text, value);
      }
      if (ts.isCallExpression(n)) {
        const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText(ast);
        let method, arg = n.arguments[0];
        if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/.test(name)) method = name;
        else if (name === "authPost" || name === "sendBeacon") method = "POST";
        else if (/^(get|q|list|pages|cursorPages|getUntyped|fetch)$/.test(name)) {
          method = "GET";
          const init = n.arguments[1];
          if (name === "fetch" && init && ts.isObjectLiteralExpression(init)) {
            const prop = init.properties.find((p) => p.name?.getText(ast).replace(/['"]/g, "") === "method");
            if (prop) method = literal(prop.initializer)?.toUpperCase();
          }
        } else if (name === "call" && /^(GET|POST|PUT|PATCH|DELETE)$/.test(literal(arg) ?? "")) {
          method = literal(arg); arg = n.arguments[1];
        }
        for (const value of literals(arg)) {
          const raw = value?.replace(/^\*\/api\//, "/api/");
          if (method && raw?.startsWith("/")) {
            const segments = raw.split("?")[0].replace(/\/$/, "").split("/");
            const candidates = ops.filter((o) => o.method === method && o.path.split("/").length === segments.length && o.path.split("/").every((x, i) => x === segments[i] || x.startsWith("{") || segments[i] === "*" || segments[i].startsWith("{")));
            const score = (o) => o.path.split("/").reduce((n, x, i) => n + (x === segments[i] ? 2 : x.startsWith("{") ? 1 : 0), 0);
            const best = Math.max(...candidates.map(score));
            for (const o of candidates) if (score(o) === best) reached.add(o.key);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(ast);
  }
  return ops.filter((o) => !reached.has(o.key) && (!releaseCrates || !crates.has(o.key) || releaseCrates.has(crates.get(o.key)))).map((o) => o.key).sort();
}

export function checkOperations({ gaps, operations, previous, uncalled }) {
  const problems = [];
  for (const [op, allow] of Object.entries(operations)) {
    if (![allow?.lane, allow?.reason].every((s) => typeof s === "string" && s.trim())) problems.push(`operation-owner: ${op} needs a lane and reason`);
    if (uncalled && !uncalled.includes(op)) problems.push(`operation-stale: ${op} is called or no longer served; remove it (node scripts/check-reach.mjs --lower)`);
  }
  for (const op of gaps) if (!Object.hasOwn(operations, op)) problems.push(`operation-unreachable: ${op} has no product call site or owned allowance`);
  if (previous !== undefined) problems.push(...baselineGrowth(counts(Object.keys(operations)), counts(Object.keys(previous))).map((p) => `operations: ${p}`));
  return problems;
}

export const lowerOperations = (operations, uncalled) => Object.fromEntries(Object.entries(operations).filter(([op]) => uncalled.includes(op)));

function operationTree(files) {
  const metadata = spawnSync("cargo", ["metadata", "--offline", "--no-deps", "--format-version", "1"], { cwd: path.join(ROOT, "backend"), encoding: "utf8", maxBuffer: 1 << 26 });
  if (metadata.status !== 0) throw new Error(`reach: release metadata unreadable: ${metadata.stderr}`);
  const { packages } = JSON.parse(metadata.stdout);
  const shipped = releasePackages(packages.find((p) => p.name === "console-app"));
  const releaseCrates = new Set(), crates = new Map();
  for (const p of packages) {
    const dir = path.dirname(p.manifest_path), relative = path.relative(realpathSync(path.join(ROOT, "backend/crates")), dir);
    if (relative.startsWith("..")) continue;
    const crate = relative.split(path.sep)[0];
    const paths = path.join(dir, "openapi/paths");
    if (!existsSync(paths)) continue;
    if (shipped.has(p.name)) releaseCrates.add(crate);
    for (const file of readdirSync(paths)) {
      const m = file.match(/^(.*)\.(get|post|put|patch|delete|head|options|trace)\.yaml$/);
      if (m) crates.set(`${m[2].toUpperCase()} /${m[1].replaceAll("__", "/")}`, crate);
    }
  }
  const spec = yaml.load(readFileSync(path.join(ROOT, "backend/openapi/openapi.yaml"), "utf8"));
  // Path filenames omit parameter braces; join through the contract rather than guessing parameter names.
  const owners = new Map(Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item).map((m) => [`${m.toUpperCase()} ${p}`, crates.get(`${m.toUpperCase()} ${p.replace(/[{}]/g, "")}`)]).filter(([, c]) => c)));
  const uncalled = operationGaps({ spec, files, crates: owners });
  return { uncalled, gaps: uncalled.filter((op) => !owners.has(op) || releaseCrates.has(owners.get(op))) };
}

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.[jt]sx?$/.test(n) && !/\.(test|gallery)\./.test(n) ? [p] : []; });

/** The Korean catalog as id → text, plus the workplace fact keys (INFO_LABEL) as INFO:<key>. */
function koCatalog() {
  const ko = new Map();
  const dir = path.join(ROOT, "packages/i18n/src/catalogs/ko");
  for (const f of readdirSync(dir)) for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(/^\s*"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) ko.set(m[1], m[2]);
  const present = readFileSync(path.join(ROOT, "apps/web/src/features/entity/present.ts"), "utf8");
  for (const m of present.matchAll(/^\s*(\w+): \(\) => t\("([\w.]+)"\)/gm)) ko.set(`INFO:${m[1]}`, ko.get(m[2]));
  return ko;
}

function registeredUnits() {
  // The public gate's debt owners are reviewed with the code, without a private Mac queue.
  const units = JSON.parse(readFileSync(path.join(ROOT, "registry/reach-units.json"), "utf8"));
  if (!Array.isArray(units) || units.some((unit) => typeof unit !== "string" || laneUnit(`unit: ${unit}`) !== unit) || new Set(units).size !== units.length) throw new Error("invalid reach-unit registry");
  return new Set(units);
}

/** Bootstrap against the base's actual debt, even before it has an operations baseline. */
export function operationsAtBase(base) {
  const contract = spawnSync("git", ["show", `${base}:backend/openapi/openapi.yaml`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  if (contract.status !== 0) throw new Error(`reach: base contract unreadable: ${contract.error ?? contract.stderr}`);
  const spec = yaml.load(contract.stdout);
  const list = spawnSync("git", ["ls-tree", "-r", "--name-only", base, "--", "apps/web", "packages"], { cwd: ROOT, encoding: "utf8" });
  if (list.status !== 0) throw new Error(`reach: base sources unreadable: ${list.stderr}`);
  const names = list.stdout.trim().split("\n").filter((f) => /\.[jt]sx?$/.test(f));
  const blobs = spawnSync("git", ["cat-file", "--batch"], { cwd: ROOT, input: names.map((f) => `${base}:${f}\n`).join(""), maxBuffer: 1 << 28 });
  if (blobs.status !== 0) throw new Error(`reach: base sources unreadable: ${blobs.stderr}`);
  let offset = 0;
  const files = names.map((f) => {
    const end = blobs.stdout.indexOf(10, offset);
    const size = Number(blobs.stdout.subarray(offset, end).toString().split(" ")[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`reach: base source unreadable: ${f}`);
    const src = blobs.stdout.subarray(end + 1, end + 1 + size).toString("utf8");
    offset = end + size + 2;
    return [f, src];
  });
  return Object.fromEntries(operationGaps({ spec, files, crates: new Map() }).map((op) => [op, {}]));
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
  const data = json === undefined ? undefined : JSON.parse(json);
  return { baseline: Array.isArray(data) ? data : data?.records, operations: data?.operations ?? operationsAtBase(base), untracked };
}

async function main() {
  const lifecycle = JSON.parse(readFileSync(path.join(ROOT, "docs/product/record-lifecycle.json"), "utf8"));
  const { REACH } = await import(path.join(ROOT, "e2e/record-actions/reach.ts"));
  const { FACTS, UNTRACKED } = await import(path.join(ROOT, "e2e/record-actions/facts.ts"));
  const basePath = path.join(ROOT, "scripts/reach-baseline.json");
  const data = JSON.parse(readFileSync(basePath, "utf8"));
  const baseline = Array.isArray(data) ? data : data.records;
  const operations = data.operations ?? {};
  const files = walk(path.join(ROOT, "apps/web/src")).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")]);
  const operationFiles = [...files, ...walk(path.join(ROOT, "packages")).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")]), ...walk(path.join(ROOT, "apps/web/public")).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")])];
  const opTree = operationTree(operationFiles);
  const ko = koCatalog();
  const tree = { lifecycle, reach: REACH, baseline, facts: FACTS, untracked: UNTRACKED, labels: editableLabels(files, ko), catalog: new Set(ko.values()), units: registeredUnits() };
  if (process.argv.includes("--lower")) {
    const need = new Set(required(lifecycle).map((p) => pairKey(p.record, p.op)));
    const reached = new Set(REACH.map((e) => pairKey(e.record, e.op)));
    const keep = baseline.filter((b, i) => need.has(pairKey(b.record, b.op)) && !reached.has(pairKey(b.record, b.op)) && baseline.findIndex((x) => pairKey(x.record, x.op) === pairKey(b.record, b.op)) === i);
    writeFileSync(basePath, `${JSON.stringify({ records: keep, operations: lowerOperations(operations, opTree.uncalled) }, null, 1)}\n`);
    return;
  }
  const at = process.argv.indexOf("--base");
  tree.previous = await atBaseOf(at > 0 ? process.argv[at + 1] : (process.env.QUALITY_BASE ?? "dev"));
  const problems = [...check(tree), ...checkOperations({ ...opTree, operations, previous: tree.previous.operations })];
  if (problems.length) {
    console.error(`reach: ${problems.length} problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`reach: ${REACH.length} paths registered, ${baseline.length} baselined gaps, ${tree.labels.size} editable labels mapped, ${opTree.gaps.length} uncalled release operations (${Object.keys(operations).length} owned allowances)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
