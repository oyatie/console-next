// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { go } from "./flows";
import { registerEntity, tenantBeforeSetup } from "./setup-flows";

test("payroll run preview derives rules without creating a run", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin, exec: reader } = await tenantBeforeSetup(browser, "payroll-run-preview", "급여미리보기상사", false, "none");
  const adminToken = bearerOf(admin);
  const readerToken = bearerOf(reader);
  try {
    await go(admin, "/org/entities/new");
    await registerEntity(admin, "급여미리보기상사");
    await Promise.all([admin.reload(), reader.reload()]);
    await expect.poll(adminToken).toMatch(/^Bearer /);
    await expect.poll(readerToken).toMatch(/^Bearer /);
    const api = apiOf(admin, adminToken);
    const groupsResponse = await api("/payroll/pay-groups");
    expect(groupsResponse.status()).toBe(200);
    const groups = await groupsResponse.json();
    const response = await api("/payroll/pay-groups", "POST", {
      legal_entity_id: groups.legal_entities[0].id, name: "모의 급여",
      pay_date_rule: { day: "LAST_DAY", month_offset: 0, non_business_day: "PREVIOUS" },
      base_period: { start_day: "FIRST", month_offset: 0 }, variable_period: { start_day: 16, month_offset: -1 },
      proration: "CALENDAR_DAYS", channel: "ATTESTATION_ONLY", sensitive: true, pay_basis_allowed: ["MONTHLY"],
    });
    expect(response.status()).toBe(201);
    const group = await response.json();
    for (const kind of ["REGULAR", "OFF_CYCLE", "CORRECTION", "EXIT_SETTLEMENT"]) {
      const path = `/payroll/runs/preview?pay_group_id=${group.id}&kind=${kind}`;
      const preview = await api(path);
      expect(preview.status()).toBe(200);
      const facts = await preview.json();
      expect(facts).toMatchObject({ kind, pay_group_id: group.id, legal_entity_id: group.legal_entity_id, pay_date_clamped: false });
      expect(facts.attribution_month).toMatch(/^\d{4}-\d{2}$/);
      for (const field of ["pay_date", "period_start", "period_end", "variable_period_start", "variable_period_end"]) {
        expect(facts[field]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(await (await api(path)).json()).toEqual(facts);
      const denied = await apiOf(reader, readerToken)(path);
      expect(denied.status()).toBe(403);
      expect(await codeOf(denied)).toBe("forbidden");
    }
    const invalid = await api(`/payroll/runs/preview?pay_group_id=${group.id}&kind=BONUS`);
    expect(invalid.status()).toBe(422);
    expect(await codeOf(invalid)).toBe("validation");
    const listed = await (await api("/payroll/runs")).json();
    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(0);
  } finally {
    await Promise.all([admin.context().close(), reader.context().close()]);
  }
});
