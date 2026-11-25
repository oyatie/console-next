// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Browser } from "@playwright/test";
import { expect, test, vi } from "vitest";
import { withTransports } from "./transport";

function browsers() {
  const close = vi.fn();
  const http1 = { close };
  const launch = vi.fn().mockResolvedValue(http1);
  const browser = { browserType: () => ({ name: () => "chromium", launch }) } as unknown as Browser;
  return { browser, http1, launch, close };
}

test.each([undefined, "h2"])("the HTTP/2 run reuses the project browser (%s)", async input => {
  const { browser, launch } = browsers();
  const measure = vi.fn();
  await withTransports(browser, input, measure);
  expect(measure).toHaveBeenCalledExactlyOnceWith([{ protocol: "h2", browser }]);
  expect(launch).not.toHaveBeenCalled();
});

test("a paired run closes its HTTP/1.1 browser even if measurement fails", async () => {
  const { browser, http1, launch, close } = browsers();
  await expect(withTransports(browser, "both", async transports => {
    expect(transports).toEqual([{ protocol: "http/1.1", browser: http1 }, { protocol: "h2", browser }]);
    throw new Error("measurement failed");
  })).rejects.toThrow("measurement failed");
  expect(launch).toHaveBeenCalledExactlyOnceWith({ args: ["--disable-http2"] });
  expect(close).toHaveBeenCalledOnce();
});

test("an unsupported selection fails before launching or measuring", async () => {
  const { browser, launch } = browsers();
  const measure = vi.fn();
  await expect(withTransports(browser, "http/1.1", measure)).rejects.toThrow("E2E_PERF_TRANSPORTS");
  expect(launch).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
});
