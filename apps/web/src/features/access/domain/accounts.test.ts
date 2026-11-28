import { expect, test } from "vitest";
import { pickable } from "./accounts";

const a = (id: string, o: Partial<{ is_active: boolean; has_passkey: boolean; employee_id: string | null }> = {}) => ({ id, is_active: true, has_passkey: false, employee_id: null, ...o });

test("regression (people-self-47): one person with two accounts is one choice — the one with a passkey", () => {
  const list = [a("old", { employee_id: "e1" }), a("new", { employee_id: "e1", has_passkey: true }), a("other", { employee_id: "e2" })];
  expect(pickable(list, undefined).map((x) => x.id)).toEqual(["new", "other"]);
});

test("the ops account and inactive accounts are never offered", () => {
  expect(pickable([a("ops"), a("gone", { is_active: false }), a("hr")], "ops").map((x) => x.id)).toEqual(["hr"]);
});

test("every designated ops holder in a multi-holder set or flagged is_tenant_ops is excluded", () => {
  const list = [
    a("ops-1"),
    a("ops-2"),
    { ...a("ops-3"), is_tenant_ops: true },
    a("staff"),
  ];
  expect(pickable(list, new Set(["ops-1", "ops-2"])).map((x) => x.id)).toEqual(["staff"]);
});
