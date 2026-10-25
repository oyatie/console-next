// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ platform: false, patch: vi.fn(), get: vi.fn() }));
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { PATCH: state.patch, GET: state.get },
  session: { get claims() { return { platform: state.platform }; } },
}));
import { updateName } from "./api";
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
