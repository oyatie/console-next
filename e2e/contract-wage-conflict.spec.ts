// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";

test("duplicate contract wage preserves the original and a later date succeeds", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec } = await staffedTenant(browser, "contract-wage-conflict", "근로계약검토상사");
  const token = bearerOf(admin);
  try {
    await registerEmployee(admin, { name: "계약검토직원", number: "WAGE-01", hired: "2026-01-01", unit: "본사" });
    const employee = new URL(admin.url()).pathname.split("/").pop()!;
    await go(admin, `/people/${employee}`);
    await expect.poll(token).toMatch(/^Bearer /);
    const api = apiOf(admin, token);
    const path = `/payroll/employees/${employee}/contract-wages`;
    const wage = { effective_from: "2026-07-01", wage_kind: "MONTHLY", amount_won: 3_000_000, monthly_standard_hours: 209, source_note: "합성 근로계약" };
    const created = await api(path, "POST", wage);
    expect(created.status()).toBe(201);
    const original = await created.json();
    for (const body of [wage, { ...wage, wage_kind: "HOURLY", amount_won: 20_000, monthly_standard_hours: 200, source_note: "변경한 합성 근로계약" }]) {
      const duplicate = await api(path, "POST", body);
      expect(duplicate.status()).toBe(409);
      expect(await codeOf(duplicate)).toBe("contract_wage_exists");
      const read = await api(`/payroll/employees/${employee}/payslip-draft?period=2026-07&pay_date=2026-07-31`);
      expect(read.status()).toBe(200);
      expect((await read.json()).contract).toEqual({ ...wage, id: original.id });
    }
    const later = { ...wage, effective_from: "2026-08-01", amount_won: 3_100_000 };
    const corrected = await api(path, "POST", later);
    expect(corrected.status()).toBe(201);
    const replacement = await corrected.json();
    expect(replacement.id).not.toBe(original.id);
    const read = await api(`/payroll/employees/${employee}/payslip-draft?period=2026-08&pay_date=2026-08-31`);
    expect(read.status()).toBe(200);
    expect((await read.json()).contract).toEqual({ ...later, id: replacement.id });
  } finally {
    await Promise.all([admin.context().close(), exec.context().close()]);
  }
});
