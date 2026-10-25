import { expect, test, type Page } from "@playwright/test";
import { fillDate } from "./sheet";
import { expectAccessible } from "./a11y";
import { go, kstDate, koDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { registerEntity, registerWorkplace, typeAddress } from "./setup-flows";

// UX-R1 ENTITY, from an empty tenant through the UI; each failed on the parent FE (no such verb or no such hold):
// company-06 휴업·재개, company-07 이전 with its date, company-11 every 사업장 fact, worst-case-25 the check digit,
// company-08 설립 중, company-03 a closed 법인 read-only but for 종료 정정.

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });

/** The 법인 record's 사업장 tab with 서울 본사 open beside the list. */
async function workplaceTab(page: Page) {
  await go(page, "/org/entities/new");
  await registerEntity(page, "새온정밀");
  const record = page.url();
  await page.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(page, "새온정밀", "서울 본사");
  await go(page, new URL(record).pathname);
  await page.getByRole("button", { name: /^사업장 \d/ }).click();
  return page.getByRole("complementary", { name: "서울 본사" });
}

test("a 사업장 records 휴업 with its expected end, then 재개, and moves on a date", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr1-ops", "새온그룹");
  const panel = await workplaceTab(a);
  const history = panel.getByRole("region", { name: "이력" });
  await expect(history).toContainText("건설 사업장 여부: — → 아님");
  await expect(history).not.toContainText(/\b[a-z]+_[a-z_]+\b|\b(true|false)\b/);

  // 휴업: start, reason, an optional expected end; an end before the start is held with its reason.
  await panel.getByRole("button", { name: "상태 수정" }).click();
  const suspend = dialog(a, "서울 본사 휴업");
  await fillDate(suspend, kstDate(0), "휴업 시작일");
  await option(a, "휴업 사유", "계절 사업").click();
  await fillDate(suspend, kstDate(-1), "끝날 예정일");
  await expect(suspend.getByText("끝날 예정일은 시작일보다 앞설 수 없습니다")).toBeVisible();
  await expect(suspend.getByRole("button", { name: "휴업", exact: true })).toHaveAttribute("aria-disabled", "true");
  await fillDate(suspend, kstDate(90), "끝날 예정일");
  await expectAccessible(a, "workplace suspension sheet");
  await suspend.getByRole("button", { name: "휴업", exact: true }).click();
  await expect(suspend).toBeHidden({ timeout: 15_000 });
  await expect(panel).toContainText(`${koDate(kstDate(0))}부터 ${koDate(kstDate(90))}까지 예정`);
  // Regression: another change of the suspended 사업장 keeps the expected end (it was resent as nothing and cleared).
  await panel.getByRole("button", { name: "주생산품 수정" }).click();
  const during = dialog(a, "주생산품 수정");
  await during.getByRole("textbox", { name: /^주생산품/ }).fill("정밀부품");
  await fillDate(during, kstDate(0), "적용일");
  await option(a, "변경 사유", "연락처 변경").click();
  await during.getByRole("button", { name: "변경 저장" }).click();
  await expect(during).toBeHidden({ timeout: 15_000 });
  await expect(panel).toContainText("정밀부품");
  await expect(panel).toContainText(`${koDate(kstDate(90))}까지 예정`);

  // 재개 closes it.
  await panel.getByRole("button", { name: "상태 수정" }).click();
  const resume = dialog(a, "서울 본사 재개");
  await fillDate(resume, kstDate(0), "다시 연 날");
  await resume.getByRole("button", { name: "재개", exact: true }).click();
  await expect(resume).toBeHidden({ timeout: 15_000 });
  await expect(panel.getByRole("definition").filter({ hasText: /^계속$/ })).toBeVisible();

  // 이전: the address row's 수정 opens the address, dated, with the people placed there named.
  await panel.getByRole("button", { name: "소재지 수정" }).click();
  const move = dialog(a, "서울 본사 소재지");
  await expect(move.getByRole("button", { name: "기록" })).toHaveAttribute("aria-disabled", "true");
  await option(a, "무엇을 기록합니까", "이전했습니다").click();
  await typeAddress(a, "새 소재지", "서울특별시 서초구 강남대로 465", "06611");
  await fillDate(move, kstDate(0), "이전일");
  await expect(move).toContainText("사업자등록 정정, 이전등기, 4대보험 변경신고는 이 화면에서 하지 않습니다");
  await move.getByRole("button", { name: "기록" }).click();
  await expect(move).toBeHidden({ timeout: 15_000 });
  await expect(panel).toContainText("서울특별시 서초구 강남대로 465");

  // Every 사업장 fact is editable from its own row in the panel: 주생산품 and 팩스 among them, each sheet only that fact.
  // The 법인's re-read (the record the sheets open on) is slowed by 1.5 s (regression: 팩스 opened before it landed was
  // refused 409 against the user's own 주생산품): a sheet closes once its record has re-read, so the next is never stale.
  const ENTITY = /\/api\/v1\/legal-entities\/[0-9a-f-]{36}(\?.*)?$/;
  await a.route(ENTITY, async (r) => {
    if (r.request().method() === "GET") await new Promise((done) => setTimeout(done, 1500));
    await r.fallback().catch(() => undefined); // a read the page dropped meanwhile
  });
  for (const [field, value, shown] of [["주생산품", "정밀기기", "정밀기기"], ["팩스", "025550199", "02-555-0199"]] as const) {
    await panel.getByRole("button", { name: `${field} 수정` }).click();
    const info = dialog(a, `${field} 수정`);
    await expect(info.getByRole("textbox", { name: /^사업장 이름/ })).toHaveCount(0); // only the one fact
    await info.getByRole("textbox", { name: new RegExp(`^${field}`) }).fill(value);
    await fillDate(info, kstDate(0), "적용일");
    await option(a, "변경 사유", "연락처 변경").click();
    await expect(info.getByRole("button", { name: "변경 저장" })).not.toHaveAttribute("aria-disabled", "true");
    const saved = a.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/workplaces\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
    await info.getByRole("button", { name: "변경 저장" }).click();
    expect((await saved).status(), `${field} is saved, not refused against the fact saved before it`).toBe(200);
    await expect(info).toBeHidden({ timeout: 15_000 });
    await expect(panel).toContainText(shown);
  }
  await a.unroute(ENTITY);
});

