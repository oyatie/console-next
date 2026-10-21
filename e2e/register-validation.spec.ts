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
    await go(admin, href!);
    await reading;
    const sheet = registerSheet(admin);
    await sheet.getByRole("textbox", { name: /^이름/ }).fill("김검증");
    await pressRegister(admin);
    await expect(sheet.getByRole("alert")).toContainText("수정해야 등록됩니다");
    await fillRegister(admin, { name: "김검증", hired: kstDate() });

    const read = admin.waitForResponse((response) => response.url().endsWith("/api/v1/org-units"));
    release();
    await read;
    await admin.unrouteAll({ behavior: "wait" });
    // A refused press must stay refused when both the draft and its placement reads become complete.
    await expectAccessible(admin, "registration after a delayed placement read");
    expect(creates.count()).toBe(0);
    await expect(sheet.getByRole("textbox", { name: /^이름/ })).toHaveValue("김검증");
    for (const name of [/^등록하고 닫기/, /^등록하고 다음 사람/]) {
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
