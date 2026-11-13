#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const META = /^\s*\/\/\s*fixme:\s*owner=([^;]+);\s*reason=([^;]+);\s*expires=(\d{4}-\d{2}-\d{2})\s*$/;
const ignored = new Set([".cache", ".git", "dist", "node_modules", "target"]);

function filesBelow(root, dir = "") {
  const absolute = path.join(root, dir);
  let entries;
  try { entries = readdirSync(absolute, { withFileTypes: true }); }
  catch { return []; }
  return entries.flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : filesBelow(root, relative);
    return entry.isFile() ? [relative] : [];
  });
}

export function checkE2ePolicy(root, today = new Date().toISOString().slice(0, 10)) {
  const tracked = filesBelow(root);
  const files = tracked.filter((file) => {
    if (!/\.[cm]?[jt]s$/.test(file)) return false;
    const source = readFileSync(path.join(root, file), "utf8");
    return /from\s+["']@playwright\/test["']/.test(source) && /\bdefineConfig\s*\(/.test(source);
  }).sort();
  const problems = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (!/\bforbidOnly\s*:/.test(source)) problems.push(`${file}: missing forbidOnly`);
  }
  for (const file of tracked.filter((name) => /^(?:e2e|apps)\//.test(name) && name.endsWith(".ts")).sort()) {
    const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\btest\.fixme\s*\(/.test(line)) return;
      const metadata = lines[index - 1]?.match(META);
      if (!metadata || !metadata[1].trim() || !metadata[2].trim()) {
        problems.push(`${file}:${index + 1}: test.fixme needs an immediately preceding owner, reason and expiry`);
      } else if (metadata[3] <= today) {
        problems.push(`${file}:${index + 1}: test.fixme owned by ${metadata[1].trim()} expired on ${metadata[3]}`);
      }
    });
  }
  for (const file of tracked.filter((name) => name.startsWith("e2e/") && name.endsWith(".spec.ts")).sort()) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const isolated = source.statements.some(statement => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      return !clause?.isTypeOnly && bindings && ts.isNamedImports(bindings)
        && bindings.elements.some(binding => !binding.isTypeOnly && (binding.propertyName ?? binding.name).text === "test")
        && path.resolve(root, path.dirname(file), `${statement.moduleSpecifier.text}.ts`) === path.resolve(root, "e2e/locale-fixture.ts");
    });
    if (isolated) continue;
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === "i18n" && node.expression.name.text === "set") {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        problems.push(`${file}:${line + 1}: i18n.set requires test from e2e/locale-fixture.ts`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkE2ePolicy(root);
  if (problems.length) {
    console.error(`E2E policy failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("E2E policy passed: focus guards, fixme ownership and catalog isolation.");
  }
}
