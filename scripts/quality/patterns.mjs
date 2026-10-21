import ts from "typescript";
import { actual, hashable, isTest } from "./project.mjs";
import { digest } from "./ratchet.mjs";

const SNAPSHOT = /^(?:toMatch(?:Inline)?Snapshot|toThrowErrorMatching(?:Inline)?Snapshot|toHaveScreenshot)$/;

function bindings(source) {
  const tests = new Set(["test", "it"]), expectations = new Set(["expect"]), assertions = new Set(["assert"]);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text, clause = node.importClause;
    const assertionModule = /^(?:node:)?assert(?:\/strict)?$/.test(module);
    if (assertionModule && clause?.name) assertions.add(clause.name.text);
    if (module === "node:test" && clause?.name) tests.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const spec of clause.namedBindings.elements) {
      const original = (spec.propertyName ?? spec.name).text;
      if (["vitest", "@playwright/test", "node:test"].includes(module) && /^(test|it)$/.test(original)) tests.add(spec.name.text);
      if (["vitest", "@playwright/test"].includes(module) && original === "expect") expectations.add(spec.name.text);
      if (assertionModule) assertions.add(spec.name.text);
    }
  }
  return { tests, expectations, assertions };
}

const testCall = (expr, names) => {
  if (ts.isIdentifier(expr)) return names.has(expr.text);
  if (ts.isCallExpression(expr)) return testCall(expr.expression, names);
  if (ts.isTaggedTemplateExpression(expr)) return testCall(expr.tag, names);
  return ts.isPropertyAccessExpression(expr) && testCall(expr.expression, names) && !/^(describe|before|after|use|extend|step)/.test(expr.name.text);
};

const callRoot = (expr) => ts.isIdentifier(expr) ? expr.text :
  ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr) ? callRoot(expr.expression) : "";

function functionBody(node, checker) {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  const symbol = actual(checker, checker.getSymbolAtLocation(node));
  for (const decl of symbol?.declarations ?? []) {
    const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
    if (fn && ts.isFunctionLike(fn) && fn.body) return fn.body;
  }
}

function assertionKinds(body, checker, seen = new Set()) {
  const kinds = new Set();
  const names = bindings(body.getSourceFile());
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call) && /^to[A-Z]/.test(call.name.text) && names.expectations.has(callRoot(call)))
        kinds.add(SNAPSHOT.test(call.name.text) ? "snapshot" : "behavior");
      if (names.assertions.has(callRoot(call))) kinds.add("behavior");
      const symbol = actual(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call) ? call.name : call));
      for (const decl of symbol?.declarations ?? []) {
        if (decl.getSourceFile().fileName.includes("node_modules") || seen.has(decl)) continue;
        const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
        if (fn && (ts.isFunctionLike(fn)) && fn.body) {
          seen.add(decl);
          assertionKinds(fn.body, checker, seen).forEach((kind) => kinds.add(kind));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return kinds;
}

export function patterns(sources, checker, relative) {
  const findings = {};
  for (const source of sources) {
    const file = relative(source.fileName), text = source.text;
    const names = bindings(source);
    const add = (rule, node) => {
      const key = `${rule}:${file}:${digest(hashable(node, source))}`;
      findings[key] = (findings[key] ?? 0) + 1;
    };
    if (!isTest(file) && !file.startsWith("e2e/")) {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
      let kind;
      while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
        if ([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(kind) && /\bTODO\b/i.test(scanner.getTokenText())) {
          const key = `todo:${file}:${digest(scanner.getTokenText().trim())}`;
          findings[key] = (findings[key] ?? 0) + 1;
        }
      }
    }
    const visit = (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) add("empty-catch", node);
      if (isTest(file) && ts.isCallExpression(node) && testCall(node.expression, names.tests)) {
        const body = node.arguments.map((a) => functionBody(a, checker)).find(Boolean);
        if (body) {
          const kinds = assertionKinds(body, checker);
          if (!kinds.size) add("assertionless-test", node);
          else if (!kinds.has("behavior") && !file.includes("/ui/") && !file.endsWith(".spec.ts")) add("snapshot-only-logic", node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
