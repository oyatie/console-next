// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { authz, checklist, failure, screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { attendanceReads } from "../mock/attendance";
import { attendanceScreens } from "./attendance";
import { accessScreens, mockAccessScreen } from "./access";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const phase of ["SETUP", "OPERATING", "failed"] as const) {
  test(`first visit: late checklist ${phase} keeps its page-head slot at ${width} @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "populated");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const answer: components["schemas"]["SetupChecklist"] = { ...checklist, phase: phase === "SETUP" ? "SETUP" : "OPERATING", steps: phase === "SETUP" ? [{
          key: "entity", group: "company", state: "todo", count: 0, can_act: true, skippable: false,
          action: "create_legal_entity", remedy: "create_legal_entity", paths: ["one"], needs: "",
          counts: { entities: 0, workplaces: 0, units: 0, people: 0, unplaced: 0, entity_unknown: 0 },
        }] : [] };
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/people", answer.phase) });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      await held;
      return phase === "failed" ? { status: 503 as const, json: failure("service_unavailable") }
        : { status: 200 as const, json: answer };
    });
    try {
      await page.goto("/people");
      const head = page.getByRole("main").locator("header").first();
      const slot = head.locator("[data-phase-band]");
      await expect(slot).toHaveAttribute("data-phase-band", "ready");
      await expect(slot).toContainText(t(phase === "SETUP" ? "shell.phase.setup" : "entityRecord.phase.operating"));
      await expect(head.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await head.boundingBox();
      const slotBefore = await slot.boundingBox();
      await page.evaluate(clearShifts);
      release();
      await expect(slot).toHaveAttribute("data-phase-band", phase === "failed" ? "failed" : "ready");
      await expect(slot).toContainText(t(phase === "failed" ? "common.read.failedReason" : phase === "SETUP" ? "shell.phase.setup" : "entityRecord.phase.operating"));
      await expect(head.locator("[data-phase]")).toHaveCount(1);
      if (phase === "SETUP") await expect(slot).toContainText(t("setup.step.entity"));
      expect(await slot.boundingBox()).toEqual(slotBefore);
      expect(await head.boundingBox()).toEqual(before);
      await expectStable(page, `late phase ${phase}/${width}`);
      await fits(page, `late phase ${phase}/${width}`);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await expectAxe(page, `late phase ${phase}/${width}/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}

for (const permission of ["none", "request_only"] as const) for (const phase of ["SETUP", "OPERATING"] as const) {
  test(`Home: employee with ${permission} sees the accessible ${phase} phase without a checklist error @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[0], "populated");
    let reads = 0;
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/", phase) });
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
      capabilities: permission === "none" ? [] : authz.capabilities.map(c => ({ ...c, permission: "request_only" as const })),
    } });
    await page.route("**/api/v1/onboarding/checklist", route => { reads++; return route.fulfill({ status: 403, json: failure("forbidden") }); });
    try {
      await page.goto("/");
      const slot = page.getByRole("main").locator("[data-phase-band]");
      await expect(slot).toHaveCount(1);
      await expect(slot).toContainText(t(phase === "SETUP" ? "shell.phase.setup" : "setup.phase.operating"));
      await expect(slot).toHaveAttribute("data-phase-band", "ready");
      await expect(slot).not.toContainText(t("common.read.failedReason"));
      await expect(slot.getByRole("button")).toHaveCount(0);
      await expect(slot.locator("[aria-busy=true]")).toHaveCount(0);
      expect(reads).toBe(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const status of [403, 503] as const) {
  test(`checklist ${status}: phase remains visible; only a fault names its subject and offers retry @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "populated");
    let failing = true, attempts = 0;
    await page.route("**/api/v1/onboarding/checklist", route => {
      attempts++;
      return route.fulfill(failing ? { status, json: failure(status === 403 ? "forbidden" : "service_unavailable") } : { json: checklist });
    });
    try {
      await page.goto("/people");
      const slot = page.getByRole("main").locator("[data-phase-band]");
      await expect(slot).toHaveAttribute("data-phase-band", status === 403 ? "ready" : "failed");
      await expect(slot.locator('[data-phase="operating"]')).toContainText(t("setup.phase.operating"));
      await expect(slot.getByRole("alert")).toHaveCount(0);
      await expect(slot.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(status === 503 ? 1 : 0);
      if (status === 403) await expect(slot).not.toContainText(t("common.read.failedReason"));
      else {
        await expect(slot).toContainText(t("setup.phase.checklistFailed"));
        await expect(slot).toContainText(t("common.read.failedReason"));
        const before = attempts, url = page.url();
        failing = false;
        await slot.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(slot).toHaveAttribute("data-phase-band", "ready");
        expect(attempts).toBe(before + 1);
        expect(page.url()).toBe(url);
      }
      await fits(page, `phase-checklist/${status}`);
      await expectAxe(page, `phase-checklist/${status}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const path of ["/access/roles", "/attendance"] as const) {
  test(`${path}: the page-specific phase note remains visible beside the shared phase @ui-state`, async ({ page }) => {
    const fixture = path.startsWith("/access") ? await mockAccessScreen(page, accessScreens[1], "populated")
      : { ...await mockScreen(page, screens[2], "populated"), ...await attendanceReads(page, attendanceScreens[0], "populated") };
    try {
      await page.goto(path.startsWith("/access") ? path : attendanceScreens[0].path);
      const key = path.startsWith("/access") ? "access.phase.operating" : "attendance.phase.operating";
      await expect(page.getByRole("main").getByText(t(key), { exact: true })).toBeVisible();
      await expect(page.getByRole("main").locator("[data-phase-band]")).toContainText(t("setup.phase.operating"));
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
