// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { firstSignIn, go, kstDate, registerEmployee, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { psql } from "./idle-fixture";
import { SETUP_DEPARTMENT, setupCompany } from "./setup-flows";

test("weekly reads use tenant warning hours and return UNKNOWN outside register coverage", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("주간근로시간");
  const slug = unique("weeklylimits");
  await tenantSlugField(vendor).fill(slug);
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "주간근로시간", "본사");
  await registerEmployee(admin, { name: "윤하준", number: "W-1", unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
  const people = await (await api("/employees?limit=10")).json() as components["schemas"]["EmployeePage"];
  const employee = people.items[0]!.id;
  const read = async (week: string, expected: string) => {
    const manager = await api(`/attendance/week52?week_start=${week}`);
    expect(manager.status(), await manager.text()).toBe(200);
    const board = await manager.json() as components["schemas"]["AttendanceWeek52Board"];
    expect(board.items).toHaveLength(1);
    expect(board.items[0]!.tone).toBe(expected);
    const ownResponse = await api(`/attendance/me/week52?week_start=${week}`);
    expect(ownResponse.status(), await ownResponse.text()).toBe(200);
    const own = await ownResponse.json() as components["schemas"]["OwnAttendanceWeek52Response"];
    expect(own.status).toBe("available");
    expect(own.projection?.tone).toBe(expected);
    return board.items[0]!;
  };
  // Isolated fixture: give the authenticated account a linked employee and five complete nine-hour pairs.
  psql(slug, `UPDATE users SET employee_id='${employee}'::uuid WHERE org_id=current_setting('app.current_org')::uuid;
    INSERT INTO employee_attendance_records(org_id,employee_id,actor_user_id,kind,occurred_at,work_date,state_after,idempotency_key)
    SELECT current_setting('app.current_org')::uuid,'${employee}'::uuid,(SELECT id FROM users WHERE employee_id='${employee}'::uuid LIMIT 1),
      v.kind,(d.day+v.clock) AT TIME ZONE 'Asia/Seoul',d.day::date,v.state,gen_random_uuid()::text
    FROM generate_series('2026-10-26'::timestamp,'2026-10-30'::timestamp,interval '1 day') d(day)
    CROSS JOIN (VALUES ('CLOCK_IN',interval '9 hours','CLOCKED_IN'),('CLOCK_OUT',interval '18 hours','OFF_DUTY')) v(kind,clock,state);`);
  expect((await read("2026-10-26", "OK")).current_hours).toBe(45);
  const refusedLimit = await api("/settings/attendance.week52.warn_hours", "POST", { value: 52, reason_code: "POLICY_REVIEW" });
  expect([refusedLimit.status(), await codeOf(refusedLimit)]).toEqual([422, "setting_out_of_range"]);
  const changed = await api("/settings/attendance.week52.warn_hours", "POST", { value: 45, reason_code: "POLICY_REVIEW" });
  expect(changed.status(), await changed.text()).toBe(201);
  await read("2026-10-26", "OK");
  psql(slug, `ALTER TABLE tenant_setting_overrides DISABLE TRIGGER trg_tenant_setting_overrides_check;
    INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction)
    SELECT current_setting('app.current_org')::uuid,'attendance.week52.warn_hours','45','2026-10-25T15:00:00Z',id,'POLICY_REVIEW','tighten'
    FROM users WHERE employee_id='${employee}'::uuid;
    ALTER TABLE tenant_setting_overrides ENABLE TRIGGER trg_tenant_setting_overrides_check;`);
  await read("2026-10-26", "WARN");
  // Outside register coverage, existing history still gives UNKNOWN.
  await read("2028-01-03", "UNKNOWN");
  await go(admin, "/attendance?tab=week&date=2028-01-03");
  const unknown = admin.getByRole("row").filter({ hasText: "윤하준" });
  await expect(unknown).toContainText("확인 불가");
  await expect(unknown).toContainText("이 주의 법정 근로시간 기준이나 설정된 주의 기준을 확인할 수 없습니다.");
  const refused = await api("/attendance/week52?week_start=2026-10-27");
  expect([refused.status(), await codeOf(refused)]).toEqual([422, "validation"]);
});
