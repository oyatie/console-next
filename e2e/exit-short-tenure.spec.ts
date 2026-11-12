// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { go, kstDate, registerEmployee } from "./flows";
import { setupCompany, startOperations } from "./setup-flows";
import { signOff } from "./sheet";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";

type ExitCase = components["schemas"]["EmployeeExitCase"];

for (const replay of [1, 2]) {
  test(`same-day service excludes severance and submits without wage sources (${replay})`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    const admin = await openTenant(browser, `short-exit-${replay}`, "단기근속회사");
    const api = apiOf(admin, bearerOf(admin));
    await setupCompany(admin, "단기근속회사", "본사");
    await startOperations(admin);
    // Last working day has ended, so the exit can apply in both browser projects.
    const on = kstDate(-1);
    await registerEmployee(admin, { name: "당일퇴직", number: "SHORT-01", hired: on, unit: "본사" });
    await admin.getByRole("button", { name: "퇴직 보고" }).click();
    const sheet = admin.getByRole("dialog");
    await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(on);
    await sheet.getByLabel("퇴직 경위").fill("개인 사정");
    await sheet.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
    await sheet.getByRole("button", { name: "퇴직 보고 1명 적용" }).click();
    const panel = admin.getByRole("region", { name: "퇴직", exact: true }).last();
    await panel.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
    await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
    await admin.getByRole("dialog").getByRole("button", { name: /퇴직 1명 (적용|예약)/ }).click();
    await expect(admin.getByRole("dialog")).toBeHidden();
    const href = await panel.getByRole("link", { name: "퇴직 건 열기" }).getAttribute("href");
    await go(admin, href!);
    await admin.getByRole("region", { name: /지금/ }).getByRole("button", { name: "퇴직 본사 확인 1명 적용" }).click();
    const id = href!.split("/").at(-1)!;
    const response = await api(`/hr/exit-cases/${id}`);
    expect(response.ok()).toBe(true);
    const c = await response.json() as ExitCase;
    const p = c.settlement_package!;
    expect(p.statutory_basis?.severance_eligibility).toMatchObject({
      outcome: "NOT_ELIGIBLE", reason: "UNDER_SERVICE_YEARS", threshold: { num: 1, den: 1 }, review_required: true,
      rule: { instrument: "근로자퇴직급여 보장법" },
    });
    expect(p.severance_pay_won).toBe(0);
    expect(p.missing_source_fields).toEqual([]);
    expect(p.certification_status).toBe("UNCERTIFIED_DRAFT");
    const draft = await api(`/hr/exit-cases/${id}/approval-draft`, "POST", { submit: false });
    expect(draft.ok()).toBe(true);
    const submitted = await api(`/hr/exit-cases/${id}/approval-draft`, "POST", { submit: true });
    expect(submitted.ok()).toBe(true);
    const done = await submitted.json() as ExitCase;
    expect(done.status).toBe("SUBMITTED");
    expect(done.next_actions).toEqual([]);
    expect(done.settlement_package?.insurance_loss_payload?.forms).toHaveLength(4);
  });
}
