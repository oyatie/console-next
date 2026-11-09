// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf } from "./helpers/api";
import { kstDate, registerEmployee } from "./flows";
import { tenantInSetup } from "./setup-flows";

test("organization attendance close remains closed under a workplace filter", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "attclosescope", "근태범위주식회사", false, "본사", "none");
  await registerEmployee(admin, { name: "김마감", number: "CS-0001", unit: "본사", hired: kstDate(-60) });
  const api = apiOf(admin, bearerOf(admin));
  const peopleResponse = await api("/employees?limit=10");
  expect(peopleResponse.status()).toBe(200);
  const people = await peopleResponse.json();
  const branch = people.items.find((person: { employee_number: string }) => person.employee_number === "CS-0001").home_branch_id;
  expect(branch).toBeTruthy();
  const month = kstDate(-32).slice(0, 7);
  const closeResponse = await api("/attendance/closes", "POST", { month, attest: true });
  expect(closeResponse.status()).toBe(201);
  const receipt = await closeResponse.json();
  expect(receipt.branch_scope).toBe("org");
  for (const filter of ["", `&branch_id=${branch}`]) {
    const response = await api(`/attendance/closes?month=${month}${filter}`);
    expect(response.status()).toBe(200);
    const board = await response.json();
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ branch_scope: "org", closed: true, close: receipt });
  }
  const preflight = await api("/attendance/closes/preflight", "POST", { month, branch_scope: branch });
  expect(preflight.status()).toBe(200);
  expect((await preflight.json()).can_close).toBe(false);
  const duplicate = await api("/attendance/closes", "POST", { month, branch_scope: branch, attest: true });
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe("close_blocked");
});
