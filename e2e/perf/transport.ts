// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Browser } from "@playwright/test";

/** Keep TLS, cookies and RP origin identical; change only ALPN negotiation. */
export function launchHTTP1(browser: Browser) {
  return browser.browserType().launch(browser.browserType().name() === "chromium"
    ? { args: ["--disable-http2"] }
    : { firefoxUserPrefs: { "network.http.http2.enabled": false } });
}
