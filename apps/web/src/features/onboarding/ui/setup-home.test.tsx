import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Checklist, ChecklistStep } from "@console/api/pending";
import { loadCatalog } from "@console/i18n";
import { SetupHome } from "./setup-home";
import { goLivePreviewQuery } from "../api";

const commands = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("../../../lib/react/command", async (original) => ({ ...(await original<typeof import("../../../lib/react/command")>()), useCommand: () => ({ mutate: commands.mutate, error: null, isPending: false }) }));
const preview = vi.hoisted(() => ({ items: [] as Array<{ code: string; remedy: string; records: Array<{ kind: string; id: string; legal_entity_id: string; name: string }> }>, enabled: false, refused: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (opts: { queryFn?: unknown; enabled?: boolean }) => {
  if (opts.queryFn === goLivePreviewQuery.queryFn) {
    preview.enabled = opts.enabled === true;
    return { data: { blockers: preview.items }, isError: preview.refused };
  }
  return { data: { items: [] }, isSuccess: true, isFetching: false };
} }));
beforeEach(() => { preview.items = [{ code: "terms_not_accepted", remedy: "accept_terms", records: [] }]; preview.enabled = false; preview.refused = false; });
beforeAll(() => loadCatalog("ko"));
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const render = (c: Checklist) => renderToStaticMarkup(<RouterContextProvider router={router}><SetupHome c={c} /></RouterContextProvider>);

const step = (key: ChecklistStep["key"], canAct: boolean, needs: string, extra: Partial<ChecklistStep> = {}): ChecklistStep => ({
  key, group: "operations", state: "todo", action: "register", can_act: canAct, needs, skippable: false,
  counts: { entities: 1, workplaces: 1, units: 2, people: 2000, unplaced: 18, entity_unknown: 3 }, paths: ["one"], ...extra,
});
const checklist = (steps: ChecklistStep[]): Checklist => ({
  phase: "SETUP", go_live_at: null, done: 0, total: steps.length, steps,
  summary: { people: 2000, placed: 1982, unplaced: 18, entity_unknown: 3, progress: 0 },
});

test("an unknown step key stays readable without a guessed action", () => {
  const html = render(checklist([step("future_step" as ChecklistStep["key"], true, "tenant_ops")]));
  expect(html).toContain("future_step");
  expect(html).not.toContain("setup.step.future_step");
  expect(html).not.toContain("setup.why.future_step");
  const unknownStep = html.match(/<li[^>]*data-step[^>]*>[\s\S]*?<\/li>/)?.[0];
  expect(unknownStep).toBeDefined();
  expect(unknownStep).toContain("future_step");
  expect(unknownStep).not.toContain('href=');
  expect(html).not.toContain('href="/settings/company-domain"');
});

test("an employees-only setup grant keeps other steps readable with permissions and no write action", () => {
  commands.mutate.mockClear();
  const html = render(checklist([
    step("entity", false, "org::edit", { state: "done" }), step("employees", true, "hr_basic::edit"),
    step("roles", false, "access::edit"), step("golive", false, "tenant_ops"),
  ]));
  expect(html).toContain('href="/people/new"');
  expect(html).not.toContain('href="/org/entities/new"');
  expect(html).not.toContain('href="/access/roles/new"');
  expect(html).not.toContain('href="/setup/go-live"');
  expect(html).not.toContain('href="/org/history"');
  expect(html).toContain("조직 등록·수정 권한 필요");
  expect(html).toContain("미배치 18");
  expect(commands.mutate).not.toHaveBeenCalled();
});

test("a role's prepared effect and skip consequence accompany its actions, and blocker details survive", () => {
  const html = render(checklist([
    step("roles", true, "access::edit", { skippable: true }),
    step("golive", true, "tenant_ops", { state: "blocked", remedy: "accept_terms" }),
  ]));
  expect(html).toContain("역할 추가");
  expect(html).toContain("담당자 초대");
  expect(html).toContain("운영 시작부터 적용됩니다");
  expect(html).toContain("운영 시작 후에도 운영 계정 혼자 처리합니다");
  expect(html).toContain("이용약관 동의");
  expect(html).toContain('href="/setup/go-live"');
});

