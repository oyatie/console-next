import { expect, test, type Page } from "@playwright/test";
import { ko } from "../packages/i18n/src/catalogs/ko";
import { bootKo } from "../packages/i18n/src/catalogs/boot";
import { fmtDateTime } from "@console/i18n/format";
import { expectAccessible } from "./a11y";
import { chooseRadio, firstSignIn, go, routeReady, stepUp, takeCode } from "./flows";
import { firstWorkplace, registerAt } from "./helpers/entity";
import { apiOf, bearerOf } from "./helpers/api";
import { todayKst } from "../apps/web/src/lib/pure/today";
import { openTenant } from "./helpers/tenant";
import { registerEntity, SECOND, setupRail, startOperations, tenantInSetup } from "./setup-flows";
import { activatePendingGrants } from "./second-person-fixture";
import { addDepartments } from "./structure-flows";
import { shot } from "./parity/shot";
import { hrItem, hrMenu, openHistory } from "./record";

// PARITY_OUT=<dir> also writes the after-frames of the re-walk (light and dark); the normal run writes nothing.
const snap = async (page: Page, name: string) => {
  if (!process.env.PARITY_OUT) return;
  await shot(page, name);
  await shot(page, name, { dark: true });
};

// AX-5 (UX-R3 SCOPE). regression r3:governance-01, people-self-01, worst-case-08 — three rounds, one root: an HR worker
// granted 인사 실무 over ONE 법인 (no 전체 grant beside it) saw a handful of people, got 403 on the history, no 인사 조치
// and 「인사팀에 변경 요청」. Here the grant's scope is all that decides: inside 늘봄정밀 the worker reads and acts, outside
// it (늘봄물류) the refusal is typed, names what the account holds and who can grant, and files a 권한 요청 record.
// Also: the refused state before any grant (people-self-38, -13, governance-18), 부서 scopes in the picker
// (governance-22), the grant's caveats in 내 권한 (governance-18) and no structure write verbs for a reader (-37).

async function role(admin: Page, name: string, cells: string[]) {
  await go(admin, "/access/roles");
  await admin.getByRole("link", { name: "역할 추가" }).first().click();
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill(name);
  for (const cell of cells) await admin.getByRole("button", { name: cell, exact: true }).click();
  // governance-03/04: no 결재 cell while org changes do not route; 퇴직 확인 and 내보내기 can be chosen.
  await expect(admin.getByRole("button", { name: "조직 결재" })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "퇴직 확인" })).toBeVisible();
  await expect(admin.getByRole("button", { name: "인사기본 내보내기" })).toBeVisible();
  await snap(admin, "after-role-grid");
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin.getByRole("row", { name: new RegExp(name) })).toBeVisible();
}

const denied = (page: Page) => page.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" });
async function showWhy(page: Page) {
  if (await denied(page).locator("details").getAttribute("open") === null) await denied(page).getByText("이유 보기", { exact: true }).click();
}

