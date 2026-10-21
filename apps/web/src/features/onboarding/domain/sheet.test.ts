import { expect, test } from "vitest";
import type { OrgStructureNode } from "@console/api/pending";
import { readDelimited } from "../../../lib/sheet-file";
import { SHEET_COLUMNS, setupSheet } from "./sheet";

const node = (kind: OrgStructureNode["kind"], name: string, children: OrgStructureNode[] = []): OrgStructureNode => ({
  kind, id: name, name, headcount: 2000, direct_headcount: 0, dispatched_headcount: 0, chips: [], children,
});

test("the setup sheet keeps column order, hierarchy, labels, head and code at every depth", () => {
  const team = { ...node("DEPARTMENT", "Team, \"A\"\nB"), code: "A1", head: { employee_id: "head", name: "Head", since: null, concurrent: false } };
  const dept = node("DEPARTMENT", "Department", [team]);
  const site = node("WORKPLACE", "Workplace", [dept]);
  const entity = node("LEGAL_ENTITY", "Entity", [site]);
  const csv = setupSheet({ tenant_name: "Account", phase: "SETUP", entities: [entity], unplaced: [] }, [], SHEET_COLUMNS, (n) => n.kind);
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(readDelimited(csv.slice(1))).toEqual([
    [...SHEET_COLUMNS],
    ["LEGAL_ENTITY", "Entity", "", "", "", "", "2000"],
    ["WORKPLACE", "Entity", "Workplace", "", "", "", "2000"],
    ["DEPARTMENT", "Entity", "Workplace", "Department", "", "", "2000"],
    ["DEPARTMENT", "Entity", "Workplace", 'Department > Team, "A"\nB', "A1", "Head", "2000"],
  ]);
  expect(csv).not.toContain("Account");
});

test("an empty tenant gets a usable header and imported names cannot run spreadsheet formulas", () => {
  const empty = { tenant_name: "Account", phase: "SETUP" as const, entities: [], unplaced: [] };
  expect(readDelimited(setupSheet(empty, [], SHEET_COLUMNS, (n) => n.kind).slice(1))).toEqual([[...SHEET_COLUMNS]]);
  const csv = setupSheet({ ...empty, entities: [node("LEGAL_ENTITY", '=HYPERLINK("bad")')] }, [], SHEET_COLUMNS, (n) => n.kind);
  expect(readDelimited(csv.slice(1))[1]![1]).toBe('\'=HYPERLINK("bad")');
});