test("the trunk rail keeps registration, imports, skips, passkey recovery and the go-live remedy", () => {
  const steps = [
    step("entity", true, "org::edit"), step("workplace", true, "org::edit"),
    step("org", true, "org::edit", { skippable: true }), step("passkey", true, "own_account", { count: 1 }),
    step("employees", true, "hr_basic::edit", { skippable: true }), step("roles", true, "access::edit", { skippable: true }),
    step("golive", true, "tenant_ops", { state: "blocked", remedy: "accept_terms" }),
  ];
  const html = steps.map(s => render(checklist([s]))).join("");
  for (const href of ["/org/entities/new", "/org/entities", "/org", "/org/paste", "/org/import", "/people/new", "/people/import", "/access/roles/new", "/setup/go-live"]) {
    expect(html, href).toContain(`href="${href}"`);
  }
  for (const href of ["/org/entities/bulk?mode=paste", "/org/entities/bulk?mode=import", "/people/import?mode=paste"]) expect(html).toContain(`href="${href}"`);
  for (const text of ["법인 등록", "사업장 등록", "부서 없이 진행", "직원은 나중에", "미배치 18", "법인 미정 3", "패스키", "일괄 작업", "이용약관 동의"]) {
    expect(html, text).toContain(text);
  }
  expect(html).toContain('role="progressbar"');
  expect(commands.mutate).not.toHaveBeenCalled();
});


test("the rail keeps its counts and legal citations without standing explanations", () => {
  const html = render(checklist([step("entity", true, "org::edit")]));
  expect(html).toContain("근로기준법 제41조");
  expect(html).toContain(">2,000</dd>");
  expect(html).toContain(">2</dd>");
  expect(html).not.toContain("고용 주체를 구분해 기록합니다");
  expect(html).not.toContain("운영을 시작하기 전까지는");
});

test("the placement remedy has one control in the setup step", () => {
  const html = render(checklist([step("employees", true, "hr_basic::edit", { state: "attention", remedy: "place_people" })]));
  expect(html.match(/href="\/people\/unplaced"/g)).toHaveLength(1);
});


test("Home keeps the server's department gap and one bulk fix for a solo admin", () => {
  const html = render(checklist([step("org", true, "org::edit", { state: "attention", remedy: "assign_department", count: 3 })]));
  expect(html).toContain("조직 구성");
  expect(html.match(/href="\/people\?review=department"/g)).toHaveLength(1);
});

const railOf = (html: string) => html.match(/<section[^>]*aria-labelledby[^>]*>[\s\S]*?<\/section>/)![0];
const rowsOf = (html: string) => [...railOf(html).matchAll(/<li[^>]*data-step[^>]*>[\s\S]*?(?=<li[^>]*data-step|<\/ol>)/g)].map((m) => m[0]);
const ordered = () => [
  step("entity", true, "org::edit", { group: "company" }),
  step("workplace", true, "org::edit", { group: "company" }),
  step("org", true, "org::edit", { group: "company" }),
  step("people", true, "tenant_ops", { group: "operations" }),
  step("passkey", true, "own_account", { group: "operations", count: 1 }),
  step("employees", true, "hr_basic::edit", { group: "people" }),
  step("roles", true, "access::edit", { group: "operations" }),
  step("golive", true, "tenant_ops", { group: "people" }),
];

test("Home renders server group runs in order with one named progress and its history", () => {
  const steps = ordered();
  steps[0]!.state = "attention";
  const html = render(checklist(steps));
  const rail = railOf(html);
  expect(rail.match(/<ol/g)).toHaveLength(5);
  expect([...rail.matchAll(/<h3[^>]*>([^<]+)/g)].map(m => m[1])).toEqual(["법인", "운영", "직원", "운영", "직원"]);
  expect(rowsOf(html).map((row) => row.match(/<span[^>]*>([^<]+)/)![1])).toEqual([
    "법인 등록", "사업장 등록", "조직 구성", "보안 연락처 · 핵심 인원", "다른 기기에 패스키 하나 더", "직원 등록", "역할 · 담당자 초대", "운영 시작",
  ]);
  expect(html).not.toContain("<progress");
  expect(rail).toContain('role="progressbar"');
  expect(rail).toContain('aria-valuenow="1"');
  expect(rail).toContain('aria-valuemax="8"');
  expect(rail).toContain('aria-valuetext="1/8 완료"');
  expect(rail).toContain('href="/org/history"');
});

