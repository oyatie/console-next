// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import globalSetup from "../e2e/global-setup";

vi.mock("../e2e/clock", () => ({ resetLifecycleDate: vi.fn() }));
vi.mock("../e2e/terms-fixture", () => ({ publishTestTerms: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test.each([404, 503, 200])("E2E setup refuses an incompatible backend (HTTP %i)", async (status) => {
  vi.stubEnv("E2E_REUSE", "0");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
  await expect(globalSetup()).rejects.toThrow(`action-inbox expected 401, got ${status}`);
});

test("E2E setup accepts the full backend's authenticated workspace route", async () => {
  vi.stubEnv("E2E_REUSE", "0");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(globalSetup()).resolves.toBeUndefined();
});
