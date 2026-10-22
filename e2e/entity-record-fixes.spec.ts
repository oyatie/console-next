import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, koDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { registerEntity, registerWorkplace } from "./setup-flows";
import { fillDate } from "./sheet";

// LANE ENTITY-FIX: the 법인 record's dead ends found by the parity capture (S3, 2026-10-07), from an empty tenant
// through the UI, each a regression test that failed on mvp 442d9d7a. A 법인 with an uploaded 등록증 and its 사업장:
// a 대표자 변경, then at once a 대표전화 정정 (refused as stale, the flow stopped), then a 개업연월일 정정 (refused with
// only 「요청을 처리하지 못했습니다」); history dated by the UTC day; the derived VAT unit shown as the admin's 변경.

const PDF = { name: "사업자등록증_새온정밀.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n") };
const sheet = (page: Page, name: string) => page.getByRole("dialog", { name });
/** The entity read itself (not its revisions or documents). */
const ENTITY_GET = /\/api\/v1\/legal-entities\/[0-9a-f-]{36}$/;

/** A 법인 with an uploaded 등록증 and its first 사업장, on its record (the parity capture's fixture). */
async function entityWithWorkplace(page: Page) {
  await go(page, "/org/entities/new");
  await registerEntity(page, "새온정밀", false, undefined, undefined, PDF);
  const record = page.url();
  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(page, "새온정밀", "서울 본사");
  await page.goto(record);
  await expect(page.getByRole("heading", { name: /새온정밀/, level: 1 })).toBeVisible();
}

async function correctPhone(page: Page, digits: string) {
  await page.getByRole("button", { name: "대표전화 수정" }).click();
  const phone = sheet(page, "대표전화 수정");
  await option(page, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await phone.getByRole("textbox", { name: /^대표전화/ }).fill(digits);
  return phone;
}

test("sequential edits on a 법인 with a 등록증 and a 사업장 save one after another", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "efix-seq", "새온그룹");
  await entityWithWorkplace(a);

  // The record re-read is slow (as on a loaded server): a sheet that closes before it lands hands the next sheet the
  // version read before the save. Deterministic red on the old code.
  let slow = false;
  await a.route(ENTITY_GET, async (r: Route) => {
    if (slow && r.request().method() === "GET") await new Promise((done) => setTimeout(done, 1500));
    await r.fallback();
  });
  await a.getByRole("button", { name: "대표자 수정" }).click();
  const reps = sheet(a, "대표자 수정");
  await option(a, "무엇을 기록합니까", "대표자가 바뀌었습니다 · 변경").click();
  await reps.getByRole("radiogroup", { name: /언제부터 바뀝니까/ }).getByText(/^다음 달 1일/).click();
  await reps.getByRole("button", { name: "대표자 선임" }).click();
  await reps.getByLabel("새 대표자 1 이름").fill("한지원");
  await option(a, "대표 방식", "각자대표").click();
  slow = true;
  await reps.getByRole("button", { name: "변경 기록" }).click();
  await expect(reps).toBeHidden({ timeout: 15_000 });

  // (1) The 정정 right after the 변경 saves: no stale refusal.
  const phone = await correctPhone(a, "025550142");
  await phone.getByRole("button", { name: "정정 기록" }).click();
  await expect(phone).toBeHidden({ timeout: 15_000 });
  await expect(a.getByText("02-555-0142").first()).toBeVisible();
  slow = false;

  // (2) 개업연월일 정정 after a 발급일: the sheet holds the 발급일 too and says why before anything is sent.
  await a.getByRole("button", { name: "개업연월일 정정" }).click();
  const opened = sheet(a, "개업연월일 수정");
  await fillDate(opened, "2020-03-03", "개업연월일");
  await expect(opened.getByText("발급일이 개업일보다 앞섭니다")).toBeVisible();
  await expect(opened.getByRole("button", { name: "정정 기록" })).toHaveAttribute("aria-disabled", "true");
  await fillDate(opened, "2020-03-03", "발급일");
  await expect(opened.getByRole("button", { name: "정정 기록" })).not.toHaveAttribute("aria-disabled", "true");
  // Negative, at the UI: the server's own refusal (issued_before_opened) is worded by field, never the generic text,
  // and nothing changes. The request is sent with the old 발급일, as another screen or a stale form would.
  await a.route(/\/api\/v1\/business-registrations\/[0-9a-f-]{36}$/, async (r) => {
    if (r.request().method() !== "PUT") return r.fallback();
    await r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), cert_issued_on: "2020-03-02" }) });
  });
  const refused = a.waitForResponse((r) => /business-registrations/.test(r.url()) && r.request().method() === "PUT");
  await opened.getByRole("button", { name: "정정 기록" }).click();
  expect((await refused).status()).toBe(422);
  await expect(opened.getByRole("alert")).toContainText("발급일: 발급일이 개업연월일보다 앞섭니다");
  await expect(opened.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
  await expectAccessible(a, "S3 개업연월일 정정: refused by field");
  await a.unroute(/\/api\/v1\/business-registrations\/[0-9a-f-]{36}$/);
  await opened.getByRole("button", { name: "정정 기록" }).click();
  await expect(opened).toBeHidden();
  await expect(a.getByText("2020. 03. 03.").first()).toBeVisible();

  // (4) W20: the VAT unit the 등록증 set is not the admin's 변경; (3) the rail dates by the Korean day.
  const rail = a.getByRole("region", { name: "이력" }).first();
  // The scheduled change is already dated in recent history; it never gets a second plan row above it.
  await expect(rail.getByText("변경 예약", { exact: true })).toHaveCount(0);
  await expect(rail.getByText(/예정/)).toBeVisible();
  await expect(rail.getByText("부가가치세 신고 단위 · 등록증에 따라 정해짐")).toBeVisible();
  await expect(rail.getByText(koDate(kstDate())).first()).toBeVisible();

  // The 대표전화 정정 lists only 대표전화, not the scheduled 대표자 변경 (backend history diff).
  await a.getByRole("button", { name: /^이력/ }).click();
  const newest = a.locator("ol.timeline").first().locator("li").first();
  await expect(newest).toContainText("대표전화");
  await expect(newest).not.toContainText("대표자");
  await expect(newest).not.toContainText("대표 방식");
});

