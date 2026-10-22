import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, typed by its use here
import { check, editableLabels, required } from "./check-reach.mjs";

const cell = (be: string[], st = "ok") => ({ st, be });
const lifecycle = {
  records: [
    { id: "HR.employee.emergency_contact", module: "HR", mvp: true, ops: { create: cell(["PATCH /api/v1/employees/{id}"]), update: cell(["PATCH /api/v1/employees/{id}"]), lifecycle: cell(["PATCH /api/v1/employees/{id}"]) } },
    { id: "Org.legacy_region", module: "Org", mvp: true, ops: { create: cell(["POST /api/v1/regions"], "by-design") } },
    { id: "Payroll.run", module: "Payroll", mvp: false, ops: { create: cell(["POST /api/v1/payroll-runs"]) } },
  ],
};
const via = [{ role: "button", name: "비상연락처 추가" }];
const reach = (["create", "update", "end"] as const).map((op) => ({ record: "HR.employee.emergency_contact", op, page: "card", via }));
const tree = { lifecycle, reach, baseline: [], facts: [{ label: "비상연락처" }], untracked: [], labels: new Map([["비상연락처", "card"]]), units: new Set(["ra-x"]) };

test("required: MVP Org/HR cells naming a backend operation, never a by-design one or a non-MVP module", () => {
  expect(required(lifecycle).map((p: { op: string }) => p.op)).toEqual(["create", "update", "end"]);
});

test("a fully reached tree passes", () => {
  expect(check(tree)).toEqual([]);
});

test("planted: an action the UI does not reach fails, naming the record and op", () => {
  const planted = { ...tree, reach: reach.filter((e) => e.op !== "end") };
  expect(check(planted)).toEqual([expect.stringMatching(/^unreachable: HR\.employee\.emergency_contact·end /)]);
});

test("a baselined gap passes while the base has it; a reached or unrequired entry is stale, and one without a lane is refused", () => {
  const entry = { record: "HR.employee.emergency_contact", op: "create", lane: "unit: ra-x" };
  expect(check({ ...tree, reach: reach.slice(1), baseline: [entry], previous: { baseline: [entry] } })).toEqual([]);
  const stale = { ...tree, baseline: [{ record: "HR.employee.emergency_contact", op: "update", lane: "unit: ra-x" }, { record: "Org.legacy_region", op: "create", lane: "unit: ra-x" }] };
  expect(check(stale)).toEqual([expect.stringMatching(/is now reached/), expect.stringMatching(/no longer required/)]);
  const gap = { ...tree, reach: reach.slice(1), baseline: [{ record: "HR.employee.emergency_contact", op: "create" }] };
  expect(check(gap)).toEqual([expect.stringMatching(/has no lane naming its unit/)]);
});

test("planted: a lane names a registered unit; prose, an unknown unit or a missing registry fails", () => {
  const at = (lane: string, units: Set<string> | null = tree.units) => check({ ...tree, reach: reach.slice(1), baseline: [{ record: "HR.employee.emergency_contact", op: "create", lane }], previous: {}, units });
  expect(at("unit: ra-x (orchestra; reach from the record page)")).toEqual([]);
  expect(at("existing: PEOPLE-W-13 (docs/plans/ideal-work/people.md:464)")).toEqual([expect.stringMatching(/has no lane naming its unit/)]);
  expect(at("unit: cx-people-capability")).toEqual([expect.stringMatching(/names unit cx-people-capability, which is not registered/)]);
  expect(at("unit: ra-x", null)).toEqual([expect.stringMatching(/lanes NOT CHECKED: no versioned reach-unit registry/)]);
});

test("planted: the baseline only shrinks against the base: a gap baselined instead of reached, or listed twice, fails", () => {
  const entry = { record: "HR.employee.emergency_contact", op: "create", lane: "unit: ra-x" };
  const grown = { ...tree, reach: reach.slice(1), baseline: [entry], previous: { baseline: [] } };
  expect(check(grown)).toEqual([expect.stringMatching(/^baseline: HR\.employee\.emergency_contact·create: baseline must only shrink/)]);
  const twice = { ...tree, reach: reach.slice(1), baseline: [entry, entry], previous: { baseline: [entry] } };
  expect(check(twice)).toEqual([expect.stringMatching(/^baseline: HR\.employee\.emergency_contact·create is listed twice/)]);
});

test("planted: UNTRACKED only shrinks against the base, and each label is an editable row or a catalog text", () => {
  const base = { ...tree, facts: [], labels: new Map([["비상연락처", "card"]]), catalog: new Set(["사진", "등록증 보며 수정"]) };
  expect(check({ ...base, untracked: ["비상연락처", "사진", "등록증 보며"], previous: { untracked: ["비상연락처", "사진", "등록증 보며"] } })).toEqual([]);
  expect(check({ ...base, untracked: ["비상연락처", "사진"], previous: { untracked: ["비상연락처"] } })).toEqual([expect.stringMatching(/^untracked: 사진: baseline must only shrink/)]);
  expect(check({ ...base, untracked: ["비상연락처", "비상연락처"], previous: { untracked: ["비상연락처"] } })).toEqual([expect.stringMatching(/^untracked: 비상연락처 is listed twice/)]);
  expect(check({ ...base, untracked: ["비상연락처", "완전히 없는 라벨"] })).toEqual([expect.stringMatching(/untracked 「완전히 없는 라벨」 is no editable row nor a catalog text/)]);
  const button = { ...base, catalog: new Set(["비상연락처 추가"]) };
  expect(check({ ...button, untracked: ["비상연락처", "비상연락처 추가"] })).toEqual([expect.stringMatching(/untracked 「비상연락처 추가」 is an action's name/)]);
});

test("a path longer than two interactions, or to an unknown record, fails", () => {
  const long = { ...tree, reach: [...reach.slice(1), { ...reach[0]!, via: [...via, ...via, ...via] }, { record: "HR.nothing", op: "create", page: "card", via }] };
  expect(check(long)).toEqual([expect.stringMatching(/takes 3 interactions/), expect.stringMatching(/HR\.nothing is not a record type/)]);
});

test("planted: a new editable row with no surfaces mapped fails; a lock mark and the legend sample are not editable", () => {
  const ko = new Map([["empCard.f.new", "새 항목"], ["empCard.f.status", "재직 상태"], ["empCard.legend.sample", "예시"]]);
  const labels = editableLabels([["sec.tsx", '<FieldMark kind="rc" field={t("empCard.f.new")} /> <FieldMark kind="lock" field={t("empCard.f.status")} /> <FieldMark kind={k} field={t("empCard.legend.sample")} />']], ko);
  expect([...labels.keys()]).toEqual(["새 항목"]);
  expect(check({ ...tree, labels })).toEqual([expect.stringMatching(/editable row 「새 항목」/)]);
});

test("the repository's own tree passes the gate", () => {
  const r = spawnSync("node", ["scripts/check-reach.mjs"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
});

test("a hosted checkout proves reachability without a private queue or home pointer", () => {
  const r = spawnSync("node", ["scripts/check-reach.mjs"], {
    encoding: "utf8",
    env: { ...process.env, BACKLOG_QUEUE_DIR: "", XDG_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), "reach-hosted-")) },
  });
  expect(r.status, r.stderr).toBe(0);
});
