// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import ts from "typescript";
import { sourceFiles } from "./quality/project.mjs";

// Keep cold server, browser and page startup outside Vitest's per-test budget.
const files = process.argv.slice(2);
if (!files.length) files.push(...sourceFiles(process.cwd(), ["apps/web/src", "scripts", "e2e"]).filter(file => /\.test\.tsx?$/.test(file) || /from\s*["']vitest["']/.test(readFileSync(file, "utf8"))));
const problems = new Set();
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`browser-setup: cannot parse ${file}`);
  const hooks = new Set(["beforeAll"]);
  const functions = new Map();
  const collect = node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "vitest" && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const spec of node.importClause.namedBindings.elements)
        if ((spec.propertyName ?? spec.name).text === "beforeAll") hooks.add(spec.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const visited = new Map();
  const body = (callback, safe) => {
    const fn = callback && (ts.isIdentifier(callback) ? functions.get(callback.text) : callback);
    if (!fn || !ts.isFunctionLike(fn) || !fn.body) return;
    const states = visited.get(fn) ?? new Set();
    if (states.has(safe)) return;
    states.add(safe);
    visited.set(fn, states);
    visit(fn.body, safe);
  };
  const visit = (node, safe) => {
    if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return;
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      if (ts.isIdentifier(call) && hooks.has(call.text)) {
        body(node.arguments[0], node.arguments.length > 1 && node.arguments[1].getText(source) !== "undefined");
        return;
      }
      const name = ts.isPropertyAccessExpression(call) ? call.name.text : ts.isIdentifier(call) ? call.text : "";
      if (/^(createServer|launch|launchPersistentContext|newContext|newPage)$/.test(name) && !safe) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        problems.add(`${file}:${line}: browser startup must run in beforeAll with an explicit hook timeout`);
      }
      if (ts.isIdentifier(call)) body(call, safe);
      for (const arg of node.arguments) if (ts.isIdentifier(arg)) body(arg, safe);
    }
    ts.forEachChild(node, child => visit(child, safe));
  };
  visit(source, false);
  // Vitest hooks may be registered by an exported harness imported by a test file.
  for (const fn of functions.values()) if (fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) body(fn, false);
}
if (problems.size) {
  console.error([...problems].join("\n"));
  process.exitCode = 1;
} else console.log(`browser-setup: ${files.length} test files checked`);
