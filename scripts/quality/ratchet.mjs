// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 20);

export function ratchet(findings, baseline) {
  const problems = [];
  for (const key of new Set([...Object.keys(findings), ...Object.keys(baseline)])) {
    const now = findings[key] ?? 0, old = baseline[key] ?? 0;
    if (key in baseline && (!Number.isSafeInteger(old) || old < 1)) problems.push(`${key}: invalid baseline count`);
    else if (now !== old) problems.push(`${key}: now ${now}, baseline ${old}; ${now > old ? "new debt" : "remove/lower stale baseline"}`);
  }
  return problems;
}

export function baselineGrowth(current, previous) {
  return Object.keys(current).filter((key) => current[key] > (previous[key] ?? 0)).map((key) => `${key}: baseline must only shrink`);
}

// Git distinguishes a missing path from an invalid base; unknown evidence must not become green.
export function atBase(root, base, file) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const valid = git(["rev-parse", "--verify", `${base}^{commit}`]);
  if (valid.status !== 0) throw new Error(`quality: cannot resolve base ${base}: ${valid.stderr}`);
  const list = git(["ls-tree", "--name-only", base, "--", file]);
  if (list.status !== 0) throw new Error(list.stderr);
  if (!list.stdout.trim()) return undefined;
  const result = git(["show", `${base}:${file}`]);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** Phase A counts inherited debt; new pages must use a floorplan and have one document heading. */
export function floorplanFindings(text) {
  const source = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (source.parseDiagnostics.length) throw new Error("floorplan: unparseable TSX");
  const found = {};
  const add = key => { found[key] = (found[key] ?? 0) + 1; };
  const components = ["Page", "PageHead", "ListPage", "PageHeadingLevel"];
  const names = new Map(components.map(name => [name, name]));
  for (const stmt of source.statements) if (ts.isImportDeclaration(stmt)) {
    const imports = stmt.importClause?.namedBindings;
    if (imports && ts.isNamedImports(imports)) for (const spec of imports.elements) {
      const name = (spec.propertyName ?? spec.name).text;
      if (names.has(name)) names.set(spec.name.text, name);
    }
    if (imports && ts.isNamespaceImport(imports)) for (const name of components) names.set(`${imports.name.text}.${name}`, name);
  }
  const jsx = node => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
  const inspect = (node, secondary, state) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const raw = open.tagName.getText(source), tag = names.get(raw) ?? raw;
      const attrs = open.attributes.properties.filter(ts.isJsxAttribute);
      const attr = name => attrs.find(a => a.name.getText(source) === name)?.initializer;
      const literal = name => {
        const value = attr(name);
        return value && ts.isStringLiteral(value) ? value.text : "";
      };
      const classes = literal("className").split(/\s+/);
      if (classes.includes("page__head")) add("legacyHead");
      if (classes.includes("page__title")) add("legacyTitle");
      if (tag === "h1") { add("moduleH1"); state.headings++; }
      const frame = tag === "Page" || tag === "ListPage";
      if (!secondary && (frame || tag === "PageHead")) state.headings++;
      if (!secondary && (frame || tag === "PageHead" || tag === "main" || classes.includes("page"))) state.page = true;
      if (frame || attr("data-floorplan")) state.floorplan = true;
      if (tag === "Page" && !attr("floorplan")) add("missingFloorplan");
      const value = attr("value");
      secondary ||= frame || tag === "PageHeadingLevel" && value && ts.isJsxExpression(value) && value.expression?.getText(source) === "2";
    }
    ts.forEachChild(node, child => inspect(child, secondary, state));
  };
  const visit = node => {
    if (jsx(node)) {
      const state = { headings: 0, page: false, floorplan: false };
      inspect(node, false, state);
      if (state.headings > 1) found.multipleH1 = (found.multipleH1 ?? 0) + state.headings - 1;
      if (state.page && !state.floorplan) add("missingFloorplan");
    } else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Page-local spacing may only fall as templates take over the outer layout. */
export async function pageSpacingFindings(text) {
  const { default: stylelint } = await import("stylelint");
  let count = 0;
  const ruleName = "page/spacing";
  const result = await stylelint.lint({ code: text, config: {
    plugins: [stylelint.createPlugin(ruleName, () => root => {
      root.walkDecls(decl => { if (/^(margin|padding)(-|$)/.test(decl.prop)) count++; });
    })],
    rules: { [ruleName]: true },
  } });
  if (result.errored) throw new Error(`floorplan: unparseable CSS: ${result.report}`);
  return count ? { pageSpacing: count } : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootAt = process.argv.indexOf("--root");
    const root = rootAt < 0 ? path.resolve(import.meta.dirname, "../..") : path.resolve(process.argv[rootAt + 1]);
    const publicDev = spawnSync("git", ["rev-parse", "--verify", "refs/remotes/public/dev"], { cwd: root });
    const base = process.env.QUALITY_BASE ?? (publicDev.status === 0 ? "public/dev" : "dev");
    const git = args => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    git(["rev-parse", "--verify", `${base}^{commit}`]);
    const previousFiles = new Set(git(["ls-tree", "-r", "--name-only", base, "--", "apps/web/src"]).trim().split("\n"));
    const renamed = new Map();
    const renames = git(["diff", "--name-status", "-z", "--find-renames", "--diff-filter=R", base, "--", "apps/web/src"]).split("\0");
    for (let i = 0; i + 2 < renames.length; i += 3) renamed.set(renames[i + 2], renames[i + 1]);
    const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps/web/src"]).trim().split("\n");
    const problems = [], totals = {};
    for (const file of files.filter(file => /\.tsx$/.test(file) && !/\.(test|spec)\.tsx$/.test(file) || /^apps\/web\/src\/features\/.*\.css$/.test(file))) {
      if (!existsSync(path.join(root, file))) continue;
      const text = readFileSync(path.join(root, file), "utf8");
      if (file.endsWith(".tsx") && !/\b(?:Page|PageHead|ListPage|h1|page__head|page__title)\b/.test(text)) continue;
      const measure = file.endsWith(".css") ? pageSpacingFindings : floorplanFindings;
      const now = await measure(text);
      const previous = renamed.get(file) ?? file;
      const old = previousFiles.has(previous) ? await measure(git(["show", `${base}:${previous}`])) : {};
      for (const [metric, count] of Object.entries(now)) {
        totals[metric] = (totals[metric] ?? 0) + count;
        if (count > (old[metric] ?? 0)) problems.push(`${file}: ${metric} ${count} > ${old[metric] ?? 0}`);
      }
    }
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(`floorplan Phase A: pass; inherited debt ${JSON.stringify(totals)}`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
