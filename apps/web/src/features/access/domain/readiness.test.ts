import { expect, test } from "vitest";
import { blocking, readiness } from "./readiness";

const acct = (id: string, name: string, o: { active?: boolean; has_passkey?: boolean } = {}) => ({ id, name, active: o.active ?? true, has_passkey: o.has_passkey ?? true });
const ops = acct("o", "박운영");
const kim = acct("k", "김인사");
const han = acct("h", "한서연", { has_passkey: false });
const gone = acct("g", "퇴사자", { active: false });
const g = (account_id: string, enforcement: string, manages_access = false) => ({ account_id, enforcement, manages_access });

test("an HR account with no live grant, or without a passkey, is flagged first, once per person; ops never needs a grant", () => {
  const checks = readiness([ops, kim, han, gone], [g("k", "PREPARED"), g("h", "REVOKED")], "o");
  expect(checks.map((c) => c.code)).toEqual(["no_grant", "ops_full", "only_ops_manages"]);
  expect(checks[0]).toMatchObject({ account: { name: "한서연" }, alsoNoPasskey: true });
  expect(blocking(checks)).toBe(1);
  const granted = readiness([ops, kim, han], [g("k", "PREPARED"), g("h", "PREPARED")], "o");
  expect(granted.map((c) => c.code)).toEqual(["no_passkey", "ops_full", "only_ops_manages"]);
});

test("a grant whose role was retired counts as nothing, and says why", () => {
  expect(readiness([ops, kim], [g("k", "ROLE_INACTIVE")], "o").map((c) => c.code)).toEqual(["role_inactive", "ops_full", "only_ops_manages"]);
});

test("a second person who manages access clears the note; only ops gives the no-accounts note", () => {
  expect(readiness([ops, kim, gone], [g("k", "ENFORCED", true)], "o").map((c) => c.code)).toEqual(["ops_full"]);
  expect(readiness([ops], [], "o").map((c) => c.code)).toEqual(["ops_full", "no_accounts"]);
  expect(blocking(readiness([ops], [], "o"))).toBe(0);
});

test("readiness checks one signing-in account per person, retaining distinct namesakes", () => {
  const old = { ...acct("old", "Namesake", { has_passkey: false }), employee_id: "person-1" };
  const current = { ...acct("current", "Namesake"), employee_id: "person-1" };
  const other = { ...acct("other", "Namesake"), employee_id: "person-2" };
  const checks = readiness([ops, old, current, other, other], [], ops.id);
  expect(checks.filter((c) => "account" in c).map((c) => "account" in c && c.account.id)).toEqual(["current", "other"]);
  expect(blocking(checks)).toBe(2);
  expect(blocking(readiness([ops, old, current], [g("current", "PREPARED")], ops.id))).toBe(0);
});
