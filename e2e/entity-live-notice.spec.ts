import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { soloTenant } from "./chaos";
import { newContext, passkeyLogin } from "./flows";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { reviseFact } from "./helpers/entity";
import { setupCompany } from "./setup-flows";
import { shot } from "./shots";

// UX-R3 STRUCT worst-case-33 (#27 §6.6): the 법인 record open in two tabs. A save in one tells the other's open 고치기 sheet,
// before it saves, that the record changed elsewhere; its own save then meets the conflict view, which shows the other
// value as typed (02-…), never E.164 (+82…). regression: on the parent the open sheet said nothing and the conflict read +82.

test("regression: an open 고치기 sheet says the record changed elsewhere, and the conflict shows values as typed (worst-case-33)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await soloTenant(browser, "uxr3-livent", "실시간법인");
  await setupCompany(a, "실시간법인", "본사");
  const record = a.url();
  // A fresh load: the setup's own writes are not this tab's pending echo window when the other tab saves.
  await a.reload();
  await expect(a.getByRole("heading", { name: /실시간법인/, level: 1 })).toBeVisible();
  // The same account on a second browser (its own context and stream), as live.spec's sameUserElsewhere.
  const b = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(b)).import(await authenticatorOf(a).export());
  await b.goto("/login");
  await passkeyLogin(b);
  await b.goto(record);
  await expect(b.getByRole("heading", { name: /실시간법인/, level: 1 })).toBeVisible();

  const mine = await reviseFact(a, "대표전화", "cor");
  await mine.getByRole("textbox", { name: /^대표전화/ }).fill("021110001");
  const theirs = await reviseFact(b, "대표전화", "cor");
  await theirs.getByRole("textbox", { name: /^대표전화/ }).fill("022220002");
  await theirs.getByRole("button", { name: "정정 기록" }).click();
  await expect(theirs).toBeHidden();

  await expect(a.getByText(/다른 곳에서 바뀌었습니다 · 저장하면 비교합니다/)).toBeVisible({ timeout: 15_000 });
  await expectAccessible(a, "entity revise: changed elsewhere");
  await shot(a, "after-worst-case-33-live-notice");
  await mine.getByRole("button", { name: "정정 기록" }).click();
  await expect(mine.getByRole("alert").first()).toBeVisible();
  await expect(mine).toContainText("02-222-0002");
  await expect(mine).not.toContainText("+82");
});
