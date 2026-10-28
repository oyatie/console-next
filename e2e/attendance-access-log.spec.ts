// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { firstSignIn, go, kstDate, registerEmployee, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openUnit, sheet } from "./helpers/structure";
import { psql, settled } from "./idle-fixture";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "./setup-flows";

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
      'after', after_snap) ORDER BY occurred_at, id), '[]'::json) FROM audit_events
      WHERE org_id=current_setting('app.current_org')::uuid AND (action LIKE 'attendance.%_read' OR action IN ('org_unit.read','org_unit.members_read','org_unit.list_read','org_structure.read','org_change.read','org_change.list_read'));`);
    return JSON.parse(output.split("\n").find(line => line.startsWith("["))!) as {
      action: string; actor: string; occurred_at: string; ip: string;
      after: { subject_ids: string[]; subject_count: number; session_id: string; self_read: boolean; user_subject_ids?: string[]; row_count?: number };
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
    const row = rows.slice(before)[0]!;
    expect(row.action).toBe(action);
    expect(row.after.subject_ids.sort()).toEqual(subjects.sort());
    expect(row.after.subject_count).toBe(subjects.length);
    expect(row.after).not.toHaveProperty("employee_subject_ids");
    expect(row.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.after.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.ip).toBeTruthy();
    expect(Date.parse(row.occurred_at)).not.toBeNaN();
  }
  const unitsResponse = await api("/org-units");
  expect(unitsResponse.status(), await unitsResponse.text()).toBe(200);
  const units = await unitsResponse.json() as { items: { id: string; kind: string }[] };
  const company = units.items.find(unit => unit.kind === "COMPANY")!;
  const department = units.items.find(unit => unit.kind === "DEPARTMENT")!;
  const reader = records().at(-1)!.actor;
  const ownPerson = people.items[0]!.id;
  const seededClose = psql(slug, `UPDATE users SET employee_id='${ownPerson}'::uuid WHERE id='${reader}'::uuid;
    INSERT INTO attendance_month_closes(org_id,month,checks,attested_by,branch_id)
    VALUES(current_setting('app.current_org')::uuid,'${month}-01'::date,
      '{"open_exceptions":0,"pending_leave":0,"already_closed":false}'::jsonb,'${reader}'::uuid,
      (SELECT home_branch_id FROM employees WHERE id='${ownPerson}'::uuid))
    RETURNING json_build_object('branch_id',branch_id);`);
  const closeBranch = (JSON.parse(seededClose.split("\n").find(line => line.startsWith("{"))!) as { branch_id: string }).branch_id;
  const monday = new Date(`${kstDate()}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  for (const [path, action, subjects] of [
    [`/attendance/week52?week_start=${monday.toISOString().slice(0, 10)}`, "attendance.week52_read", people.items.map(person => person.id)],
    [`/attendance/schedule/calendar?scope_kind=PERSON&scope_id=${people.items[0]!.id}&month=${month}`, "attendance.schedule_read", [people.items[0]!.id]],
    [`/attendance/exceptions?month=${month}`, "attendance.exceptions_read", []],
    [`/attendance/substitutions?month=${month}`, "attendance.substitutions_read", []],
    ["/attendance/crews", "attendance.crews_read", []],
    [`/attendance/schedule/layers?scope_kind=PERSON&scope_id=${people.items[0]!.id}`, "attendance.layers_read", []],
    ["/attendance/schedule/tree", "attendance.schedule_tree_read", []],
    [`/attendance/closes?month=${month}&branch_id=${closeBranch}`, "attendance.closes_read", [ownPerson]],
    [`/org-units/${company.id}`, "org_unit.read", people.items.map(person => person.id)],
    [`/org-structure/units/${department.id}/members`, "org_unit.members_read", people.items.map(person => person.id)],
    [`/attendance/me/exceptions?month=${month}`, "attendance.own_exceptions_read", []],
    [`/attendance/me/week52?week_start=${monday.toISOString().slice(0, 10)}`, "attendance.own_week52_read", [ownPerson]],
  ] as const) {
    const before = records().length;
    const response = await api(path);
    expect(response.status(), await response.text()).toBe(200);
    const rows = records();
    expect(rows).toHaveLength(before + 1);
    const row = rows.slice(before)[0]!;
    expect(row.action).toBe(action);
    expect(row.after.subject_ids.sort(), action).toEqual([...subjects].sort());
    if (action === "attendance.schedule_tree_read") {
      expect(row.after.row_count).toBe((await response.json() as { people_total: number }).people_total);
    }
    expect(row.after.subject_count).toBe(subjects.length);
    expect(row.after).not.toHaveProperty("employee_subject_ids");
    if (["attendance.layers_read", "attendance.schedule_tree_read", "attendance.closes_read", "org_unit.read", "org_unit.members_read"].includes(action)) {
      expect(row.after.self_read, action).toBe(subjects.length === 1 && subjects[0] === ownPerson);
    }
    expect(row.after.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.ip).toBeTruthy();
    expect(Date.parse(row.occurred_at)).not.toBeNaN();
    const anonymous = await admin.request.get(`/api/v1${path}`);
    expect(anonymous.status()).toBe(401);
    expect(records()).toHaveLength(rows.length);
  }
  const amended = psql(slug, `WITH actor AS (
      INSERT INTO users(display_name,roles,org_id,is_active)
      VALUES('정정 담당자',ARRAY[]::text[],current_setting('app.current_org')::uuid,true) RETURNING id
    ) INSERT INTO attendance_close_amendments(org_id,close_id,reason,detail,idempotency_key,request_fingerprint,actor_user_id)
      SELECT c.org_id,c.id,'정정','접속기록 확인',gen_random_uuid()::text,repeat('a',64),actor.id
      FROM attendance_month_closes c CROSS JOIN actor WHERE c.org_id=current_setting('app.current_org')::uuid
      RETURNING json_build_object('actor',actor_user_id);`);
  const amendmentActor = (JSON.parse(amended.split("\n").find(line => line.startsWith("{"))!) as { actor: string }).actor;
  const beforeAmendmentRead = records().length;
  const closeResponse = await api(`/attendance/closes?month=${month}&branch_id=${closeBranch}`);
  expect(closeResponse.status(), await closeResponse.text()).toBe(200);
  const amendedRows = records();
  expect(amendedRows).toHaveLength(beforeAmendmentRead + 1);
  const closeRead = amendedRows.at(-1)!;
  expect(closeRead.after.subject_ids).toEqual([ownPerson]);
  expect(closeRead.after.subject_count).toBe(1);
  expect(closeRead.after.user_subject_ids).toEqual([amendmentActor]);
  expect(closeRead.after.self_read).toBe(false);
  expect(closeRead.after).not.toHaveProperty("employee_subject_ids");
  const before = records().length;
  const anonymous = await admin.request.get(`/api/v1/attendance/month?month=${month}`);
  expect(anonymous.status()).toBe(401);
  expect(records()).toHaveLength(before);

  const departmentPanel = await openUnit(admin, SETUP_DEPARTMENT);
  await departmentPanel.getByRole("button", { name: "부서장 지정", exact: true }).click();
  const appoint = sheet(admin, "부서장 지정");
  await appoint.getByRole("combobox", { name: "부서장", exact: true }).fill("윤하준");
  await admin.getByRole("option", { name: /윤하준/ }).click();
  await appoint.getByRole("button", { name: "부서장 지정", exact: true }).click();
  await expect(appoint).toBeHidden();
  await startOperations(admin);
  const operatingPanel = await openUnit(admin, SETUP_DEPARTMENT);
  await operatingPanel.getByRole("button", { name: "이름 변경" }).click();
  const rename = sheet(admin, `${SETUP_DEPARTMENT} 이름 변경`);
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("접속기록 부서");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(kstDate(3));
  await rename.getByRole("textbox", { name: /^사유/ }).fill("접속기록 확인");
  await rename.getByRole("button", { name: "부서 이름 변경 1개 예약" }).click();
  await expect(rename).toBeHidden();
  await go(admin, "/account");
  await settled(admin);
  const changes = await (await api("/org-changes?limit=1")).json() as { items: { id: string }[] };
  expect(changes.items).toHaveLength(1);
  for (const [path, action, subjects] of [
    ["/org-changes?limit=1", "org_change.list_read", [ownPerson]],
    [`/org-changes/${changes.items[0]!.id}`, "org_change.read", [ownPerson]],
    ["/org-structure", "org_structure.read", [ownPerson]],
    ["/org-units", "org_unit.list_read", []],
  ] as const) {
    const prior = records().length;
    const response = await api(path);
    expect(response.status(), await response.text()).toBe(200);
    const rows = records();
    expect(rows).toHaveLength(prior + 1);
    const row = rows.at(-1)!;
    expect(row.action).toBe(action);
    expect(row.actor).toBe(reader);
    expect(row.after.subject_ids).toEqual(subjects);
    expect(row.after.subject_count).toBe(subjects.length);
    expect(row.after.user_subject_ids).toEqual([]);
    expect(row.after.self_read).toBe(subjects.length === 1);
    expect(row.ip).toBeTruthy();
    expect(row.after.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(row.occurred_at)).not.toBeNaN();
    expect((await admin.request.get(`/api/v1${path}`)).status()).toBe(401);
    expect(records()).toHaveLength(rows.length);
  }
});
