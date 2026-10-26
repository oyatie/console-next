import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectStatus, expectSuccess } from "./helpers/setup-response";
import { expectAccessible } from "./a11y";
import type { clickCounter } from "./clicks";
import { inviteAccount, type Access } from "./access-flows";
import { addDepartments } from "./structure-flows";
import { tenantOnboardSubmit, firstSignIn, go, option, plain, routeReady, takeCode, tenantSlugField, unique, vendorPage } from "./flows";

type C = Pick<ReturnType<typeof clickCounter>, "click">;
type RegistrationIds = { brn: string; crn: string };
type RegistrationFixture = RegistrationIds & {
  biz_kind: "CORPORATION";
  head_office: boolean;
  synthetic: true;
};
type RegistrationFixtures = {
  primary: RegistrationFixture;
  second: RegistrationFixture;
  branch_primary: RegistrationFixture;
};

/** The 10 digits as the product shows them (3-2-5 with dashes). */
export function brnDisplay(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** `second`'s CRN with its check digit moved by one: the wizard's check-digit warning fixture (never a real number). */
export const REGISTRATION_FIXTURES = JSON.parse(
  readFileSync(new URL("./registration-identifiers.json", import.meta.url), "utf8"),
) as RegistrationFixtures;

export const CRN_BAD_CHECK = (() => {
  const d = REGISTRATION_FIXTURES.second.crn;
  return d.slice(0, 12) + String((Number(d.slice(12)) + 1) % 10);
})();


// The tenant's setup phase, through the product (design §5, §6): the legal entity typed beside no document,
// its one workplace, and the one-way start of operations.

/**
 * The next `method` answer on a path matching `path`; take it before the press that sends the request. A round trip's
 * time grows with the host's load, so a step waits for the answer (and asserts it) rather than a fixed time after a press.
 */
const answer = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((r) => r.request().method() === method && path.test(new URL(r.url()).pathname));

/**
 * Presses `target` until `done` is on the page. In Firefox under load a press that lands right after typing is now
 * and then dropped (the 과세 radio stayed unchecked, the typed address unsaved, then 법인 등록 refused); a person's
 * press never comes that fast. A press that did land is not repeated.
 */
async function pressUntil(c: C, target: Locator, done: Locator) {
  await expect(async () => {
    if ((await done.count()) === 0) await c.click(target);
    await expect(done).not.toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** A manually typed address (road-name search is a server proxy that may be unavailable). */
export async function typeAddress(page: Page, group: string, road: string, zip: string, c: C = plain) {
  const g = page.getByRole("group", { name: group, exact: true });
  await c.click(page.getByRole("button", { name: "주소를 직접 입력" }).first());
  await g.getByLabel("도로명주소").fill(road);
  await g.getByLabel("우편번호 (5자리)").fill(zip);
  await pressUntil(c, g.getByRole("button", { name: "이 주소로 저장" }), g.getByRole("button", { name: "주소 다시 찾기" }));
}

/** An entity's registration facts typed by hand (the certificate's sections), shared by an entity and a branch. */
async function typeCertificate(page: Page, f: { brn: string; name: string; road: string; zip: string }, c: C) {
  await page.getByLabel("사업자등록번호").fill(f.brn);
  await page.getByLabel("법인명(단체명)").fill(f.name);
  await page.getByLabel("개업연월일").fill("2020-03-02");
  await typeAddress(page, "사업장 소재지", f.road, f.zip, c);
}

/** The certificate's business and tax sections (no NTS list loaded on this server: the office is taken as printed). */
async function typeBusiness(page: Page, c: C) {
  await page.getByRole("textbox", { name: /^업태/ }).fill("정보통신업");
  await page.getByRole("textbox", { name: /^종목/ }).fill("응용 소프트웨어 개발");
  // The radio first: in Firefox a press right after a native select's change can start without committing.
  await pressUntil(c, option(page, "사업자 단위 과세 적용", "적용 안 함"), page.getByRole("radiogroup", { name: /사업자 단위 과세 적용/ }).getByRole("radio", { name: "적용 안 함", checked: true }));
  await page.getByLabel("과세유형").selectOption({ label: "일반과세자" });
  await page.getByLabel("관할 세무서 (등록증 표기)").fill("삼성세무서");
}

/** A second corporation of the same tenant: its own numbers. */
export const SECOND = REGISTRATION_FIXTURES.second;

/**
 * On the 법인 추가 wizard (spec S4): 기본 (kind and name), the certificate typed as printed, 등기·대표자 left empty,
 * then 확인 and 「법인 만들기」; lands on the 법인's record. `upload`: the certificate is uploaded beside the form and
 * kept as the registration's evidence, with its issue reason and date typed.
 */
export async function registerEntity(page: Page, name: string, audit = false, c: C = plain, ids: RegistrationIds = REGISTRATION_FIXTURES.primary, upload?: { name: string; mimeType: string; buffer: Buffer }) {
  await fillEntity(page, name, c, ids, upload);
  if (audit) await expectAccessible(page, "entity wizard: review");
  // The save is three round trips (the 법인, its registration, the record's first read) whose time grows with the host's
  // load: each answer is awaited as the state it is, and only the drawing of the landed record is held to a time.
  // (A 5 s wait from the press to the heading failed 7–9 of 10 runs at load 25–80, the record still 「불러오는 중…」.)
  const created = answer(page, "POST", /^\/api\/v1\/legal-entities$/);
  const registered = answer(page, "POST", /^\/api\/v1\/legal-entities\/[^/]+\/registrations$/);
  const read = answer(page, "GET", /^\/api\/v1\/legal-entities\/[0-9a-f-]{36}$/);
  await c.click(page.getByRole("button", { name: "법인만 등록" }));
  await expectStatus(created, 201, "legal entity create");
  await expectStatus(registered, 201, "registration create");
  await read;
  await expect(page.getByRole("heading", { name: new RegExp(name), level: 1 })).toBeVisible();
}

/** The wizard filled as registerEntity does, up to its review step, not yet saved. */
export async function fillEntity(page: Page, name: string, c: C = plain, ids: RegistrationIds = REGISTRATION_FIXTURES.primary, upload?: { name: string; mimeType: string; buffer: Buffer }) {
  await c.click(option(page, "사업자 구분", "법인사업자"));
  await page.getByLabel("법인명(단체명)").fill(`주식회사 ${name}`);
  await c.click(page.getByRole("button", { name: "다음", exact: true }));
  if (upload) {
    await page.locator('input[type="file"]').setInputFiles(upload);
    await expect(page.getByText(upload.name)).toBeVisible();
  }
  await page.getByLabel("사업자등록번호").fill(ids.brn);
  await page.getByRole("textbox", { name: /^법인등록번호/ }).fill(ids.crn);
  await page.getByRole("textbox", { name: /^대표자/ }).fill("홍길동");
  await page.getByLabel("개업연월일").fill("2020-03-02");
  await typeAddress(page, "사업장 소재지", "서울특별시 강남구 테헤란로 152", "06236", c);
  await pressUntil(c, page.getByLabel("본점 소재지가 사업장 소재지와 같음"), page.getByRole("checkbox", { name: "본점 소재지가 사업장 소재지와 같음", checked: true }));
  await page.getByRole("textbox", { name: /^업태/ }).first().fill("정보통신업");
  await page.getByRole("textbox", { name: /^종목/ }).first().fill("응용 소프트웨어 개발");
  const radio = (group: string, name: string) => page.getByRole("radiogroup", { name: new RegExp(group) }).getByRole("radio", { name, checked: true });
  await pressUntil(c, option(page, "과세유형", "일반과세자"), radio("과세유형", "일반과세자"));
  await pressUntil(c, option(page, "사업자 단위 과세 적용", "부"), radio("사업자 단위 과세 적용", "부"));
  await page.getByLabel("관할 세무서").fill("삼성세무서");
  if (upload) {
    await c.click(option(page, "발급 사유", "신규"));
    await page.getByLabel("발급일").fill("2020-03-02");
  }
  await c.click(page.getByRole("button", { name: "다음: 등기·대표자" }));
  await c.click(page.getByRole("button", { name: "다음", exact: true }));
  await expect(page.getByRole("heading", { name: "조직도에 생기는 것" })).toBeVisible();
}

/** The 사업장 추가 sheet (S5-create) over 회사 구조: nothing is preselected, so every answer is a deliberate pick. */
export const workplaceSheet = (page: Page) => page.getByRole("dialog", { name: "사업장 추가" });

/** In the 사업장 추가 sheet: its 종류 (ENT-KIND MR-19), a label only and never preselected; a server without the list draws none. */
export async function pickKind(sheet: Locator, c: C = plain, kind = "사업장") {
  const group = sheet.getByRole("radiogroup", { name: /^종류/ });
  if (await group.count()) await c.click(group.getByText(kind, { exact: true }));
}

/** In the 사업장 추가 sheet: the 법인's first certificate (already entered, no 사업장 holds it) as this 사업장's own. */
export async function registerWorkplace(page: Page, entity: string, name: string, audit = false, c: C = plain) {
  const sheet = workplaceSheet(page);
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("사업장 이름").fill(name);
  await c.click(option(page, "사업자등록", "이미 입력한 등록증"));
  await finishWorkplace(page, name, audit, c);
}

/** The two statutory answers (원천징수 with the head office, 4대보험 numbers later) and the save; the chart shows it. */
async function finishWorkplace(page: Page, name: string, audit: boolean, c: C) {
  const sheet = workplaceSheet(page);
  await pickKind(sheet, c);
  await c.click(sheet.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/));
  await c.click(option(page, "4대보험", "모두 성립 · 번호는 나중에"));
  if (audit) await expectAccessible(page, "add workplace sheet");
  const created = answer(page, "POST", /^\/api\/v1\/legal-entities\/[^/]+\/workplaces$/);
  await c.click(sheet.getByRole("button", { name: "사업장 추가", exact: true }));
  await expectStatus(created, 201, "workplace create");
  // The sheet closes once the reads the save changed have re-read: a state, however long they take under load.
  await sheet.waitFor({ state: "hidden" });
  await expect(page.getByRole("status").filter({ hasText: `${name} 사업장을 등록했습니다` })).toBeAttached();
}

/**
 * From the entity's page: a further workplace with its own certificate (a 지점's registration), typed in the sheet.
 * `brn` is the branch's own classified number. Starts and ends on the entity's page.
 */
export async function registerBranch(page: Page, entity: string, name: string, brn: string, audit = false, c: C = plain) {
  await go(page, "/org/entities");
  await page.getByRole("row", { name: new RegExp(entity) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(entity), level: 1 })).toBeVisible();
  const back = new URL(page.url()).pathname;
  await c.click(page.getByRole("button", { name: /^사업장 \d/ }));
  await c.click(page.getByRole("link", { name: "사업장 추가" }).first());
  await c.click(option(page, "사업자등록", "이 사업장의 등록증"));
  await workplaceSheet(page).getByLabel("사업장 이름").fill(name);
  await typeCertificate(page, { brn, name: `주식회사 ${entity}`, road: "경기도 성남시 분당구 판교역로 166", zip: "13529" }, c);
  await typeBusiness(page, c);
  // A second certificate: how the entity files VAT is asked once, with no default.
  await c.click(option(page, "부가가치세 신고 단위", "사업장별"));
  await finishWorkplace(page, name, audit, c);
  await go(page, back);
  await expect(page.getByRole("heading", { name: new RegExp(entity), level: 1 })).toBeVisible();
}

/** The setup rail on Home. */
export const setupRail = (page: Page) => page.getByRole("region", { name: /운영 준비/ });

/**
 * Home once its reads have landed: its heading is up and its loading line gone, then its setup rail. Both are state
 * waits with no fixed time (the test's timeout bounds them): Home holds every read under one loading line, and under
 * host load those reads take what they take (a 5 s wait for the rail right after sign-in failed in first-run-solo).
 */
export async function homeRail(page: Page) {
  await page.locator("#home-title").waitFor();
  await page.getByRole("status").filter({ hasText: "불러오는 중" }).first().waitFor({ state: "detached" });
  return setupRail(page);
}

/** The 부서 every setup helper adds under its first workplace: every staffed setup person must be placed here (or in another 부서) before 운영 시작. */
export const SETUP_DEPARTMENT = "기획관리팀";

/**
 * The entity `name`, its workplace `workplace` and one 부서 under it, each opened from the setup rail. Ends on the
 * entity's page.
 */
export async function setupCompany(admin: Page, name: string, workplace = "본점") {
  await go(admin, "/");
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, name);
  const entityPage = new URL(admin.url()).pathname;
  await go(admin, "/");
  const add = setupRail(admin).getByRole("link", { name: "사업장 등록" }).first();
  await expect(add).toHaveAttribute("href", /\/workplaces\/new$/);
  await add.click();
  await registerWorkplace(admin, name, workplace);
  await go(admin, "/");
  await setupRail(admin).getByRole("link", { name: "부서 추가" }).first().click();
  await addDepartments(admin, workplace, [SETUP_DEPARTMENT]);
  await go(admin, entityPage);
  await expect(admin.getByRole("heading", { name: new RegExp(name), level: 1 })).toBeVisible();
}

/** Read the current document before the contracting admin accepts it in the go-live preview. */
export async function acceptSetupTerms(admin: Page, c: C = plain) {
  const readTerms = admin.getByRole("button", { name: "이용약관 읽기" });
  const accept = admin.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의" });
  if (await readTerms.isVisible()) {
    await c.click(readTerms);
    await expect(accept).toBeVisible();
  }
  if (await accept.isVisible()) {
    await c.click(accept);
    await expect(accept).toBeHidden();
  }
}

/**
 * 운영 시작 from its preview: the company's terms accepted in place when still open, the sole-approver statement
 * confirmed when the preview asks for it, and the actor's passkey. One way; Home then has no setup rail.
 */
export async function startOperations(admin: Page, audit = false, c: C = plain) {
  if (!admin.url().endsWith("/setup/go-live")) await go(admin, "/setup/go-live");
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  // The preview has loaded once its start button shows (enabled or with its reason).
  const start = admin.getByRole("button", { name: "운영 시작", exact: true });
  await expect(start).toBeVisible();
  await acceptSetupTerms(admin, c);
  if (audit) await expectAccessible(admin, "go-live preview");
  const sole = admin.getByLabel(/본인뿐인 채로 운영을 시작합니다/);
  if (await sole.isVisible()) await c.click(sole);
  await expect(start).toBeEnabled();
  // The passkey, then the go-live command (1.6–4.2 s server-side at load 40, against a 5 s wait for Home that failed).
  const started = answer(admin, "POST", /^\/api\/v1\/onboarding\/go-live$/);
  await c.click(start);
  await expectSuccess(started, "operations start");
  await routeReady(admin, "/");
  await expect(setupRail(admin)).toBeHidden();
}

/**
 * A fresh tenant in its setup phase with its admin and one executive colleague, before any entity or workplace. The
 * colleague holds a tenant-made 조회·결재 role over 회사 전체 (no preset roles), or nothing with `execAccess` "none".
 */
export async function tenantBeforeSetup(browser: Browser, slug: string, name: string, audit = false, execAccess: Access | "none" = "oversight") {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await expect(v.getByRole("button", { name: "고객 계정 개설" })).toBeVisible();
  if (audit) await expectAccessible(v, "platform tenants");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(name);
  await tenantSlugField(v).fill(unique(slug));
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v, audit), undefined, audit);

  const exec = await firstSignIn(browser, await inviteAccount(admin, "이임원", execAccess, audit), undefined, audit);
  return { admin, exec };
}

/**
 * A fresh tenant in its setup phase with its admin, one executive colleague (invited during setup) and its legal
 * entity with one workplace, all created through the UI.
 */
export async function tenantInSetup(browser: Browser, slug: string, name: string, audit = false, workplace = "본점", execAccess: Access | "none" = "oversight") {
  const t = await tenantBeforeSetup(browser, slug, name, audit, execAccess);
  await setupCompany(t.admin, name, workplace);
  return t;
}

/** The same tenant, operating: org changes, exits and leave are governed from here on. */
export async function tenantWithExecutive(browser: Browser, slug: string, name: string, audit = false) {
  const t = await tenantInSetup(browser, slug, name, audit);
  await startOperations(t.admin, audit);
  return t;
}

/**
 * A tenant ready for staffing, built in its setup phase on the chart: workplace 본사 › 부서 인사부 › 채용팀 (each
 * applies at once, no approval); every employee's home branch is the workplace's own. Then it operates.
 */
export async function staffedTenant(browser: Browser, slug: string, name: string) {
  const t = await tenantInSetup(browser, slug, name, false, "본사");
  const { admin } = t;
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사부"]);
  await addDepartments(admin, "인사부", ["채용팀"]);
  await startOperations(admin);
  return t;
}
