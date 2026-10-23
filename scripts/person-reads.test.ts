// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { rawReads } from "./check-person-reads.mjs";
import { baselineGrowth, ratchet } from "./quality/ratchet.mjs";

test("legacy facts in aliases, joins, raw literals and unqualified queries are inventoried", () => {
  for (const sql of [
    'sqlx::query("SELECT e.name,e.birth_date FROM employees e WHERE e.name ILIKE $1")',
    'query!(r#"SELECT u.display_name,u.phone FROM public.users AS u JOIN employees e ON e.id=u.employee_id"#)',
    'QueryBuilder::new("SELECT display_name FROM users WHERE phone=$1")',
    'query("SELECT u.* FROM users u")',
  ]) expect(rawReads(sql)).toHaveLength(1);
  expect(rawReads('"SELECT e.name FROM employees e"')[0]).toContain("employees.name:");
});
test("query-builder and concatenated SQL fragments retain their table context", () => {
  expect(rawReads('new QueryBuilder("SELECT e.name").push(" FROM employees e").push(" WHERE e.birth_date=$1")')).toHaveLength(2);
  expect(rawReads('"SELECT e.name FROM person_employees_current e"; "SELECT e.id FROM employees e"')).toEqual([]);
});
test("account contact phones are separate from the inventoried human facts", () => {
  expect(rawReads('"SELECT u.phone FROM users u"')).toEqual([]);
  expect(rawReads('"SELECT u.display_name,u.phone FROM users u"')[0]).toMatch(/^users.display_name:/);
});
test("canonical views, unrelated columns, writes and prose are not legacy fact readers", () => {
  for (const source of ['"SELECT e.name FROM person_employees_current e"', '"SELECT u.phone FROM person_accounts_current u"', '"SELECT e.id FROM employees e"', '"UPDATE users SET display_name=$1 WHERE id=$2"', '"employees name"']) expect(rawReads(source)).toEqual([]);
});
test("the baseline refuses both new readers and stale entries, and cannot grow", () => {
  expect(ratchet({ new: 1 }, {})).toEqual([expect.stringContaining("new debt")]);
  expect(ratchet({}, { old: 1 })).toEqual([expect.stringContaining("stale baseline")]);
  expect(baselineGrowth({ old: 2 }, { old: 1 })).toEqual([expect.stringContaining("only shrink")]);
  expect(baselineGrowth({ old: 1 }, { old: 2 })).toEqual([]);
});
test("the actual repository reader inventory passes its shrink-only gate", () => {
  expect(execFileSync("node", ["scripts/check-person-reads.mjs"], { encoding: "utf8" })).toContain("no new or stale entries");
});
