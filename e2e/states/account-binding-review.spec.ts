// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { test } from "../locale-fixture";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { id, inbox } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

async function setup(page: Page, locale: "ko" | "en") {
  await loadCatalog(locale); i18n.set(locale);
  await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
  const fixture = await mockScreen(page, screens[0], "populated");
  const data = inbox(1);
  data.items = [{ ...data.items[0]!, id: `account_binding_review:${id(7100)}`, kind: "account_binding_review",
    title: "Employee record", who: "Self-attesting account", due: data.as_of, days_remaining: 0,
    links: [{ kind: "employee", id: id(7101) }], context: { command_id: id(7100) } }];
  await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: data }));
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 200, json: {
    ceremony_id: id(7102), expires_at: "2099-01-01T00:00:00Z",
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } });
  await page.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  return { ...fixture, data };
}

for (const locale of ["ko", "en"] as const) {
  test(`only a server-provided binding review offers commands in ${locale} @ui-state`, async ({ page }) => {
    const fixture = await setup(page, locale);
    const row = fixture.data.items[0]!;
    row.context = {};
    await page.goto(`/inbox?sel=${encodeURIComponent(row.id)}`);
    const confirm = page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.confirmBinding") }), exact: true });
    await expect(page.getByRole("complementary")).toContainText(row.title);
    await expect(confirm).toHaveCount(0);
    row.context = { command_id: id(7100) };
    await page.reload();
    await expect(confirm).toHaveCount(1);
    row.kind = "contract_renewal";
    await page.reload();
    await expect(page.getByRole("complementary")).toContainText(row.title);
    await expect(confirm).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
  for (const path of ["/", "/inbox"]) for (const decision of ["CONFIRM", "REVOKE"] as const) test(`reviewer inbox ${decision} uses an own passkey in ${locale} on ${path} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await setup(page, locale);
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/users/employee-link-attestations/{id}/review", request => {
      expect(request.url()).toContain(id(7100));
      expect(request.postDataJSON()).toEqual({ decision, step_up: {
        ceremony_id: id(7102), credential: { id: "test-passkey", type: "public-key" },
      } });
      writes++; fixture.data.items = [];
      return { status: 200, json: {} };
    });
    await page.goto(`${path}?sel=${encodeURIComponent(fixture.data.items[0]!.id)}`);
    const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
    await expect(pane).toContainText("Self-attesting account");
    await expect(pane).toContainText("Employee record");
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `binding-review/${locale}/${decision}/${theme}`);
      await expectAxe(page, `binding-review/${locale}/${decision}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    const action = t(decision === "CONFIRM" ? "people.account.confirmBinding" : "people.account.revokeBinding");
    const button = pane.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action }), exact: true });
    await expect(button).toHaveCount(1);
    await button.click();
    await expect.poll(() => writes).toBe(1);
    await expect(button).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const [code, status] of [
    ["account_link.refuse.review_ineligible", 403], ["account_link.refuse.identity_unbound", 403],
    ["account_link.refuse.review_stale", 409], ["passkey_step_up_required", 428], ["unauthorized", 401],
  ] as const) test(`reviewer inbox renders ${code} in ${locale} @ui-state`, async ({ page }) => {
    const fixture = await setup(page, locale);
    await mockRoute(page, "post", "/api/v1/users/employee-link-attestations/{id}/review", { status, json: { error: { code, message: "" } } });
    await page.goto(`/inbox?sel=${encodeURIComponent(fixture.data.items[0]!.id)}`);
    await page.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.confirmBinding") }), exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    if (code.startsWith("account_link.")) await expect(alert).toContainText(t(code as "account_link.refuse.review_ineligible"));
    expect(fixture.unexpected).toEqual([]);
  });
}
