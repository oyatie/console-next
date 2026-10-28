#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isTest, sourceFiles } from "./quality/project.mjs";

/** CSV joins must write every cell, including headers, through the canonical writer. */
export function csvCellProblems(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const joins = [];
  const writers = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text)).replace(/\.ts$/, "");
    if (target !== "apps/web/src/lib/csv-cell") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "csvCell") writers.add(binding.name.text);
      }
    }
  }
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "join" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) joins.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const csv = joins.some(node => /[\r\n]/.test(node.arguments[0].text)) || /new\s+Blob\b[\s\S]*text\/csv/.test(text);
  if (!csv) return [];
  return joins.filter(node => node.arguments[0].text === ",").flatMap(node => {
    const cells = node.expression.expression;
    const written = ts.isCallExpression(cells) && ts.isPropertyAccessExpression(cells.expression) &&
      cells.expression.name.text === "map" && cells.arguments.length === 1 &&
      ts.isIdentifier(cells.arguments[0]) && writers.has(cells.arguments[0].text);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return written ? [] : [`${file}:${line}: CSV cells must use lib/csv-cell.csvCell before joining`];
  });
}

export function checkCsvCells(root = process.cwd()) {
  return sourceFiles(root, ["apps/web/src"]).filter(file => !isTest(file)).flatMap(file =>
    csvCellProblems(file, readFileSync(path.join(root, file), "utf8")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkCsvCells();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  }
}
