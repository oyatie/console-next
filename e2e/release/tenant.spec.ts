// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { t } from "@console/i18n";
import { test } from "../locale-fixture";
import { go, submitRegistration } from "../flows";
import { receiptOf } from "../helpers/register";
import { openTenant } from "../helpers/tenant";
import saeon from "../mock/saeon-universe.json" with { type: "json" };
import { SETUP_DEPARTMENT, setupCompany, setupRail } from "../setup-flows";

test("tenant administrator signs in and opens the inbox, a personnel record and approvals", { tag: "@release" }, async ({ browser }) => {
  const admin = await test.step("Sign in with a new tenant passkey", () =>
    openTenant(browser, "releasesmoke", saeon.tenantName));

  await test.step("Read Home and the setup inbox", async () => {
    await go(admin, "/");
    await expect(setupRail(admin)).toBeVisible();
    await go(admin, "/inbox");
    await expect(admin.getByText(t("home.inbox.setup.title"), { exact: true })).toBeVisible();
  });

  await test.step("Open one employee from the people list", async () => {
    const { name, hireDate, workplace } = saeon.hero;
    await setupCompany(admin, saeon.tenantName, workplace);
    await submitRegistration(admin, { name, hired: hireDate, unit: SETUP_DEPARTMENT });
    await expect(receiptOf(admin, name)).toBeVisible();
    await admin.getByRole("rowheader", { name, exact: true }).click();
    await admin.getByRole("complementary", { name: t("people.panel") }).getByRole("link", { name: t("people.panel.open") }).click();
    await expect(admin.getByRole("heading", { level: 1 })).toContainText(name);
  });

  await test.step("Read the pending approvals list", async () => {
    await go(admin, "/approvals");
    await expect(admin.getByRole("heading", { level: 1, name: t("approvals.title") })).toBeVisible();
    await expect(admin.getByText(t("approvals.empty.pending"), { exact: true })).toBeVisible();
  });
});