test("a wrong check digit is held until confirmed, and a 법인 is recorded while being founded", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr1-found", "새온그룹");
  await go(a, "/org/entities/new");
  await option(a, "사업자 구분", "법인사업자").click();
  await a.getByLabel("법인명(단체명)").fill("주식회사 새온정밀");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  // worst-case-25: 000-81-62516 (the right one ends 5) is never shown with a ✓, and the next step waits.
  await a.getByLabel("사업자등록번호").fill("0008162516");
  await expect(a.getByText(/검증 숫자가 맞지 않습니다/).first()).toBeVisible();
  await expect(a.getByText(/다른 등록증과 겹치지 않습니다/)).toHaveCount(0);
  await expect(a.getByRole("button", { name: /^다음/ })).toHaveAttribute("aria-disabled", "true");
  await a.getByRole("checkbox", { name: /등록증에 적힌 번호가 000-81-62516 그대로입니다/ }).check();
  await expect(a.getByRole("button", { name: /^다음/ })).not.toHaveAttribute("aria-disabled", "true");
  // Back in the browser returns to the previous step (worst-case-30), and the number is still there after a reload.
  await a.goBack();
  await expect(a.getByRole("heading", { name: "기본", level: 2 })).toBeVisible();
  await a.reload();
  await a.goForward();
  await expect(a.getByLabel("사업자등록번호")).toHaveValue("000-81-62516");

  // company-08: 설립 중 skips the certificate; the 법인 is created with no number and says what it waits for.
  await a.goBack();
  await a.getByRole("checkbox", { name: /설립 중인 법인입니다/ }).check();
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByRole("textbox", { name: /^대표자/ }).first().fill("홍길동");
  await typeAddress(a, "본점 소재지", "서울특별시 강남구 테헤란로 152", "06236");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByRole("button", { name: "법인만 등록" }).click();
  await expect(a.getByRole("heading", { name: /새온정밀/, level: 1 })).toBeVisible();
  await expect(a.getByRole("region", { name: "설립 중" })).toBeVisible();
  await a.getByRole("button", { name: "설립등기 입력" }).click();
  const founded = dialog(a, "설립등기 입력");
  await founded.getByRole("textbox", { name: /^법인등록번호/ }).fill("0002110006241");
  await fillDate(founded, kstDate(0), "설립등기일");
  await founded.getByRole("button", { name: "설립등기 기록" }).click();
  await expect(founded).toBeHidden({ timeout: 15_000 });
  await expect(a.getByRole("region", { name: "설립 중" })).toHaveCount(0);
});

test("a closed 법인 offers no edit verb, only 종료 정정, and a refused 정정 changes nothing", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr1-close", "새온그룹");
  const auth = new Promise<string>((resolve) => a.on("request", (r) => r.headers()["authorization"] && r.url().includes("/api/v1/") && resolve(r.headers()["authorization"]!)));
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온리테일");
  const id = new URL(a.url()).pathname.split("/").pop()!;
  // Closed (no people, no 사업장) as the close sheet would after go-live.
  const closed = await a.request.post(`/api/v1/legal-entities/${id}/close`, { headers: { authorization: await auth, "Idempotency-Key": crypto.randomUUID() }, data: { closed_on: kstDate(-1), reason_code: "BUSINESS_CLOSED" } });
  expect(closed.status()).toBe(200);
  await a.reload();
  await expect(a.getByRole("note")).toContainText("종료한 법인의 기록은 수정할 수 없고");
  await expect(a.getByRole("button", { name: /수정$/ })).toHaveCount(0);
  await expect(a.getByRole("button", { name: "등록증 보며 수정" })).toHaveCount(0);
  await expectAccessible(a, "closed entity record");

  await a.getByRole("button", { name: "종료 정정" }).click();
  const fix = dialog(a, /종료 정정$/);
  await expect(fix.getByText("기록된 종료와 같습니다", { exact: false })).toBeVisible();
  await fillDate(fix, kstDate(-2), "종료일");
  await fix.getByRole("textbox", { name: /^정정 사유/ }).fill("폐업일을 잘못 적음");
  // Negative: the server refuses (a reason it cannot take); the words name it and the close stays as it was.
  await a.route(`**/api/v1/legal-entities/${id}/close`, (r) => r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), why: "" }) }));
  const refused = a.waitForResponse((r) => r.url().endsWith(`/legal-entities/${id}/close`) && r.request().method() === "PUT");
  await fix.getByRole("button", { name: "종료 정정" }).click();
  expect((await refused).status()).toBe(422);
  await expect(fix.getByRole("alert")).toBeVisible();
  await expect(fix.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
  await a.unroute(`**/api/v1/legal-entities/${id}/close`);
  await fix.getByRole("button", { name: "종료 정정" }).click();
  await expect(fix).toBeHidden({ timeout: 15_000 });
  await expect(a.getByRole("note")).toContainText(koDate(kstDate(-2)));
});
