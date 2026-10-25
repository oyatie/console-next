// SPDX-License-Identifier: LicenseRef-Proprietary
import { globSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import ts from "typescript";

// Architectural guard: applies to every caller, including pages added after this lane's route sweep.
test("page chrome is outside every QueryState loading boundary", () => {
  const chrome = new Set(["h1", "PageHead", "PeopleHead", "RosterHead", "AccessHead", "AsOfBand", "RosterFilters"]);
  const violations: string[] = [];
  for (const path of globSync("apps/web/src/**/*.tsx", { exclude: ["**/*.test.tsx", "**/*.gallery.tsx"] })) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("<QueryState")) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (node: ts.Node, boundary = false) => {
      if (ts.isJsxElement(node)) {
        const name = node.openingElement.tagName.getText(source);
        if (boundary && chrome.has(name)) violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} ${name}`);
        if (name === "QueryState") boundary = true;
      } else if (boundary && ts.isJsxSelfClosingElement(node) && chrome.has(node.tagName.getText(source))) {
        violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} ${node.tagName.getText(source)}`);
      }
      ts.forEachChild(node, child => walk(child, boundary));
    };
    walk(source);
  }
  expect(violations).toEqual([]);
});
