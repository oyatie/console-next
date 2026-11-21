// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ platform: false, patch: vi.fn(), get: vi.fn() }));
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { PATCH: state.patch, GET: state.get },
  session: { get claims() { return { platform: state.platform }; } },
}));
import { updateName, updatePhone } from "./api";
import { payslipMonthSource } from "./domain/profile";
import { LANDED } from "../../lib/react/landed";
afterEach(() => { state.platform = false; vi.clearAllMocks(); });
test.each([false, true])("name edits use the correct realm (platform=%s)", async (platform) => {
  state.platform = platform;
  const path = platform ? "/api/platform/users/me" : "/api/v1/users/me";
  state.patch.mockResolvedValue({ data: { display_name: "박관리자" }, response: new Response() });
  await updateName("박관리자");
  expect(state.patch).toHaveBeenCalledWith(path, { body: { display_name: "박관리자" } });
});
test("a lost name-edit response is checked without sending the write again", async () => {
  state.patch.mockRejectedValue(new TypeError("connection lost"));
  state.get.mockResolvedValue({ data: { display_name: "박관리자" }, response: new Response() });
  expect(await updateName("박관리자")).toBe(LANDED);
  expect(state.patch).toHaveBeenCalledTimes(1);
  expect(state.get).toHaveBeenCalledWith("/api/v1/users/me", undefined);
});

test("phone edit patches /api/v1/users/me and verifies lost response against /api/v1/users/me", async () => {
  state.patch.mockResolvedValue({ data: { phone: "010-1234-4821" }, response: new Response() });
  await updatePhone("010-1234-4821");
  expect(state.patch).toHaveBeenCalledWith("/api/v1/users/me", { body: { phone: "010-1234-4821" } });

  state.patch.mockRejectedValue(new TypeError("connection lost"));
  state.get.mockResolvedValue({ data: { phone: "010-1234-4821" }, response: new Response() });
  expect(await updatePhone("01012344821")).toBe(LANDED);
  expect(state.get).toHaveBeenCalledWith("/api/v1/users/me", undefined);
});

test("updatePhone resolves LANDED on E.164 normalization and distinct masked numbers, but refuses unchanged masks", async () => {
  state.patch.mockRejectedValue(new TypeError("connection lost"));
  state.get.mockResolvedValue({ data: { phone: "+821098765432" }, response: new Response() });
  expect(await updatePhone("010-9876-5432")).toBe(LANDED);

  state.get.mockResolvedValue({ data: { phone: "010-••••-5432" }, response: new Response() });
  expect(await updatePhone("010-9876-5432", "010-••••-4821")).toBe(LANDED);

  state.get.mockResolvedValue({ data: { phone: "010-••••-4821" }, response: new Response() });
  await expect(updatePhone("010-9876-4821", "010-••••-4821")).rejects.toThrow("connection lost");

  state.get.mockResolvedValue({ data: { phone: null }, response: new Response() });
  expect(await updatePhone(null, "010-••••-4821")).toBe(LANDED);
});

test("payslipMonthSource extracts attribution month from payslip_meta or title", () => {
  expect(payslipMonthSource({ title: "x", payslip_meta: { attribution_month: "2026-10" } })).toBe("2026-10");
  expect(payslipMonthSource({ title: "Payslip 2026-09-01 ~ 2026-09-30" })).toBe("2026-09");
  expect(payslipMonthSource({ title: "Unknown" })).toBeNull();
});
