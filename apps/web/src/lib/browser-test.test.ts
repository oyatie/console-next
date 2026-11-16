// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, firefox } from "@playwright/test";
import { afterEach, expect, test, vi } from "vitest";
import { browserEngine } from "./browser-test";

afterEach(() => vi.unstubAllEnvs());

test.each([undefined, "0", "1"])("browser tests select the installed engine for E2E_XBROWSER=%s", value => {
  vi.stubEnv("E2E_XBROWSER", value);
  expect(browserEngine()).toBe(value === "1" ? firefox : chromium);
});
