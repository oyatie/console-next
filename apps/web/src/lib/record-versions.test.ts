import { expect, test } from "vitest";
import { employeeRecord, pinned, versionToSend } from "./record-versions";

const echo = (to?: string) => async (at: string) => ({ at, updated_at: to });

test("regression (사번 변경 409 after the user's own contact delete): every writer goes at the version past this tab's own writes", async () => {
  const e = employeeRecord("e-own");
  await pinned(e, "v0", ["emergency_contacts"], echo("v1"), (o) => o.updated_at);
  // 사번 변경 and 소속 지점 pressed while the card still shows v0: both go at v1, not the version read.
  expect((await pinned(e, "v0", ["employee_number"], echo())).at).toBe("v1");
  expect((await pinned(e, "v0", ["home_branch"], echo("v2"), (o) => o.updated_at)).at).toBe("v1");
  // A delete or void (no fields) goes past every own write; the bulk grid's rows take the same version.
  expect((await pinned(e, "v0", [], echo())).at).toBe("v2");
  expect(versionToSend(e, "v0", ["name"])).toBe("v2");
});

test("an answer without a version ends the chain; a refusal records nothing; another record is untouched", async () => {
  const e = employeeRecord("e-chain");
  await pinned(e, "v0", ["employee_number"], echo());
  expect(versionToSend(e, "v0", ["photo"])).toBe("v0");
  await expect(pinned(e, "v0", ["photo"], async () => Promise.reject(new Error("409")), () => "v9")).rejects.toThrow("409");
  expect(versionToSend(e, "v0", ["photo"])).toBe("v0");
  await pinned(e, "v0", ["photo"], echo("v1"), (o) => o.updated_at);
  expect(versionToSend(e, "v0", ["photo"])).toBe("v0");
  expect(versionToSend(e, "v0", ["name"])).toBe("v1");
  expect(versionToSend(employeeRecord("other"), "v0", ["name"])).toBe("v0");
});
