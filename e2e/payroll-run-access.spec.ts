// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";
import { chooseRadio, go } from "./flows";
import { activatePendingGrants } from "./second-person-fixture";

async function grantAlphaAccess(admin: Page, token: () => string, domain: "pay" | "sensitive") {
  // These alpha role lines are absent from the editor; create the role through the public API.
  const name = domain === "pay" ? "급여 민감 제외" : "급여 민감 허용";
  const role = await apiOf(admin, token)("/access/roles", "POST", {
    name_ko: name, status: "ACTIVE", lines: [{ domain, levels: ["view", "edit"] }],
  });
  expect(role.status()).toBe(201);
  await admin.reload();
  await go(admin, "/access/grants");
  await admin.getByRole("button", { name: "권한 부여", exact: true }).click();
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill("이임원");
  await admin.getByRole("option", { name: /이임원/ }).first().click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await sheet.getByRole("button", { name: / 역할$/ }).click();
  await admin.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const scope = admin.getByRole("dialog", { name: "범위 선택" });
  await scope.getByRole("row", { name: /^전체/ }).first().click();
  await scope.getByRole("button", { name: "이 범위로 설정" }).click();
  await sheet.getByRole("button", { name: /^1년/ }).click();
  await chooseRadio(sheet, /^설정 단계부터/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "이임원님에게 부여 1건을 저장했습니다" })).toBeVisible({ timeout: 20_000 });
  await activatePendingGrants(admin, token);
}

test("payroll reads and commands require tenant pay access", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec: reader } = await tenantInSetup(browser, "payroll-run-access", "급여권한검토상사", false, "본점", "none");
  const token = bearerOf(reader);
  const opsToken = bearerOf(admin);
  await Promise.all([reader.reload(), admin.reload()]);
  await expect.poll(token).toMatch(/^Bearer /);
  await expect.poll(opsToken).toMatch(/^Bearer /);
  const api = apiOf(reader, token);
  const missing = `/payroll/runs/${randomUUID()}`;
  try {
    const readiness = await api("/payroll/payslips/me");
    expect(readiness.status()).toBe(200);
    const page = await readiness.json();
    expect(page).toMatchObject({ items: [], total: 0 });
    expect(JSON.stringify(page)).not.toMatch(/won/i);
    for (const path of ["/payroll/pay-groups", "/payroll/runs", missing, `${missing}/close-preflight`, `${missing}/exceptions`, `${missing}/payslip-delivery`]) {
      const refused = await api(path);
      expect(refused.status()).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    const commands: [string, object | undefined][] = [
      ["close-attendance", { attest: true }], ["calculate", undefined],
      [`exceptions/${randomUUID()}/resolve`, { action: "ACKNOWLEDGE" }],
      ["submit", undefined], ["decision", { decision: "APPROVE" }], ["withdraw", undefined],
      ["schedule-disbursement", { scheduled_at: new Date(Date.now() + 86_400_000).toISOString() }],
      ["disbursement/attest", { status: "SUCCEEDED" }], ["issue-payslips", undefined],
    ];
    const inboxBefore = await api("/me/inbox-docs?filter=payslip");
    expect(inboxBefore.status()).toBe(200);
    const before = await inboxBefore.json();
    for (const [suffix, body] of commands) {
      const refused = await api(`${missing}/${suffix}`, "POST", body);
      expect(refused.status()).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    const inboxAfter = await api("/me/inbox-docs?filter=payslip");
    expect(inboxAfter.status()).toBe(200);
    expect(await inboxAfter.json()).toEqual(before);
    // The bootstrap owner holds tenant pay access; payroll is not offered in the MVP role grid.
    const opsApi = apiOf(admin, opsToken);
    const groupsBefore = await opsApi("/payroll/pay-groups");
    expect(groupsBefore.status()).toBe(200);
    const groups = await groupsBefore.json();
    expect(groups.items).toEqual([]);
    expect(groups.legal_entities).toHaveLength(1);
    const groupInput = {
      legal_entity_id: groups.legal_entities[0].id, name: "모의 급여 그룹",
      pay_date_rule: { day: "LAST_DAY", month_offset: 0, non_business_day: "PREVIOUS" },
      base_period: { start_day: "FIRST", month_offset: 0 }, variable_period: { start_day: 16, month_offset: -1 },
      proration: "CALENDAR_DAYS", channel: "ATTESTATION_ONLY", sensitive: true, pay_basis_allowed: ["MONTHLY"],
    };
    const refusedGroup = await api("/payroll/pay-groups", "POST", groupInput);
    expect(refusedGroup.status()).toBe(403);
    expect(await codeOf(refusedGroup)).toBe("forbidden");
    for (const required of ["sensitive", "pay_basis_allowed"] as const) {
      const invalid: Partial<typeof groupInput> = { ...groupInput };
      delete invalid[required];
      const response = await opsApi("/payroll/pay-groups", "POST", invalid);
      expect(response.status()).toBe(422);
      expect(await codeOf(response)).toBe("validation");
    }
    expect((await (await opsApi("/payroll/pay-groups")).json()).items).toEqual([]);
    const createdGroup = await opsApi("/payroll/pay-groups", "POST", groupInput);
    expect(createdGroup.status()).toBe(201);
    const group = await createdGroup.json();
    expect(group).toMatchObject(groupInput);
    expect(group.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await (await opsApi("/payroll/pay-groups")).json()).items).toEqual([group]);
    expect((await opsApi("/payroll/runs")).status()).toBe(200);
    for (const suffix of ["close-preflight", "exceptions", "payslip-delivery"]) {
      expect((await opsApi(`${missing}/${suffix}`)).status()).toBe(404);
    }
    for (const [suffix, body] of commands) {
      expect((await opsApi(`${missing}/${suffix}`, "POST", body)).status()).toBe(404);
    }
    const listed = await opsApi("/payroll/runs");
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [], total: 0 });
    const absent = await opsApi(missing);
    expect(absent.status()).toBe(404);
    expect(await codeOf(absent)).toBe("not_found");
    await grantAlphaAccess(admin, opsToken, "pay");
    const regularInput = { ...groupInput, name: "모의 일반 급여 그룹", sensitive: false };
    const regularResponse = await api("/payroll/pay-groups", "POST", regularInput);
    expect(regularResponse.status()).toBe(201);
    const regular = await regularResponse.json();
    const hidden = await api("/payroll/pay-groups");
    expect(hidden.status()).toBe(200);
    expect((await hidden.json()).items).toEqual([regular]);
    const sensitiveRefused = await api("/payroll/pay-groups", "POST", groupInput);
    expect(sensitiveRefused.status()).toBe(403);
    expect(await codeOf(sensitiveRefused)).toBe("forbidden");
    expect((await (await opsApi("/payroll/pay-groups")).json()).items).toHaveLength(2);
    await grantAlphaAccess(admin, opsToken, "sensitive");
    const cleared = await api("/payroll/pay-groups");
    expect(cleared.status()).toBe(200);
    expect((await cleared.json()).items).toEqual(expect.arrayContaining([regular, group]));
    expect((await api("/payroll/pay-groups", "POST", groupInput)).status()).toBe(201);
  } finally {
    await Promise.all([admin.context().close(), reader.context().close()]);
  }
});
