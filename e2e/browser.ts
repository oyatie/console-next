// SPDX-License-Identifier: LicenseRef-Proprietary
/** Select one engine per run; the legacy Firefox switch remains compatible with existing callers. */
export function e2eBrowser() {
  const browser = process.env.E2E_BROWSER ?? (process.env.E2E_XBROWSER === "1" ? "firefox" : "chromium");
  if (browser !== "chromium" && browser !== "firefox" && browser !== "webkit")
    throw new Error("E2E_BROWSER must be chromium, firefox or webkit");
  return browser;
}
