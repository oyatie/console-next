// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api/schema";
import { atPhoneWidth, expectAccessible, fits } from "../a11y";
import { firstSignIn, go, kstDate, option, routeReady, unique } from "../flows";
import { registerEntity, registerWorkplace, SECOND, SETUP_DEPARTMENT, setupCompany } from "../setup-flows";
import { apiOf, bearerOf, codeOf, headcount } from "../helpers/api";
import { openTenant } from "../helpers/tenant";
import { activatePendingGrants, letGrantsAge } from "../second-person-fixture";
import { workbook } from "../helpers/import-layouts";
import { addDepartments, leaveScreen } from "../structure-flows";
import { chooseWorkbook, payPeriod, people, protectedWorkbook, rosterWorkbook, type Person } from "../helpers/import";
import { gridRow, openItem, openRow, panel, queue, rowsGrid, settled } from "../helpers/import-queue";

// Roster import across two legal entities. A person's workplace and legal entity follow their department.
// Ambiguous workplace columns require an explicit reading per sheet.

const step = (page: Page) => page.locator('[aria-current="step"]');
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });

test("a protected workbook is told apart before upload, with how to get a readable copy", { tag: "@hr" }, async ({ browser }) => {
  const admin = await openTenant(browser, "importlock", "잠금상사");
  await setupCompany(admin, "잠금상사");
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "급여대장_보안.xlsx", protectedWorkbook());
  await payPeriod(admin);
  await expect(admin.getByRole("alert").filter({ hasText: "암호나 문서 보안(DRM)이 걸린 파일입니다" })).toContainText("암호를 해제하거나");
  // The upload stays reachable and says why it does nothing.
  await expect(button(admin, "명부 미리보기")).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "import: protected workbook");
});

/** The second 법인 with its one 사업장, then a 부서 under each 사업장 (setup: each applies at once). */
async function twoEntities(admin: Page) {
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "누리", false, undefined, SECOND);
  await admin.getByRole("tab", { name: /^사업장 \d/ }).click();
  await admin.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(admin, "누리", "누리 공장");
  // Setup: each 부서 typed on the chart under its 사업장 applies at once.
  await go(admin, "/org");
  await addDepartments(admin, "가람 본점", ["인사팀", "영업팀"]);
  await addDepartments(admin, "누리 공장", ["생산팀"]);
}

