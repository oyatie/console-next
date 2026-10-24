import os from "node:os";
// Queue helpers shared by the source checks.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./backlog-sources.mjs";
import { resolveBase } from "./git-base.mjs";

export const QUEUE_ENV = "BACKLOG_QUEUE_DIR";
// Fall back to the local queue pointer when no environment override is set.
export const QUEUE_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "console-orchestra", "queue-dir");
export const queueDirDefault = () => process.env[QUEUE_ENV] || (existsSync(QUEUE_FILE) ? readFileSync(QUEUE_FILE, "utf8").trim() || undefined : undefined);
const MVP = "docs/plans/mvp-completion.md", UNITS = "docs/plans/aspirational-units.json";
const STATUS_DOCS = [MVP, "docs/plans/aspirational-delivery.md", UNITS];
const UNIT_MENTION = /`([a-z0-9]+(?:-[a-z0-9]+)+|AD-[A-Z]+\d+)`(?: \(row ([^()\s]+)\))?/g;
const unitIds = (s) => [...s.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+|AD-[A-Z]+\d+)`/g)].map((m) => m[1]);
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

export function cells(line) {
  const out = [], s = line.trim().replace(/^\|/, "");
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) cur += s[i] + s[++i];
    else if (s[i] === "|") { out.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function tableProblems(file, text) {
  const out = [], lines = text.split("\n");
  let want, fence;
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) { fence = fence === undefined ? f[1][0] : fence === f[1][0] ? undefined : fence; want = undefined; return; }
    if (fence) return;
    if (i && l.includes("|") && lines[i - 1].includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l)) { want = cells(lines[i - 1]).length; return; }
    if (want === undefined) return;
    if (!l.trim() || !l.includes("|")) { want = undefined; return; }
    const n = cells(l).length;
    if (n !== want) out.push(`${file}:${i + 1}: table row has ${n} cells, its header ${want} (write a literal pipe as \\|)`);
  });
  return out;
}

export const section2 = (text) => text.match(/^## 2\.[\s\S]*?(?=^## \d+\.|(?![\s\S]))/m)?.[0] ?? "";
export function rowsOf(text) {
  const rows = new Map();
  for (const l of text.split("\n").filter((x) => x.startsWith("|"))) {
    const c = cells(l);
    if (c.length > 1) rows.set(c[0].replace(/[*`]/g, "").trim(), c[c.length - 1]);
  }
  return rows;
}

