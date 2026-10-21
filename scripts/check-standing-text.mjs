#!/usr/bin/env node
// Count message/hint sites on each screen surface, including delegated shared components.
import { readFileSync, readdirSync } from "node:fs";
import { readRegistry } from "./standing-text-registry.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATEGORIES = ["FACT", "REFUSAL", "EMPTY", "LEGAL", "RECEIPT", "EXPLANATION"];
const props = new Set(["example", "hint", "basis", "note", "sub", "subtitle", "caption", "description"]);
export const inScope = (file) => file.endsWith(".tsx") && !/\/(shell|features\/structure|gallery)\/|\.(test|gallery)\.tsx$/.test(file);
export const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesIn(`${dir}/${e.name}`) : `${dir}/${e.name}`);

// Count conservatively: facts, refusals and receipts share these surfaces too. A new explanation cannot hide
// behind a dynamic value or a different tone. Removing one block never grants room on another screen.
export function blocks(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (n) => {
    if (ts.isJsxElement(n) && ["p", "span", "Banner"].includes(n.openingElement.tagName.getText(ast))) count++;
    if (ts.isJsxAttribute(n) && props.has(n.name.getText(ast))) count++;
    if (ts.isJsxAttribute(n) && n.name.getText(ast) === "data-hint" && !["p", "span", "Banner"].includes(n.parent.parent.tagName.getText(ast))) count++;
    if (ts.isPropertyAssignment(n) && n.name.getText(ast) === "description" && !ts.isStringLiteral(n.initializer)) count++;
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return count;
}

const resolve = (file, spec, sources) => {
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  return [stem, `${stem}.tsx`, `${stem}.ts`, `${stem}/index.tsx`, `${stem}/index.ts`]
    .find((f) => Object.hasOwn(sources, f));
};
const importsOf = (file, source, sources, dynamicOnly = false) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Set();
  const visit = (n) => {
    const spec = !dynamicOnly && ((ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) || (ts.isExportDeclaration(n) && !n.isTypeOnly)) ? n.moduleSpecifier
      : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword ? n.arguments[0] : undefined;
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) {
      const filePath = resolve(file, spec.text, sources);
      if (filePath && !/\/(shell|features\/structure|gallery)\//.test(filePath)) imports.add(filePath);
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return [...imports];
};

// Routes name their lazy export. Count that screen's own body and shared imports, not its sibling screens.
function screens(file, source, sources) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = new Map();
  const roots = [];
  const collect = (n) => { if (ts.isVariableDeclaration(n) && n.initializer) locals.set(n.name.getText(ast), n.initializer); ts.forEachChild(n, collect); };
  collect(ast);
  const imports = (node, seen = new Set()) => {
    if (ts.isIdentifier(node) && locals.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text); return imports(locals.get(node.text), seen);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      const root = resolve(file, node.arguments[0].text, sources); return root ? [root] : [];
    }
    const found = []; ts.forEachChild(node, (child) => { found.push(...imports(child, seen)); }); return found;
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === "lazyRouteComponent") {
      const name = n.arguments[1] && ts.isStringLiteral(n.arguments[1]) ? n.arguments[1].text : "default";
      for (const root of imports(n.arguments[0])) if (inScope(root)) roots.push([root, name]);
    }
    ts.forEachChild(n, visit);
  };
  visit(ast);
  return roots;
}

function screenBody(file, source, name) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  for (const n of ast.statements) {
    if (ts.isFunctionDeclaration(n) && n.name) declarations.set(n.name.text, n);
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations)
      if (d.initializer) declarations.set(d.name.getText(ast), d.initializer);
  }
  const body = declarations.get(name);
  // Re-export barrels and default wrappers retain their whole import graph.
  if (!body) return source;
  const used = new Set();
  const seen = new Set();
  const parts = [];
  const add = (node) => {
    parts.push(node.getText(ast));
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        used.add(n.text);
        if (declarations.has(n.text) && !seen.has(n.text)) { seen.add(n.text); add(declarations.get(n.text)); }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  seen.add(name); add(body);
  const imports = ast.statements.filter((n) => ts.isImportDeclaration(n) && n.importClause &&
    (used.has(n.importClause.name?.text) || n.importClause.namedBindings &&
      (ts.isNamespaceImport(n.importClause.namedBindings) ? used.has(n.importClause.namedBindings.name.text) : n.importClause.namedBindings.elements.some((e) => used.has(e.name.text)))));
  return imports.map((n) => n.getText(ast)).join("\n") + "\n" + parts.join("\n");
}

export function screenCounts(sources, newScreens = {}) {
  const roots = Object.entries(sources).filter(([f]) => f.startsWith("apps/web/src/routes/") || f === "apps/web/src/main.tsx")
    .flatMap(([f, source]) => screens(f, source, sources));
  const standalone = Object.keys(newScreens).map((key) => key.split("#"));
  const boundaries = new Set(standalone.map(([file]) => file));
  for (const [file, name] of standalone) if (!roots.some(([f, n]) => f === file && n === name)) roots.push([file, name]);
  const counts = {};
  for (const [root, name] of roots) {
    const seen = new Set();
    const count = (file, source = sources[file]) => {
      if (seen.has(file) || (file !== root && boundaries.has(file))) return 0;
      seen.add(file);
      return (inScope(file) ? blocks(file, source) : 0) + importsOf(file, source, sources).reduce((n, f) => n + count(f), 0);
    };
    counts[`${root}#${name}`] = count(root, screenBody(root, sources[root], name));
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function ratchet(now, baseline, previous = baseline, newScreens = {}) {
  const problems = [];
  for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
    const count = now[file] ?? 0, pin = baseline[file] ?? 0;
    if (count > pin) problems.push(`${file}: ${count} standing blocks exceeds ${pin}`);
    if (count < pin) problems.push(`${file}: lower the standing-text baseline from ${pin} to ${count}`);
  }
  for (const [file, count] of Object.entries(baseline))
    if (count > (previous[file] ?? 0) && (Object.hasOwn(previous, file) || !Object.hasOwn(newScreens, file)))
      problems.push(`${file}: standing-text baseline may only go down`);
  for (const [file, counts] of Object.entries(newScreens)) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length !== CATEGORIES.length ||
      !CATEGORIES.every((category) => Number.isSafeInteger(counts[category]) && counts[category] >= 0)) {
      problems.push(`${file}: new screen needs nonnegative integer counts for all six categories`);
      continue;
    }
    if (counts.EXPLANATION > 0) problems.push(`${file}: new screen cannot contain EXPLANATION`);
    if (Object.hasOwn(previous, file)) continue;
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== baseline[file])
      problems.push(`${file}: new-screen category counts must sum to its standing-text pin`);
    if (!Object.hasOwn(now, file)) problems.push(`${file}: classified new screen is absent`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.chdir(ROOT);
  const sources = Object.fromEntries(filesIn("apps/web/src").filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => [f, readFileSync(f, "utf8")]));
  const { baseline, newScreens } = readRegistry();
  const now = screenCounts(sources, newScreens);
  const previous = readRegistry("dev").baseline;
  const problems = ratchet(now, baseline, previous, newScreens);
  if (problems.length) {
    console.error(`standing-text: ${problems.length} problem(s):\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`standing-text: ${Object.keys(now).length} screens, ${Object.values(now).reduce((sum, n) => sum + n, 0)} blocks; pins match, existing pins unchanged or lower`);
}