test("an HR admin imports 300 people across two legal entities, answers each unplaced value once, then settles a second load item by item", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await openTenant(browser, "importtwo", "가람");
  await setupCompany(admin, "가람", "가람 본점");
  await twoEntities(admin);
  await leaveScreen(admin);
  const g = people("GR", 180, ["인사팀", "영업팀"], ["가람 본점"], ["정규직", "계약직"]);
  // 누리's sheet: half its people are in a 부서 the tenant does not have (품질팀) and work at a customer site.
  const n = people("NR", 120, ["생산팀", "품질팀"], ["누리 공장", "A고객사 현장"]);

  // 1. First load: 300 new people.
  await go(admin, "/people/import");
  await expectAccessible(admin, "import: upload");
  await chooseWorkbook(admin, "인사명부_2026-10.xlsx", await rosterWorkbook([{ name: "가람", rows: g }, { name: "누리", rows: n }]));
  await payPeriod(admin);
  await button(admin, "명부 미리보기").click();
  await expect(step(admin)).toHaveText("열 확인", { timeout: 30_000 });
  const columns = admin.getByRole("table", { name: "열", exact: true });
  // r3:hire-38: what is stored says so (the sealed 주민등록번호, the 휴대전화), what is dropped says so (the account).
  for (const col of ["주민등록번호", "휴대전화"])
    await expect(columns.getByRole("row").filter({ hasText: col }).first()).toContainText("가려서 보관 · 원본에 남기지 않음");
  await expect(columns.getByRole("row").filter({ hasText: "급여계좌" }).first()).toContainText("저장하지 않음");
  // 가람's values all name its workplace; 누리 also has a customer site, so its reading needs a choice.
  const reading = admin.getByRole("region", { name: "누리 · D · 사업장", exact: true });
  const remapped = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/preview$/.test(new URL(r.url()).pathname));
  await reading.getByRole("button", { name: "법인 사업장으로 읽기", exact: true }).click();
  expect((await remapped).status()).toBe(200);
  await expect(reading).toBeHidden();
  await expect(columns.getByRole("row").filter({ hasText: "사업장" }).first()).toContainText("직원 정보로 반영");
  await expectAccessible(admin, "import: columns");
  await button(admin, "모의 반영 실행").click();

  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  await expect(await gridRow(queue(admin), "품질팀")).toContainText("60");
  await expect(await gridRow(queue(admin), "A고객사 현장")).toContainText("60");
  await expect(await gridRow(queue(admin), "계약직")).toContainText("90");
  // Unplaced values never block: those people would come in 미배치. Each is answered once for every row, and each
  // answer runs the dry run again at once.
  await expect(button(admin, "명부 반영: 신규 300명 · 갱신 0명")).toBeEnabled();
  await openItem(admin, "품질팀");
  const departmentBound = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/[^/]+\/dry-run$/.test(new URL(r.url()).pathname));
  await panel(admin).getByRole("combobox", { name: /품질팀에 연결할 부서/ }).selectOption({ label: "미배치로 둡니다" });
  expect((await departmentBound).status()).toBe(200);
  await openItem(admin, "A고객사 현장");
  const workplaceBound = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/[^/]+\/dry-run$/.test(new URL(r.url()).pathname));
  await panel(admin).getByRole("radiogroup", { name: /A고객사 현장/ }).getByText("사업장이 아닌 고객 현장입니다").click();
  expect((await workplaceBound).status()).toBe(200);
  for (const type of ["정규직", "계약직"]) {
    await openItem(admin, type);
    const typeBound = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/[^/]+\/dry-run$/.test(new URL(r.url()).pathname));
    await panel(admin).getByLabel(new RegExp(`${type}에 해당하는 고용 형태`)).selectOption({ label: type });
    expect((await typeBound).status()).toBe(200);
  }
  await settled(admin);
  await expectAccessible(admin, "import: dry run with its 확인 필요 queue");
  const apply1 = button(admin, "명부 반영: 신규 300명 · 갱신 0명");
  await expect(apply1).toBeEnabled();
  // Each new person's 법인 · 사업장 follows their 부서 (decisions #18).
  await expect(await gridRow(rowsGrid(admin), g[0]!.number)).toContainText("가람 본점");
  await expect(await gridRow(rowsGrid(admin), g[0]!.number)).toContainText("신규 등록");
  await apply1.click();
  // 300 people with their placement, profile and ledger rows: allow the write its time.
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText("신규 300명 · 갱신 0명 · 건너뜀 0명")).toBeVisible();
  await expectAccessible(admin, "import: applied");

  // The record reads the placement back by id (Enter on an exact 사번 opens that person).
  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill(n[0]!.number);
  await find.press("Enter");
  await expect(admin.getByRole("heading", { name: new RegExp(n[0]!.name), level: 1 })).toBeVisible();
  // The head's 소속, not the placement history's same links.
  const head = admin.getByRole("group", { name: "소속", exact: true });
  await expect(head.getByRole("link", { name: "주식회사 누리" })).toBeVisible();
  await expect(head.getByRole("link", { name: "누리 공장" })).toBeVisible();

  // 2. Second load of the same roster, as HR edits it: a promotion (an update), a 부서 move (never written by import:
  //    it goes to 발령), a renamed person (refused), a hire date no calendar has (refused), and a row without a 사번
  //    that carries the 주민등록번호 of a person on file (offered by it for explicit confirmation).
  const g2: Person[] = g.map((p) => ({ ...p }));
  g2[0]!.position = "부장";
  g2[1]!.unit = g2[1]!.unit === "인사팀" ? "영업팀" : "인사팀";
  g2[2]!.name = `${g2[2]!.name}수`;
  g2[3]!.hired = "2026-13-40";
  // The twin is 누리's sixth person, whose own row this second file leaves out (a row per person, as on file).
  const twin: Person = { ...n[5]!, number: "" };
  const n2 = n.filter((_, i) => i !== 5);
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사명부_2026-10_수정.xlsx", await rosterWorkbook([{ name: "가람", rows: [...g2, twin] }, { name: "누리", rows: n2 }]));
  await payPeriod(admin);
  await button(admin, "명부 미리보기").click();
  await button(admin, "모의 반영 실행").click();
  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  await expect(await openRow(admin, g2[0]!.number)).toContainText("직위: 사원 → 부장");
  await expect(await openRow(admin, g2[1]!.number)).toContainText("발령으로 처리합니다");
  await expect(await openRow(admin, g2[2]!.number)).toContainText("같은 사번의 직원과 다릅니다");
  await expect(await openRow(admin, g2[3]!.number)).toContainText("날짜로 읽을 수 없습니다");
  // Confirm identity even when a sealed identifier names one candidate.
  await expect(button(admin, /^명부 반영/)).toHaveAttribute("aria-disabled", "true");
  await expect(admin.getByText(/반영을 막는 확인 필요 항목 3개를 처리하십시오/)).toBeVisible();
  await openItem(admin, "누구인지 확인(동명이인)");
  const identified = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/[^/]+\/dry-run$/.test(new URL(r.url()).pathname));
  await panel(admin).getByRole("button", { name: `이 사람입니다 (${n[5]!.number})`, exact: true }).click();
  expect((await identified).status()).toBe(200);
  await settled(admin);
  await expect(admin.getByText(/반영을 막는 확인 필요 항목 2개를 처리하십시오/)).toBeVisible();
  await expectAccessible(admin, "import: second dry run, items that block");

  for (const [what, why] of [["같은 사번의 직원과 다릅니다", "중복"], ["날짜로 읽을 수 없습니다", "형식 오류"]] as const) {
    await openItem(admin, what);
    const exclude = panel(admin).getByRole("button", { name: "이번에는 제외" });
    if (await exclude.isVisible()) await exclude.click();
    await panel(admin).getByRole("radiogroup", { name: /제외하는 이유/ }).getByText(why, { exact: true }).click();
    const excluded = admin.waitForResponse(r => r.request().method() === "POST" && /\/import\/[^/]+\/dry-run$/.test(new URL(r.url()).pathname));
    await panel(admin).getByRole("button", { name: "이 행을 제외하고 다시 모의 반영" }).click();
    expect((await excluded).status()).toBe(200);
    await settled(admin);
  }
  const apply2 = admin.getByRole("button", { name: /^명부 반영: 신규 0명 · 갱신 \d+명$/ });
  await expect(apply2).toBeEnabled();
  await apply2.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
});