export const retired = (brief) => /^(SPLIT|MERGED|SUPERSEDED|LANDED)\b/.test(brief.split("\n")[1] ?? "");
export function placement(brief) {
  const line = brief.match(/^Row:(.*)$/m)?.[1]?.split("Source:")[0];
  if (!line) return undefined;
  return {
    rows: [...line.matchAll(/§2\s+(\d+[a-z]?(?:\s*(?:,|and)\s*\d+[a-z]?)*)/g)].flatMap((m) => m[1].split(/\s*(?:,|and)\s*/)),
    branches: [...line.matchAll(/in-flight:`?([A-Za-z0-9._/-]*[A-Za-z0-9_])/g)].map((m) => m[1]),
    ops: /ops-backlog\.md\s+[A-Z]/.test(line),
  };
}

export const rowLabel = (at) => [...at.rows, ...at.branches.map((b) => `in-flight:${b}`), ...(at.ops ? ["ops-backlog"] : [])].join(", ");

export function briefProblems(id, brief, rows, { state, show } = {}) {
  const out = [];
  if (!/^Acceptance/m.test(brief)) out.push(`queue: brief ${id} has no Acceptance`);
  const at = placement(brief);
  if (!at) return [...out, `queue: brief ${id} has no Row: line`];
  if (!at.rows.length && !at.branches.length && !at.ops) out.push(`queue: brief ${id}'s Row: names no §2 or ops-backlog row`);
  for (const b of at.branches) {
    if (!state || !show) { out.push(`queue: brief ${id}'s Row: names ${b}, which cannot be checked without git`); continue; }
    const s = state(b);
    if (s !== "ahead") out.push(`queue: brief ${id}'s Row: names ${b} as in flight, but it is ${s === "missing" ? "not a branch" : "fully on dev"}`);
    else if (!new RegExp(`(?<![a-z0-9-])${id}(?![a-z0-9-])`).test(show(b, UNITS) ?? "")) out.push(`queue: brief ${id}'s Row: names ${b}, whose ${UNITS} does not name it`);
  }
  for (const row of at.rows) if (!rows.has(row)) out.push(`queue: brief ${id}'s Row: names §2 ${row}, which does not exist`);
  return out;
}

export function queueProblems(mvpText, dir, git = {}) {
  const out = [], rows = rowsOf(section2(mvpText));
  let entries;
  try { entries = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")); if (!Array.isArray(entries)) throw new Error("not a list"); }
  // An unreadable queue is not a valid check result.
  catch (e) { throw new Error(`queue: ${dir}/index.json unreadable: ${e.message}`); }
  const index = new Set(entries.map((e) => e.id));
  const briefs = new Map(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), readFileSync(path.join(dir, f), "utf8")]));
  for (const [row, state] of rows) {
    for (const id of new Set(unitIds(state))) {
      const brief = briefs.get(id);
      if (!brief) out.push(`§2 ${row}: unit ${id} has no brief in the queue`);
      else if (retired(brief)) out.push(`§2 ${row}: names ${id}, a retired (split, merged or landed) unit`);
      else if (!/^Acceptance/m.test(brief)) out.push(`§2 ${row}: unit ${id}'s brief has no Acceptance`);
      if (!index.has(id)) out.push(`§2 ${row}: unit ${id} is not in the queue index`);
    }
    for (const m of state.matchAll(UNIT_MENTION)) {
      const brief = briefs.get(m[1]), at = brief && !retired(brief) ? placement(brief) : undefined;
      if (!at || at.rows.includes(row)) continue;
      const label = rowLabel(at), ref = m[2]?.trim();
      if (ref === undefined) out.push(`§2 ${row}: names ${m[1]}, which its Row: places on ${JSON.stringify(label)} (a reference is written \`${m[1]}\` (row ${label.split(", ")[0]}))`);
      else if (!label.split(", ").includes(ref)) out.push(`§2 ${row}: names ${m[1]} (row ${ref}), but its Row: places it on ${JSON.stringify(label)}`);
    }
  }
  for (const [id, brief] of briefs) {
    if (retired(brief)) continue;
    if (!index.has(id)) out.push(`queue: brief ${id} is not in index.json`);
    out.push(...briefProblems(id, brief, rows, git));
  }
  // The index mirrors the placement declared in the brief.
  for (const e of entries) {
    const brief = briefs.get(e.id), at = brief && !retired(brief) ? placement(brief) : undefined;
    if (at && e.row !== rowLabel(at)) out.push(`queue: index.json row for ${e.id} is ${JSON.stringify(e.row)}, its brief's Row: derives ${JSON.stringify(rowLabel(at))} (backlog-queue.mjs reconcile)`);
  }
  return out;
}

export function gitBranchState(root) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const ok = (ref) => { try { git("rev-parse", "--verify", "-q", `${ref}^{commit}`); return true; } catch { return false; } };
  const dev = resolveBase(root);
  const state = (b) => {
    const ref = [`refs/heads/${b}`, `refs/remotes/origin/${b}`].find(ok);
    if (!ref) return "missing";
    return Number(git("rev-list", "--count", `${dev}..${ref}`)) ? "ahead" : "merged";
  };
  state.show = (b, file) => { try { return git("show", `${b}:${file}`); } catch { return undefined; } };
  state.trunk = dev;
  return state;
}

export function branchProblems(file, text, state) {
  const out = [];
  for (const m of text.matchAll(/in-flight:`?([A-Za-z0-9._/-]*[A-Za-z0-9_])|runs as `?([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]*[A-Za-z0-9_])/g)) {
    const b = m[1] ?? m[2], s = state(b);
    if (s !== "ahead") out.push(`${file}:${lineOf(text, m.index)}: names ${b} as in flight, but it is ${s === "missing" ? "not a branch" : "fully on dev"}`);
  }
  return out;
}