for (const { key, scope } of [
  { key: "department", scope: /^인사부/ },
  { key: "workplace", scope: /^본점/ },
  { key: "legal-entity", scope: /주식회사 범위 확인/ },
]) test(`a ${key}-only HR holder agrees with every initial scoped read and tenant-wide numbering refusal`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec: hr } = await tenantInSetup(browser, `route-scoped-${key}`, "범위 확인", false, "본점", "none");
  const token = bearerOf(admin);
  const readAsHr = apiOf(hr, bearerOf(hr));
  try {
    await go(admin, "/org");
    await addDepartments(admin, "본점", ["인사부"]);
    await role(admin, "부서 인사", ["인사기본 등록·수정", "조직 조회"]);
    await go(admin, "/access/grants");
    await admin.getByRole("button", { name: ko["access.grant.title"], exact: true }).click();
    await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill("이임원");
    await admin.getByRole("option", { name: /이임원/ }).first().click();
    const sheet = admin.getByRole("dialog", { name: "권한 부여" });
    await sheet.getByRole("button", { name: / 역할$/ }).click();
    await admin.getByRole("option", { name: /^부서 인사/ }).click();
    await sheet.getByRole("button", { name: /범위 선택/ }).click();
    const pick = admin.getByRole("dialog", { name: "범위 선택" });
    await pick.getByRole("row", { name: scope }).first().click();
    await pick.getByRole("button", { name: "이 범위로 설정" }).click();
    await sheet.getByRole("button", { name: /^1년/ }).click();
    await chooseRadio(sheet, /^설정 단계부터/);
    await chooseRadio(sheet, /^업무 배정·변경/);
    await stepUp(sheet, "패스키로 확인하고 부여 1건 저장", admin.getByRole("status").filter({ hasText: "이임원님에게 부여 1건을 저장했습니다" }));
    await activatePendingGrants(admin, token);
    for (const [path, read] of [["/people", "/api/v1/employees"], ...(key === "department" ? [] : [["/people/exits", "/api/v1/hr/exit-cases"]])]) {
      const response = hr.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === read);
      await hr.goto(path!);
      expect((await response).status()).toBe(200);
      await routeReady(hr);
      await expect(hr.getByRole("main").getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(denied(hr)).toHaveCount(0);
    }
    if (key === "department") for (const path of ["/org", "/org/entities", "/org/changes", "/org/history", "/setup/org", "/setup/company-names", "/people/exits"]) {
      await go(hr, path, path.startsWith("/setup/"));
      const main = hr.getByRole("main");
      await expect(denied(hr)).toHaveCount(1);
      await expect(denied(hr)).toContainText(path === "/people/exits" ? "인사기본 · 조회" : "조직 · 조회");
      expect(await main.innerText()).toBe(await denied(hr).innerText());
      await showWhy(hr);
      await expect(denied(hr).getByText("out_of_scope", { exact: true })).toBeVisible();
    }
    if (key !== "department") for (const [path, read] of [["/org", "/api/v1/org-structure"], ["/org/entities", "/api/v1/legal-entities"], ["/org/changes", "/api/v1/org-changes"], ["/org/history", "/api/v1/org-structure/batches"]]) {
      const response = hr.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === read);
      await hr.goto(path!);
      expect((await response).status()).toBe(200);
      await routeReady(hr);
      await expect(denied(hr)).toHaveCount(0);
    }
    await expect(hr.locator(".rail__link[href='/org']")).toHaveCount(key === "department" ? 0 : 1);
    await expect(hr.locator(".rail__link[href='/org/entities']")).toHaveCount(0);
    await expect(hr.locator(".rail__link[href='/attendance']")).toHaveCount(0);
    for (const read of ["/org-structure", "/legal-entities", "/org-units", "/org-changes", "/org-structure/batches"]) expect((await readAsHr(read)).status()).toBe(key === "department" ? 403 : 200);
    expect((await readAsHr("/hr/exit-cases")).status()).toBe(key === "department" ? 403 : 200);
    for (const [tab, read] of [
      ["month", `/attendance/month?month=${todayKst().slice(0, 7)}`],
      ["day", `/attendance/days?date=${todayKst()}`],
      ["schedule", "/attendance/schedule/tree"],
    ]) {
      const response = key === "department" ? null : hr.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1${read!.split("?")[0]}`);
      await hr.goto(`/attendance?tab=${tab}`);
      await routeReady(hr);
      if (key === "department") {
        await expect(denied(hr)).toHaveCount(1);
        expect(await hr.getByRole("main").innerText()).toBe(await denied(hr).innerText());
        await showWhy(hr);
        await expect(denied(hr).getByText("out_of_scope", { exact: true })).toBeVisible();
      } else {
        expect((await response!).status()).toBe(200);
        await expect(denied(hr)).toHaveCount(0);
      }
      expect((await readAsHr(read!)).status()).toBe(key === "department" ? 403 : 200);
    }
    await go(hr, "/people/numbering");
    await expect(denied(hr)).toBeVisible();
    await showWhy(hr);
    await expect(denied(hr).getByText("scope_tenant_wide_only", { exact: true })).toBeVisible();
  } finally { await Promise.all([admin.context().close(), hr.context().close()]); }
});

for (const { key, name, cell, admitted, paths } of [
  { key: "hr-view", name: "인사 조회", cell: "인사기본 조회", admitted: true, paths: [["/people", "/api/v1/employees"], ["/people?view=accounts", "/api/v1/directory/people"], [`/attendance?month=${todayKst().slice(0, 7)}`, "/api/v1/attendance/month"], ["/people/exits", "/api/v1/hr/exit-cases"]] },
  { key: "account-manager", name: "계정 관리", cell: "권한 관리 등록·수정", admitted: false, paths: [["/people?view=accounts", "/api/v1/directory/people"]] },
]) test(`${name} alone agrees with the page's actual server read`, async ({ browser }) => {
  const { admin, exec: reader } = await tenantInSetup(browser, `route-${key}-${test.info().workerIndex}`, name, false, "본점", "none");
  const token = bearerOf(admin);
  const readAsReader = apiOf(reader, bearerOf(reader));
  try {
    await role(admin, name, [cell]);
    await go(admin, "/access/grants");
    await admin.getByRole("button", { name: ko["access.grant.title"], exact: true }).click();
    await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill("이임원");
    await admin.getByRole("option", { name: /이임원/ }).first().click();
    const sheet = admin.getByRole("dialog", { name: "권한 부여" });
    await sheet.getByRole("button", { name: / 역할$/ }).click();
    await admin.getByRole("option", { name: new RegExp(`^${name}`) }).click();
    await sheet.getByRole("button", { name: /범위 선택/ }).click();
    const pick = admin.getByRole("dialog", { name: "범위 선택" });
    await pick.getByRole("row", { name: /^전체/ }).first().click();
    await pick.getByRole("button", { name: "이 범위로 설정" }).click();
    await sheet.getByRole("button", { name: /^1년/ }).click();
    await chooseRadio(sheet, /^설정 단계부터/);
    await chooseRadio(sheet, /^업무 배정·변경/);
    const previewResponse = admin.waitForResponse(r => r.url().endsWith("/access/grants/preview") && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
    const preview = await (await previewResponse).json() as { items: { enforcement_after: string }[] };
    if (preview.items.some(item => item.enforcement_after === "SCHEDULED")) await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "이임원님에게 부여 1건을 저장했습니다" })).toBeVisible();
    await activatePendingGrants(admin, token);
    for (const [path, read] of paths) {
      if (!admitted) {
        await go(reader, path!);
        await expect(denied(reader)).toHaveCount(1);
        await expect(denied(reader)).toContainText("인사기본 · 조회");
        expect((await readAsReader(read!.replace("/api/v1", ""))).status()).toBe(403);
        await expect(reader.getByRole("button", { name: "계정 초대", exact: true })).toHaveCount(0);
        continue;
      }
      const response = reader.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === read);
      await reader.goto(path!);
      expect((await response).status()).toBe(200);
      await routeReady(reader);
      await expect(reader.getByRole("main").getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(denied(reader)).toHaveCount(0);
    }
  } finally { await Promise.all([admin.context().close(), reader.context().close()]); }
});

