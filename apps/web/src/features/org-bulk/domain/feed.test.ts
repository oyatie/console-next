import { describe, expect, it } from "vitest";
import { feedRows, scheduled, unitNames } from "./feed";

const batch = (id: string, at: string, over: object = {}) => ({
  id, kind: "APPLY" as const, undoes: null, undone_by: null, undoable: true, actor_id: "me", created_at: at,
  units: [{ op_index: 0, org_unit_id: "u1", version: 1 }, { op_index: 1, org_unit_id: "u2", version: 1 }, { op_index: 2, org_unit_id: "u1", version: 2 }],
  ...over,
});
const change = (id: string, status: string, effectiveDate: string, createdAt: string) =>
  ({ id, code: `OC-${id}`, kind: "REORG", status, target: { kind: "ORG_UNIT", ref: "u1", label: "생산부" }, effectiveDate, reason: "", headcount: 3, siteCount: 0, teamCount: 0, draftedBy: "other", draftedByName: "박지윤", createdAt, updatedAt: createdAt }) as never;

describe("feedRows", () => {
  const rows = feedRows({
    org: [batch("b1", "2026-10-03T00:00:00Z"), batch("b2", "2026-10-05T00:00:00Z", { kind: "UNDO", undoable: false }), batch("b3", "2026-10-04T00:00:00Z", { undone_by: "b2", undoable: false })],
    entity: [{ id: "e1", kind: "APPLY", undoes: null, undone_by: null, change_mode: "SETUP", records: 2, created_at: "2026-10-06T00:00:00Z", undoable: false }],
    changes: [change("c1", "APPLIED", "2026-10-01", "2026-10-02T00:00:00Z")],
    nameOf: (id) => ({ u1: "재무팀" })[id],
    me: "me",
  });
  it("merges the three records newest first", () => {
    expect(rows.map((r) => r.id)).toEqual(["entity:e1", "org:b2", "org:b3", "org:b1", "change:c1"]);
  });
  it("counts a batch's units once and names those still standing", () => {
    expect(rows.find((r) => r.id === "org:b1")).toMatchObject({ count: 2, units: ["재무팀"], actor: { mine: true }, undo: { batchId: "b1" } });
  });
  it("gives every row that cannot be undone its reason", () => {
    expect(rows.map((r) => ("block" in r.undo ? r.undo.block : "ok"))).toEqual(["phase", "isUndo", "undone", "ok", "governed"]);
  });
});

describe("scheduled and unitNames", () => {
  it("lists approved changes after today, nearest first", () => {
    const list = scheduled([change("a", "APPROVED", "2026-12-01", "x"), change("b", "APPROVED", "2026-11-01", "x"), change("c", "APPROVED", "2026-10-06", "x"), change("d", "DRAFT", "2026-11-02", "x")], "2026-10-06");
    expect(list.map((c: { id: string }) => c.id)).toEqual(["b", "a"]);
  });
  it("names a 사업장 by its own unit as well", () => {
    const m = unitNames([{ id: "W", name: "오송공장", org_unit_id: "WU", children: [{ id: "D", name: "생산부", children: [] }] }]);
    expect([m.get("WU"), m.get("D")]).toEqual(["오송공장", "생산부"]);
  });
});