test.each([0, 1, 2, 3, 4, 5, 6, 7])("only current step %i has a primary action", (current) => {
  const steps = ordered().map((s, i) => ({ ...s, state: i < current ? "done" as const : s.state }));
  const rows = rowsOf(render(checklist(steps)));
  expect(rows.join("").match(/btn--primary/g)).toHaveLength(1);
  expect(rows[current]).toContain('aria-current="step"');
  expect(rows[current]).toContain("btn--primary");
});

test.each(["create_legal_entity", "create_workplace"])("a prerequisite %s leaves the blocked step quiet", (remedy) => {
  const html = render(checklist([step("entity", true, "org::edit"), step("workplace", true, "org::edit", { state: "blocked", remedy })]));
  const blocked = rowsOf(html)[1]!;
  expect(blocked).toContain(remedy === "create_legal_entity" ? "대기 · 법인 등록 후" : "대기 · 사업장 등록 후");
  expect(blocked).toContain('href="/org/entities');
});

test("bulk offers only download and workplace does not duplicate department import paths", () => {
  const html = render(checklist(ordered()));
  const bulk = html.slice(html.indexOf('<section aria-labelledby="setup-bulk"'));
  expect(bulk).toContain("조직 시트 내려받기");
  expect(bulk).not.toMatch(/href="\/org\/(import|paste|history)"/);
  const rows = rowsOf(html);
  expect(rows[1]).not.toMatch(/href="\/org\/(import|paste)"/);
  expect(rows[2]).not.toContain('href="/org/import"');
  expect(rows[2]).not.toContain('href="/org/paste"');
});

test("a blocked go-live keeps its fix and disables starting operations", () => {
  const row = rowsOf(render(checklist([step("golive", true, "tenant_ops", { state: "blocked", remedy: "accept_terms" })])))[0]!;
  expect(row).toContain("이용약관 동의");
  expect(row).toContain('href="/setup/go-live"');
  expect(row).toContain('aria-disabled="true"');
});

test("each tracker row shows visible state, owner, and gated go-live blocker summary", () => {
  const html = render(checklist([
    step("entity", true, "org::edit", { state: "done" }),
    step("employees", false, "hr_basic::edit", { state: "done" }),
    step("golive", true, "tenant_ops", { state: "blocked", remedy: "accept_terms", count: 2 }),
  ]));
  expect(html).not.toContain("sr-only");
  const [entityRow, employeesRow, goliveRow] = rowsOf(html);
  expect(entityRow).toContain(">완료<");
  expect(entityRow).not.toContain("담당 ·");
  expect(employeesRow).toContain(">완료<");
  expect(goliveRow).toContain(">차단<");
  expect(goliveRow).toContain("담당 · 운영 계정");
  expect(goliveRow).toContain("시작 전에 할 일 2건을 마치면 시작할 수 있습니다");
  expect(goliveRow).toContain("이용약관 동의");
  expect(goliveRow).toContain('href="/setup/go-live"');
});

test("a required entity registration shows its fix instead of another entity form", () => {
  const row = rowsOf(render(checklist([
    step("entity", true, "org::edit", { state: "todo", action: "add_registration", remedy: "add_registration", count: 1 }),
  ])))[0]!;
  expect(row).toContain(">필요<");
  expect(row).toContain("법인에 사업자등록을 추가합니다");
  expect(row).toContain("사업자등록 추가");
  expect(row).toContain('href="/org/entities"');
  expect(row).not.toContain('href="/org/entities/new"');
  expect(row.match(/btn--primary/g)).toHaveLength(1);
});

