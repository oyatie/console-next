// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { test } from "../locale-fixture";
import { t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { EXPERIENCE_SOURCE_KEY } from "../../apps/web/src/experience/store";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { shot, withFullPage } from "../shots";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";
import { failure, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

const STATUS_ACTIVE_URL = "https://status.cosskorea.com/active.json";
const DEFAULT_EXPIRES_AT = "2099-01-01T00:00:00Z";

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    rev: 42,
    generated_at: "2026-11-20T09:00:00Z",
    evidence_at: "2026-11-20T09:00:00Z",
    evidence_expires_at: DEFAULT_EXPIRES_AT,
    components: {
      web: { name: { ko: "Web Console", en: "Web Console" }, status: "ok", vantage_count: 1 },
      api: { name: { ko: "API", en: "API" }, status: "ok", vantage_count: 1 },
    },
    incidents: [],
    ...overrides,
  };
}

async function seedExperience(page: import("@playwright/test").Page, experience: "console" | "baseline", theme: "light" | "dark") {
  await page.addInitScript(
    ({ expKey, srcKey, exp, mode }) => {
      localStorage.setItem(expKey, exp);
      localStorage.setItem(srcKey, "personal");
      localStorage.setItem("console.theme", mode);
    },
    { expKey: EXPERIENCE_KEY, srcKey: EXPERIENCE_SOURCE_KEY, exp: experience, mode: theme },
  );
}

async function armChunkLoadedBarrier(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__e2e_chunk_barrier__")) {
      sessionStorage.setItem("__e2e_chunk_barrier__", "1");
      sessionStorage.setItem("console.chunk-reload:__ready__", "1");
    }
  });
}

