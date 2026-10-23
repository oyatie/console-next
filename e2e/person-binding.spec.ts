// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, registerEmployee, stepUp, takeCode } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { staffedTenant } from "./setup-flows";

test("open binding evidence surfaces on employee and account records without a legacy review flag", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "bindingreviews", "사람연결상사");
  const api = apiOf(admin, bearerOf(admin));
  type Employees = { items: { id: string; name: string; employee_number: string; identity_review_required: boolean }[] };
  type Accounts = { items: { id: string; employee_id: string | null }[] };
  // The durable review source is DB-tested; this fixture isolates both browser entry points.
  // Registration opens the card: install evidence before its first query is cached.
  await admin.route("**/api/v1/person-binding-reviews?*", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("subject_id");
    const employees = await (await api("/employees?search=PB-100")).json() as Employees;
    const subject = employees.items.find((e) => e.employee_number === "PB-1001");
    const accounts = await (await api("/users")).json() as Accounts;
    const linked = accounts.items.some((u) => u.id === id && u.employee_id === subject?.id);
    const items = subject && (id === subject.id || linked) ? [{
      subject_kind: id === subject.id ? "EMPLOYEE" : "ACCOUNT", subject_id: id,
      reason: "NUMBER_BIRTH_AMBIGUOUS", created_at: new Date().toISOString(),
      evidence: { candidates: employees.items.map((e) => ({ employee_id: e.id, name: e.name, employee_number: e.employee_number, birth_date: "1990-03-04" })) },
    }] : [];
    await route.fulfill({ json: { items, total: items.length, limit: 50, offset: 0 } });
  });
  await registerEmployee(admin, { name: "연결검토이", number: "PB-1002", unit: "채용팀" });
  await registerEmployee(admin, { name: "연결검토일", number: "PB-1001", unit: "채용팀" });
  const employees = await (await api("/employees?search=PB-100")).json() as Employees;
  const subject = employees.items.find((e) => e.employee_number === "PB-1001")!;
  const other = employees.items.find((e) => e.employee_number === "PB-1002")!;
  expect(subject.identity_review_required).toBe(false);
  await go(admin, `/people/${subject.id}`);
  await admin.getByRole("button", { name: "동일인 확인", exact: true }).click();
  const sheet = admin.getByRole("dialog", { name: `${subject.name} 동일인 확인` });
  await expect(sheet).toContainText("다른 사람이면 표시만 해제하고");
  await expect(sheet.getByRole("radio", { name: /다른 사람입니다/ })).toBeVisible();
  await expect(sheet.getByRole("radio", { name: /같은 사람입니다/ })).toBeVisible();
  await expect(sheet.getByRole("link", { name: /연결검토이.*PB-1002/ })).toHaveAttribute("href", `/people/${other.id}`);
  await expect(sheet.getByRole("link", { name: /연결검토일/ })).toHaveCount(0);
  await expectAccessible(admin, "binding evidence in identity review");
  await sheet.getByRole("button", { name: "닫기", exact: true }).click();
  await admin.getByRole("button", { name: "계정 초대", exact: true }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  await takeCode(admin);
  const accounts = await (await api("/users")).json() as Accounts;
  const accountId = accounts.items.find((u) => u.employee_id === subject.id)!.id;
  await go(admin, `/people?view=accounts&sel=${accountId}`);
  const panel = admin.getByRole("complementary", { name: subject.name });
  await panel.getByRole("button", { name: "동일인 확인", exact: true }).click();
  const accountSheet = admin.getByRole("dialog", { name: "사람 연결 확인 자료" });
  await expect(accountSheet.getByRole("link", { name: /연결검토이.*PB-1002/ })).toBeVisible();
  await expectAccessible(admin, "account binding evidence");
});