test("three server groups expand only the next step and retain a collapsed blocker fix", () => {
  const html = render(checklist([
    step("entity", true, "org::edit", { group: "company" }),
    step("org", true, "org::edit", { group: "operations", state: "blocked", remedy: "create_workplace" }),
    step("employees", true, "hr_basic::edit", { group: "people" }),
  ]));
  expect([...railOf(html).matchAll(/<h3[^>]*>([^<]+)/g)].map(m => m[1])).toEqual(["법인", "운영", "직원"]);
  const rows = rowsOf(html);
  expect(rows[0]).toContain("근로기준법 제41조");
  expect(rows[0]).toContain('href="/org/entities/bulk?mode=paste"');
  expect(rows[1]).toContain("대기 · 사업장 등록 후");
  expect(rows[1]).toContain('href="/org/entities"');
  expect(rows[1]).not.toContain("근로기준법 시행령 제20조");
  expect(rows[2]).not.toContain("담당 ·");
  expect(rows[2]).not.toContain("/people/import");
});

test.each([3, 7])("go-live lists up to five of %i preview blockers with direct record fixes", (count) => {
  preview.items = Array.from({ length: count }, (_, i) => ({ code: i === 0 ? "future_refusal" : "workplace_incomplete", remedy: "complete_workplace", records: [{ kind: "workplace", id: `wp-${i}`, legal_entity_id: `entity-${i}`, name: `사업장 ${i}` }] }));
  const html = render(checklist([step("entity", true, "org::edit", { state: "done" }), step("golive", true, "tenant_ops", { state: "blocked", count })]));
  expect(preview.enabled).toBe(true);
  expect(html.match(/data-setup-blocker=/g)).toHaveLength(Math.min(5, count));
  expect(html).toContain('href="/org/entities/entity-0?wp=wp-0"');
  expect(html).not.toContain("future_refusal");
  expect(html).toContain('aria-disabled="true"');
  if (count > 5) expect(html).toContain("2건 더 보기");
});

test.each([false, true])("a refused or unavailable preview keeps only the go-live count (refused=%s)", (canAct) => {
  preview.items = [{ code: "no_legal_entity", remedy: "create_legal_entity", records: [] }];
  preview.refused = true;
  const html = render(checklist([step("golive", canAct, "tenant_ops", { state: "blocked", count: 3, remedy: "unknown_refusal" })]));
  expect(preview.enabled).toBe(canAct);
  expect(html).toContain("시작 전에 할 일 3건");
  expect(html).not.toContain("data-setup-blocker");
  expect(html).not.toContain("unknown_refusal");
  expect(rowsOf(html)[0]).not.toContain('href="/setup/go-live"');
  expect(html).not.toContain('role="alert"');
});

test.each(["todo", "done"] as const)("go-live %s does not read a cached preview", (state) => {
  preview.items = [{ code: "no_legal_entity", remedy: "create_legal_entity", records: [] }];
  const html = render(checklist([step("golive", true, "tenant_ops", { state })]));
  expect(preview.enabled).toBe(false);
  expect(html).not.toContain("data-setup-blocker");
});

test("fresh Home has no alert or danger tone and keeps go-live visible", () => {
  const html = render(checklist([step("entity", true, "org::edit"), step("golive", true, "tenant_ops", { state: "blocked", count: 3 })]));
  expect(html).toContain("운영 시작");
  expect(html).not.toMatch(/role="alert"|chip--danger|btn--danger/);
});


test("a blocker counting many employees offers its one bulk fix", () => {
  preview.items = [{ code: "people_without_department", remedy: "assign_department", records: Array.from({ length: 2000 }, (_, i) => ({ kind: "employee", id: `employee-${i}`, legal_entity_id: "entity", name: `직원 ${i}` })) }];
  const html = render(checklist([step("golive", true, "tenant_ops", { state: "blocked", count: 1 })]));
  expect(html.match(/href="\/people\?review=department"/g)).toHaveLength(1);
});