export function openProblems(mvpText, unitsText) {
  const out = [], s2 = section2(mvpText);
  for (const [row, state] of rowsOf(s2)) {
    const done = /\*\*(?!not\b)[^*]*\b(?:in production|landed|DONE)\b[^*]*\*\*/.test(state);
    if (done && (/\bOPEN\b/.test(state) || unitIds(state).length) && !/\*\*OPEN\b/.test(state)) out.push(`${MVP} §2 ${row}: claims a done slice and has an open part but no **OPEN** marker`);
  }
  const rest = mvpText.replace(s2, "");
  for (const l of rest.split("\n")) if (l.startsWith("|") && /\bOPEN\b/.test(l)) out.push(`${MVP}: a row outside §2 has an OPEN part: ${l.slice(0, 80)}`);
  let units;
  try { units = JSON.parse(unitsText).units; } catch (e) { return [...out, `${UNITS} unreadable: ${e.message}`]; }
  const named = new Set([...s2.matchAll(/in-flight:`?([A-Za-z0-9._/-]*[A-Za-z0-9_])/g)].map((m) => m[1]));
  for (const u of units) {
    const inFlight = [u.brief, u.brief_source].some((b) => `${b ?? ""}`.startsWith("in-flight:"));
    const branch = [u.brief, u.brief_source].map((b) => `${b ?? ""}`.match(/^in-flight:(\S+)/)?.[1]).find(Boolean);
    if (u.status === "in-flight" && branch && !named.has(branch)) out.push(`${UNITS} ${u.id}: in flight on ${branch}, which no ${MVP} §2 row names as in-flight:${branch}`);
    if (inFlight !== (u.status === "in-flight")) out.push(`${UNITS} ${u.id}: status ${u.status} but brief ${inFlight ? "is" : "is not"} in-flight`);
    if (/^(?:landed|done|in production)$/i.test(u.status) && /\bOPEN\b/.test(JSON.stringify(u))) out.push(`${UNITS} ${u.id}: status ${u.status} with an OPEN part`);
  }
  return out;
}

export function checkClaims(root, { queueDir = queueDirDefault(), branchState = gitBranchState(root), strict = process.env.BACKLOG_STRICT === "1" } = {}) {
  const problems = [], notChecked = [], onTrunk = [], read = (f) => readFileSync(path.join(root, f), "utf8");
  const md = [...sourceFiles(root).filter((f) => f.endsWith(".md")), "docs/plans/backlog-index.md"].filter((f) => existsSync(path.join(root, f)));
  for (const f of md) problems.push(...tableProblems(f, read(f)));
  const mvp = existsSync(path.join(root, MVP)) ? read(MVP) : "";
  if (!queueDir) notChecked.push(`queue units and briefs (set ${QUEUE_ENV} to the queue's open/ directory)`);
  else if (!existsSync(queueDir)) problems.push(`queue: ${QUEUE_ENV}=${queueDir} does not exist`);
  else {
    const git = { state: branchState, show: branchState?.show };
    let found;
    try { found = queueProblems(mvp, queueDir, git); } catch (e) { notChecked.push(e.message); }
    if (found) {
      // Ignore findings already present on dev unless strict mode is enabled.
      const trunkMvp = strict ? undefined : branchState?.show(branchState.trunk, MVP);
      const trunk = new Set(trunkMvp === undefined ? [] : queueProblems(trunkMvp, queueDir, git));
      for (const p of found) (trunk.has(p) ? onTrunk : problems).push(p);
    }
  }
  const docs = STATUS_DOCS.filter((f) => existsSync(path.join(root, f)));
  if (!branchState) notChecked.push("in-flight branches (not a git checkout with dev)");
  else for (const f of docs) problems.push(...branchProblems(f, read(f), branchState));
  if (existsSync(path.join(root, UNITS))) problems.push(...openProblems(mvp, read(UNITS)));
  return { problems, notChecked, onTrunk };
}