async function waitForChunkLoadedAndExhaustReload(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => sessionStorage.getItem("console.chunk-reload:__ready__") === null);
  await page.evaluate(() => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!;
    sessionStorage.setItem(`console.chunk-reload:${entry.src}`, "1");
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console outage banner renders max-1 non-dismissible alert and recovers on retry (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await mockScreen(page, screens[0], "populated");
      await seedExperience(page, "console", theme);
      let current = statusPayload({
        components: {
          web: { name: { ko: "Web Console", en: "Web Console" }, status: "partial", vantage_count: 1 },
          api: { name: { ko: "API", en: "API" }, status: "major", vantage_count: 1 },
        },
        incidents: [
          {
            id: "ST-101",
            title: { ko: "API gateway outage", en: "API gateway outage" },
            stage: "investigating",
            components: { api: "major", web: "partial" },
          },
          {
            id: "ST-102",
            title: { ko: "Secondary warning", en: "Secondary warning" },
            stage: "identified",
            components: { web: "partial" },
          },
        ],
      });
      await page.route(STATUS_ACTIVE_URL, route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }),
      );
      try {
        await page.goto("/");
        await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
        const notices = page.getByRole("region", { name: t("live.noticesLabel"), exact: true });
        await expect(notices).toBeVisible();
        const alerts = notices.getByRole("alert");
        await expect(alerts).toHaveCount(1);
        await expect(alerts).toContainText("API gateway outage");
        await expect(alerts).toContainText("API");
        await expect(alerts).toContainText("Web Console");

        // Non-dismissible: only retry button inside alert, plus status page link.
        await expect(alerts.getByRole("button")).toHaveCount(1);
        const retryBtn = alerts.getByRole("button", { name: t("live.retry"), exact: true });
        await expect(retryBtn).toBeVisible();
        const statusLink = alerts.getByRole("link", { name: t("live.statusPage"), exact: true });
        await expect(statusLink).toHaveAttribute("href", "https://status.cosskorea.com");
        await expect(statusLink).toHaveAttribute("target", "_blank");

        await page.evaluate(() => document.fonts.ready);
        await fits(page, `console outage ${width} ${theme}`);
        await expectAxe(page, `console outage ${width} ${theme}`);
        await withFullPage(page, () => shot(page, `outage-major-${width}-${theme}`));

        current = statusPayload();
        await retryBtn.click();
        await expect(alerts).toHaveCount(0);
        await expect(notices).toHaveCount(0);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`Console staleness bar appears on SSE drop and clears on reconnect (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await mockScreen(page, screens[0], "populated");
      await seedExperience(page, "console", theme);
      await page.addInitScript(() => {
        const origFetch = window.fetch;
        Object.assign(window, { __testSseDown: false });
        window.fetch = (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).pathname !== "/api/v1/events") return origFetch(input, init);
          if ((window as Window & { __testSseDown?: boolean }).__testSseDown) {
            return Promise.resolve(new Response(null, { status: 503 }));
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  let closed = false;
                  controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
                  const closeStream = () => {
                    if (closed) return;
                    closed = true;
                    controller.close();
                  };
                  window.addEventListener("__testDropSse", closeStream, { once: true });
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      window.removeEventListener("__testDropSse", closeStream);
                      closeStream();
                    },
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        };
      });
      try {
        await page.goto("/");
        await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
        const notices = page.getByRole("region", { name: t("live.noticesLabel"), exact: true });
        await expect(notices).toHaveCount(0);

        await page.evaluate(() => {
          (window as Window & { __testSseDown?: boolean }).__testSseDown = true;
          window.dispatchEvent(new Event("__testDropSse"));
        });

        const staleBar = notices.getByRole("status");
        await expect(staleBar).toBeVisible({ timeout: 8_000 });
        await expect(staleBar).toContainText(t("live.status.stale"));
        await expect(staleBar).toContainText(/\d{2}:\d{2} KST/);

        await page.evaluate(() => document.fonts.ready);
        await fits(page, `console staleness ${width} ${theme}`);
        await expectAxe(page, `console staleness ${width} ${theme}`);
        await withFullPage(page, () => shot(page, `staleness-${width}-${theme}`));

        await page.evaluate(() => {
          (window as Window & { __testSseDown?: boolean }).__testSseDown = false;
          window.dispatchEvent(new Event("online"));
        });
        await expect(staleBar).toHaveCount(0, { timeout: 10_000 });
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`Console crash screen shows status link and input-kept reassurance (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await mockScreen(page, screens[0], "populated");
      await seedExperience(page, "console", theme);
      await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
      await mockRoute(page, "post", "/api/v1/auth/otp/redeem", { status: 200, json: token() });
      const liveAsset = (url: URL) => /\/live-[^/]+\.js$/.test(url.pathname);
      await page.route(liveAsset, route => route.fulfill({ status: 404, body: "" }));
      try {
        await armChunkLoadedBarrier(page);
        await page.goto("/login");
        await waitForChunkLoadedAndExhaustReload(page);
        await page.locator("summary").click();
        await page.getByRole("textbox", { name: t("auth.login.code"), exact: true }).fill("ABCD-EFGH");
        await page.getByRole("button", { name: t("auth.login.submitCode"), exact: true }).click();

        const heading = page.getByRole("heading", { name: t("common.crashed.title"), exact: true });
        await expect(heading).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
        const statusLink = page.getByRole("link", { name: t("live.statusPage"), exact: true });
        await expect(statusLink).toBeVisible();
        await expect(statusLink).toHaveAttribute("href", "https://status.cosskorea.com");
        await expect(page.getByText(t("live.crashed.inputKept"), { exact: true })).toBeVisible();

        await page.evaluate(() => document.fonts.ready);
        await fits(page, `console crash ${width} ${theme}`);
        await expectAxe(page, `console crash ${width} ${theme}`);
        await withFullPage(page, () => shot(page, `crash-console-${width}-${theme}`));
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("partial outage without incident title uses partial warning banner", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await seedExperience(page, "console", "light");
  await page.route(STATUS_ACTIVE_URL, route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        statusPayload({
          components: {
            live: { name: { ko: "Realtime", en: "Realtime" }, status: "partial", vantage_count: 1 },
          },
          incidents: [],
        }),
      ),
    }),
  );
  try {
    await page.goto("/");
    const alerts = page.getByRole("region", { name: t("live.noticesLabel"), exact: true }).getByRole("alert");
    await expect(alerts).toHaveCount(1);
    await expect(alerts).toHaveAttribute("data-tone", "warn");
    await expect(alerts).toContainText(t("live.outage.partial.title"));
    await expect(alerts).toContainText("Realtime");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("unknown, expired, null evidence_expires_at, and network abort never claim an outage", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  const cases: { name: string; handle: (route: import("@playwright/test").Route) => Promise<void> }[] = [
    {
      name: "all-unknown",
      handle: route =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            statusPayload({
              components: { api: { name: { ko: "API", en: "API" }, status: "unknown", vantage_count: 0 } },
            }),
          ),
        }),
    },
    {
      name: "expired",
      handle: route =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            statusPayload({
              evidence_expires_at: "2020-01-01T00:00:00Z",
              components: { api: { name: { ko: "API", en: "API" }, status: "major", vantage_count: 1 } },
            }),
          ),
        }),
    },
    {
      name: "null-expiry",
      handle: route =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            statusPayload({
              evidence_expires_at: null,
              components: { api: { name: { ko: "API", en: "API" }, status: "major", vantage_count: 1 } },
            }),
          ),
        }),
    },
    {
      name: "network-abort",
      handle: route => route.abort("failed"),
    },
  ];
  for (const testCase of cases) {
    const fixture = await mockScreen(page, screens[0], "populated");
    await seedExperience(page, "console", "light");
    await page.route(STATUS_ACTIVE_URL, testCase.handle);
    try {
      await page.goto("/");
      await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
      await page.waitForTimeout(200);
      await expect(page.getByRole("region", { name: t("live.noticesLabel"), exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: t("live.statusPage"), exact: true })).toHaveCount(0);
      expect(fixture.unexpected, testCase.name).toEqual([]);
    } finally {
      fixture.release();
    }
  }
});

