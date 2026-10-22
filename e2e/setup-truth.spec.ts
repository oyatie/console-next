import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAccessible } from "./a11y";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { tenantSlugField, firstSignIn, go, kstDate, option, takeCode, unique, vendorPage } from "./flows";
import { pickKind, setupCompany, setupRail, startOperations, tenantInSetup, typeAddress, workplaceSheet } from "./setup-flows";
import { fillRegister, openRegistered, pressRegister, registerSheet } from "./helpers/register";
import { addDepartments, revealUnit } from "./structure-flows";

// UX-R2 SETUP, from an empty DB through the UI. regression: on the r2 preview the go-live preview counted
// 「직원이 있는데 4대보험이 성립하지 않은 사업장 4곳」 for one 사업장 (one row per insurer: company-49), 「인원 3명」 with a
// 입사 예정 among them (hire-34), listed the contact store that does not exist and promised deletion closes (company-49,
// -51); its fixes opened lists, not the record (company-53); the tenancy was a 회사 (「회사 구조」, 「회사를 대표해
// 이용약관 동의」: company-02, governance-23, hire-24, people-self-22, worst-case-26) and its name led the 사업장 crumb
// (org-14); and nothing asked the only ops holder for a second passkey (governance-20, people-self-17, -31).

const ACCOUNT = "새온그룹";
/** Before/after evidence for the UX loop when E2E_SHOTS names a directory; nothing otherwise. */
const shot = (page: Page, name: string) => (process.env.E2E_SHOTS ? page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const ENTITY = "주식회사 새온정밀";
test.beforeAll(() => loadCatalog("ko"));

/** The next WebAuthn registration lands on a second device (the first holds this account's credential, which is excluded). */
async function onSecondDevice(page: Page) {
  const first = authenticatorOf(page);
  await page.route("**/api/v1/auth/passkey/register/start", async (route) => {
    await first.remove();
    await virtualAuthenticator(page);
    await route.continue();
  });
}

/** Registers `name` from `unit`'s box at `site` (two 사업장: the sheet asks which), hired `hired`; lands on their record. */
async function hire(page: Page, name: string, unit: string, site: string, hired: string) {
  await go(page, "/org");
  await revealUnit(page, unit);
  await page.getByRole("complementary", { name: unit, exact: true }).getByRole("link", { name: `${unit}에 직원 등록` }).click();
  await expect(registerSheet(page).getByRole("textbox", { name: /^이름/ })).toBeVisible();
  const asks = await registerSheet(page).getByRole("radiogroup", { name: /^어느 사업장 소속입니까/ }).count();
  await fillRegister(page, { name, hired, workplace: asks ? site : undefined });
  await pressRegister(page);
  await openRegistered(page, name);
  await expect(page.getByRole("heading", { name: new RegExp(name), level: 1 })).toBeVisible();
}

/** From the 법인 record: 오송공장 added with 「나중에 연결」 and 4대보험 「아직 없음」 (four insurers, one 사업장). */
async function addOsong(page: Page) {
  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  const sheet = workplaceSheet(page);
  await sheet.getByLabel("사업장 이름").fill("오송공장");
  await option(page, "사업자등록", "나중에 연결").click();
  await typeAddress(page, "소재지", "충청북도 청주시 흥덕구 오송읍 오송생명1로 194", "28160");
  await pickKind(sheet);
  await sheet.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(page, "4대보험", "아직 없음").click();
  await sheet.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(sheet).toBeHidden();
}

test("go-live counts what the panels show and fixes each record in place; the tenancy is never a 회사; a second passkey from the rail", { tag: ["@first-run", "@regression", "@org"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(ACCOUNT);
  await tenantSlugField(v).fill(unique("setup-truth"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  // #29: the screen is 「조직 구조」; the rail names the customer account's terms, never a 회사.
  const nav = admin.getByRole("navigation", { name: "주 메뉴" });
  await expect(nav.getByRole("link", { name: "조직 구조" })).toBeVisible();
  await expect(nav).not.toContainText(/(?<!주식)회사/);
  await expect(setupRail(admin)).not.toContainText(/(?<!주식)회사/);
  await expect(setupRail(admin)).not.toContainText("보안 연락처");
  await expect(setupRail(admin)).toContainText("다른 기기에 패스키 하나 더");

  await setupCompany(admin, "새온정밀", "본사");
  const record = new URL(admin.url()).pathname;
  await addOsong(admin);
  await go(admin, "/org");
  // Regression (entity-ops:25's 0.0017 shift): a setup-panel step has one height whatever its state, so the checklist's
  // re-read after a command never moves the steps below it or the preview link. Here the steps are in mixed states.
  const panelSteps = admin.locator("aside[aria-labelledby=setup-panel-title] li");
  await expect(panelSteps.first()).toBeVisible();
  // The setup and record panels share their final width so switching them cannot move chart controls.
  const panelWidth = await admin.locator("aside[aria-labelledby=setup-panel-title]").evaluate((el) => ({
    setup: el.getBoundingClientRect().width,
    record: Number.parseFloat(getComputedStyle(el).getPropertyValue("--panel-w")),
  }));
  expect(panelWidth.setup).toBe(panelWidth.record);
  const steps = await panelSteps.evaluateAll((els) => els.map((el) => ({ state: el.getAttribute("data-state"), h: (el as HTMLElement).offsetHeight })));
  expect(new Set(steps.map((x) => x.state)).size).toBeGreaterThan(1);
  expect(new Set(steps.map((x) => x.h)), JSON.stringify(steps)).toHaveProperty("size", 1);
  await addDepartments(admin, "본사", ["인사부"]);
  await addDepartments(admin, "오송공장", ["생산팀"]);
  await hire(admin, "김본사", "인사부", "본사", kstDate(-30));
  await hire(admin, "이오송", "생산팀", "오송공장", kstDate(-30));
  await hire(admin, "박예정", "인사부", "본사", kstDate(12));

  // org-14: the 사업장 panel's crumb starts at the 법인, never at the account's name.
  await go(admin, "/org");
  await revealUnit(admin, "본사");
  const crumb = admin.getByRole("complementary", { name: "본사", exact: true }).getByRole("navigation", { name: "보고 있는 위치" });
  await expect(crumb).toContainText(ENTITY);
  await expect(crumb).not.toContainText(ACCOUNT);
  await shot(admin, "after-org14-site-panel-crumb");

  await go(admin, "/setup/go-live");
  const main = admin.getByRole("main");
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  // hire-34: 재직 인원 2, the 입사 예정 said apart.
  await expect(main.getByRole("term").filter({ hasText: /^직원$/ }).locator("..").getByRole("definition")).toHaveText("2");
  await expect(main.getByRole("term").filter({ hasText: /^입사 예정$/ }).locator("..").getByRole("definition")).toHaveText("1");
  // company-53: the insurance line names 오송공장 and opens its fix on that record.
  const insurance = main.getByText(t("setup.golive.item.insurance_not_established_with_people", { count: 1 }), { exact: true });
  await expect(insurance).toBeVisible();
  const fix = main.getByRole("link", { name: t("setup.golive.fixOf", { fix: t("setup.fix.update_insurance"), name: "오송공장" }) });
  await expect(fix).toHaveAttribute("href", new RegExp(`^${record}\\?wp=`));
  await expect(main).not.toContainText(/등록증이 없는 (?:빈 )?사업장/);
  // company-49: one 사업장 short of all four insurers counts once; the contact store and the closing promise are gone.
  await expect(main).toContainText("직원이 있는데 4대보험이 성립하지 않은 사업장 1곳");
  await expect(main.getByRole("link", { name: "4대보험 확인 · 오송공장" })).toBeVisible();
  await expect(main).not.toContainText("보안 연락처");
  await expect(main).not.toContainText("지우는 기능은 닫히고");
  await expect(main).toContainText("쓴 적이 없는 것은 지금처럼 삭제할 수 있습니다");
  await expect(main).toContainText("패스키가 1개뿐입니다");
  // #29 explicitly keeps the contracting-admin acceptance wording.
  await main.getByRole("button", { name: "이용약관 읽기" }).click();
  await expect(main.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의" })).toBeVisible();
  // (「주식회사 …」 is a 법인's own name, a legal company: allowed.)
  await expect(main.getByRole("heading", { level: 1 })).not.toContainText(/(?<!주식)회사/);
  // Negative: with blockers open, 운영 시작 stays refused with its reason, and nothing starts.
  const start = main.getByRole("button", { name: "운영 시작", exact: true });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription(/^시작 전에 할 일 \d+건을 마치면 시작할 수 있습니다$/);
  await start.focus();
  await admin.keyboard.press("Enter");
  await expect(admin).toHaveURL(/\/setup\/go-live$/);
  await expect(insurance).toBeVisible();
  await expectAccessible(admin, "go-live preview: blockers with their records");
  await shot(admin, "after-go-live-preview");

  // The fix opens on 오송공장's own record; back on the preview it is read again.
  await fix.click();
  await expect(admin).toHaveURL(new RegExp(`${record}\\?wp=`));
  await expect(admin.getByRole("heading", { name: new RegExp(ENTITY), level: 1 })).toBeVisible();
  await go(admin, "/setup/go-live");
  await expect(insurance).toBeVisible();
  await expect(main).not.toContainText(/등록증이 없는 (?:빈 )?사업장/);

  // governance-20 / people-self-31: the rail adds the second passkey in one press, and the step is done.
  await go(admin, "/");
  await shot(admin, "after-home-rail-passkey-step");
  const step = setupRail(admin).getByRole("listitem").filter({ hasText: "다른 기기에 패스키 하나 더" });
  await onSecondDevice(admin);
  await step.getByRole("button", { name: "새 패스키 등록" }).click();
  await expect(step.getByRole("button", { name: "새 패스키 등록" })).toBeHidden();
  await expect(step).toHaveAttribute("data-state", "done");
  await admin.unroute("**/api/v1/auth/passkey/register/start");
  await go(admin, "/setup/go-live");
  await expect(main.getByRole("alert").first()).toBeVisible();
  await expect(main).not.toContainText("패스키가 1개뿐입니다");
});

test("after go-live the only ops holder is asked for a second passkey on Home and in My account's passkey card, until there are two", { tag: ["@first-run", "@regression", "@auth"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin } = await tenantInSetup(browser, "saeon2", "새온물산", false, "본사", "none");
  // regression: the terms accepted in place left a shorter 「해결함」 row where their BlockedPanel was, so the re-read
  // pulled 「운영을 시작하면 바뀌는 것」 up under the pointer (a layout shift in every spec that starts operations).
  await go(admin, "/setup/go-live");
  const governed = admin.getByRole("heading", { name: "운영을 시작하면 바뀌는 것", level: 2 });
  await expect(governed).toBeVisible();
  await admin.getByRole("button", { name: "이용약관 읽기" }).click();
  const accept = admin.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의" });
  const before = (await governed.boundingBox())!.y;
  await accept.click();
  await expect(accept).toBeHidden();
  await expect(admin.getByText("해결함", { exact: true })).toBeVisible();
  expect(Math.abs((await governed.boundingBox())!.y - before)).toBeLessThan(2); // was 96.5 px
  await startOperations(admin);

  // The single queue names account work; recovery guidance lives on its resolving record.
  const home = admin.getByRole("region", { name: "업무함", exact: true });
  const security = home.getByRole("listitem").filter({ hasText: "다른 기기에 패스키 하나 더" });
  await expect(security).toHaveCount(1);
  await expect(security.getByRole("button", { name: "두 번째 패스키 등록", exact: true })).toBeVisible();
  await expect(home.getByRole("link", { name: "내 계정", exact: true })).toHaveAttribute("href", "/account");
  await expectAccessible(admin, "Home after go-live: second passkey");
  await shot(admin, "after-home-operating-second-passkey");

  await go(admin, "/account");
  await expect(admin.getByRole("heading", { name: "내 계정", level: 1 })).toBeVisible();
  const keys = admin.getByRole("region", { name: "패스키", exact: true });
  const warning = keys.getByText(/공급사에 본인 확인 후 운영 계정 복구를 요청하고 대기 기간을 거쳐야 합니다/);
  await expect(warning).toHaveCount(1);
  await expect(warning).toBeVisible();
  await expect(admin.getByRole("region", { name: "다른 기기에 패스키 하나 더" })).toHaveCount(0);
  await expectAccessible(admin, "My account: second passkey in passkey card");
  await shot(admin, "after-account-second-passkey-card");
  await onSecondDevice(admin);
  await keys.getByRole("button", { name: "패스키로 확인하고 새 패스키 등록", exact: true }).click();
  await expect(admin.getByRole("table", { name: "패스키" }).getByRole("row")).toHaveCount(3);
  await expect(warning).toHaveCount(0);
  await expect(admin.getByRole("region", { name: "다른 기기에 패스키 하나 더" })).toHaveCount(0);
  await expect(admin.locator("#acct-passkey-receipt")).toBeFocused();
  await go(admin, "/");
  await expect(admin.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(home).toBeVisible();
  await expect(security).toHaveCount(0);
});
