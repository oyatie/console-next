#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { fileURLToPath } from "node:url";
import { atBase, qualityRef } from "./quality/base.mjs";

export const HANGUL = /\p{Script=Hangul}/u;
const CATALOGS = "packages/i18n/src/catalogs";
const HANGUL_BASELINE = "scripts/copy-hangul-baseline.json";
const OFFICIAL_DOMAINS = ["law.go.kr", "nts.go.kr", "nps.or.kr", "nhis.or.kr", "comwel.or.kr", "ei.go.kr", "kosis.kr", "juso.go.kr", "code.go.kr"];
// The existing country catalog cites Unicode's official CLDR dataset; other GitHub repositories are not publishers.
const officialSource = source => {
  if (!URL.canParse(source)) return false;
  const url = new URL(source);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && (OFFICIAL_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      || (url.hostname === "github.com" && url.pathname.startsWith("/unicode-org/cldr-json/")));
};
const isDebtTest = file => /(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|(?:[._-](?:tests?|spec))\.[^.]+$/.test(file);
const hangulCategory = file => {
  if (/(?:^|\/)migrations\//.test(file)) return "migrations";
  if (file.endsWith(".rs")) return isDebtTest(file) ? "rustTests" : "rustSource";
  if (file.startsWith("e2e/")) return "e2e";
  if (file.startsWith("apps/web/") && isDebtTest(file)) return "webTests";
  if (file.startsWith("scripts/")) return "scripts";
  if (file.startsWith("docs/") || /\.(?:md|mdx|rst)$/.test(file)) return "docs";
  return "other";
};

const isReferenceData = entry => /(?:^|\/)(?:migrations|refdata)\/(?:.*\/)?[^/]+\.(?:sql|tsv|csv|json)$/.test(entry.path) && !isDebtTest(entry.path);
const canRefresh = entry => isReferenceData(entry) && entry.name.startsWith("official-") && officialSource(entry.source);

const NUMBER = /[+-]?(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[\d_]+(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?)/g;
const CONSTRUCTOR = new RegExp(String.raw`String\s*\.\s*from(CharCode|CodePoint)\(\s*(?:\.\.\.\[\s*)?((?:${NUMBER.source}\s*,\s*)*${NUMBER.source})\s*,?\s*(?:\]\s*)?\)`, "g");

// Decode static spellings without evaluating source code; count each original line once.
function decodeEscapes(text, file) {
  const character = value => Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
  if (/\.(?:css|scss)$/.test(file)) {
    text = text.replace(/\\([\da-fA-F]{1,6})([ \t\r\n\f]?)/g, (match, hex, space) => {
      const decoded = character(Number.parseInt(hex, 16));
      return HANGUL.test(decoded) ? decoded + space : match;
    });
  }
  return text.replace(/\\u(?:\{([\da-fA-F_]{1,8})\}|([\da-fA-F]{4}))|&#(?:x([\da-fA-F]+)|(\d+));/g,
    (match, braced, fixed, hex, decimal) => {
      const decoded = character(Number.parseInt((braced ?? fixed ?? hex ?? decimal).replaceAll("_", ""), decimal ? 10 : 16));
      return HANGUL.test(decoded) ? decoded : match;
    })
    .replace(CONSTRUCTOR, (call, method, args) => call.replace(args, args.replace(NUMBER, number => {
      const value = (number.startsWith("-") ? -1 : 1) * Number(number.replace(/^[+-]/, "").replaceAll("_", ""));
      const decoded = method === "CharCode" ? String.fromCharCode(value) : character(value);
      return HANGUL.test(decoded) ? decoded : number;
    })));
}

// Count lines, including comments. An exception removes only its matched fragment, not the rest of a line.
export function hangulDebt(sources, allow) {
  const names = new Set();
  const rules = allow.map(entry => {
    if (/^(?:e2e|apps\/web)\//.test(entry.path)) throw new Error(`${entry.name}: UI tests cannot declare a Hangul exception; use catalog lookups`);
    if (!entry.name?.trim() || names.has(entry.name) || !entry.reason?.trim()
      || !(isDebtTest(entry.path) || isReferenceData(entry))) throw new Error("Hangul exception needs a unique name, eligible path and reason");
    names.add(entry.name);
    if (entry.name !== [...names].sort().at(-1)) throw new Error("Hangul exceptions must be sorted by name");
    if (/(?:^|\/)(?:migrations|refdata)\//.test(entry.path) || entry.name.startsWith("official-")) {
      if (!officialSource(entry.source)) throw new Error(`${entry.name}: official Hangul exception needs an allow-listed publisher source URL`);
    }
    const re = new RegExp(entry.pattern, "gu");
    for (const probe of ["", "x", "English words", "\u1100"]) {
      if ([...probe.matchAll(re)].some(match => match[0] === probe)) throw new Error(`${entry.name}: whole-line Hangul exception patterns are forbidden`);
    }
    return { ...entry, re };
  });
  const counts = {}, problems = [], encodedProblems = [], lines = {};
  const add = category => { counts[category] = (counts[category] ?? 0) + 1; };
  for (const { file, text: sourceText } of sources) {
    let text = sourceText;
    if ((file.startsWith(`${CATALOGS}/`) && /\.(?:ts|json)$/.test(file) && !isDebtTest(file)) || file === "packages/api/src/schema.d.ts") continue;
    // The shared synthetic target-board tenant dataset lives strictly in e2e/mock as pure JSON data, never in i18n or TS selectors.
    if (file === "e2e/mock/saeon-universe.json") {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("saeon-universe.json must be a JSON object");
      continue;
    }
    // Declared header synonyms are multilingual input data; all other catalogue text remains checked.
    if (file === "backend/crates/hr/domain/data/employee.json") {
      const catalogue = JSON.parse(text);
      for (const field of catalogue.fields) {
        if (!Array.isArray(field.aliases) || field.aliases.some(alias => typeof alias !== "string")) throw new Error("import aliases must be strings");
        field.aliases = [];
      }
      text = JSON.stringify(catalogue, null, 2);
    }
    const category = hangulCategory(file);
    const product = /^(?:apps\/web\/src|packages\/api\/src)\//.test(file) && /\.(?:tsx?|s?css)$/.test(file) && !/\.test\.tsx?$/.test(file);
    const entries = rules.filter(rule => rule.path === file);
    let blockDepth = 0;
    const rawLines = text.split("\n");
    decodeEscapes(text, file).split("\n").forEach((line, i) => {
      const raw = rawLines[i];
      const blockComment = blockDepth > 0 || line.includes("/*");
      for (const marker of line.matchAll(/\/\*|\*\//g)) blockDepth = Math.max(0, blockDepth + (marker[0] === "/*" ? 1 : -1));
      if (!HANGUL.test(line)) return;
      lines[file] = (lines[file] ?? 0) + 1;
      // Exceptions never weaken the existing zero-debt product-source rule.
      if (product) {
        const problem = `${file}:${i + 1}: literal outside the i18n catalogs: ${line.trim().slice(0, 100)}`;
        problems.push(problem);
        if (!HANGUL.test(raw)) encodedProblems.push(problem);
      }
      // Conservative boundaries keep quoted comments out of input/label exceptions, including nested blocks.
      const commentAt = blockComment ? 0 : line.search(/\/\/|--|#/);
      let code = commentAt < 0 ? line : line.slice(0, commentAt);
      const comment = commentAt < 0 ? "" : line.slice(commentAt);
      for (const entry of entries) {
        let used = false;
        code = code.replace(entry.re, match => {
          if (!HANGUL.test(match)) return match;
          if (match.trim() === code.trim()) return match;
          used = true;
          return "";
        });
        if (used) add(`allowed.${entry.name}`);
      }
      if (HANGUL.test(code + comment)) add(category);
    });
  }
  return { counts, problems, encodedProblems, lines };
}

const BLOB_BATCH_BYTES = 32 * 1024 * 1024;

export function repositoryHangul(base, allow) {
  const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const source = (file, bytes) => isUtf8(bytes) && !bytes.includes(0) ? [{ file, text: bytes.toString("utf8") }] : [];
  if (base) {
    // Read the same UTF-8 blobs at first adoption, including text fixtures marked binary by Git attributes.
    const entries = git(["ls-tree", "-r", "-l", "-z", base]).split("\0").filter(Boolean).map(line => {
      const tab = line.indexOf("\t");
      return { file: line.slice(tab + 1), size: Number(line.slice(0, tab).split(/\s+/)[3]) || 0 };
    });
    // Batches keep each read bounded however large the tree grows; a blob over the budget is read alone.
    const batches = [[]];
    let bytes = 0;
    for (const entry of entries) {
      if (bytes + entry.size > BLOB_BATCH_BYTES && batches.at(-1).length) {
        batches.push([]);
        bytes = 0;
      }
      batches.at(-1).push(entry);
      bytes += entry.size;
    }
    const sources = batches.flatMap(batch => {
      const input = batch.map(({ file }) => `${base}:${file}\0`).join("");
      const blobs = execFileSync("git", ["cat-file", "--batch", "-Z"], {
        input, maxBuffer: batch.reduce((sum, { size }) => sum + size + 128, Buffer.byteLength(input)),
      });
      let offset = 0;
      return batch.flatMap(({ file }) => {
        const end = blobs.indexOf(0, offset);
        const header = blobs.subarray(offset, end).toString("utf8").match(/^[a-f0-9]+ blob (\d+)$/);
        if (!header) throw new Error(`cannot read Hangul merge-base blob: ${file}`);
        const start = end + 1, size = Number(header[1]);
        offset = start + size + 1;
        return source(file, blobs.subarray(start, start + size));
      });
    });
    return hangulDebt(sources, allow);
  }
  const files = [...new Set(git(["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
  return hangulDebt(files.filter(file => existsSync(file) && statSync(file).isFile())
    .flatMap(file => source(file, readFileSync(file))), allow);
}

export function checkHangulBaseline(counts, baseline, allow = [], previous = allow) {
  const problems = [];
  for (const [category, count] of Object.entries(baseline)) {
    if (!Number.isSafeInteger(count) || count < 0) problems.push(`${category}: invalid baseline count`);
  }
  for (const entry of allow) {
    const old = previous.find(old => old.name === entry.name || old.path === entry.path);
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) problems.push(`${entry.name}: existing exception cannot change`);
    if (!isReferenceData(entry) && !previous.some(old => old.name === entry.name) && !baseline[`allowed.${entry.name}`]) problems.push(`${entry.name}: new test exceptions cannot self-approve; use catalog lookups or English`);
    if (!counts[`allowed.${entry.name}`]) problems.push(`${entry.name}: remove stale Hangul exception`);
  }
  for (const [category, count] of Object.entries(counts)) {
    if (allow.some(entry => category === `allowed.${entry.name}` && canRefresh(entry))) continue;
    if (count > (baseline[category] ?? 0)) problems.push(`${category}: now ${count}, baseline ${baseline[category] ?? 0}; new debt`);
  }
  return problems;
}

export function checkRepositoryHangul(base) {
  const allow = JSON.parse(readFileSync(HANGUL_BASELINE, "utf8")).allow;
  const previous = JSON.parse(atBase(process.cwd(), base, HANGUL_BASELINE) ?? '{"allow":[]}').allow;
  const changes = allow.filter(entry => !previous.some(old => JSON.stringify(old) === JSON.stringify(entry)));
  if (changes.length) {
    const report = `Hangul exception additions/changes:\n${changes.map(entry => JSON.stringify(entry)).join("\n")}\n`;
    console.log(report.trimEnd());
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n<pre>${report.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n`);
  }
  const moved = execFileSync("git", ["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", "--diff-filter=RC", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const origins = new Map(), copies = new Set();
  for (let i = 0; i < moved.length; i += 3) {
    origins.set(moved[i + 2], moved[i + 1]);
    if (moved[i].startsWith("C")) copies.add(moved[i + 2]);
  }
  const now = repositoryHangul(undefined, allow);
  // Apply the same exceptions on both trees so existing labels can be reclassified without blessing growth.
  const mapped = allow.flatMap(entry => copies.has(entry.path) && !canRefresh(entry) ? [] : [{ ...entry, path: origins.get(entry.path) ?? entry.path }]);
  const before = repositoryHangul(base, mapped);
  const baseline = before.counts;
  for (const entry of mapped) {
    const first = mapped.find(first => first.path === entry.path && first.pattern === entry.pattern);
    baseline[`allowed.${entry.name}`] = first === entry || canRefresh(entry) ? baseline[`allowed.${first.name}`] ?? 0 : 0;
  }
  // A path-only change is permitted for a Git-detected move of sourced reference data.
  const approved = previous.map(old => {
    const entry = allow.find(entry => entry.name === old.name);
    return entry && canRefresh(entry) && origins.get(entry.path) === old.path ? { ...old, path: entry.path } : old;
  });
  const deltas = allow.map(entry => {
    const key = `allowed.${entry.name}`, before = baseline[key] ?? 0, after = now.counts[key] ?? 0;
    return before === after ? [] : [`${key}: ${before} -> ${after} (${after - before >= 0 ? "+" : ""}${after - before})`];
  }).flat();
  if (deltas.length) {
    const report = `Hangul exception count changes:\n${deltas.join("\n")}\n`;
    console.log(report.trimEnd());
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${report}\n`);
  }
  // Exceptions split lines between buckets, so a file with a test exception may not gain Hangul lines at all.
  const grown = allow.filter(entry => !canRefresh(entry)).flatMap(entry => {
    const origin = copies.has(entry.path) ? undefined : origins.get(entry.path) ?? entry.path;
    const was = origin ? before.lines[origin] ?? 0 : 0, is = now.lines[entry.path] ?? 0;
    return is > was ? [`${entry.path}: ${is} Hangul lines, merge base ${was}; a file with a test exception cannot add Hangul lines`] : [];
  });
  // Count each Hangul line once per category, so moving a double-counted line cannot free exception room.
  const refreshed = new Set(allow.filter(canRefresh).flatMap(entry => [entry.path, origins.get(entry.path) ?? entry.path]));
  const perCategory = lines => Object.entries(lines).reduce((sum, [file, n]) => refreshed.has(file) ? sum : { ...sum, [hangulCategory(file)]: (sum[hangulCategory(file)] ?? 0) + n }, {});
  const [wasLines, isLines] = [perCategory(before.lines), perCategory(now.lines)];
  const pooled = Object.entries(isLines).flatMap(([category, is]) => is > (wasLines[category] ?? 0) ? [`${category}: ${is} Hangul lines, merge base ${wasLines[category] ?? 0}; a category cannot add Hangul lines`] : []);
  const existingEncoded = new Set(before.encodedProblems.map(problem => problem.replace(/:\d+:/, ":")));
  return { ...now, baseline, problems: [...now.problems.filter(problem => !now.encodedProblems.includes(problem) || !existingEncoded.has(problem.replace(/:\d+:/, ":"))), ...checkHangulBaseline(now.counts, baseline, allow, approved), ...grown, ...pooled] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const ref = qualityRef(process.cwd());
    let base;
    try { base = execFileSync("git", ["merge-base", "HEAD", ref], { encoding: "utf8", stdio: "pipe" }).trim(); }
    catch { throw new Error(`cannot resolve quality merge-base between HEAD and ${ref}`); }
    const result = checkRepositoryHangul(base);
    if (process.argv.includes("--report")) {
      console.log(`Hangul lines: ${JSON.stringify(result.counts)}`);
      console.log(`Merge-base Hangul lines: ${JSON.stringify(result.baseline)}`);
    }
    if (result.problems.length) throw new Error(result.problems.join("\n"));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
