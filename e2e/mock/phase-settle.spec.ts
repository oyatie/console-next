// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { authz, checklist, failure, id, inbox, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { entityRecordPath, mockEntityRecord } from "../states/entity-record";
import { contractWindowSettings } from "./directory";
import { accountScreens } from "../states/account";
import { accountReads } from "./account";
import { attendanceBoardScreens } from "../states/attendance";
import { screens } from "../states/registry";
import { expectStable, recordShifts } from "../stability";
import { orgPanelReads } from "./org-work";
import { advanceUntil } from "./clock";

test.beforeAll(() => loadCatalog("ko"));

async function freezeClock(page: Page) {
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
}

for (const width of [1440, 390]) test(`a deep-linked workplace Sheet keeps focus and Escape after the phase hold at ${width}px @ui-state`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const panel = await orgPanelReads(page);
  await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", { status: 200, json: {
    list: { key: "brn_classification", status: "NOT_LOADED" }, items: [],
  } });
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  await freezeClock(page);
  try {
    await page.goto(`/org?sel=${id(3)}&act=wp-create`);
    await advanceUntil(page, page.locator("[data-sheet-layer]").waitFor({ state: "attached" }));
    const pending = page.locator("[data-phase-pending]");
    await expect(pending).toHaveAttribute("inert", "");
    await expect(pending).toBeHidden();
    held.resolve();
    await page.clock.resume();
    await expect(pending).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: t("workplace.add"), exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await fits(page, `workplace Sheet/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/act=wp-create/);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); panel.release(); fixture.release(); }
});

for (const path of ["/people", entityRecordPath]) for (const width of [1440, 390]) {
  for (const outcome of ["receipt", "expired", "checklist-503"] as const) {
    test(`${path}: ${outcome} first paints with its settled head at ${width}px @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(recordShifts);
      const fixture = path === entityRecordPath ? await mockEntityRecord(page, "populated") : await mockScreen(page, screens[1], "populated");
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
      const access = Promise.withResolvers<void>();
      const phase = Promise.withResolvers<void>();
      const accessAsked = Promise.withResolvers<void>();
      const phaseAsked = Promise.withResolvers<void>();
      await mockRoute(page, "get", "/api/v1/access/me", async () => {
        accessAsked.resolve();
        await access.promise;
        return { status: 200, json: screenAccess(path) };
      });
      await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [...contractWindowSettings(60).items, {
        key: "onboarding.receipt_days", value: 2, default: 2, kind: { type: "int", unit: "days" },
        looser_when: "neutral", governance: "tenant", legal_basis: null, version: "code_default",
        effective_from: null, scheduled: [], source: { layer: "code_default", scope_entity_id: null }, chain: [],
      }] } });
      await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
        phaseAsked.resolve();
        await phase.promise;
        return outcome === "checklist-503" ? { status: 503, json: failure("service_unavailable") }
          : { status: 200, json: { ...checklist, go_live_at: new Date(Date.now() - (outcome === "expired" ? 3 * 86400000 : 0)).toISOString() } };
      });
      await freezeClock(page);
      try {
        const dataRead = path === entityRecordPath ? page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/legal-entities/${entityRecordPath.split("/").at(-1)}`) : undefined;
        await page.goto(path);
        await advanceUntil(page, accessAsked.promise);
        access.resolve();
        await advanceUntil(page, phaseAsked.promise);
        if (dataRead) await (await dataRead).finished();
        await page.clock.runFor(50);
        const main = page.getByRole("main");
        const heldPage = main.locator("[data-phase-pending]");
        await expect(heldPage).toHaveCount(1);
        await expect(heldPage).toBeHidden();
        await expect(heldPage).toHaveAttribute("inert", "");
        const heading = main.getByRole("heading", { level: 1 });
        await page.evaluate(() => document.fonts.ready);
        await expect(heading).toHaveCount(0);
        await expect(main.locator("[data-phase-band]")).toHaveCount(0);
        phase.resolve();
        await page.clock.resume();
        await expect(heading).toBeVisible();
        const slot = main.locator("header [data-phase-band]");
        await expect(slot).toHaveCount(outcome === "receipt" ? 1 : 0);
        await expect(main.getByRole("alert")).toHaveCount(0);
        const head = heading.locator("xpath=ancestor::header");
        const before = await head.boundingBox();
        await expectStable(page, `settled ${path}/${outcome}/${width}`);
        expect(await head.boundingBox()).toEqual(before);
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
          await fits(page, `settled ${path}/${width}/${theme}`);
          await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        access.resolve(); phase.resolve();
        await page.close(); fixture.release();
      }
    });
  }
}

test("a cold record paints within 1.5 seconds of its data while settings takes 3 seconds @ui-state", async ({ page }, info) => {
  const fixture = await mockEntityRecord(page, "populated");
  await page.addInitScript(name => {
    const observer = new MutationObserver(() => {
      const heading = document.querySelector("main h1");
      if (heading?.textContent === name && heading.getBoundingClientRect().height > 0) {
        requestAnimationFrame(() => performance.mark("record-heading"));
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }, fixture.entity.current!.name!);
  let settingsAnswered = false;
  await page.route(url => url.pathname === "/api/v1/settings", async route => {
    await new Promise(resolve => setTimeout(resolve, 3_000));
    settingsAnswered = true;
    await route.fallback();
  });
  try {
    const settingsRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/settings");
    const entityRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/legal-entities/${fixture.entity.id}`);
    await page.goto(entityRecordPath);
    await (await entityRead).finished();
    await expect(page.getByRole("main").getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible({ timeout: 1_500 });
    const timing = await page.evaluate(() => {
      const heading = performance.getEntriesByName("record-heading")[0]!.startTime;
      const read = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === location.pathname.replace("/org/entities/", "/api/v1/legal-entities/")) as PerformanceResourceTiming;
      return { navigationToHeading: heading, dataToHeading: heading - read.responseEnd };
    });
    expect(timing.dataToHeading).toBeGreaterThanOrEqual(0);
    expect(timing.dataToHeading).toBeLessThan(1_500);
    expect(settingsAnswered).toBe(false);
    await info.attach("heading-time", { body: JSON.stringify(timing), contentType: "application/json" });
    await settingsRead;
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const screen of [attendanceBoardScreens[0], accountScreens[0]]) {
  for (const read of ["/api/v1/access/me", "/api/v1/me/authz", "/api/v1/onboarding/checklist"]) {
    for (const width of [1440, 390]) test(`${screen.path}: held ${read} reveals the whole page at ${width}px @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(recordShifts);
      const fixture = await mockScreen(page, screen, "populated");
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
      if (screen.path === "/account") await accountReads(page, "save-unchanged");
      const held = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      await page.route(url => url.pathname === read, async route => {
        requested.resolve();
        await held.promise;
        await route.fallback();
      });
      await freezeClock(page);
      try {
        await page.goto(screen.path);
        await advanceUntil(page, requested.promise);
        const main = page.getByRole("main");
        if (!(screen.path.startsWith("/attendance") && read === "/api/v1/access/me")) {
          await expect(main.locator("[data-phase-pending]")).toHaveAttribute("inert", "");
          await expect(main.locator("[data-phase-pending]")).toBeHidden();
        }
        await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
        await expect(main.getByRole("button")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        held.resolve();
        await page.clock.resume();
        await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
        await expectStable(page, `${screen.path}/${read}/${width} from navigation`);
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
          await fits(page, `${screen.path}/${width}/${theme}`);
          await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
        }
        expect(fixture.unexpected).toEqual([]);
      } finally { held.resolve(); await page.close(); fixture.release(); }
    });
  }
}

for (const phase of ["SETUP", "OPERATING"] as const) test(`entity-record: ${phase} access owns the first paint with a late checklist @ui-state`, async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  fixture.entity.registrations[0]!.current = {
    version: 1, effective_from: "2026-01-01", before_first_record: false,
    trade_name: fixture.entity.current!.name!, business_types: [], tax_type: "01", status: "CONTINUING", change_mode: "SETUP",
  };
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess(entityRecordPath, phase) });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    requested.resolve();
    await held.promise;
    return { status: 200, json: { ...checklist, phase } };
  });
  try {
    await page.goto(entityRecordPath);
    await requested.promise;
    const main = page.getByRole("main");
    const heading = main.getByRole("heading", { level: 1 });
    const edit = main.getByRole("button", { name: "과세유형 수정", exact: true });
    if (phase === "OPERATING") {
      await expect(heading).toHaveCount(0);
      await expect(edit).toHaveCount(0);
      held.resolve();
    }
    await expect(heading).toBeVisible();
    await expect(main.locator("section.card").getByText(t(phase === "SETUP" ? "entityRecord.phase.setup" : "entityRecord.phase.operating"), { exact: true })).toBeVisible();
    await expect(edit).toBeVisible();
    const before = await main.getByRole("button").allTextContents();
    held.resolve();
    await expect(main.getByRole("button")).toHaveText(before);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

for (const read of ["/api/v1/access/me", "/api/v1/me/authz", "/api/v1/onboarding/checklist"]) {
  test(`/account: a never-answering ${read} releases the page after two seconds @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, accountScreens[0], "populated");
    await accountReads(page, "save-unchanged");
    if (read === "/api/v1/onboarding/checklist") await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/people") });
    const held = Promise.withResolvers<void>();
    await page.route(url => url.pathname === read, async route => {
      await held.promise;
      await route.fallback();
    });
    await freezeClock(page);
    try {
      await page.goto("/account");
      await advanceUntil(page, page.locator("[data-phase-pending]").waitFor({ state: "attached" }));
      const main = page.getByRole("main");
      await expect(main.locator("[data-phase-pending]")).toHaveAttribute("inert", "");
      await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toHaveAttribute("aria-busy", "true");
      const heading = main.getByRole("heading", { level: 1 });
      await expect(heading).toHaveCount(0);
      if (read === "/api/v1/onboarding/checklist") {
        await page.clock.runFor(1_000);
        await page.locator('nav a[href="/people"]').click();
        await advanceUntil(page, page.waitForURL("**/people"));
        await page.clock.runFor(1_000);
      } else await page.clock.runFor(2_000);
      await expect(heading).toBeVisible();
      await expect(main.locator("[data-phase-band]")).toHaveCount(0);
      if (read === "/api/v1/onboarding/checklist") {
        await page.locator('a[href="/account"]').first().click();
        await advanceUntil(page, main.getByRole("heading", { level: 1, name: t("account.title"), exact: true }).waitFor({ state: "visible" }));
        await expect(main.locator("[data-phase-pending]")).toHaveCount(0);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });
}

for (const capabilities of ["none", "request_only", "read"] as const) {
  test(`/account: ${capabilities} checklist access settles before the frozen deadline @ui-state`, async ({ page }, info) => {
    const fixture = await mockScreen(page, accountScreens[0], "populated");
    await accountReads(page, "save-unchanged");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
      capabilities: capabilities === "none" ? [] : capabilities === "request_only"
        ? authz.capabilities.map(capability => ({ ...capability, permission: "request_only" as const })) : authz.capabilities,
    } });
    let checklistReads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/onboarding/checklist") checklistReads++; });
    await freezeClock(page);
    try {
      const started = Date.now();
      await page.goto("/account");
      const main = page.getByRole("main");
      const frozen = await page.evaluate(() => Date.now());
      await expect.poll(async () => {
        await page.clock.fastForward(1); // Drain nested query notifications without reaching the hold deadline.
        return main.getByRole("heading", { level: 1 }).isVisible();
      }).toBe(true);
      expect(await page.evaluate(() => Date.now()) - frozen).toBeLessThan(100);
      await info.attach("heading-time", { body: JSON.stringify({ milliseconds: Date.now() - started }), contentType: "application/json" });
      await expect(main.locator("[data-phase-pending]")).toHaveCount(0);
      await expect(main.locator("[data-phase-band]")).toHaveCount(0);
      if (capabilities === "read") expect(checklistReads).toBeGreaterThan(0);
      else expect(checklistReads).toBe(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("a held page keeps its head laid out at the revealed width @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  await freezeClock(page);
  try {
    await page.goto("/people");
    const pending = page.locator("[data-phase-pending]");
    const head = pending.locator("header").first();
    await expect.poll(async () => {
      await page.clock.fastForward(1);
      return head.count();
    }).toBe(1);
    expect(await pending.evaluate(el => ({ visibility: getComputedStyle(el).visibility, position: getComputedStyle(el).position })))
      .toEqual({ visibility: "hidden", position: "absolute" });
    const width = await head.evaluate(el => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(0);
    held.resolve();
    const heading = page.getByRole("main").getByRole("heading", { level: 1 });
    await expect.poll(async () => {
      await page.clock.fastForward(1);
      return heading.isVisible();
    }).toBe(true);
    expect(await heading.locator("xpath=ancestor::header").evaluate(el => el.getBoundingClientRect().width)).toBe(width);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});
