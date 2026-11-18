#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Component pages under docs/design-system/components keep their props and token tables in generated blocks, so a
// page cannot say something its component no longer does. A page names a source between a pair of markers:
//   <!-- ds:props apps/web/src/ui/button/button.tsx -->   ...   <!-- /ds:props -->
//   <!-- ds:tokens apps/web/src/app.css .btn -->          ...   <!-- /ds:tokens -->
// Everything between a pair is written here; everything outside is hand-written and never touched.
//   node scripts/ds-docs.mjs [--check] [--root path]   fail when a block differs from what its source says now
//   node scripts/ds-docs.mjs --write [--root path]     rewrite the blocks
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseCss } from "./check-ds-refs.mjs";
import { actual, project } from "./quality/project.mjs";

const PAGES = "docs/design-system/components";
const FIX = "node scripts/ds-docs.mjs --write";
const SOURCE = { props: /\.tsx?$/, tokens: /\.css$/ };

// Code-unit order, never the locale's: the same tables on every machine.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cell = (text) => text.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
const code = (text) => (text.includes("`") ? `\`\` ${cell(text)} \`\`` : `\`${cell(text)}\``);
/** A doc comment as a table cell: markdown as written, except that a tag outside a code span must not become HTML. */
const prose = (text) => cell(text).split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replaceAll("<", "&lt;"))).join("");
const table = (head, rows) => [head, head.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The generated blocks of a page: what each marker names, and where the text between the pair starts and ends. */
export function markers(text) {
  const blocks = [], problems = [];
  const unclosed = (block) => `\`${block.label}\` is not closed; add <!-- /ds:${block.kind} --> after it`;
  let open;
  for (const found of text.matchAll(/<!--\s*(\/?)ds:(\w+)\s*(.*?)\s*-->/g)) {
    const [marker, closing, kind, named] = found;
    if (!closing) {
      if (open) problems.push(unclosed(open));
      open = { kind, label: `ds:${kind} ${named}`.trim(), source: named.split(/\s+/)[0], filter: named.replace(/^\S+\s*/, ""), from: found.index + marker.length };
    } else if (open?.kind === kind) {
      blocks.push({ ...open, to: found.index });
      open = undefined;
    } else problems.push(`<!-- /ds:${kind} --> closes no block; remove it or add the opening marker`);
  }
  if (open) problems.push(unclosed(open));
  return { blocks, problems };
}

/** Every token a stylesheet reads, with the properties that read it. `filter` keeps the rules whose selector contains it. */
export function tokenTable(css, filter = "", file) {
  const readers = new Map();
  let matched = !filter;
  parseCss(css, file).walkDecls((decl) => {
    // A nested rule belongs to the rule around it, so any enclosing selector may carry the filter text.
    let inside = !filter;
    for (let rule = decl.parent; rule && !inside; rule = rule.parent) inside = rule.selector?.includes(filter) ?? false;
    if (!inside) return;
    matched = true;
    for (const [, name] of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) readers.set(name, (readers.get(name) ?? new Set()).add(decl.prop));
  });
  if (!matched) throw new Error(`matches no rule: no selector in the file contains "${filter}"`);
  if (!readers.size) return "Reads no tokens.";
  return table(["Token", "Read by"], [...readers].sort(([a], [b]) => byText(a, b)).map(([name, props]) => [code(name), [...props].sort(byText).map(code).join(", ")]));
}

/** The initialisers in a component's destructured first parameter, found through memo(...), forwardRef(...) and a named inner function. */
function defaults(checker, node) {
  if (!node) return new Map();
  if (ts.isVariableDeclaration(node)) return defaults(checker, node.initializer);
  if (ts.isCallExpression(node)) return defaults(checker, node.arguments[0]);
  if (ts.isIdentifier(node)) return defaults(checker, actual(checker, checker.getSymbolAtLocation(node))?.valueDeclaration);
  const pattern = ts.isFunctionLike(node) ? node.parameters[0]?.name : undefined;
  return new Map(pattern && ts.isObjectBindingPattern(pattern) ? pattern.elements.filter((e) => e.initializer).map((e) => [(e.propertyName ?? e.name).text, e.initializer.getText()]) : []);
}

/**
 * One line for the props a library declares, in place of a row each. It names the library types that declare them,
 * leaving out a type another of them extends, and says what the component left out of those types. When more was
 * left out than kept, it names what was kept instead.
 */
function inherited(checker, props, taken, lead) {
  const owners = new Map();
  for (const declaration of props.flatMap((prop) => prop.declarations)) {
    const home = ts.findAncestor(declaration, (n) => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n));
    const symbol = home?.name && checker.getSymbolAtLocation(home.name);
    const pack = declaration.getSourceFile().fileName.split("/node_modules/").at(-1).match(/^(?:@[^/]+\/)?[^/]+/)[0];
    owners.set(symbol ?? pack, { symbol, label: symbol ? `${code(symbol.name)} (${code(pack)})` : code(pack) });
  }
  const extended = new Set();
  const climb = (symbol) => {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    for (const base of type.isClassOrInterface() ? checker.getBaseTypes(type) : []) if (base.symbol && !extended.has(base.symbol)) { extended.add(base.symbol); climb(base.symbol); }
  };
  for (const { symbol } of owners.values()) if (symbol) climb(symbol);
  const named = [...owners.values()].filter((owner) => !extended.has(owner.symbol));
  const from = list(named.map((owner) => owner.label).sort(byText));
  const left = new Set(named.flatMap((owner) => (owner.symbol ? checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(owner.symbol)).map((p) => p.name) : [])).filter((name) => !taken.has(name)));
  if (left.size > props.length) return `${lead} ${list(props.map((p) => code(p.name)).sort(byText))} of ${from}.`;
  return `${lead} the attributes of ${from}${left.size ? `, except ${list([...left].sort(byText).map(code))}` : ""}.`;
}

