import ts from "typescript";
import path from "node:path";
import { actual, isTest, platformEntry } from "./project.mjs";

export function deadCode(sources, checker, relative) {
  const all = new Map(sources.map((s) => [relative(s.fileName), s]));
  const edges = new Map(), uses = new Map(), exported = new Map();
  for (const [file, source] of all) {
    const dependencies = new Set(), references = new Set();
    const module = checker.getSymbolAtLocation(source);
    exported.set(file, module ? checker.getExportsOfModule(module) : []);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "lazyRouteComponent" &&
          node.arguments[1] && ts.isStringLiteralLike(node.arguments[1])) {
        const name = node.arguments[1].text;
        const visited = new Set();
        const imported = (child) => {
          if (visited.has(child)) return;
          visited.add(child);
          if (ts.isIdentifier(child)) {
            for (const declaration of checker.getSymbolAtLocation(child)?.declarations ?? [])
              if (ts.isVariableDeclaration(declaration) && declaration.initializer) imported(declaration.initializer);
          }
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword &&
              child.arguments[0] && ts.isStringLiteralLike(child.arguments[0])) {
            const symbol = checker.getSymbolAtLocation(child.arguments[0]);
            const target = symbol && checker.getExportsOfModule(symbol).find((s) => s.name === name);
            if (target) references.add(actual(checker, target));
          }
          ts.forEachChild(child, imported);
        };
        if (node.arguments[0]) imported(node.arguments[0]);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === "import.meta.glob") {
        const arg = node.arguments[0];
        const globs = arg && ts.isArrayLiteralExpression(arg) ? arg.elements : [arg];
        for (const glob of globs.filter((g) => g && ts.isStringLiteralLike(g))) {
          const pattern = path.posix.normalize(path.posix.join(path.posix.dirname(file), glob.text));
          for (const [target, targetSource] of all) if (path.matchesGlob(target, pattern)) {
            dependencies.add(target);
            const targetSymbol = checker.getSymbolAtLocation(targetSource);
            if (targetSymbol) checker.getExportsOfModule(targetSymbol).forEach((s) => references.add(actual(checker, s)));
          }
        }
      }
      if (ts.isStringLiteralLike(node) && (
        (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node ||
        ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
      )) {
        const symbol = checker.getSymbolAtLocation(node);
        for (const decl of symbol?.declarations ?? []) {
          const dependency = relative(decl.getSourceFile().fileName);
          if (all.has(dependency)) dependencies.add(dependency);
        }
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const declaration = parent.name === node && ts.isDeclaration(parent);
        const importOrExport = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
        if (!declaration && !importOrExport) {
          const symbol = actual(checker, checker.getSymbolAtLocation(node));
          if (symbol) {
            references.add(symbol);
            // Passing a namespace as a value reads its exported surface, not just its module symbol.
            if (symbol.flags & ts.SymbolFlags.Module && !(ts.isPropertyAccessExpression(parent) && parent.expression === node))
              checker.getExportsOfModule(symbol).forEach((s) => references.add(actual(checker, s)));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    edges.set(file, dependencies);
    uses.set(file, references);
  }
  const live = new Set();
  const mark = (file) => {
    if (live.has(file)) return;
    live.add(file);
    edges.get(file)?.forEach(mark);
  };
  for (const file of all.keys()) if (["apps/web/src/main.tsx", "e2e/global-setup.ts"].includes(file) || isTest(file) || platformEntry(file)) mark(file);
  const readers = new Map();
  for (const file of live) for (const symbol of uses.get(file) ?? []) {
    if (!readers.has(symbol)) readers.set(symbol, new Set());
    readers.get(symbol).add(file);
  }
  const findings = {};
  for (const [file, exports] of exported) {
    if (!live.has(file)) findings[`dead-file:${file}`] = 1;
    else for (const symbol of exports) {
      if (platformEntry(file) && symbol.name === "default") continue;
      const target = actual(checker, symbol);
      if (![...(readers.get(target) ?? [])].some((reader) => reader !== file))
        findings[`unused-export:${file}:${symbol.name}`] = 1;
    }
  }
  return findings;
}
