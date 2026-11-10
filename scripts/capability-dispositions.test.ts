// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
// @ts-expect-error: the gate is an executable JavaScript module.
import { checkDispositions, checkOperations, lowerOperations } from "./check-reach.mjs";

const op = "POST /api/v1/regions";
const allowance = { lane: "Organization structure", reason: "Separate region drafting is retired; workplaces own placement.", when: "place model retirement" };
const row = (disposition: string, detail = "Reason") => `| \`${op}\` | hidden | ${disposition} | ${detail} |`;
const tree = { document: row("allow-list"), served: new Set([op]), gaps: [op], operations: {}, capabilities: { [op]: allowance } };

test("a hidden operation has an owned allowance, rather than a promised screen", () => {
  expect(checkDispositions(tree)).toEqual([]);
  expect(checkDispositions({ ...tree, document: row("expose", "`/org` · `Draft`") })).toContainEqual(expect.stringContaining("not exposed"));
});

test.each(["lane", "reason", "when"])("a capability allowance requires %s", field => {
  expect(checkDispositions({ ...tree, capabilities: { [op]: { ...allowance, [field]: " " } } })).toContainEqual(expect.stringContaining("needs a lane, reason and release gate"));
});

test("a disposition cannot silently omit, duplicate or invent an operation", () => {
  expect(checkDispositions({ ...tree, document: "" })).toContainEqual(expect.stringContaining("unclassified"));
  expect(checkDispositions({ ...tree, document: `${tree.document}\n${tree.document}` })).toContainEqual(expect.stringContaining("duplicate"));
  expect(checkDispositions({ ...tree, served: new Set() })).toContainEqual(expect.stringContaining("not served"));
});

test("an allowance cannot go missing, stale or grow after seeding", () => {
  expect(checkDispositions({ ...tree, capabilities: {} })).toContainEqual(expect.stringContaining("no owned allowance"));
  expect(checkDispositions({ ...tree, document: row("internal", "Retired protocol; no user action.") })).toContainEqual(expect.stringContaining("stale allowance"));
  expect(checkDispositions({ ...tree, previous: {} })).toContainEqual(expect.stringContaining("baseline must only shrink"));
  expect(checkDispositions({ ...tree, previous: tree.capabilities })).toEqual([]);
});

test("existing operation allowances and genuine product call sites remain usable", () => {
  expect(checkDispositions({ ...tree, capabilities: {}, operations: { [op]: allowance } })).toEqual([]);
  expect(checkDispositions({ ...tree, capabilities: {}, gaps: [], document: row("expose", "`/org` · `Draft`").replace("hidden", "partial") })).toEqual([]);
  expect(checkDispositions({ ...tree, capabilities: {}, gaps: [], document: row("expose", "Missing destination").replace("hidden", "partial") })).toContainEqual(expect.stringContaining("needs a route and component"));
  expect(checkDispositions({ ...tree, capabilities: {}, document: row("internal", "Retired protocol; no user action.") })).toEqual([]);
  expect(checkDispositions({ ...tree, capabilities: {}, document: row("unknown") })).toContainEqual(expect.stringContaining("invalid disposition"));
});

test("route allowances survive wrapper calls and --lower until their screen is delivered", () => {
  const operations = { [op]: { ...allowance, scope: "route" } };
  expect(checkOperations({ gaps: [], uncalled: [], operations, previous: {} })).toEqual([]);
  expect(lowerOperations(operations, [])).toEqual(operations);
});
