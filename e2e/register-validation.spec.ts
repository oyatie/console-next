import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { sent, soloTenant } from "./chaos";
import { go, kstDate } from "./flows";
import { fillRegister, pressRegister, receiptOf, registerSheet } from "./helpers/register";
import { setupCompany } from "./setup-flows";
import { forgetResize } from "./stability";
import { box } from "./structure-flows";

for (const width of [1280, 390]) {
  test(`an invalid registration press is not queued behind placement reads at ${width}px`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    const admin = await soloTenant(browser, `reg-validation-${width}`, "등록검증");
    await setupCompany(admin, "등록검증", "본사");
    await go(admin, "/org");
    await expect(box(admin, "본사")).toBeVisible();
    await box(admin, "본사").click();
    const href = await admin.getByRole("complementary", { name: "본사", exact: true }).getByRole("link", { name: "본사에 직원 등록" }).getAttribute("href");
    await admin.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
    await forgetResize(admin);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    await admin.route("**/api/v1/org-units", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    const creates = sent(admin, /\/api\/v1\/employees$/);
    const navigating = go(admin, href!);
    await reading;
    const sheet = registerSheet(admin);
    await sheet.getByRole("textbox", { name: /^이름/ }).fill("김검증");
    await pressRegister(admin);
    await expect(sheet.getByRole("alert")).toContainText("수정해야 등록됩니다");
    await fillRegister(admin, { name: "김검증", hired: kstDate() });

    const read = admin.waitForResponse((response) => response.url().endsWith("/api/v1/org-units"));
    release();
    await read;
    await navigating;
    await admin.unrouteAll({ behavior: "wait" });
    // A refused press must stay refused when both the draft and its placement reads become complete.
    await expectAccessible(admin, "registration after a delayed placement read");
    expect(creates.count()).toBe(0);
    await expect(sheet.getByRole("textbox", { name: /^이름/ })).toHaveValue("김검증");
    for (const name of [/^직원 등록 1명 반영(?: ⌘|$)/, /^직원 등록 1명 반영 · 다음 직원/]) {
      const action = sheet.getByRole("button", { name });
      const bounds = await action.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(admin.viewportSize()!.height);
      await action.click({ trial: true });
    }
    await pressRegister(admin);
    await expect(sheet).toBeHidden();
    await expect(receiptOf(admin, "김검증")).toBeVisible();
    expect(creates.count()).toBe(1);
  });
}

test("a named server refusal focuses once and its summary link returns to the field", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "reg-server-field", "서버검증");
  await setupCompany(admin, "서버검증", "본사");
  await go(admin, "/people/new");
  // The client accepts a non-empty name; the real server enforces its text bound.
  await fillRegister(admin, { name: "김".repeat(201), hired: kstDate() });
  const refused = admin.waitForResponse((response) => response.url().endsWith("/api/v1/employees") && response.request().method() === "POST");
  await pressRegister(admin);
  const response = await refused;
  expect(response.status()).toBe(422);
  const body = await response.json();
  expect(body.error.errors).toEqual([{ field: "name", code: "validation" }]);
  expect(body.error.operation_id).toEqual(expect.any(String));
  const sheet = registerSheet(admin);
  const name = sheet.getByRole("textbox", { name: /^이름/ });
  const phone = sheet.getByLabel("휴대전화");
  const summary = sheet.locator('[data-component="error-summary"]');
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await phone.fill("01012345678");
  await expect(phone).toBeFocused();
  await summary.getByRole("link", { name: /이름/ }).click();
  await expect(name).toBeFocused();
  await name.fill("김".repeat(200));
  const created = admin.waitForResponse((response) => response.url().endsWith("/api/v1/employees") && response.request().method() === "POST");
  await pressRegister(admin);
  expect((await created).status()).toBe(201);
  await expect(sheet).toBeHidden();
});
