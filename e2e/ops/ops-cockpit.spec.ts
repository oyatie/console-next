// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAxe, fits } from "../a11y";
import { withFullPage } from "../shots";
import { forgetResize } from "../stability";
import { buildFixtures, makeMe, mountOpsMock } from "./fixtures";

async function shotOps(page: Page, screen: string) {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  const html = page.locator("html");
  const prevTheme = await html.getAttribute("data-theme");
  const prevViewport = page.viewportSize();
  const capture = (width: number, mode: string) =>
    withFullPage(page, () =>
      page.screenshot({ path: `${dir}/${width}/${screen}-${mode}.png`, fullPage: true }),
    );
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const mode of ["light", "dark"] as const) {
      await html.evaluate((el, t) => {
        el.dataset.theme = t;
      }, mode);
      await capture(1440, mode);
      await atPhoneWidth(page, () => capture(390, mode));
    }
  } finally {
    await html.evaluate((el, t) => {
      if (t === null) delete el.dataset.theme;
      else el.dataset.theme = t;
    }, prevTheme);
    if (prevViewport) await page.setViewportSize(prevViewport);
  }
}

test.describe("Stage-0 Ops Cockpit", () => {
  test("Now renders paging verdict, top 3 worklist above fold at 1440, compact phone rows, and Evidence last at 390", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
    await expect(page.getByText("1 page · HighErrorRate×api · 2 budgets burning")).toBeVisible();
    await expect(page.getByText("Needs a human now")).toBeVisible();
    await expect(page.getByText("Exhausted")).toBeVisible();
    await expect(page.getByText("0.0x").first()).toBeVisible();
    await expect(page.getByText("$184.20 USD")).toBeVisible();
    await expect(page.getByRole("meter", { name: "Object Storage Free Tier" })).toBeVisible();

    const thirdRowBox = await page.getByText("Canary bake watch expires 22:00Z").boundingBox();
    expect(thirdRowBox).not.toBeNull();
    expect((thirdRowBox?.y ?? 999) + (thirdRowBox?.height ?? 0)).toBeLessThan(900);

    // StatusBar anchors flush to viewport bottom at 1440x900
    const statusBox = await page.locator("footer").boundingBox();
    expect(statusBox).not.toBeNull();
    expect(Math.round((statusBox?.y ?? 0) + (statusBox?.height ?? 0))).toBeGreaterThanOrEqual(898);

    // Zero Hangul and zero PII in storage/URL
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/\p{Script=Hangul}/u);
    const storageCheck = await page.evaluate(() => ({
      ls: JSON.stringify(localStorage),
      ss: JSON.stringify(sessionStorage),
      url: location.href,
    }));
    expect(storageCheck.ls).not.toContain("oncall@cosskorea.invalid");
    expect(storageCheck.ss).not.toContain("oncall@cosskorea.invalid");
    expect(storageCheck.url).not.toContain("oncall@cosskorea.invalid");

    await expectAxe(page, "ops-now-1440");

    // Mobile 390px: compact 2-line rows (<=68px), sticky PhoneBottomNav, Evidence placed last, zero horizontal scroll
    await atPhoneWidth(page, async () => {
      await expect(page.getByText("Live")).toBeVisible();
      const firstRowBox = await page.locator("tbody tr").first().boundingBox();
      expect(firstRowBox?.height ?? 999).toBeLessThanOrEqual(68);

      const phoneNavBox = await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox();
      expect(phoneNavBox).not.toBeNull();
      expect(Math.round((phoneNavBox?.y ?? 0) + (phoneNavBox?.height ?? 0))).toBeGreaterThanOrEqual(842);
      expect(Math.round((phoneNavBox?.y ?? 0) + (phoneNavBox?.height ?? 0))).toBeLessThanOrEqual(845);

      const costY = (await page.locator("#now-cost").boundingBox())?.y ?? 0;
      const evY = (await page.locator("#now-evidence").boundingBox())?.y ?? 0;
      expect(evY).toBeGreaterThan(costY);
      await fits(page, "ops-now-390");
    });

    // 320px containment
    await page.setViewportSize({ width: 320, height: 640 });
    await forgetResize(page);
    await fits(page, "ops-now-320");

    await page.setViewportSize({ width: 1440, height: 900 });
    await forgetResize(page);
    await shotOps(page, "now");
    expect(mock.unexpected).toEqual([]);
  });

  test("Quiet first-run renders All quiet verdict and explicit checked-source empty states", async ({ page }) => {
    const mock = await mountOpsMock(page, "quiet");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.getByText("All quiet · 0 pages · evidence fresh")).toBeVisible();
    await expect(page.getByText(/No items need human action/)).toBeVisible();
    await expectAxe(page, "ops-quiet");
    expect(mock.unexpected).toEqual([]);
  });

  test("Alerts supports URL-synced filters, encoded key detail in 11-item order, Silences single-active tab, and plain-text ExternalUrl", async ({ page }) => {
    const requestedUrls: string[] = [];
    const mock = await mountOpsMock(page, "paging", {
      onAlertsRequest: (u) => requestedUrls.push(u.search),
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/alerts");

    await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
    await shotOps(page, "alerts");

    await page.getByLabel("Severity").selectOption("Page");
    await expect(page).toHaveURL(/severity=Page/);
    expect(requestedUrls.some((s) => s.includes("severity=Page"))).toBe(true);

    // Open encoded key detail
    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page).toHaveURL(/\/alerts\/HighErrorRate%C3%97api/);

    // Verify 11-item §3.2 fixed order and Unknown: not instrumented on impact
    const detail = page.locator("aside");
    await expect(detail.getByRole("heading", { name: "Summary" })).toBeVisible();
    const headings = await detail.locator("h3").allInnerTexts();
    expect(headings).toEqual([
      "Summary",
      "Impact",
      "Value & since",
      "Probable cause",
      "First action",
      "Notices (1)",
      "Rule",
      "Members (2)",
      "Changes in preceding 2h",
      "Links",
      "Group key",
    ]);
    await expect(detail.getByText("Unknown: not instrumented")).toBeVisible();
    await expect(detail.locator('a[href^="https://"]')).toHaveCount(0);
    await expect(detail.getByRole("button", { name: /Copy:/ }).first()).toBeVisible();

    await expectAxe(page, "ops-alerts-1440");
    await shotOps(page, "alert-detail");

    // Silences read-only empty state + single-active tab + 320px containment
    await page.goto("/alerts/silences");
    await expect(page.getByText(/No active silences · Alertmanager checked at/)).toBeVisible();
    const alertsTabs = page.getByRole("navigation", { name: "Alerts" });
    await expect(alertsTabs.getByRole("link", { name: "Groups" })).not.toHaveAttribute("aria-current", "page");
    await expect(alertsTabs.getByRole("link", { name: "Silences" })).toHaveAttribute("aria-current", "page");
    await expectAxe(page, "ops-silences");
    await shotOps(page, "silences");
    await page.setViewportSize({ width: 320, height: 640 });
    await forgetResize(page);
    await fits(page, "ops-silences-320");

    // Phone 390px detail full view: single Back control (no duplicate Close)
    await atPhoneWidth(page, async () => {
      await page.goto(`/alerts/${encodeURIComponent("HighErrorRate×api")}`);
      await expect(page.getByRole("link", { name: "Back to alerts" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Close" })).toBeHidden();
      await fits(page, "ops-alert-detail-390");
    });
    expect(mock.unexpected).toEqual([]);
  });

  test("Special alert key HighLatency%25×api round-trips without double-decoding and marks row selected", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging", {
      extraAlertKeys: ["HighLatency%25×api"],
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/alerts");

    const row = page.locator("tbody tr", { hasText: "HighLatency%25" });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: "Open" }).click();

    await expect(page).toHaveURL(/\/alerts\/HighLatency%2525%C3%97api/);
    await expect.poll(() => mock.alertDetailPaths).toContain("/api/ops/v1/alerts/HighLatency%2525%C3%97api");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("aside").getByText("HighLatency%25 on api exceeded error budget threshold.")).toBeVisible();
    expect(mock.unexpected).toEqual([]);
  });

  test("Source-down shows ? badge, Alert delivery unverified banner, and Unknown never green", async ({ page }) => {
    const mock = await mountOpsMock(page, "source-down");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/alerts");

    await expect(page.getByTitle("Unknown: source down")).toBeVisible();
    await expect(page.getByText("Alert delivery unverified")).toBeVisible();
    await expect(page.getByText("Unknown: source down").first()).toBeVisible();
    expect(mock.unexpected).toEqual([]);
  });

  test("Storm-146 virtualises 146 groups within 2s budget and scrolls to StormAlert146 at 390x844", async ({ page }) => {
    const mock = await mountOpsMock(page, "storm-146");
    await page.setViewportSize({ width: 1440, height: 900 });
    const started = Date.now();
    await page.goto("/alerts");
    await expect(page.getByText("Showing 146 groups")).toBeVisible();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    const renderedRows = await page.locator("tbody tr:not([aria-hidden])").count();
    expect(renderedRows).toBeLessThan(60);

    await atPhoneWidth(page, async () => {
      await fits(page, "ops-storm-390");
      const scroller = page.locator('[data-virtual="true"]');
      for (let i = 0; i < 6; i += 1) {
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await page.waitForTimeout(40);
      }
      await expect(page.getByText("StormAlert146")).toBeVisible();
    });
    expect(mock.unexpected).toEqual([]);
  });

  test("Running, Jobs, and Sources render contract tables, single-active tabs, URL filters, and pass axe and fits", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/running");
    await expect(page.getByText("console-api")).toBeVisible();
    await page.getByLabel("Health").selectOption("Degraded");
    await expect(page).toHaveURL(/state=Degraded/);
    await expectAxe(page, "ops-running-1440");
    await shotOps(page, "running");

    await page.goto("/running/jobs");
    await expect(page.getByText("pgbackrest-incr")).toBeVisible();
    await expect(page.getByText("Not scheduled")).toBeVisible();
    const runningTabs = page.getByRole("navigation", { name: "Running" });
    await expect(runningTabs.getByRole("link", { name: "Components" })).not.toHaveAttribute("aria-current", "page");
    await expect(runningTabs.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
    await expectAxe(page, "ops-jobs");
    await shotOps(page, "jobs");

    await page.setViewportSize({ width: 320, height: 640 });
    await forgetResize(page);
    await fits(page, "ops-jobs-320");

    await page.setViewportSize({ width: 1440, height: 900 });
    await forgetResize(page);
    await page.goto("/sources");
    await expect(page.getByRole("cell", { name: "victoriametrics" }).first()).toBeVisible();
    await expectAxe(page, "ops-sources-1440");
    await shotOps(page, "sources");

    await atPhoneWidth(page, async () => {
      await fits(page, "ops-sources-390");
    });
    await page.goto("/running");
    await expect(page.getByText("console-api")).toBeVisible();
    await atPhoneWidth(page, async () => {
      await expect(page.getByText("Drift: Synced").first()).toBeVisible();
      await expect(page.getByText("Drift: OutOfSync")).toBeVisible();
      const rollupRowBox = await page.locator("tbody tr").first().boundingBox();
      expect(rollupRowBox?.height ?? 999).toBeLessThanOrEqual(68);
      await fits(page, "ops-running-390");
    });
    expect(mock.unexpected).toEqual([]);
  });

  test("SSE updates cache, Pause holds as n new · Show, resync refetches once, ignores malformed objects, and tracks Last-Event-ID on reconnect", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.addInitScript(() => {
      const w = window as unknown as { __unhandled?: string[] };
      w.__unhandled = [];
      window.addEventListener("unhandledrejection", (ev) => {
        w.__unhandled?.push(String(ev.reason));
      });
    });

    const fixtures = buildFixtures("paging");
    const liveHome = {
      ...fixtures.home,
      verdict: { text: "SSE live verdict · 0 pages", worst: "Healthy" as const },
    };
    const heldHome = {
      ...fixtures.home,
      verdict: { text: "SSE held verdict applied", worst: "Healthy" as const },
    };
    let homeFetchCount = 0;

    const mock = await mountOpsMock(page, "paging", {
      onHomeRequest: () => {
        homeFetchCount += 1;
      },
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByText("1 page · HighErrorRate×api · 2 budgets burning")).toBeVisible();
    expect(homeFetchCount).toBe(1);

    // Live delta updates verdict in place with zero extra fetch
    await page.evaluate((h) => {
      (window as unknown as { __pushSse: (e: string, i: number, d: unknown) => void }).__pushSse("home.changed", 2, {
        type: "home.changed",
        id: 2,
        evaluated_at: "2026-11-21T21:42:00Z",
        home: h,
      });
    }, liveHome);
    await expect(page.getByText("SSE live verdict · 0 pages")).toBeVisible();
    expect(homeFetchCount).toBe(1);

    // Malformed valid-JSON objects must not throw uncaught TypeError / unhandledrejection
    await page.evaluate(() => {
      const push = (window as unknown as { __pushSse: (e: string, i: number, d: unknown) => void }).__pushSse;
      push("alert.group.changed", 3, { bad: true });
      push("home.changed", 4, { bad: true });
    });

    // Pause holds incoming SSE delta and shows "1 new · Show"
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused").first()).toBeVisible();

    await page.evaluate((h) => {
      (window as unknown as { __pushSse: (e: string, i: number, d: unknown) => void }).__pushSse("home.changed", 5, {
        type: "home.changed",
        id: 5,
        evaluated_at: "2026-11-21T21:43:00Z",
        home: h,
      });
    }, heldHome);
    await expect(page.getByText("SSE live verdict · 0 pages")).toBeVisible();
    const showBtn = page.getByRole("button", { name: "1 new · Show" }).first();
    await expect(showBtn).toBeVisible();
    await showBtn.click();
    await expect(page.getByText("SSE held verdict applied")).toBeVisible();

    // resync event triggers one-shot refetch of active view
    await page.evaluate(() => {
      (window as unknown as { __pushSse: (e: string, i: number, d: unknown) => void }).__pushSse("resync", 6, {
        type: "resync",
        id: 6,
        evaluated_at: "2026-11-21T21:44:00Z",
      });
    });
    await expect.poll(() => homeFetchCount).toBe(2);

    // Disconnect marks values stale, and reconnect sends Last-Event-ID = "6"
    await page.evaluate(() => {
      const w = window as unknown as { __setSseStatus: (s: number) => void; __dropSse: () => void };
      w.__setSseStatus(503);
      w.__dropSse();
    });
    await expect(page.getByText("Reconnecting").first()).toBeVisible();
    await expect(page.locator("s").first()).toBeVisible();
    await expect(page.getByText(/Unknown: stale/).first()).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __setSseStatus: (s: number) => void }).__setSseStatus(200);
    });
    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.getByText("Live").first()).toBeVisible();
    await expect.poll(() => mock.getLastEventIds()).toContain("6");

    const unhandled = await page.evaluate(() => (window as unknown as { __unhandled?: string[] }).__unhandled ?? []);
    expect(pageErrors).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(mock.unexpected).toEqual([]);
  });

  test("Initial SSE 503 reports Reconnecting (never Live) and marks readings stale", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging", { sseStatus: 503 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.getByText("Reconnecting").first()).toBeVisible();
    await expect(page.locator("header").getByText("Live", { exact: true })).toHaveCount(0);
    await expect(page.locator("s").first()).toBeVisible();
    expect(mock.unexpected).toEqual([]);
  });

  test("Partial Cedar role without read.home skips SSE and renders Verified REST data without strike-throughs", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging", {
      meOverride: makeMe(["read.me", "read.alerts"]),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/alerts");

    await expect(page.getByText("HighErrorRate")).toBeVisible();
    expect(await page.locator("s").count()).toBe(0);
    await expect(page.getByText("Reconnecting")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    expect(await mock.getSseConnectCount()).toBe(0);
    expect(mock.unexpected).toEqual([]);
  });

  test("O0 fail-closed states render 401, 403, 503 with support_ref and Cedar filters nav", async ({ page }) => {
    // 401
    const mock401 = await mountOpsMock(page, "paging", { meStatus: 401 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Cloudflare Access session required")).toBeVisible();
    await expect(page.getByText("HTTP 401")).toBeVisible();
    await expect(page.getByText("Access token missing")).toBeVisible();
    await expect(page.getByText("ops-access-jwt-missing")).toBeVisible();
    await expect(page.getByText("sup-401")).toBeVisible();
    await expect(page.getByText("2026-11-21T21:40:00Z")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    expect(mock401.unexpected).toEqual([]);

    // 403
    const mock403 = await mountOpsMock(page, "paging", { meStatus: 403 });
    await page.goto("/");
    await expect(page.getByText("Not an operator")).toBeVisible();
    await expect(page.getByText("HTTP 403")).toBeVisible();
    await expect(page.getByText("Operator grant required")).toBeVisible();
    await expect(page.getByText("ops-not-operator")).toBeVisible();
    await expect(page.getByText("sup-403")).toBeVisible();
    await expect(page.getByText("2026-11-21T21:40:00Z")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    await shotOps(page, "o0-refusal");
    expect(mock403.unexpected).toEqual([]);

    // 503
    const mock503 = await mountOpsMock(page, "paging", { meStatus: 503 });
    await page.goto("/");
    await expect(page.getByText("Ops cockpit unreachable")).toBeVisible();
    await expect(page.getByText("HTTP 503")).toBeVisible();
    await expect(page.getByText("Gateway timeout")).toBeVisible();
    await expect(page.getByText("ops-timeout")).toBeVisible();
    await expect(page.getByText("sup-503")).toBeVisible();
    await expect(page.getByText("2026-11-21T21:40:00Z")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    expect(mock503.unexpected).toEqual([]);

    // Cedar partial permissions: home only
    const mockHomeOnly = await mountOpsMock(page, "paging", {
      meOverride: makeMe(["read.me", "read.home"]),
    });
    await page.goto("/");
    const primaryNav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(primaryNav.getByRole("link", { name: "Now" })).toBeVisible();
    await expect(primaryNav.getByRole("link", { name: "Alerts" })).toHaveCount(0);
    await expect(primaryNav.getByRole("link", { name: "Running" })).toHaveCount(0);
    await expect(primaryNav.getByRole("link", { name: "Sources" })).toHaveCount(0);
    await page.goto("/alerts");
    await expect(page.getByText("Permission missing")).toBeVisible();
    await expect(page.getByText("Action permission required")).toBeVisible();
    await expect(page.getByText("ops-action-denied")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    expect(mockHomeOnly.unexpected).toEqual([]);
  });
});
