import { expect, test, type Page } from "@playwright/test";
import { openTenant } from "../helpers/tenant";
import { go, kstDate, registerEmployee } from "../flows";
import { openRegistered, pressRegister, receiptOf, registerSheet } from "../helpers/register";
import { registerBranch, setupCompany, startOperations } from "../setup-flows";
import { addDepartments, box, revealUnit } from "../structure-flows";
import { openUnit } from "../helpers/structure";
import { hrAct, openCard, openHistory } from "../record";
import { reasonBox, sheet, todayPreset } from "../sheet";
import { reasonChip } from "../helpers/lifecycle";
import { capture, inspect } from "./capture";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

test("parity 1011: minimum unplaced registration and named passkey sign-in", async ({ browser }) => {
  const a = await openTenant(browser, "parity-minimum", "최소등록");
  await go(a, "/people/new");
  const s = registerSheet(a);
  await expect(s).toBeVisible();
  await s.getByRole("textbox", { name: /^이름/ }).fill("미배치직원");
  await pressRegister(a);
  await expect(s.getByRole("alert")).toContainText("입사일");
  await s.getByRole("textbox", { name: /^입사일/ }).fill(kstDate());
  await pressRegister(a);
  await expect(receiptOf(a, "미배치직원")).toBeVisible();
  await openRegistered(a, "미배치직원");
  await expect(a.getByRole("heading", { level: 1 })).toContainText("미배치직원");
  await go(a, "/account");
  await expect(a.getByRole("heading", { name: "내 계정", level: 1 })).toBeVisible();
  const id = (await a.getByRole("main").locator(".code").filter({ hasText: "@" }).first().textContent())!.trim();
  expect(id).toContain("@");
  await a.getByRole("button", { name: "로그아웃", exact: true }).first().click();
  await expect(a).toHaveURL(/\/login$/);
  await expect(a.getByRole("textbox", { name: "아이디", exact: true })).toHaveAttribute("autocomplete", "username webauthn");
  await capture(a, "home-first-run", ["P4-login"], "AUTH-ID: actual identifier-first sign-in, usernameless fallback and one-time-code route; sole admin is signed out.");
  await inspect(a, "access", "identifier-login");
  await a.getByRole("textbox", { name: "아이디", exact: true }).fill("unknown@parity-minimum");
  await a.getByRole("button", { name: "아이디로 계속", exact: true }).click();
  await expect(a.getByRole("status").filter({ hasText: "이 기기에서 쓸 수 있는 패스키가 없습니다" })).toBeVisible();
  await capture(a, "home-first-run", ["P4-login--wrong"], "Real backend challenge for unknown identifier; generic no-passkey recovery, no forged auth response.");
  await a.getByRole("textbox", { name: "아이디", exact: true }).fill(id);
  const named = a.waitForRequest((r) => r.url().endsWith("/auth/passkey/login/start") && (r.postData() ?? "").includes(`"identifier":"${id}"`));
  await a.getByRole("button", { name: "아이디로 계속", exact: true }).click();
  await named;
  await expect(a.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
});

async function readStates(a: Page, v: string, route: string, api: RegExp, loading: string[], error: string[]) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let called!: () => void;
  const request = new Promise<void>((resolve) => { called = resolve; });
  await a.route(api, async (r) => { called(); await held; await r.fallback(); });
  try {
    await a.goto(route);
    await request;
    if (v === "people") await expect(a.getByRole("region", { name: "아직 직원이 없습니다" })).toHaveCount(0);
    await capture(a, v, loading, "Controlled read delay; actual loading with zero real employees. No counts or writes fabricated.");
  } finally {
    const loaded = a.waitForResponse((r) => api.test(r.url()) && r.status() === 200);
    release();
    await loaded;
    await a.unroute(api);
  }
  await a.route(api, (r) => r.fulfill({ status: 500, body: "" }));
  const failed = a.waitForResponse((r) => api.test(r.url()) && r.status() === 500);
  await a.reload();
  await failed;
  await expect(a.getByRole("alert").first()).toBeVisible({ timeout: 25_000 });
  if (v === "people") {
    await expect(a.getByRole("region", { name: "아직 직원이 없습니다" })).toHaveCount(0);
    await expect(a.getByRole("button", { name: /다시/ }).first()).toBeVisible();
  }
  await capture(a, v, error, "Controlled GET500; actual error/retry with zero real employees. The earlier first-use masking regression is absent.");
  await a.unroute(api);
}

test("parity 1011: Home and zero-facet roster read states", async ({ browser }) => {
  const a = await openTenant(browser, "parity-states-1011", "패리티상태");
  await setupCompany(a, "패리티상태", "본사");
  await startOperations(a);
  await readStates(a, "home-first-run", "/", /\/api\/v1\/me\/action-inbox(?:\?|$)/, ["H11-loading", "S1-loading"], ["H6-source-error"]);
  await readStates(a, "people", "/people", /\/api\/v1\/employees(\?|$)/, ["E12-loading", "R-loading"], ["E12-error", "R-error"]);
  await inspect(a, "people", "roster-error");
});