async function assertPasskey(page: Page, api: ReturnType<typeof apiOf>) {
  await page.bringToFront();
  const response = await api("/auth/passkey/login/start", "POST", {});
  expect(response.status()).toBe(200);
  const start = await response.json() as components["schemas"]["PasskeyLoginStartResponse"];
  const credential = await page.evaluate(async challenge => {
    const { publicKey } = challenge as { publicKey: PublicKeyCredentialRequestOptionsJSON };
    const assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey) });
    return (assertion as PublicKeyCredential).toJSON();
  }, start.challenge);
  return { ceremony_id: start.ceremony_id, credential };
}

test("a second person rolls an applied import back within its configured window", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  const slug = "importsecond";
  const operator = await openTenant(browser, slug, "되돌림상사");
  const operatorToken = bearerOf(operator);
  const ops = apiOf(operator, operatorToken);
  const read = async (path: string) => {
    const response = await ops(path);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  await setupCompany(operator, "되돌림상사", "본점");
  const entities = await read("/legal-entities") as components["schemas"]["LegalEntityList"];
  const entity = entities.items[0]!;
  const workplace = entity.workplaces[0]!;
  const units = await read("/org-units") as { items: { id: string; name: string }[] };
  const department = units.items.find(unit => unit.name === SETUP_DEPARTMENT)!;
  const holders: Page[] = [];
  const accounts: string[] = [];
  const codes: string[] = [];
  const names = ["김가져오기", "이확인"] as const;
  // Prepare accounts and imports through APIs; exercise the governed rollback in the browser.
  const catalog = await read("/access/catalog") as components["schemas"]["AccessCatalog"];
  const createdRole = await ops("/access/roles", "POST", {
    name_ko: "전체 업무", status: "ACTIVE",
    lines: catalog.domains.filter(domain => domain.grantable).map(({ domain, levels }) => ({ domain, levels })) as components["schemas"]["AccessRoleLineInput"][],
  } satisfies components["schemas"]["CreateAccessRoleRequest"]);
  expect(createdRole.status(), await createdRole.text()).toBe(201);
  const role = await createdRole.json() as components["schemas"]["AccessRole"];
  for (const name of names) {
    const registered = await ops("/employees", "POST", {
      name, hire_date: kstDate(-30), org_unit_id: department.id, idempotency_key: crypto.randomUUID(),
      legal_entity_id: entity.id, workplace_id: workplace.id, home_branch_id: workplace.default_branch_id,
    });
    expect(registered.status(), await registered.text()).toBe(201);
    const person = await registered.json() as components["schemas"]["EmployeeDetail"];
    const created = await ops("/users", "POST", {
      display_name: name, employee_id: person.employee.id, roles: [], branch_ids: [],
    }, { "Idempotency-Key": crypto.randomUUID() });
    expect(created.status(), await created.text()).toBe(201);
    const account = await created.json() as components["schemas"]["UserSummary"];
    expect(account.roles).toEqual([]);
    accounts.push(account.id);
    const issued = await ops("/auth/admin/otp/issue", "POST", { user_id: account.id, step_up: await assertPasskey(operator, ops) });
    expect(issued.status(), await issued.text()).toBe(200);
    const { otp } = await issued.json() as components["schemas"]["AdminIssueOtpResponse"];
    codes.push(otp);
  }
  const previewedGrants = await ops("/access/grants/preview", "POST", {
    operations: accounts.map(account_id => ({
      op: "grant", account_id, role_id: role.id, scope: { kind: "TENANT", include_descendants: true }, effective_in_setup: true,
    })), reason_code: "PROMOTION_OR_REASSIGNMENT",
  } satisfies components["schemas"]["AccessGrantBatchRequest"]);
  expect(previewedGrants.status(), await previewedGrants.text()).toBe(200);
  const grantsPreview = await previewedGrants.json() as components["schemas"]["AccessGrantPreview"];
  expect(grantsPreview.refused).toBe(0);
  const granted = await ops("/access/grants/apply", "POST", {
    receipt_id: grantsPreview.receipt_id, step_up: await assertPasskey(operator, ops),
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect(granted.status(), await granted.text()).toBe(200);
  const { items: grants } = await granted.json() as { items: components["schemas"]["AccessGrant"][] };
  expect(grants).toHaveLength(names.length);
  await activatePendingGrants(operator, operatorToken);
  const enforced = await read("/access/grants") as components["schemas"]["AccessGrant"][];
  expect(enforced.filter(grant => accounts.includes(grant.account_id)).map(grant => grant.enforcement)).toEqual(["ENFORCED", "ENFORCED"]);
  for (const code of codes) holders.push(await firstSignIn(browser, code));
  const terms = await read("/onboarding/terms") as components["schemas"]["TermsDocument"];
  const accepted = await ops("/onboarding/terms", "POST", { version: terms.version, sha256: terms.sha256 });
  expect(accepted.status(), await accepted.text()).toBe(204);
  const goLive = await read("/onboarding/go-live/preview") as components["schemas"]["GoLivePreview"];
  expect(goLive.blockers).toEqual([]);
  const started = await ops("/onboarding/go-live", "POST", {
    digest: goLive.digest, line_digests: goLive.line_digests, step_up: await assertPasskey(operator, ops),
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect(started.status(), await started.text()).toBe(200);
  expect((await started.json() as components["schemas"]["GoLiveResult"]).phase).toBe("OPERATING");
  const policy = await ops("/settings/approval.policy.import_rollback", "POST", { value: "route", reason_code: "POLICY_REVIEW" });
  expect(policy.status(), await policy.text()).toBe(201);
  const [admin, signedInReviewer] = holders as [Page, Page];
  const reviewApi = apiOf(signedInReviewer, bearerOf(signedInReviewer));
  await go(signedInReviewer, "/inbox?tab=reference");
  const acknowledged = await reviewApi(`/access/grants/${grants.find(grant => grant.account_id === accounts[1])!.id}/notice`, "POST");
  expect(acknowledged.status(), await acknowledged.text()).toBe(200);
  letGrantsAge(unique(slug), names[1]);
  await admin.bringToFront();
  const adminToken = bearerOf(admin);
  const api = apiOf(admin, adminToken);
  await go(admin, "/people/import");
  const before = await headcount(api);
  const previewed = await admin.request.post("/api/v1/employees/import/preview", {
    headers: { authorization: adminToken() },
    multipart: { file: { name: "확인할명부.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await workbook([{ name: "명부", lines: [
      ["사번", "성명", "입사일", "고용형태"],
      ["RB-SECOND", "가져온직원", kstDate(-10), "정규직"],
    ] }]) } },
  });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const { run_id: run } = await previewed.json() as components["schemas"]["EmployeeImportPreviewResponse"];
  const dryRun = await api(`/employees/import/${run}/dry-run`, "POST", { decisions: {} });
  expect(dryRun.status(), await dryRun.text()).toBe(200);
  const plan = await dryRun.json() as components["schemas"]["EmployeeImportDryRunSummary"];
  expect(plan.unsettled_rows).toBe(0);
  const applied = await api(`/employees/import/${run}/apply`, "POST", { dry_run_digest: plan.dry_run_digest });
  expect(applied.status(), await applied.text()).toBe(200);
  expect(await headcount(api)).toBe(before + 1);
  const record = await (await api(`/employee-import-runs/${run}`)).json() as components["schemas"]["EmployeeImportRun"];
  expect(Date.parse(record.rollback.window_until!)).toBeGreaterThan(Date.parse(record.applied_at!));
  await go(admin, `/people/import?run=${run}`);
  const panel = admin.getByRole("region", { name: "되돌리기", exact: true });
  await option(admin, "되돌리는 이유", "다른 파일을 올림").click();
  const request = button(admin, "되돌리기 요청");
  await expect(request).toBeDisabled();
  await panel.getByRole("checkbox").press("Space");
  const requested = admin.waitForResponse(r => r.request().method() === "POST" && new RegExp(`/employee-import-runs/${run}/rollback$`).test(new URL(r.url()).pathname));
  await request.click();
  const response = await requested;
  expect(response.status()).toBe(202);
  const outcome = await response.json() as { request_id: string };
  await expect(panel.getByRole("status")).toContainText(/다른.*승인/);
  const self = await api(`/change-requests/${outcome.request_id}/decide`, "POST", { decision: "APPLY", reason_code: "REVIEWED" });
  expect([self.status(), await codeOf(self)]).toEqual([403, "authz_sod_requester"]);
  expect(await headcount(api)).toBe(before + 1);
  // shortcut: the shell repaints a stale saved rail after go-live (an 80 px nav shift in Chromium), so refresh it first; remove once the shell stops painting a saved rail across a phase change.
  await signedInReviewer.goto(`/people/requests?sel=${outcome.request_id}`);
  await routeReady(signedInReviewer);
  const reviewer = await signedInReviewer.context().newPage();
  await signedInReviewer.close();
  await go(reviewer, `/people/requests?sel=${outcome.request_id}`);
  const decision = reviewer.getByRole("complementary", { name: "요청 상세" });
  await decision.getByRole("button", { name: "반영", exact: true }).click();
  await decision.getByRole("textbox", { name: /^처리 사유/ }).fill("원본 명부 확인");
  await expectAccessible(reviewer, "second person reviews applied import rollback");
  await atPhoneWidth(reviewer, async () => {
    for (const theme of ["light", "dark"]) {
      await reviewer.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await fits(reviewer, "import rollback decision");
    }
  });
  const decided = reviewer.waitForResponse(r => r.request().method() === "POST" && /\/change-requests\/[^/]+\/decide$/.test(new URL(r.url()).pathname));
  await decision.getByRole("button", { name: "요청 반영", exact: true }).click();
  expect((await decided).status()).toBe(200);
  await expect(panel.getByRole("status")).toContainText("되돌렸습니다");
  expect(await headcount(api)).toBe(before);
  const done = await (await api(`/employee-import-runs/${run}`)).json() as components["schemas"]["EmployeeImportRun"];
  expect(done.status).toBe("ROLLED_BACK");
  expect(done.applied_by).toMatchObject({ name: names[0] });
  expect(done.rolled_back_by).toMatchObject({ name: names[1] });
  expect(done.rolled_back_by?.id).not.toBe(done.applied_by?.id);
  await go(admin, `/people/import?run=${run}`);
  await expect(panel.getByRole("status")).toContainText("되돌렸습니다");
});
