import { expect, test } from "vitest";
import { granted } from "../../reference/authz/api";
import { hasWork } from "./api";

type Caps = Parameters<typeof granted>[0];
// regression (people-self-26): the no-work page is for an account holding nothing this app offers. A legacy 구성원
// holds only `login`; a branch-scoped HR worker or someone who may only report an exit has work, and an unreadable
// projection leaves it to the server.
test("an account has work here when it holds any of this app's features, not a login or a request-only one", () => {
  const caps = (...c: { feature: string; permission: "allow" | "limited" | "request_only"; org_wide?: boolean }[]) => c.map((x) => ({ org_wide: false, ...x })) as unknown as Caps;
  expect(hasWork(granted(caps({ feature: "login", permission: "allow" })))).toBe(false);
  expect(hasWork(granted(caps({ feature: "exit_case_report", permission: "request_only" })))).toBe(false);
  expect(hasWork(granted(caps({ feature: "exit_case_report", permission: "limited" })))).toBe(true);
  expect(hasWork(granted(caps({ feature: "employee_directory_read", permission: "allow" })))).toBe(true);
  expect(hasWork(granted(undefined, true))).toBe(true);
});
