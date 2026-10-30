// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { checklist, failure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
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
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      await held;
      return phase === "failed" ? { status: 503 as const, json: failure("service_unavailable") }
        : { status: 200 as const, json: answer };
    });
    try {
      await page.goto("/people");
      const head = page.getByRole("main").locator("header").first();
      const slot = head.locator("[data-phase-band]");
      await expect(slot).toHaveAttribute("data-phase-band", "loading");
      await expect(slot.getByRole("status")).toHaveAttribute("aria-busy", "true");
      await expect(head.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await head.boundingBox();
      const slotBefore = await slot.boundingBox();
      await page.evaluate(clearShifts);
      release();
      await expect(slot).toHaveAttribute("data-phase-band", phase === "failed" ? "failed" : "ready");
      await expect(slot).toContainText(t(phase === "failed" ? "common.read.failedReason" : phase === "SETUP" ? "shell.phase.setup" : "entityRecord.phase.operating"));
      await expect(head.locator("[data-phase]")).toHaveCount(phase === "failed" ? 0 : 1);
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
