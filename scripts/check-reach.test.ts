import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REACH } from "../e2e/record-actions/reach";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script, typed by its use here
import { check, editableLabels, required, operationGaps, checkOperations, lowerOperations, releasePackages, operationsAtBase } from "./check-reach.mjs";

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
}, 30_000);


const plantedOp = "GET /api/v1/employees/parity-probe";
const paritySpec = { paths: {
  "/api/v1/employees/parity-probe": { get: {} },
  "/api/v1/payroll-runs": { get: {} },
} };
const parity = (files: [string, string][] = []) => operationGaps({
  spec: paritySpec, files, crates: new Map([[plantedOp, "hr"], ["GET /api/v1/payroll-runs", "payroll"]]), releaseCrates: new Set(["hr"]),
});

test("a hosted checkout proves reachability without a private queue or home pointer", () => {
  const r = spawnSync("node", ["scripts/check-reach.mjs"], {
    encoding: "utf8",
    env: { ...process.env, BACKLOG_QUEUE_DIR: "", XDG_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), "reach-hosted-")) },
  });
  expect(r.status, r.stderr).toBe(0);
}, 30_000);
const allowance = { lane: "P1b", reason: "Employee card delivery, units/mvp-completion/plan.md" };

test("operations: an uncalled MVP OpenAPI operation is refused with METHOD path, even if a test calls it", () => {
  const files: [string, string][] = [["apps/web/src/parity.test.ts", `api.GET("/api/v1/employees/parity-probe")`]];
  expect(checkOperations({ gaps: parity(files), operations: {} })).toEqual([expect.stringContaining(`operation-unreachable: ${plantedOp}`)]);
  expect(parity()).toEqual([plantedOp]);
});

test("operations: generated client, literal fetch and same-file constant calls reach only the matching method", () => {
  for (const source of [
    `api.GET("/api/v1/employees/parity-probe")`,
    `fetch('/api/v1/employees/parity-probe?limit=1')`,
    `const PROBE = "/api/v1/employees/parity-probe"; get(PROBE)`,
    `api.GET(flag ? "/api/v1/employees/parity-probe" : "/api/v1/employees/other")`,
  ]) expect(parity([["apps/web/src/probe.ts", source]])).toEqual([]);
  expect(parity([["apps/web/src/probe.ts", `api.POST("/api/v1/employees/parity-probe")`]])).toEqual([plantedOp]);
});

test("operations: types, comments, cache keys, gallery and spec files never count as calls", () => {
  for (const source of [
    `type Probe = paths["/api/v1/employees/parity-probe"];`,
    `// api.GET("/api/v1/employees/parity-probe")`,
    `const READS = ["/api/v1/employees/parity-probe"];`,
    `read("/api/v1/employees/parity-probe", () => null)`,
  ]) expect(parity([["apps/web/src/probe.ts", source]])).toEqual([plantedOp]);
  for (const file of ["apps/web/src/probe.spec.ts", "apps/web/src/probe.gallery.tsx", "apps/web/src/__tests__/probe.ts", "packages/api/src/schema.d.ts"])
    expect(parity([[file, `api.GET("/api/v1/employees/parity-probe")`]])).toEqual([plantedOp]);
});

test("operations: every allowance needs a lane and reason; valid owned debt passes", () => {
  for (const bad of [{ reason: allowance.reason }, { lane: allowance.lane }, { lane: " ", reason: " " }]) {
    expect(checkOperations({ gaps: [plantedOp], operations: { [plantedOp]: bad } })).toEqual([expect.stringContaining(`operation-owner: ${plantedOp}`)]);
  }
  expect(checkOperations({ gaps: [plantedOp], operations: { [plantedOp]: allowance }, previous: { [plantedOp]: allowance } })).toEqual([]);
});

test("operations: adding an allowance after the base is refused; initial seeding and shrinking pass", () => {
  expect(checkOperations({ gaps: [plantedOp], operations: { [plantedOp]: allowance }, previous: {} })).toEqual([expect.stringContaining(`operations: ${plantedOp}: baseline must only shrink`)]);
  expect(checkOperations({ gaps: [], operations: {}, previous: { [plantedOp]: allowance } })).toEqual([]);
});

test("operations: --lower removes an allowance once its operation is called or deleted and retains deferred non-MVP debt", () => {
  const deferred = "GET /api/v1/payroll-runs";
  const operations = { [plantedOp]: allowance, [deferred]: allowance };
  const allUncalled = operationGaps({ spec: paritySpec, files: [["apps/web/src/probe.ts", `api.GET("/api/v1/employees/parity-probe")`]], crates: new Map(), releaseCrates: undefined });
  expect(checkOperations({ gaps: [], operations: { [plantedOp]: allowance }, uncalled: allUncalled })).toEqual([expect.stringContaining(`operation-stale: ${plantedOp}`)]);
  expect(lowerOperations(operations, allUncalled)).toEqual({ [deferred]: allowance });
});

test("operations: parameter calls prefer literal endpoints and never reach the sibling static path", () => {
  const spec = { paths: { "/api/v1/employees/{id}": { get: {} }, "/api/v1/employees/facets": { get: {} } } };
  expect(operationGaps({ spec, files: [["apps/web/src/probe.ts", 'get(`/api/v1/employees/${id}`)']], crates: new Map() })).toEqual(["GET /api/v1/employees/facets"]);
  expect(operationGaps({ spec, files: [["apps/web/src/probe.ts", 'api.GET("/api/v1/employees/facets")']], crates: new Map() })).toEqual(["GET /api/v1/employees/{id}"]);
});