for (const width of [1440, 1024]) test(`baseline top bar keeps its controls in place while the stream reconnects at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await seedExperience(page, "baseline", "light");
  await page.addInitScript(recordShifts);
  await page.addInitScript(() => {
    const origFetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return origFetch(input, init);
      if (document.documentElement.dataset.streamDown) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        request.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  await page.goto("/");
  await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
  const needsMe = page.locator("#top-needs-me");
  const logout = page.getByRole("banner").getByRole("button", { name: t("shell.logout"), exact: true });
  await expect(needsMe.locator("[data-count]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const boxes = async () => [await needsMe.boundingBox(), await logout.boundingBox()];
  const before = await boxes();
  await page.evaluate(clearShifts);
  // The browser reports the network gone: the stream reconnects at once and its server refuses it.
  await page.evaluate(() => { document.documentElement.dataset.streamDown = "1"; window.dispatchEvent(new Event("offline")); });
  await expect(page.getByText(t("live.status.reconnecting"), { exact: true })).toBeVisible({ timeout: 8_000 });
  expect(await boxes()).toEqual(before);
  expect(await page.getByRole("banner").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expectStable(page, "stream reconnecting");
  expect(fixture.unexpected).toEqual([]);
});

test("baseline experience remains completely unaltered under outage, SSE drop, and crash", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await seedExperience(page, "baseline", "light");
  await page.route(STATUS_ACTIVE_URL, route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        statusPayload({
          components: { api: { name: { ko: "API", en: "API" }, status: "major", vantage_count: 1 } },
        }),
      ),
    }),
  );
  await page.addInitScript(() => {
    const origFetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/api/v1/events") {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return origFetch(input, init);
    };
  });
  try {
    await page.goto("/");
    await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
    await expect(page.getByText(t("live.status.reconnecting"), { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("region", { name: t("live.noticesLabel"), exact: true })).toHaveCount(0);
    await expect(page.getByText(t("live.status.stale"))).toHaveCount(0);
    await expect(page.getByRole("link", { name: t("live.statusPage"), exact: true })).toHaveCount(0);

    await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
    await mockRoute(page, "post", "/api/v1/auth/otp/redeem", { status: 200, json: token() });
    const liveAsset = (url: URL) => /\/live-[^/]+\.js$/.test(url.pathname);
    await page.route(liveAsset, route => route.fulfill({ status: 404, body: "" }));
    await armChunkLoadedBarrier(page);
    await page.goto("/login");
    await waitForChunkLoadedAndExhaustReload(page);
    await page.locator("summary").click();
    await page.getByRole("textbox", { name: t("auth.login.code"), exact: true }).fill("ABCD-EFGH");
    await page.getByRole("button", { name: t("auth.login.submitCode"), exact: true }).click();
    await expect(page.getByRole("heading", { name: t("common.crashed.title"), exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await expect(page.getByRole("link", { name: t("live.statusPage"), exact: true })).toHaveCount(0);
    await expect(page.getByText(t("live.crashed.inputKept"), { exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
