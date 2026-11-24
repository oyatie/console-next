// SPDX-License-Identifier: LicenseRef-Proprietary
import { test as base, type Browser } from "@playwright/test";

type Transport = { protocol: "h2" | "http/1.1"; browser: Browser };

export async function withTransports(browser: Browser, input: string | undefined, use: (transports: Transport[]) => Promise<void>) {
  const h2: Transport = { protocol: "h2", browser };
  if (input === undefined || input === "h2") return use([h2]);
  if (input !== "both") throw new Error(`E2E_PERF_TRANSPORTS must be h2 or both, received ${JSON.stringify(input)}`);

  // Keep TLS, cookies and RP origin identical; change only ALPN negotiation.
  const http1 = await browser.browserType().launch(browser.browserType().name() === "chromium"
    ? { args: ["--disable-http2"] }
    : { firefoxUserPrefs: { "network.http.http2.enabled": false } });
  try {
    await use([{ protocol: "http/1.1", browser: http1 }, h2]);
  } finally {
    await http1.close();
  }
}

export const test = base.extend<{ transports: Transport[] }>({
  transports: async ({ browser }, use) => withTransports(browser, process.env.E2E_PERF_TRANSPORTS, use),
});