test("operations: release packages follow default features and optional dependency activation", () => {
  const app = { features: { default: ["mvp"], mvp: ["attendance"], attendance: ["dep:console-attendance-rest"], full: ["payroll"] }, dependencies: [
    { name: "console-hr-rest", optional: false }, { name: "console-attendance-rest", optional: true }, { name: "console-payroll-rest", optional: true },
  ] };
  expect([...releasePackages(app)]).toEqual(["console-hr-rest", "console-attendance-rest"]);
});


test("operations: the CLI rejects a removed release-operation allowance against a committed base", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "reach-cli-")));
  try {
    for (const dir of ["scripts/quality", "apps/web"]) mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ["check-reach.mjs", "backlog-claims.mjs", "backlog-sources.mjs", "quality/ratchet.mjs", "reach-baseline.json"]) copyFileSync(`scripts/${file}`, path.join(root, "scripts", file));
    for (const dir of ["node_modules", "backend", "docs", "e2e", "packages", "registry", "apps/web/src", "apps/web/public"]) symlinkSync(path.resolve(dir), path.join(root, dir), "dir");
    for (const args of [["init"], ["add", "scripts/reach-baseline.json"], ["-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-m", "test: seed reach baseline"]]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const run = () => spawnSync("node", [path.join(root, "scripts/check-reach.mjs"), "--base", "HEAD"], { encoding: "utf8" });
    const clean = run();
    expect(clean.status, clean.stderr).toBe(0);
    const data = JSON.parse(readFileSync(path.join(root, "scripts/reach-baseline.json"), "utf8"));
    const op = "GET /api/v1/attendance/week52";
    delete data.operations[op];
    writeFileSync(path.join(root, "scripts/reach-baseline.json"), JSON.stringify(data));
    const planted = run();
    expect(planted.status, planted.stderr).toBe(1);
    expect(planted.stderr).toContain(`operation-unreachable: ${op}`);
    data.operations[op] = allowance;
    data.operations[plantedOp] = allowance;
    writeFileSync(path.join(root, "scripts/reach-baseline.json"), JSON.stringify(data));
    const grown = run();
    expect(grown.status, grown.stderr).toBe(1);
    expect(grown.stderr).toContain(`operations: ${plantedOp}: baseline must only shrink`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("operations: the --lower CLI persists removal of newly called debt without dropping record gaps", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "reach-cli-")));
  try {
    for (const dir of ["scripts/quality", "apps/web/public"]) mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ["check-reach.mjs", "backlog-claims.mjs", "backlog-sources.mjs", "quality/ratchet.mjs"]) copyFileSync(`scripts/${file}`, path.join(root, "scripts", file));
    for (const dir of ["node_modules", "backend", "docs", "e2e", "packages", "registry"]) symlinkSync(path.resolve(dir), path.join(root, dir), "dir");
    symlinkSync(path.resolve("apps/web/src"), path.join(root, "apps/web/src"), "dir");
    const data = JSON.parse(readFileSync("scripts/reach-baseline.json", "utf8"));
    const records = Array.isArray(data) ? data : data.records;
    const op = "GET /api/v1/attendance/me/week52";
    writeFileSync(path.join(root, "scripts/reach-baseline.json"), JSON.stringify({ records, operations: { [op]: allowance } }));
    writeFileSync(path.join(root, "apps/web/public/probe.js"), 'fetch("/api/v1/attendance/me/week52")');
    const result = spawnSync("node", [path.join(root, "scripts/check-reach.mjs"), "--lower"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, "scripts/reach-baseline.json"), "utf8"))).toEqual({ records, operations: {} });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);


test("operations: initial seeding is limited to uncalled operations already present at the base", () => {
  const previous = operationsAtBase("HEAD");
  const existing = Object.keys(previous)[0]!;
  expect(existing).toBeDefined();
  expect(checkOperations({ gaps: [existing], operations: { [existing]: allowance }, previous })).toEqual([]);
  expect(checkOperations({ gaps: [plantedOp], operations: { [plantedOp]: allowance }, previous })).toEqual([expect.stringContaining(`operations: ${plantedOp}: baseline must only shrink`)]);
}, 30_000);

test("registration end is reached from the certificate menu; restoring its old baseline entry fails", () => {
  const saved = JSON.parse(readFileSync(new URL("./reach-baseline.json", import.meta.url), "utf8"));
  const baseline = Array.isArray(saved) ? saved : saved.records;
  const lifecycle = JSON.parse(readFileSync(new URL("../docs/product/record-lifecycle.json", import.meta.url), "utf8"));
  const entry = { record: "Entity.business_registration", op: "end", lane: "unit: crud-g10" };
  expect(baseline).not.toContainEqual(expect.objectContaining({ record: entry.record, op: entry.op }));
  expect(REACH).toContainEqual({ record: entry.record, op: entry.op, page: "entity", phase: "setup", via: [
    { role: "button", name: "사업자등록증 · 본점 ", prefix: true },
    { role: "menuitem", name: "삭제", exact: true },
  ] });
  const planted = check({ lifecycle, reach: REACH, baseline: [...baseline, entry], facts: [], untracked: [], labels: new Map(), units: new Set(baseline.map((b: { lane: string }) => b.lane.match(/unit: ([^ ]+)/)?.[1]).concat("crud-g10")) });
  expect(planted).toContainEqual(expect.stringMatching(/^baseline: Entity\.business_registration·end is now reached/));
});

test("registration void has no hidden-operation allowance", () => {
  const baseline = JSON.parse(readFileSync(new URL("./reach-baseline.json", import.meta.url), "utf8"));
  expect(baseline.operations ?? {}).not.toHaveProperty("POST /api/v1/business-registrations/{registrationId}/void");
});
