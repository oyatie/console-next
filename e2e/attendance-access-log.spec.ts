// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { firstSignIn, go, kstDate, registerEmployee, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { psql, settled } from "./idle-fixture";
import { SETUP_DEPARTMENT, setupCompany } from "./setup-flows";

test("attendance reads commit one access row naming the people returned", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("근태접속기록");
  const slug = unique("attaccess");
  await tenantSlugField(vendor).fill(slug);
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  const bearer = bearerOf(admin);
  await setupCompany(admin, "근태접속기록", "본사");
  await registerEmployee(admin, { name: "윤하준", number: "A-1", unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
  await registerEmployee(admin, { name: "황정우", number: "A-2", unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
  const api = apiOf(admin, bearer);
  const people = await (await api("/employees?limit=10")).json() as { items: { id: string }[] };
  expect(people.items).toHaveLength(2);
  await go(admin, "/account");
  await settled(admin);
  const records = () => {
    const output = psql(slug, `SELECT COALESCE(json_agg(json_build_object(
      'action', action, 'actor', actor, 'occurred_at', occurred_at, 'ip', ip,
      'after', after_snap)), '[]'::json) FROM audit_events
      WHERE org_id=current_setting('app.current_org')::uuid AND action LIKE 'attendance.%_read';`);
    return JSON.parse(output.split("\n").find(line => line.startsWith("["))!) as {
      action: string; actor: string; occurred_at: string; ip: string;
      after: { subject_ids: string[]; subject_count: number; session_id: string };
    }[];
  };
  const month = kstDate().slice(0, 7);
  for (const [path, action] of [
    [`/attendance/days?date=${kstDate()}&rows=all`, "attendance.day_read"],
    [`/attendance/month?month=${month}&limit=1`, "attendance.month_read"],
    [`/attendance/people/${people.items[0]!.id}/month?month=${month}`, "attendance.person_month_read"],
  ]) {
    const before = records().length;
    const response = await api(path!);
    expect(response.status(), await response.text()).toBe(200);
    const body = await response.json() as { employee_id?: string; rows?: { employee_id: string }[]; groups?: { rows: { employee_id: string }[] }[] };
    const subjects = body.employee_id ? [body.employee_id] : (body.rows ?? body.groups!.flatMap(group => group.rows)).map(row => row.employee_id);
    expect(subjects).not.toHaveLength(0);
    const rows = records();
    expect(rows).toHaveLength(before + 1);
    const row = rows.filter(row => row.action === action).at(-1)!;
    expect(row.after.subject_ids.sort()).toEqual(subjects.sort());
    expect(row.after.subject_count).toBe(subjects.length);
    expect(row.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.after.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.ip).toBeTruthy();
    expect(Date.parse(row.occurred_at)).not.toBeNaN();
  }
  const before = records().length;
  const anonymous = await admin.request.get(`/api/v1/attendance/month?month=${month}`);
  expect(anonymous.status()).toBe(401);
  expect(records()).toHaveLength(before);
});