/** One props shape: a row for each prop this repository declares, then the line for the ones a library declares. */
function shape(checker, type, initialisers) {
  const all = checker.getPropertiesOfType(type);
  const library = (prop) => prop.declarations?.length > 0 && prop.declarations.every((d) => d.getSourceFile().fileName.includes("/node_modules/"));
  const own = all.filter((prop) => !library(prop)).map((prop) => {
    const optional = Boolean(prop.flags & ts.SymbolFlags.Optional);
    const declared = checker.getTypeOfSymbol(prop);
    const print = (t) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
    // An optional prop's type carries `undefined`; the Required column already says it may be left out.
    const rest = optional && declared.isUnion() ? declared.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)) : [];
    const text = !optional ? print(declared) : rest.length === 1 ? print(rest[0]) : print(declared).replace(/ \| undefined$/, "");
    const initial = initialisers.get(prop.name);
    return { name: prop.name, optional, row: [code(prop.name), optional ? "no" : "yes", code(text), initial ? code(initial) : "", prose(ts.displayPartsToString(prop.getDocumentationComment(checker)))] };
  }).sort((a, b) => a.optional - b.optional || byText(a.name, b.name));
  const parts = own.length ? [table(["Prop", "Required", "Type", "Default", "Description"], own.map((prop) => prop.row))] : [];
  const fromLibrary = all.filter(library);
  if (fromLibrary.length) parts.push(inherited(checker, fromLibrary, new Set(all.map((p) => p.name)), own.length ? "Also accepts" : "Accepts"));
  return parts.join("\n\n") || "Takes no props.";
}

/** A props table for every component a module exports: a capitalised export that can be called, re-exports included. */
export function propsTables(checker, source) {
  const module = checker.getSymbolAtLocation(source);
  const sections = [];
  for (const exported of (module ? checker.getExportsOfModule(module) : []).filter((e) => /^[A-Z]/.test(e.name)).sort((a, b) => byText(a.name, b.name))) {
    const symbol = actual(checker, exported);
    // shortcut: an overloaded component is documented by its first signature; write a table per signature when one exists.
    const signature = symbol.flags & ts.SymbolFlags.Value ? checker.getTypeOfSymbol(symbol).getCallSignatures()[0] : undefined;
    if (!signature) continue;
    const props = signature.parameters[0] && checker.getTypeOfSymbol(signature.parameters[0]);
    const shapes = !props ? [] : props.isUnion() ? props.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)) : [props];
    const initialisers = defaults(checker, symbol.valueDeclaration);
    const tables = shapes.map((type, i) => (shapes.length > 1 ? `**Shape ${i + 1} of ${shapes.length}${type.aliasSymbol ? `: ${code(type.aliasSymbol.name)}` : ""}**\n\n` : "") + shape(checker, type, initialisers));
    sections.push(`### ${exported.name}\n\n${tables.join("\n\n") || "Takes no props."}`);
  }
  if (!sections.length) throw new Error("exports no component: a capitalised export that can be called");
  return sections.join("\n\n");
}

