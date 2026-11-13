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

// Count lines, including comments. An exception removes only its matched fragment, not the rest of a line.
export function hangulDebt(sources, allow) {
  const names = new Set();
  const rules = allow.map(entry => {
    if (/^(?:e2e|apps\/web)\//.test(entry.path)) throw new Error(`${entry.name}: UI tests cannot declare a Hangul exception; use catalog lookups`);
    if (!entry.name?.trim() || names.has(entry.name) || !entry.reason?.trim()
      || !(isDebtTest(entry.path) || /(?:^|\/)(?:migrations|refdata)\//.test(entry.path))) throw new Error("Hangul exception needs a unique name, eligible path and reason");
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
  const counts = {}, problems = [];
  const add = category => { counts[category] = (counts[category] ?? 0) + 1; };
  for (const { file, text } of sources) {
    if ((file.startsWith(`${CATALOGS}/`) && /\.(?:ts|json)$/.test(file) && !isDebtTest(file)) || file === "packages/api/src/schema.d.ts") continue;
    const category = hangulCategory(file);
    const product = /^(?:apps\/web\/src|packages\/api\/src)\//.test(file) && /\.(?:tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file);
    const entries = rules.filter(rule => rule.path === file);
    let blockDepth = 0;
    text.split("\n").forEach((line, i) => {
      const blockComment = blockDepth > 0 || line.includes("/*");
      for (const marker of line.matchAll(/\/\*|\*\//g)) blockDepth = Math.max(0, blockDepth + (marker[0] === "/*" ? 1 : -1));
      if (!HANGUL.test(line)) return;
      // Exceptions never weaken the existing zero-debt product-source rule.
      if (product) problems.push(`${file}:${i + 1}: literal outside the i18n catalogs: ${line.trim().slice(0, 100)}`);
      // Conservative boundaries keep quoted comments out of input/label exceptions, including nested blocks.
      const commentAt = blockComment ? 0 : line.search(/\/\/|--/);
      let code = commentAt < 0 ? line : line.slice(0, commentAt);
      const comment = commentAt < 0 ? "" : line.slice(commentAt);
      for (const entry of entries) {
        let used = false;
        code = code.replace(entry.re, match => {
          if (!HANGUL.test(match)) return match;
          if (match.trim() === code.trim()) throw new Error(`${entry.name}: whole-line Hangul exception match at ${file}:${i + 1}`);
          used = true;
          return "";
        });
        if (used) add(`allowed.${entry.name}`);
      }
      if (HANGUL.test(code + comment)) add(category);
    });
  }
  return { counts, problems };
}

export function repositoryHangul(base, allow) {
  const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const source = (file, bytes) => isUtf8(bytes) && !bytes.includes(0) ? [{ file, text: bytes.toString("utf8") }] : [];
  if (base) {
    // Read the same UTF-8 blobs at first adoption, including text fixtures marked binary by Git attributes.
    const files = git(["ls-tree", "-r", "--name-only", "-z", base]).split("\0").filter(Boolean);
    const blobs = execFileSync("git", ["cat-file", "--batch", "-Z"], {
      input: files.map(file => `${base}:${file}\0`).join(""), maxBuffer: 128 * 1024 * 1024,
    });
    let offset = 0;
    const sources = files.flatMap(file => {
      const end = blobs.indexOf(0, offset);
      const header = blobs.subarray(offset, end).toString("utf8").match(/^[a-f0-9]+ blob (\d+)$/);
      if (!header) throw new Error(`cannot read Hangul merge-base blob: ${file}`);
      const start = end + 1, size = Number(header[1]);
      offset = start + size + 1;
      return source(file, blobs.subarray(start, start + size));
    });
    return hangulDebt(sources, allow);
  }
  const files = [...new Set(git(["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
  return hangulDebt(files.filter(file => existsSync(file) && statSync(file).isFile())
    .flatMap(file => source(file, readFileSync(file))), allow);
}

export function checkHangulBaseline(counts, baseline, allow = [], previous = allow, newFiles = new Set()) {
  const problems = [];
  for (const [category, count] of Object.entries(baseline)) {
    if (!Number.isSafeInteger(count) || count < 0) problems.push(`${category}: invalid baseline count`);
  }
  for (const entry of allow) {
    const old = previous.find(old => old.name === entry.name || old.path === entry.path);
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) problems.push(`${entry.name}: existing exception cannot change`);
    if (!counts[`allowed.${entry.name}`]) problems.push(`${entry.name}: remove stale Hangul exception`);
  }
  for (const [category, count] of Object.entries(counts)) {
    const added = allow.find(entry => category === `allowed.${entry.name}` && !previous.some(old => old.name === entry.name));
    if (added && newFiles.has(added.path)) continue;
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
  const origins = new Map();
  for (let i = 0; i < moved.length; i += 3) origins.set(moved[i + 2], moved[i + 1]);
  const now = repositoryHangul(undefined, allow);
  // Apply the same exceptions on both trees so existing labels can be reclassified without blessing growth.
  const baseline = repositoryHangul(base, allow.map(entry => ({ ...entry, path: origins.get(entry.path) ?? entry.path }))).counts;
  const files = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0"));
  const added = new Set(allow.filter(entry => !files.has(entry.path) && !origins.has(entry.path)).map(entry => entry.path));
  return { ...now, baseline, problems: [...now.problems, ...checkHangulBaseline(now.counts, baseline, allow, previous, added)] };
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
