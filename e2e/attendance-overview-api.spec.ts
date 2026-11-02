// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";
import { addDepartments } from "./structure-flows";

test("attendance issue aggregates and keysets describe the authorized scope", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin, exec } = await tenantInSetup(browser, "attoverview", "근태확인주식회사", false, "본사", "none");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사부"]);
  const bearer = bearerOf(admin);
  for (const [name, number] of [["윤하준", "O-0001"], ["황정우", "O-0002"], ["송재원", "O-0003"]]) {
    await registerEmployee(admin, { name: name!, number: number!, hired: kstDate(-60) });
  }
  const api = apiOf(admin, bearer);
  await expect.poll(bearer).not.toBe("");
  const date = kstDate(-1);
  const path = `/attendance/days?date=${date}&mark=NO_SCHEDULE&limit=1`;
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await api(`${path}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.status()).toBe(200);
    const board = await response.json();
    expect(board.ledger.people).toBe(3);
    expect(board.issue_groups).toEqual([{ kind: "NO_SCHEDULE", count: 3, earliest_date: date }]);
    const rows = board.groups.flatMap((g: { rows: { employee_id: string }[] }) => g.rows);
    expect(rows).toHaveLength(1);
    expect(seen.has(rows[0].employee_id)).toBe(false);
    seen.add(rows[0].employee_id);
    cursor = board.next_cursor;
  } while (cursor);
  expect(seen.size).toBe(3);
  const empty = await api(`/attendance/days?date=${date}&mark=MISSING_OUT`);
  expect(empty.status()).toBe(200);
  const board = await empty.json();
  expect(board.groups).toEqual([]);
  expect(board.issue_groups).toEqual([{ kind: "NO_SCHEDULE", count: 3, earliest_date: date }]);
  const invalid = await api(`/attendance/days?date=${date}&mark=UNKNOWN`);
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error.code).toBe("invalid_query");

  const restrictedBearer = bearerOf(exec);
  await go(exec, "/account");
  await expect.poll(restrictedBearer).not.toBe("");
  const refused = await apiOf(exec, restrictedBearer)(path);
  expect(refused.status()).toBe(403);
  const denial = await refused.json();
  expect(denial.error.code).toBe("forbidden");
  expect(denial).not.toHaveProperty("issue_groups");
  expect(denial).not.toHaveProperty("ledger");
});
