// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const registered = vi.hoisted(() => ({ browserName: "chromium", run: undefined as undefined | ((fixtures: object) => Promise<void>) }));
vi.mock("@playwright/test", () => ({ test: Object.assign(
  (_name: string, _options: object, run: typeof registered.run) => { registered.run = run; },
  { use: vi.fn(), skip: vi.fn(), setTimeout: vi.fn(), info: () => ({ project: { use: { browserName: registered.browserName } } }) },
) }));
vi.mock("../e2e/parity/e3", () => ({ captureE3: vi.fn(), captureE3Run: vi.fn() }));
vi.mock("../e2e/parity/e5", () => ({ captureE5: vi.fn() }));
vi.mock("../e2e/parity/e6", () => ({ captureE6: vi.fn() }));
vi.mock("../e2e/parity/e8", () => ({ captureE8: vi.fn() }));
vi.mock("../e2e/parity/world-b", () => ({ world: vi.fn(async () => ({})) }));
vi.mock("../e2e/setup-flows", () => ({ startOperations: vi.fn() }));

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

test.each(["chromium", "firefox", "webkit"])("%s parity captures cannot overwrite another engine's frames", async browserName => {
  registered.browserName = browserName;
  const out = mkdtempSync(path.join(tmpdir(), "parity-"));
  vi.stubEnv("PARITY_OUT", out);
  try {
    const { shot } = await import("../e2e/parity/shot");
    const screenshot = vi.fn();
    const page = {
      locator: () => ({ getAttribute: async () => null }),
      evaluate: vi.fn(), waitForTimeout: vi.fn(), screenshot,
      context: () => ({ browser: () => ({ browserType: () => ({ name: () => browserName }) }) }),
    };
    await shot(page as never, "grid");
    expect(screenshot).toHaveBeenCalledWith({ path: path.join(out, `grid${browserName === "chromium" ? "" : `--${browserName}`}.png`), fullPage: undefined });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test.each(["chromium", "firefox", "webkit"])("%s employee captures choose their reference set explicitly", async browserName => {
  await import("../e2e/parity/employee-b.capture.spec");
  await registered.run!({ browser: {}, browserName });
  const { captureE3, captureE3Run } = await import("../e2e/parity/e3");
  const { captureE5 } = await import("../e2e/parity/e5");
  const { captureE8 } = await import("../e2e/parity/e8");
  const { captureE6 } = await import("../e2e/parity/e6");
  for (const capture of [captureE3, captureE3Run, captureE5, captureE8]) {
    expect(capture).toHaveBeenCalledTimes(browserName === "chromium" ? 1 : 0);
  }
  expect(captureE6).toHaveBeenCalledWith({}, browserName !== "chromium");
});