test("an HR worker granted 인사 실무 over one 법인 works inside it and is refused outside it, typed", { tag: ["@access", "@hr", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "axfive", "늘봄그룹");
  const token = bearerOf(admin);
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "늘봄정밀");
  await firstWorkplace(admin, "늘봄정밀", "본사");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "늘봄물류", false, undefined, SECOND);
  const otherEntity = new URL(admin.url()).pathname;
  await firstWorkplace(admin, "늘봄물류", "물류센터");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사부", "총무부"]);
  await addDepartments(admin, "물류센터", ["영업부"]);
  await registerAt(admin, "김인사", "늘봄정밀", "인사부");
  await admin.getByRole("button", { name: "계정 초대" }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const code = await takeCode(admin);
  const inside = await registerAt(admin, "박담당", "늘봄정밀", "총무부");
  const outside = await registerAt(admin, "최물류", "늘봄물류", "영업부");
  await startOperations(admin);
  const hr = await firstSignIn(browser, code);

  // Nothing granted yet: one refused state — the screen, what the account holds today, who can grant, a request
  // record and a way back; nothing of the refused screen beside it (people-self-38, -13).
  await go(hr, "/people/exits");
  await expect(denied(hr)).toBeVisible();
  await expect(denied(hr)).toContainText("부여된 권한이 없습니다 · 지금은 내 계정만 쓸 수 있습니다");
  await expect(denied(hr)).toContainText("권한을 부여할 수 있는 담당자");
  await expect(denied(hr).getByRole("link", { name: "내 권한 보기" })).toHaveCount(0);
  await denied(hr).getByRole("button", { name: "권한 요청" }).click();
  await denied(hr).getByRole("button", { name: "권한 요청" }).click();
  await expect(denied(hr).getByText("요청하는 까닭을 선택하십시오")).toBeVisible();
  await chooseRadio(denied(hr), /^새로 맡은 업무/);
  await denied(hr).getByRole("button", { name: "권한 요청" }).click();
  await expect(denied(hr).getByText("권한 요청을 보냈습니다")).toBeVisible();
  await expectAccessible(hr, "refused state with 권한 요청");
  await snap(hr, "after-denied-no-grant");

  // The request is a record the granter sees on 부여 현황, and closes once handled.
  await role(admin, "인사 실무", ["인사기본 등록·수정", "발령 등록·수정", "퇴직 등록·수정", "조직 조회"]);
  await go(admin, "/access/grants");
  const requests = admin.getByRole("region", { name: "열린 권한 요청 1건" });
  await expect(requests.getByRole("row", { name: /김인사/ })).toContainText("/people/exits");
  await expect(requests).toContainText("새로 맡은 업무");
  await expect(requests.getByRole("button", { name: /김인사.*권한 부여/ })).toHaveCount(1);
  await expect(admin.getByRole("button", { name: "권한 부여", exact: true })).toHaveCount(1);

  // The grant: 인사 실무 over 늘봄정밀 only. The scope picker offers 부서 subtrees now (governance-22).
  await admin.getByRole("button", { name: "권한 부여", exact: true }).click();
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill("김인사");
  await admin.getByRole("option", { name: /김인사/ }).first().click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await sheet.getByRole("button", { name: / 역할$/ }).click();
  await admin.getByRole("option", { name: /^인사 실무/ }).click();
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const pick = admin.getByRole("dialog", { name: "범위 선택" });
  await expect(pick.getByRole("row", { name: /총무부/ })).toBeVisible();
  await expect(pick.getByText(/부서만 따로 맡기는 범위는 아직/)).toHaveCount(0);
  await pick.getByRole("row", { name: /주식회사 늘봄정밀/ }).first().click();
  await pick.getByRole("button", { name: "이 범위로 설정" }).click();
  await sheet.getByRole("button", { name: /^1년/ }).click();
  await chooseRadio(sheet, new RegExp(`^${ko["accessGrants.start.NOW"]}`));
  await chooseRadio(sheet, /^업무 배정·변경/);
  // ROL-M4-grant-person: what a narrower-than-tenant HR grant reaches is said before it is saved.
  await expect(sheet).toContainText("그 범위 안 사람만 보고 일합니다");
  await snap(admin, "after-grant-sheet");
  const previewResponse = admin.waitForResponse((r) => r.url().endsWith("/access/grants/preview") && r.request().method() === "POST");
  await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
  const preview = await (await previewResponse).json() as { items: { enforcement_after: string; activates_at?: string }[] };
  for (const item of preview.items) {
    expect(item.enforcement_after).toBe("SCHEDULED");
    await expect(sheet.getByText(fmtDateTime(item.activates_at), { exact: false })).toBeVisible();
  }
  await stepUp(sheet, "패스키로 확인하고 부여 1건 저장", admin.getByRole("status").filter({ hasText: "김인사님에게 부여 1건을 저장했습니다" }));
  await activatePendingGrants(admin, token);
  // ROL-M4-grant-saved: a receipt with 되돌리기; then the request is closed as handled.
  await expect(admin.getByRole("status").filter({ hasText: "김인사님에게 부여 1건을 저장했습니다" }).getByRole("button", { name: "되돌리기" })).toBeVisible();
  await requests.getByRole("button", { name: "처리됨" }).click();
  await expect(requests).toHaveCount(0);
  await snap(admin, "after-grants-list");

  // Inside the 법인: the roster is its people; a colleague's record has 인사 조치 and its history (no 403).
  // A fresh load picks up the new grant (a live push of /me/authz is the realtime lane's, #27).
  await hr.goto("/people");
  await expect(hr.getByRole("rowheader", { name: "박담당", exact: true })).toBeVisible();
  await expect(hr.getByRole("rowheader", { name: "최물류", exact: true })).toHaveCount(0);
  await go(hr, `/people/${inside}`);
  await expect(hrItem(await hrMenu(hr), "전보")).toBeVisible();
  await hr.keyboard.press("Escape");
  await openHistory(hr);
  await expect(hr.getByRole("region", { name: "인사 이력" })).toBeVisible();
  await expect(hr.getByText("인사 이력 접근 권한이 없습니다")).toHaveCount(0);
  await snap(hr, "after-hr-inside-record");

  // Outside it: typed, with what the account holds and 권한 요청 (worst-case-44's scope half).
  await go(hr, `/people/${outside}`);
  await expect(denied(hr)).toBeVisible();
  await expect(denied(hr)).toContainText("권한 범위 밖입니다");
  await expect(denied(hr)).toContainText(/인사 실무 · .*늘봄정밀/);
  await expect(denied(hr).getByRole("button", { name: "권한 요청" })).toBeVisible();
  await expectAccessible(hr, "out of scope");
  await snap(hr, "after-hr-outside-record");

  // Another 법인's record stays not-found, matching the server's existence-preserving 404.
  await go(hr, otherEntity);
  await expect(hr.getByRole("heading", { name: bootKo["common.read.notFound.title"], exact: true })).toBeVisible();
  await expect(denied(hr)).toHaveCount(0);
  await expect(hr.getByRole("button", { name: "권한 요청", exact: true })).toHaveCount(0);
  await expect(hr.getByRole("button", { name: "다시 불러오기" })).toHaveCount(0);

  // 내 권한 reads the server's decision, with what the 법인 scope does not reach (governance-18).
  await go(hr, "/account");
  const mine = hr.getByRole("region", { name: "내 권한" });
  await expect(mine).toContainText("인사 실무");
  await expect(mine).toContainText("직원 등록은 이 범위 안으로만");
  await snap(hr, "after-my-access");

  // A reader of the structure (조직 조회 only) is offered no structure write verb (people-self-37).
  await go(hr, "/org");
  await expect(hr.getByRole("heading", { name: "조직 구조", level: 1 })).toBeVisible();
  await expect(hr.getByRole("button", { name: "가져오기" })).toHaveCount(0);
  await go(admin, "/org");
  await expect(admin.getByRole("button", { name: "가져오기" })).toBeVisible();

  // 회수 is a row verb that says what is lost, in numbers, before the passkey (ROL-M7-grant-revoke).
  await go(admin, "/access/grants");
  await admin.getByRole("button", { name: /^김인사.*님의 인사 실무 회수$/ }).click();
  const revoke = admin.getByRole("dialog", { name: /김인사님의 「인사 실무」/ });
  await expect(revoke).toContainText(/저장하는 즉시 김인사님은 주식회사 늘봄정밀 및 하위 · 2명의 .*인사기본 등록·수정.* 할 수 없게 됩니다/);
  await expect(revoke.getByRole("button", { name: "패스키로 확인하고 회수" })).toHaveClass(/btn--danger/);
  await snap(admin, "after-grant-revoke");
  await revoke.getByRole("button", { name: "취소" }).click();
});
