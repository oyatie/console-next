import { expect, test } from "vitest";
import { continuityShape, groupMissing, groupTargets, type GroupInput } from "./group-transfer";
import type { PlaceOption } from "./register-place";

const entity = (id: string, workplaces: { id: string; closed_on?: string }[], closed_on?: string) => ({ id, closed_on, current: { name: `법인 ${id}` }, workplaces }) as never;
const place = (unit: string, entityId: string, workplaceId: string | null) => ({ unit: { id: unit }, entity: entityId, entityId, workplaceId, site: "" }) as unknown as PlaceOption;

test("targets: nothing to leave, nowhere to go (whole tenant or a scoped grant), no open 사업장, else the other 법인's units", () => {
  const places = [place("own", "a", "wa"), place("site-b", "b", "wb"), place("team-b", "b", "wb"), place("closed", "b", "wb-closed"), place("loose", "b", null)];
  expect(groupTargets(null, [entity("a", [{ id: "wa" }])], places, false)).toEqual({ kind: "unplaced" });
  expect(groupTargets("a", [entity("a", [{ id: "wa" }])], places, false)).toEqual({ kind: "none", scoped: false });
  expect(groupTargets("a", [entity("a", [{ id: "wa" }]), entity("c", [], "2026-01-01")], places, true)).toEqual({ kind: "none", scoped: true });
  expect(groupTargets("a", [entity("a", [{ id: "wa" }]), entity("b", [{ id: "wb", closed_on: "2026-01-01" }])], places, false)).toEqual({ kind: "noPlace", entities: [{ id: "b", name: "법인 b" }] });
  const ready = groupTargets("a", [entity("a", [{ id: "wa" }]), entity("b", [{ id: "wb" }, { id: "wb-closed", closed_on: "2026-01-01" }])], places, false);
  expect(ready.kind === "ready" && ready.options.map((o) => o.unit.id)).toEqual(["site-b", "team-b"]);
});

const full: GroupInput = {
  unit: "u", workplaceId: "w", severance: "SETTLED", annualLeave: "SETTLED", seniority: "RESTART",
  consentDate: "2026-10-01", consentRef: "전적 동의서", successionRef: "", groupStart: "2020-03-02",
};
const open = (v: GroupInput, date: string) => Object.entries(groupMissing(v, date)).filter(([, on]) => on).map(([k]) => k);

test("missing: every 전적 fact, each continuity dimension, no defaults; the agreement when any is carried; dates on or before the 전적", () => {
  expect(open(full, "2026-11-01")).toEqual([]);
  const bare = { ...full, unit: "", workplaceId: "", severance: null, annualLeave: null, seniority: null, consentRef: " ", consentDate: "", groupStart: "" };
  expect(open(bare, "")).toEqual(["target", "consentRef", "consentDate", "severance", "annualLeave", "seniority", "groupStart"]);
  for (const carried of [{ severance: "CARRIED" }, { annualLeave: "CARRIED" }, { seniority: "CARRIED" }] as const) {
    expect(open({ ...full, ...carried }, "2026-11-01")).toEqual(["successionRef"]);
    expect(open({ ...full, ...carried, successionRef: "승계 합의서" }, "2026-11-01")).toEqual([]);
  }
  expect(open(full, "2026-09-30")).toEqual(["consentDate"]);
  expect(open({ ...full, consentDate: "2026-10-01" }, "2026-10-01")).toEqual([]);
  expect(open({ ...full, groupStart: "2026-12-01" }, "2026-11-01")).toEqual(["groupStart"]);
});

test("continuity reads as one choice when uniform, dimension by dimension when mixed, and a pre-split record keeps its meaning", () => {
  expect(continuityShape({ continuity: "SETTLED", annual_leave_continuity: "SETTLED", seniority_continuity: "RESTART" })).toBe("SETTLED");
  expect(continuityShape({ continuity: "CARRIED", annual_leave_continuity: "CARRIED", seniority_continuity: "CARRIED" })).toBe("CARRIED");
  expect(continuityShape({ continuity: "SETTLED", annual_leave_continuity: "CARRIED", seniority_continuity: "CARRIED" })).toBe("MIXED");
  expect(continuityShape({ continuity: "CARRIED" })).toBe("CARRIED");
  expect(continuityShape({ continuity: "SETTLED" })).toBe("SETTLED");
});
