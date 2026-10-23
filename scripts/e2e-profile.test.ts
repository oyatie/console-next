// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import globalSetup from "../e2e/global-setup";
import { requireActionInbox } from "../e2e/require-action-inbox";
import { PORTS } from "../e2e/slot";

vi.mock("../e2e/clock", () => ({ resetLifecycleDate: vi.fn() }));
vi.mock("../e2e/terms-fixture", () => ({ publishTestTerms: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test.each([404, 503, 200])("inbox-dependent tests refuse an incompatible backend (HTTP %i)", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
  await expect(requireActionInbox()).rejects.toThrow(`action-inbox expected 401, got ${status}; build console-app with --features full,e2e-test-support and set CONSOLE_APP_BIN to that binary`);
});

test("inbox-dependent tests accept the full backend's authenticated workspace route", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  await expect(requireActionInbox()).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:${PORTS.backend}/api/v1/me/action-inbox`);
});

test("E2E setup allows MVP backends without probing workspace routes", async () => {
  vi.stubEnv("E2E_REUSE", "0");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  await expect(globalSetup()).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