test("parity 1011: repeated children remain reachable and duplicates refuse", async ({ browser }) => {
  const a = await openTenant(browser, "parity-children", "하위추가");
  await setupCompany(a, "하위추가", "본사");
  await go(a, "/org");
  await revealUnit(a, "본사");
  await capture(a, "org", ["S10-first-entity"], "P0: registered entity and first workplace; selected workplace offers another child before any department exists.");
  await a.getByRole("toolbar", { name: "본사 작업" }).getByRole("button", { name: /부서 추가$/ }).click();
  const field = a.getByRole("textbox", { name: "본사 아래 새 부서 이름" });
  for (const name of ["부서1", "부서2", "부서3"]) {
    await field.fill(name);
    await field.press("Enter");
    await expect(box(a, name)).toHaveCount(1);
    await expect(field).toHaveValue("");
    await expect(field).toBeEnabled();
  }
  await field.fill("부서1");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.press("Enter");
  await expect(a.getByRole("alert").first()).toBeVisible();
  await expect(box(a, "부서1")).toHaveCount(1);
  await capture(a, "org", ["S11-conflict-field"], "P0: three sibling departments added without leaving the editor; duplicate name refused with retained input and no fourth child.");
  await field.press("Escape");
  await a.getByRole("button", { name: "아웃라인", exact: true }).click();
  const outline = a.getByRole("tree", { name: "아웃라인", exact: true });
  await outline.getByRole("treeitem", { name: /^본사\s/ }).getByRole("button", { name: /부서 추가$/ }).click();
  const next = outline.locator("[data-new]").getByRole("textbox", { name: "본사 아래 새 부서 이름" });
  await next.fill("부서4");
  await next.press("Enter");
  await expect(outline.getByRole("treeitem", { name: /^부서4\s/ })).toHaveCount(1);
  await next.press("Escape");
  await a.getByRole("button", { name: "목록", exact: true }).click();
  const grid = a.getByRole("grid", { name: "조직 구조 목록" });
  await expect(grid.getByRole("row").filter({ has: a.getByText("본사", { exact: true }) }).getByRole("button", { name: "부서 추가", exact: true })).toBeVisible();
  await capture(a, "org", ["S13-lists-merge"], "P0: four siblings from chart and outline; list retains per-row add controls. This is ordinary list evidence, not a merge fixture.");
  await inspect(a, "org", "repeated-children");
});

test("parity 1011: staffed-unit dissolution and workplace-following placement", async ({ browser }) => {
  const a = await openTenant(browser, "parity-placement", "배치확인");
  await setupCompany(a, "배치확인", "본사");
  await registerBranch(a, "배치확인", "평택공장", "0008512347");
  await go(a, "/org");
  await addDepartments(a, "본사", ["영업팀"]);
  await addDepartments(a, "평택공장", ["생산팀"]);
  await registerEmployee(a, { name: "배치직원", unit: "영업팀", hired: kstDate(-30) });
  const card = new URL(a.url()).pathname;
  await expect(a.getByRole("region", { name: "재직·배치" })).toContainText("본사");
  await startOperations(a);
  await go(a, "/org");
  await openUnit(a, "영업팀");
  const end = new URL(a.url());
  end.searchParams.set("act", "dept-delete");
  await go(a, end.pathname + end.search);
  await expect(a.getByRole("dialog", { name: "영업팀 폐지", exact: true })).toBeVisible();
  await expect(a.getByText("먼저 이동하십시오")).toHaveCount(0);
  await capture(a, "org", ["S6-dept-dissolve-op"], "STRUCT: staffed department opens the same dated dissolution flow from 삭제·폐지. No dissolution committed; one employee remains.");
  await a.keyboard.press("Escape");
  await go(a, card);
  await hrAct(a, "전보");
  const transfer = sheet(a, "배치직원 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("생산");
  await a.getByRole("option", { name: /생산팀/ }).first().click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("생산 지원");
  await capture(a, "people", ["E5-transfer"], "PLACEMENT: actual cross-workplace transfer review in the same entity, explicit destination/date/reason.");
  await transfer.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
  await openHistory(a);
  await expect(a.getByRole("region", { name: "인사 이력" })).toContainText("배치직원을 영업팀에서 생산팀으로 전보했습니다");
  await openCard(a);
  await expect(a.getByRole("region", { name: "재직·배치" })).toContainText("평택공장");
  await expect(a.getByRole("region", { name: "소속 지점" })).toContainText("현재 평택공장");
  await inspect(a, "people", "placement-after");
});
