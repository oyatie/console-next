import { describe, expect, it } from "vitest";
import { feedRows, filterRows, scheduled, unitNames } from "./feed";

const batch = (id: string, at: string, over: object = {}) => ({
  id, kind: "APPLY" as const, undoes: null, undone_by: null, undoable: true, actor_id: "me", created_at: at,
  units: [{ op_index: 0, org_unit_id: "u1", version: 1 }, { op_index: 1, org_unit_id: "u2", version: 1 }, { op_index: 2, org_unit_id: "u1", version: 2 }],
  ...over,
});

describe("history filters", () => {
  const rows = feedRows({ org: [
    batch("before", "2026-10-04T14:59:59Z", { actor_id: "other" }),
    batch("first", "2026-10-04T15:00:00Z"),
    batch("last", "2026-10-05T14:59:59Z"),
    batch("after", "2026-10-05T15:00:00Z"),
  ], entity: [], changes: [], nameOf: () => undefined, me: "me" });
  const filters = { source: "all" as const, undoable: false, from: "", to: "", actorId: "" };
  it("includes both recorded-date bounds in the displayed business zone", () => {
    expect(filterRows(rows, { ...filters, from: "2026-10-05", to: "2026-10-05" }).map(r => r.id)).toEqual(["org:last", "org:first"]);
  });
  it("filters by the recorded actor id and clearing the filters restores all rows", () => {
    expect(filterRows(rows, { ...filters, actorId: "other" }).map(r => r.id)).toEqual(["org:before"]);
    expect(filterRows(rows, filters)).toEqual(rows);
  });
  it("combines source, actor, period and undoability", () => {
    expect(filterRows(rows, { ...filters, source: "entity", actorId: "me", from: "2026-10-05", undoable: true })).toEqual([]);
  });
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
  it("keeps the server's recorded actor and actions even for the signed-in actor", () => {
    const named = feedRows({
      org: [batch("named", "2026-10-03T00:00:00Z", { actor_name: "김인사", actions: ["org_unit.setup_rename"], unit_names: ["품질관리팀"] })],
      entity: [], changes: [], nameOf: () => "나중 이름", me: "me",
    });
    expect(named[0]).toMatchObject({ actor: { id: "me", name: "김인사" }, actions: ["org_unit.setup_rename"], units: ["품질관리팀"] });
  });
  it("keeps direct entity/workplace registrations in the same feed without offering batch undo", () => {
    const registered = feedRows({
      org: [], entity: [{ id: "registration", kind: "APPLY", change_mode: "SETUP", records: 1, created_at: "2026-10-06T00:00:00Z", undoable: false,
        actor_id: "me", actor_name: "김인사", registration_action: "legal_entity.create", target_names: ["주식회사 새온"], actions: ["CREATE_ENTITY"] },
      { id: "registration", kind: "APPLY", change_mode: "SETUP", records: 1, created_at: "2026-10-05T00:00:00Z", undoable: true }],
      changes: [], nameOf: () => undefined, me: "me",
    });
    expect(registered[0]).toMatchObject({ source: "entity", registration: "legal_entity.create", actor: { id: "me", name: "김인사" }, units: ["주식회사 새온"], undo: { block: "registration" } });
    expect(registered.map(r => r.id)).toEqual(["registration:registration", "entity:registration"]);
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
