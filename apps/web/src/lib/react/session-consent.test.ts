// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ consentStatus: vi.fn(), session: { token: "app-token", stage: "app", lost: false, claims: { platform: false } } }));
vi.mock("@console/api", () => ({ ...mocks, refresh: vi.fn(), logout: vi.fn() }));
import { ensureSession, ensureEnrolling } from "./session";
beforeEach(() => { mocks.consentStatus.mockReset(); });
test("unaccepted app session deep links go to consent", async () => {
  mocks.consentStatus.mockResolvedValue({ accepted: false });
  await expect(ensureSession({ location: { pathname: "/people/new" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
});
test("consent status faults cannot open a personal-data route", async () => {
  const fault = new Error("offline");
  mocks.consentStatus.mockRejectedValue(fault);
  await expect(ensureSession({ location: { pathname: "/people/new" } })).rejects.toBe(fault);
});
test("accepted app session can open personal-data route and leaves setup", async () => {
  mocks.consentStatus.mockResolvedValue({ accepted: true });
  await ensureSession({ location: { pathname: "/people/new" } });
  await expect(ensureEnrolling()).rejects.toMatchObject({ options: { to: "/" } });
});
