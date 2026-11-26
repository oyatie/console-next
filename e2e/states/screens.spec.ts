// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, LONG_NAME } from "../mock/fixtures";
import { experienceState } from "../experience";
import { mockScreen } from "../mock/screen";
import { faultAttempts } from "./fault-clock";
import { screens, type State } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

type Screen = (typeof screens)[number];
type Look = "baseline" | "console";
// Home's work preview and the people list's total are drawn their own way in each style, and only Classic draws the
// org chart at phone width: those pins are tests of their own. Console's home pin is at desk width only (no phone
// board); its people readout counts the rows loaded, not the rows on screen d-people's readout shows, so it has none.
const pinned = (screen: Screen, state: State, width: number) => ["populated", "long", "large"].includes(state)
  && (screen.key === "home" || (screen.key === "people" && state === "large") || (screen.key === "org" && width === 390));

for (const screen of screens) for (const state of Object.keys(screen.states) as State[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, check(screen, state, width));
  if (pinned(screen, state, width)) test(`${screen.key}: ${state} at ${width}px @baseline @ui-state`, check(screen, state, width, "baseline"));
}
test.describe("console", () => {
  test.use({ storageState: experienceState("console") });
  for (const screen of screens) for (const state of Object.keys(screen.states) as State[]) {
    if (screen.key === "home" && pinned(screen, state, 1440)) test(`${screen.key}: ${state} at 1440px in console @ui-state`, check(screen, state, 1440, "console"));
  }
});

function check(screen: Screen, state: State, width: number, look?: Look) {
  return async ({ page }: { page: Page }, info: TestInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockScreen(page, screen, state);
    let observed = false;
    try {
      let attempts = 0;
      page.on("request", request => { if (new URL(request.url()).pathname === screen.read) attempts++; });
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === screen.read);
      await page.goto(screen.path);
      await requested;
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(main.locator("[data-read-layout]").last()).toBeVisible();
        await expect(main.getByText(t("home.noWork.title"), { exact: true })).toHaveCount(0);
        await expect(main.locator("#first-run, #first-run-title")).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText("불러오지 못했습니다", { exact: true }).first()).toBeVisible();
        await expect(main.getByRole("button", { name: "다시 불러오기", exact: true }).first()).toBeVisible();
        await expect(main.getByText(fixture.operationId, { exact: true }).first()).toBeVisible();
        expect(attempts).toBe(faultAttempts);
      } else if (state === "refused") {
        const refusal = main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" });
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText("김권한담당");
        await expect(refusal.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeVisible();
      } else if (state === "empty") {
        await expect(screen.key === "home" ? main.getByText(t("home.noWork.title"), { exact: true }) : main.locator(screen.key === "people" ? "#first-run" : "#first-run-title")).toBeVisible();
      } else {
        await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
        if (screen.key === "home" && look) {
          // Classic previews five rows of the work list; d-home draws Console's list with ten before its more button.
          const list = look === "console" ? main.getByRole("grid", { name: t("home.inbox.title"), exact: true }) : main.getByRole("region", { name: t("home.inbox.title"), exact: true });
          const rows = list.locator("[data-id]");
          await expect(rows).toHaveCount(Math.min(fixture.count, look === "console" ? 10 : 5));
          await expect(rows.first()).toContainText(state === "long" ? LONG_NAME : "검증직원 1");
          if (state === "large" && look === "baseline") {
            await main.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true }).click();
            await expect(rows).toHaveCount(100);
            await main.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
            await expect(rows).toHaveCount(200);
            await expect(rows.last()).toContainText("UI-0200");
          }
        } else if (screen.key === "people") {
          await expect(main.getByText("UI-0001", { exact: true })).toBeVisible();
          if (state === "long") await expect(main.getByText(LONG_NAME, { exact: true }).first()).toBeVisible();
          if (state === "large") {
            if (look) await expect(main.getByRole("note").filter({ hasText: "2,000" })).toBeVisible();
            const table = main.getByRole("grid");
            for (let loaded = 100; loaded < fixture.count; loaded += 100) {
              const nextPage = page.waitForResponse(response => {
                const url = new URL(response.url());
                return url.pathname === screen.read && url.searchParams.get("cursor") === id(100 + loaded - 1) && !url.searchParams.has("offset");
              });
              await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
              await nextPage;
              if (look) await expect(main.getByText(t("roster.foot.range", { shown: loaded + 100, total: fixture.count }), { exact: true })).toBeVisible();
            }
            await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
            await expect(table.getByText("UI-2000", { exact: true })).toBeVisible();
            expect(await table.getByRole("row").count()).toBeLessThan(100);
          }
        } else if (screen.key === "org") {
          // Console lists the units at phone width.
          if (width === 1440 || look) await expect(main.getByRole("tree", { name: t("structure.chart.treeLabel", { name: t("structure.root.word") }), exact: true })).toBeVisible();
          await expect(main.getByRole("treeitem").or(main.getByRole("row")).filter({ hasText: state === "long" ? LONG_NAME : "검증법인" }).first()).toBeVisible();
        }
      }
      if (screen.key === "org") await main.getByRole("group", { name: "보기", exact: true }).getByRole("button", { name: "조직도", exact: true }).click({ trial: true });
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "add every supporting API read to the typed fixture").toEqual([]);
      observed = true;
    } finally {
      try {
        if (["loading", "failed", "empty", "refused"].includes(state)) {
          const observation = await page.evaluate(raw => {
            const main = document.querySelector("main");
            const references = main?.querySelectorAll("[data-support-reference]");
            return {
              support_ref: references?.length === 1 ? references[0]!.getAttribute("data-support-reference") : null,
              reference_count: references?.length ?? 0,
              raw_server_text: main?.textContent?.includes(raw) ?? false,
              floorplan: main?.getAttribute("data-floorplan") ?? main?.querySelector("[data-floorplan]")?.getAttribute("data-floorplan") ?? null,
            };
          }, failure("service_unavailable").error.message);
          await info.attach("screen-state", { contentType: "application/json", body: Buffer.from(JSON.stringify({
            ...observation, route: screen.path, state, width, status: observed ? "pass" : "unknown",
          })) });
        }
      } finally {
        await page.close();
        fixture.release();
      }
    }
  };
}
