import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { ancestorsOf, childIndex, defaultExpanded, filterTree, historyLines, markerOf, moveTargets } from "./tree";

type Unit = components["schemas"]["OrgUnitHead"];
type Summary = components["schemas"]["OrgChangeSummary"];
type Revision = components["schemas"]["OrgUnitRevision"];

const unit = (id: string, kind: Unit["kind"], parentId: string | null, name = id, status: Unit["status"] = "ACTIVE"): Unit =>
  ({ id, kind, name, parentId, status, effectiveFrom: "2026-01-01", headcount: 0, updatedAt: "" });
const units = [
  unit("root", "COMPANY", null),
  unit("hq", "SITE", "root", "본사"),
  unit("plant", "SITE", null, "공장"),
  unit("hr", "DEPARTMENT", "hq", "인사부"),
  unit("ops", "DEPARTMENT", "hq", "운영부"),
  unit("rec", "TEAM", "hr", "채용팀"),
  unit("sub", "TEAM", "rec", "채용지원팀"),
  unit("old", "TEAM", "hr", "인사기획팀", "DISSOLVED"),
];
const change = (id: string, status: Summary["status"], effectiveDate = "2026-11-02"): Summary =>
  ({ id, code: id, kind: "REORG", status, target: { kind: "ORG_UNIT", ref: "rec", label: "" }, effectiveDate, reason: "", headcount: 0, siteCount: 0, teamCount: 0, draftedBy: "u", draftedByName: null, createdAt: "", updatedAt: "" });

test("childIndex: a legacy null-parent site under the root; dissolved only on request", () => {
  expect(childIndex(units, false).get("root")?.map((u) => u.id)).toEqual(["hq", "plant"]);
  expect(childIndex(units, false).get("hr")?.map((u) => u.id)).toEqual(["rec"]);
  expect(childIndex(units, true).get("hr")?.map((u) => u.id)).toEqual(["rec", "old"]);
});

test("ancestorsOf and defaultExpanded: teams start closed except on the selection's path", () => {
  expect(ancestorsOf(units, "sub")).toEqual(["rec", "hr", "hq", "root"]);
  expect(defaultExpanded(units).has("rec")).toBe(false);
  expect(defaultExpanded(units, "sub").has("rec")).toBe(true);
});

test("filterTree: matches keep their path; kinds narrow; dissolved only when included; no filter shows all", () => {
  expect(filterTree(units, { q: "", kinds: new Set(), dissolved: false })).toBeUndefined();
  const r = filterTree(units, { q: "채용", kinds: new Set(), dissolved: false })!;
  expect([...r.matches]).toEqual(["rec", "sub"]);
  expect(r.visible).toEqual(new Set(["rec", "sub", "hr", "hq", "root"]));
  expect([...filterTree(units, { q: "인사", kinds: new Set(), dissolved: false })!.matches]).toEqual(["hr"]);
  expect([...filterTree(units, { q: "인사", kinds: new Set(), dissolved: true })!.matches]).toEqual(["hr", "old"]);
  expect([...filterTree(units, { q: "", kinds: new Set(["SITE"]), dissolved: false })!.matches]).toEqual(["hq", "plant"]);
});

test("moveTargets: a 사업장 or any other 부서 (decisions #18), not itself, its parent or its own sub-units", () => {
  expect(moveTargets(units, units.find((u) => u.id === "rec")!).map((u) => u.id)).toEqual(["hq", "plant", "ops"]);
  expect(moveTargets(units, units.find((u) => u.id === "hr")!).map((u) => u.id)).toEqual(["plant", "ops"]);
});

test("markerOf: the most urgent kind, its earliest change, and the count of the rest", () => {
  expect(markerOf([], "2026-10-02")).toBeUndefined();
  const m = markerOf([change("d", "DRAFT"), change("a", "IN_APPROVAL"), change("b", "IN_APPROVAL"), change("x", "REJECTED")], "2026-10-02")!;
  expect(m).toMatchObject({ kind: "inApproval", count: 2, more: 1 });
  expect(markerOf([change("s", "APPROVED", "2026-12-01"), change("t", "APPROVED", "2026-11-01")], "2026-10-02")).toMatchObject({ kind: "scheduled", change: { id: "t" } });
  expect(markerOf([change("s", "APPROVED", "2026-10-02")], "2026-10-02")?.kind).toBe("due");
});

test("historyLines: what changed between revisions, newest first", () => {
  const rev = (version: number, name: string, parentId: string, status: Revision["status"] = "ACTIVE"): Revision =>
    ({ version, name, parentId, status, effectiveFrom: `2026-0${version}-01`, actorId: "u", actorName: "김인사", createdAt: "" });
  const lines = historyLines([rev(3, "인재팀", "ops", "DISSOLVED"), rev(2, "인재팀", "hr"), rev(1, "채용팀", "hr")]);
  expect(lines.map((l) => l.kind)).toEqual(["dissolved", "moved", "renamed", "created"]);
  expect(lines[2]).toMatchObject({ from: "채용팀", to: "인재팀", date: "2026-02-01" });
  expect(lines[1]).toMatchObject({ from: "hr", to: "ops" });
});

test("historyLines: a code and a 부서장 change are lines, and a merge names its successor (regression: org-17, org-07)", () => {
  const base = { name: "개발팀", parentId: "hq", status: "ACTIVE" as const, actorId: "u", actorName: "김인사", createdAt: "" };
  const lines = historyLines([
    { ...base, version: 4, effectiveFrom: "2026-04-01", status: "DISSOLVED", code: "D-1", headEmployeeId: "e1", headName: "박개발", mergedInto: "hr" },
    { ...base, version: 3, effectiveFrom: "2026-03-01", code: "D-1", headEmployeeId: "e1", headName: "박개발" },
    { ...base, version: 2, effectiveFrom: "2026-02-01", code: "D-1" },
    { ...base, version: 1, effectiveFrom: "2026-01-01" },
  ] as Revision[]);
  expect(lines.map((l) => l.kind)).toEqual(["merged", "head", "code", "created"]);
  expect(lines[0]).toMatchObject({ into: "hr" });
  expect(lines[1]).toMatchObject({ from: null, to: "박개발" });
  expect(lines[2]).toMatchObject({ from: null, to: "D-1" });
});