test("the record rail dates an entry recorded before 09:00 KST by the Korean day", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "efix-kst", "새온그룹");
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온정밀");
  // Every entry recorded at 00:30 KST today: the UTC date of that instant is yesterday.
  const early = new Date(`${kstDate()}T00:30:00+09:00`).toISOString();
  await a.route(/\/api\/v1\/legal-entities\/[0-9a-f-]{36}\/revisions$/, async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as { items: { recorded_at: string }[] };
    await r.fulfill({ response: res, json: { ...body, items: body.items.map((x) => ({ ...x, recorded_at: early })) } });
  });
  await a.reload();
  const rail = a.getByRole("region", { name: "이력" }).first();
  await expect(rail.getByText("법인 만듦")).toBeVisible();
  await expect(rail.getByText(koDate(kstDate())).first()).toBeVisible();
  await expect(rail.getByText(koDate(kstDate(-1)))).toHaveCount(0);
});

test("a real conflict shows what changed meanwhile and re-applies the value on top of it", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "efix-conflict", "새온그룹");
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온정밀");
  // Someone else records a 대표전화 정정 first: the first PUT is preceded by a real competing save with the same
  // credentials and version read, so the server answers this one 409 stale_revision.
  let competed = false;
  await a.route(/\/api\/v1\/legal-entities\/[0-9a-f-]{36}$/, async (r) => {
    if (r.request().method() !== "PUT" || competed) return r.fallback();
    competed = true;
    const headers = { ...r.request().headers(), "idempotency-key": crypto.randomUUID() };
    const other = await a.request.put(r.request().url(), { headers, data: { ...r.request().postDataJSON(), main_phone: "+8225550199" } });
    expect(other.status()).toBe(200);
    await r.fallback();
  });
  const phone = await correctPhone(a, "025550142");
  const refused = a.waitForResponse((r) => ENTITY_GET.test(r.url()) && r.request().method() === "PUT");
  await phone.getByRole("button", { name: "정정 기록" }).click();
  expect((await refused).status()).toBe(409);
  await expect(phone.getByRole("alert")).toContainText("다른 사람이 먼저 이 법인을 변경해 저장해서");
  const conflict = phone.getByRole("region", { name: "그사이 기록된 내용" });
  await expect(conflict).toContainText(/대표전화: .*→ .*0199/);
  await expect(conflict).toContainText("내 값: 02-555-0142");
  // Nothing is re-sent from the stale read: the foot's 기록 holds until the user chooses.
  await expect(phone.getByRole("button", { name: "정정 기록" })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(a, "S3 revise sheet: stale conflict");
  await conflict.getByRole("button", { name: "바뀐 내용 위에 내 값 다시 적용" }).click();
  await expect(phone.getByText(/바뀐 내용을 읽었습니다/)).toBeVisible();
  await phone.getByRole("button", { name: "정정 기록" }).click();
  await expect(phone).toBeHidden();
  await expect(a.getByText("02-555-0142").first()).toBeVisible();
  // Both are in the history: the other person's 정정, then this one; the refused attempt wrote nothing.
  await a.getByRole("button", { name: /^이력/ }).click();
  const items = a.locator("ol.timeline").first().locator("li");
  await expect(items.nth(0)).toContainText(/대표전화: \S*0199 → \S*0142/);
  await expect(items.nth(1)).toContainText(/대표전화: .*→ \S*0199/);
});