function sourceProblem(root, { kind, source }) {
  if (!SOURCE[kind]) return "is not a block this script writes; use ds:props or ds:tokens";
  if (!source || path.isAbsolute(source) || source.split("/").includes("..") || !statSync(path.join(root, source), { throwIfNoEntry: false })?.isFile())
    return "names a source that does not exist; give a file path from the repository root";
  return SOURCE[kind].test(source) ? undefined : `cannot read ${source}; ds:props takes a .ts or .tsx file and ds:tokens a .css file`;
}

/**
 * Every page with its blocks regenerated: `next` is the text `--write` would save and `stale` the blocks that
 * differ now. `problems` are what stops a block from being generated at all.
 */
export function render(root) {
  const dir = path.join(root, PAGES);
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => `${PAGES}/${f.split(path.sep).join("/")}`).sort(byText) : [];
  const problems = files.length ? [] : [`${PAGES}: no component page found`];
  const pages = files.map((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    const found = markers(text);
    if (!found.blocks.length && !found.problems.length) found.problems.push("has no generated block; add a ds:props or ds:tokens marker pair");
    const blocks = found.blocks.filter((block) => {
      const problem = sourceProblem(root, block);
      if (problem) found.problems.push(`\`${block.label}\` ${problem}`);
      return !problem;
    });
    problems.push(...found.problems.map((problem) => `${file}: ${problem}`));
    return { file, text, blocks };
  });
  // One program for every component source any page names; sorted, so the checker meets the types in the same order each run.
  const sources = [...new Set(pages.flatMap((page) => page.blocks.filter((b) => b.kind === "props").map((b) => b.source)))].sort(byText);
  const built = sources.length ? project(root, sources) : undefined;
  for (const page of pages) {
    page.stale = [];
    page.next = "";
    let at = 0;
    for (const block of page.blocks) {
      let current = page.text.slice(block.from, block.to);
      try {
        const body = block.kind === "props" ? propsTables(built.checker, built.sources[sources.indexOf(block.source)]) : tokenTable(readFileSync(path.join(root, block.source), "utf8"), block.filter, block.source);
        if (current !== `\n\n${body}\n\n`) page.stale.push(block.label);
        current = `\n\n${body}\n\n`;
      } catch (error) {
        problems.push(`${page.file}: \`${block.label}\` ${error.message}`);
      }
      page.next += page.text.slice(at, block.from) + current;
      at = block.to;
    }
    page.next += page.text.slice(at);
  }
  return { pages, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const root = path.resolve(args.includes("--root") ? args[args.indexOf("--root") + 1] : path.join(import.meta.dirname, ".."));
    const { pages, problems } = render(root);
    const stale = pages.filter((page) => page.stale.length);
    const blocks = pages.reduce((n, page) => n + page.blocks.length, 0);
    if (args.includes("--write") && !problems.length) {
      for (const page of stale) writeFileSync(path.join(root, page.file), page.next);
      console.log(`ds-docs: ${pages.length} page(s), ${blocks} generated block(s), ${stale.length} page(s) rewritten`);
    } else {
      if (!args.includes("--write")) problems.push(...stale.flatMap((page) => page.stale.map((label) => `${page.file}: \`${label}\` is out of date; run ${FIX}`)));
      for (const problem of problems) console.error(problem);
      if (problems.length) console.error(`ds-docs: ${problems.length} problem(s)${args.includes("--write") ? "; nothing was written" : ""}`);
      else console.log(`ds-docs: ${pages.length} page(s), ${blocks} generated block(s) match their sources`);
      process.exitCode = problems.length ? 1 : 0;
    }
  } catch (error) {
    console.error(`ds-docs: ${error.message}`);
    process.exitCode = 1;
  }
}
