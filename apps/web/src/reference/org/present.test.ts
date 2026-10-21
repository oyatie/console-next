import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { applyOps, changeTitle, descendants, openChangesByRef, openChangesByUnit, rollupHeadcount } from "./present";

type Unit = components["schemas"]["OrgUnitHead"];
type Summary = components["schemas"]["OrgChangeSummary"];

beforeAll(() => loadCatalog("ko"));

const NIL = "00000000-0000-0000-0000-000000000000";
const UUID = "9e207452-1111-4222-8333-444455556666";
const unit = (id: string, kind: Unit["kind"], parentId: string | null, headcount = 0, status: Unit["status"] = "ACTIVE"): Unit =>
  ({ id, kind, name: id, parentId, status, effectiveFrom: "2026-01-01", headcount, updatedAt: "2026-01-01T00:00:00Z" });
// root(10) › hq(site, 1) › hr(dept, 0) › rec(team, 2) › sub(team, 3); hq › ops(dept, 4); hr › old(team, dissolved, 0)
const units = [
  unit("root", "COMPANY", null, 10),
  unit("hq", "SITE", "root", 1),
  unit("hr", "DEPARTMENT", "hq", 0),
  unit("rec", "TEAM", "hr", 2),
  unit("sub", "TEAM", "rec", 3),
  unit("ops", "DEPARTMENT", "hq", 4),
  unit("old", "TEAM", "hr", 0, "DISSOLVED"),
];
const change = (x: Partial<Summary>): Summary =>
  ({ id: "c", code: "OC-2026-0001", kind: "REORG", status: "DRAFT", target: { kind: "ORG_UNIT", ref: "rec", label: "x" }, effectiveDate: "2026-11-02", reason: "", headcount: 0, siteCount: 0, teamCount: 0, draftedBy: "u", draftedByName: null, createdAt: "", updatedAt: "", ...x });

test("descendants: every unit below, any status, not the unit itself; a legacy null-parent site sits under the root", () => {
  expect(descendants(units, "hr")).toEqual(new Set(["rec", "sub", "old"]));
  expect(descendants(units, "sub")).toEqual(new Set());
  expect(descendants([unit("root", "COMPANY", null), unit("s", "SITE", null), unit("d", "DEPARTMENT", "s")], "root")).toEqual(new Set(["s", "d"]));
});

test("rollupHeadcount: direct plus active descendants; the company keeps its tenant-wide count", () => {
  const r = rollupHeadcount(units);
  expect(r.get("hr")).toBe(5);
  expect(r.get("hq")).toBe(10);
  expect(r.get("rec")).toBe(5);
  expect(r.get("root")).toBe(10);
  expect(r.get("old")).toBe(0);
});

test("openChangesByUnit: by target ref, a site create's nil ref on the root, and every unit a detail's ops name", () => {
  const a = change({ id: "a" });
  const b = change({ id: "b", kind: "NEW", target: { kind: "ORG_UNIT", ref: NIL, label: "본사" } });
  const c = { ...change({ id: "c", target: { kind: "ORG_UNIT", ref: "rec", label: "x" } }), proposal: [{ op: "REASSIGN_ORG_UNIT" as const, fromOrgUnit: "rec", toOrgUnit: "ops", scope: { company: "x" } }] };
  const m = openChangesByUnit([a, b, c], "root");
  expect(m.get("rec")?.map((x) => x.id)).toEqual(["a", "c"]);
  expect(m.get("root")?.map((x) => x.id)).toEqual(["b"]);
  expect(m.get("ops")?.map((x) => x.id)).toEqual(["c"]);
  const r = openChangesByRef([change({ id: "r", target: { kind: "REGION", ref: "reg", label: "x" } }), change({ id: "n", target: { kind: "REGION", ref: NIL, label: "x" } })], "REGION");
  expect([...r.keys()]).toEqual(["reg"]);
});

test("changeTitle: the label, else a resolved name for the server's id placeholder, else the op's id, else the code", () => {
  const name = (_k: string, id: string) => ({ rec: "채용팀", reg: "수도권" })[id];
  expect(changeTitle(change({ kind: "NEW", target: { kind: "ORG_UNIT", ref: "hr", label: "인재개발팀" } }), name)).toBe("신설 · 인재개발팀");
  expect(changeTitle(change({ kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: "rec", label: `OrgUnit ${UUID}` } }), name)).toBe("폐지 · 채용팀");
  expect(changeTitle(change({ kind: "DISSOLVE", target: { kind: "REGION", ref: "reg", label: `Region ${UUID}` } }), name)).toBe("폐지 · 수도권");
  const viaOp = { ...change({ kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: "free-form", label: `OrgUnit ${UUID}` } }), proposal: [{ op: "DISSOLVE_ORG_UNIT" as const, orgUnitId: "rec" }] };
  expect(changeTitle(viaOp, name)).toBe("폐지 · 채용팀");
  expect(changeTitle(change({ kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: "gone", label: `OrgUnit ${UUID}` } }), name)).toBe("폐지 · OC-2026-0001");
});

test("applyOps: projects creates, renames, moves, dissolves and a reassign's headcount", () => {
  const { units: out, marks } = applyOps(units, [
    { op: "CREATE_ORG_UNIT", kind: "TEAM", parentId: "hr", name: "인재팀" },
    { op: "RENAME_ORG_UNIT", orgUnitId: "ops", name: "운영부" },
    { op: "MOVE_ORG_UNIT", orgUnitId: "sub", parentId: "ops" },
    { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "rec", toOrgUnit: "ops", scope: { company: "x" } },
    { op: "DISSOLVE_ORG_UNIT", orgUnitId: "rec" },
  ]);
  const by = new Map(out.map((u) => [u.id, u]));
  expect(by.get("new:0")).toMatchObject({ name: "인재팀", parentId: "hr", kind: "TEAM" });
  expect(by.get("ops")).toMatchObject({ name: "운영부", headcount: 6 });
  expect(by.get("sub")?.parentId).toBe("ops");
  expect(by.get("rec")).toMatchObject({ status: "DISSOLVED", headcount: 0 });
  expect(marks.get("rec")).toEqual(["lost", "dissolved"]);
  expect(units.find((u) => u.id === "ops")?.name).toBe("ops"); // input untouched
});
