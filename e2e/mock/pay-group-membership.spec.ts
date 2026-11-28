// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { payrollScreens } from "../states/payroll";
import { id, modules, screenAccess, failure } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { saeonPayGroups } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));
for (const experience of ["console", "baseline"] as const) {
  test(`payroll setup assigns and moves a later hire, with a dated freeze refusal in ${experience}`, async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [EXPERIENCE_KEY, experience]);
    const fixture = await mockScreen(page, payrollScreens[0], "populated");
    const entity = saeonPayGroups().items[0]!;
    const a = { ...entity, name: "Monthly" };
    const b = { ...a, id: id(720), name: "Hourly" };
    const person = { employee_id: id(740), employee_number: "T-740", name: "Alex Morgan" };
    let source: string | null = null;
    let frozen = false;
    const writes: { pay_group_id: string; expected_pay_group_id: string | null; effective_from: string }[] = [];
    await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: [...modules.ready, { key: "payroll", ready: true, unblock: null }] });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/payroll/setup") });
    await mockRoute(page, "get", "/api/v1/payroll/pay-groups", { status: 200, json: { legal_entities: saeonPayGroups().legal_entities, items: [a,b], manageable_group_ids: [a.id,b.id] } });
    await mockRoute(page, "get", "/api/v1/payroll/pay-group-memberships", () => ({ status: 200, json: [{ ...person, current_pay_group_id: source }] }));
    await mockRoute(page, "post", "/api/v1/payroll/pay-group-memberships", request => {
      const body = request.postDataJSON();
      writes.push(body);
      if (frozen) return { status: 409, json: failure("pay_group_membership_frozen") };
      source = body.pay_group_id;
      return { status: 200, json: { id: body.pay_group_id } };
    });
    await mockRoute(page, "get", "/api/v1/payroll/runs/preview", { status: 409, json: failure("pay_group_roster_ambiguous") });
    try {
      await page.goto("/payroll/setup");
      await expect(page.getByRole("link", { name: t("payroll.members.title") })).toBeVisible();
      await page.goto("/payroll/runs/new");
      await page.getByText(new RegExp(a.name)).click();
      await page.getByText(t("payroll.create.kind.REGULAR"), { exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(t("common.failed.code.pay_group_roster_ambiguous"));
      await page.getByRole("link", { name: t("payroll.members.title") }).click();
      const target = page.getByLabel(t("payroll.members.target"), { exact: false });
      const personPicker = page.getByRole("combobox", { name: new RegExp(t("payroll.members.search")) });
      const submit = page.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "assign" }), exact: true });
      for (const group of [a,b]) {
        await target.selectOption(group.id);
        const effective = page.getByLabel(t("payroll.employee.effective"), { exact: false }).first();
        await effective.fill(group === a ? "2026-01-01" : "2026-02-01");
        await effective.press("Tab");
        await personPicker.fill(person.name);
        await page.getByRole("option", { name: new RegExp(person.name) }).click();
        if (group === b) {
          frozen = true;
          await submit.click();
          await expect(page.getByText(t("common.failed.code.pay_group_membership_frozen"))).toBeVisible();
          frozen = false;
        }
        await submit.click();
        await expect(page.getByText(t("payroll.members.saved")).first()).toBeVisible();
      }
      expect(writes.map(row => [row.pay_group_id, row.expected_pay_group_id, row.effective_from])).toEqual([
        [a.id, null,"2026-01-01"],[b.id,a.id,"2026-02-01"],[b.id,a.id,"2026-02-01"],
      ]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
