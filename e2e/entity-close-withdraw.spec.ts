import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { registerEntity } from "./setup-flows";
import { shot } from "./shots";

// UX-R3 STRUCT company-15 (catalog company-19): a closed 법인's one verb has two modes, 정정 and 취소. 취소 previews what reopens
// and that ended grants stay ended, refuses without its reason (the words name it, nothing changes), then reopens the 법인.
// regression: on the parent only 종료 정정 existed (no way back for a business that goes on; the DELETE was 405).

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });

test("regression: a closed 법인's close is withdrawn, with what reopens previewed and a refusal that changes nothing (company-15)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "uxr3-withdraw", "취소그룹");
  const auth = new Promise<string>((resolve) => a.on("request", (r) => r.headers()["authorization"] && r.url().includes("/api/v1/") && resolve(r.headers()["authorization"]!)));
  await go(a, "/org/entities/new");
  await registerEntity(a, "취소리테일");
  const id = new URL(a.url()).pathname.split("/").pop()!;
  const closed = await a.request.post(`/api/v1/legal-entities/${id}/close`, { headers: { authorization: await auth, "Idempotency-Key": crypto.randomUUID() }, data: { closed_on: kstDate(-1), reason_code: "BUSINESS_CLOSED" } });
  expect(closed.status()).toBe(200);
  await a.reload();
  await expect(a.getByRole("note")).toContainText("종료한 법인의 기록은 수정할 수 없고");

  await a.getByRole("button", { name: "종료 정정" }).click();
  const fix = dialog(a, /종료 정정$/);
  await option(a, "무엇을 정정합니까", "종료 취소 · 계속 영업").click();
  await expect(fix.getByRole("region", { name: "다시 열리는 것" })).toBeVisible();
  await expect(fix).toContainText("종료할 때 끝난 권한은 다시 생기지 않습니다");
  await expect(fix.getByRole("textbox", { name: /^종료일/ })).toHaveCount(0);
  await expectAccessible(a, "close withdrawal preview");
  await shot(a, "after-company-15-withdraw-preview");
  await fix.getByRole("textbox", { name: /^취소 사유/ }).fill("폐업을 철회하고 계속 영업");

  // Negative: the server refuses a blank reason; the words name it and the 법인 stays closed.
  await a.route(`**/api/v1/legal-entities/${id}/close`, (r) => r.fallback({ postData: JSON.stringify({ why: "" }) }));
  const refused = a.waitForResponse((r) => r.url().endsWith(`/legal-entities/${id}/close`) && r.request().method() === "DELETE");
  await fix.getByRole("button", { name: "종료 취소", exact: true }).click();
  expect((await refused).status()).toBe(422);
  await expect(fix.getByRole("alert")).toBeVisible();
  await expect(fix.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
  await a.unroute(`**/api/v1/legal-entities/${id}/close`);

  await fix.getByRole("button", { name: "종료 취소", exact: true }).click();
  await expect(fix).toBeHidden({ timeout: 15_000 });
  await expect(a.getByText("종료한 법인의 기록은 수정할 수 없고")).toHaveCount(0);
  await expect(a.getByRole("button", { name: /수정$/ }).first()).toBeVisible();
});
