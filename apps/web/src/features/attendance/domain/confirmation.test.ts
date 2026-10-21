import { expect, test } from "vitest";
import { confirmationKey } from "./confirmation";

test("confirmation cannot transfer to another cell, edit, or optimistic base", () => {
  const cell = { employee_id: "one", work_date: "2026-10-06", value: "5-23", base_entry_id: null };
  const key = confirmationKey(cell);
  for (const change of [{ employee_id: "two" }, { work_date: "2026-10-07" }, { value: "5-24" }, { base_entry_id: "new" }]) expect(confirmationKey({ ...cell, ...change })).not.toBe(key);
  expect(confirmationKey({ ...cell, base_entry_id: undefined })).toBe(key);
});
