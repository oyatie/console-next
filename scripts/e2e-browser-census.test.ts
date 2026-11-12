// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

function browserEnvReads(source: string) {
  if (!/\b(?:E2E_BROWSER|E2E_XBROWSER|browserName)\b/.test(source)) return [];
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const reads: string[] = [];
  const key = (node: ts.Node) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const isEnv = (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.getText(file) === "process.env";
  const browserKeys = new Set(["E2E_BROWSER", "E2E_XBROWSER", "browserName"]);
  function visit(node: ts.Node) {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isEnv(node.expression)) {
      const name = key(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
      if (name && browserKeys.has(name)) reads.push(name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const name = key(element.propertyName ?? element.name);
        if (name && browserKeys.has(name)) reads.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return reads;
}

test.each([
  'process.env.E2E_XBROWSER',
  'process.env["E2E_BROWSER"]',
  'const { E2E_XBROWSER: legacy } = process.env',
  'process.env.browserName',
])("the census detects a browser switch: %s", source => {
  expect(browserEnvReads(source)).toHaveLength(1);
});

test("only the browser selector reads engine environment switches", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
  const readers = files.filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && file !== "e2e/browser.ts")
    .filter(file => browserEnvReads(readFileSync(file, "utf8")).length > 0);
  expect(readers).toEqual([]);
});
