// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { chooseRadio } from "../flows";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { screens } from "../states/registry";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { SAEON_EXITED_ID, SAEON_HERO_ID, saeonPersonRecords, saeonUniverse } from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function assertZeroOverflowAt320(page: Page) {
  await page.setViewportSize({ width: 320, height: 844 });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /people renders ListRecord (P2) with Saeon roster at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, { theme });
      try {
        await page.goto(width === 1440 ? `/people?sel=${SAEON_HERO_ID}` : "/people");
        const pattern = page.locator('[data-pattern="list-record"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1, name: t("roster.head.title"), exact: true })).toBeVisible();

        await expect(page.getByRole("button", { name: new RegExp(t("people.stat.activeViewing")) })).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("roster.status.ON_LEAVE")) })).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("people.stat.preHire")) })).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("people.stat.exited")) })).toBeVisible();
        await expect(page.getByRole("button", { name: new RegExp(t("people.stat.missing")) })).toBeVisible();

        const rows = pattern.locator('[role="row"][data-row-id]');
        await expect(rows.first()).toBeVisible();
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThanOrEqual(8);

        if (width === 1440) {
          const heroRow = pattern.locator(`[role="row"][data-row-id="${SAEON_HERO_ID}"]`);
          await expect(heroRow).toBeVisible();
          await expect(heroRow).toHaveAttribute("data-active-row", "true");
          await heroRow.locator("label", { has: page.getByRole("checkbox") }).click();

          const sidePane = page.locator('aside[data-pane="record"]');
          await expect(sidePane).toBeVisible();
          await expect(sidePane).toContainText(saeonUniverse.hero.name);
          await expect(sidePane).toContainText(saeonUniverse.hero.employeeNumber);
          await expect(sidePane).toContainText(saeonUniverse.hero.rrnMasked);
          await expect(sidePane.getByRole("tab", { name: new RegExp(`^${t("people.panel.tab.docs")}`) })).toContainText("2");

          const footBar = pattern.locator("footer").first();
          await expect(footBar).toBeVisible();
          const footBox = await footBar.boundingBox();
          expect(footBox).not.toBeNull();
          expect(footBox!.y + footBox!.height).toBeLessThanOrEqual(876);

          const gridBox = await pattern.locator('[role="grid"]').boundingBox();
          const sideBox = await sidePane.boundingBox();
          expect(gridBox).not.toBeNull();
          expect(sideBox).not.toBeNull();
          expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(sideBox!.x + 1);
          const lastHeaderBox = await pattern.locator('[role="columnheader"]').last().boundingBox();
          expect(lastHeaderBox).not.toBeNull();
          expect(lastHeaderBox!.x + lastHeaderBox!.width).toBeLessThanOrEqual(sideBox!.x + 1);
        } else {
          const statButtons = await pattern.locator('[aria-label] button[aria-pressed]').all();
          const statBoxes = (await Promise.all(statButtons.map(b => b.boundingBox()))).filter((b): b is NonNullable<typeof b> => b !== null);
          for (let i = 0; i < statBoxes.length; i++) {
            for (let j = i + 1; j < statBoxes.length; j++) {
              const a = statBoxes[i]!;
              const b = statBoxes[j]!;
              const overlaps = a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1;
              expect(overlaps).toBe(false);
            }
          }
          const lastIndexBox = await pattern.locator(`[role="region"][aria-label="${t("people.index.label")}"] button[aria-pressed]`).last().boundingBox();
          expect(lastIndexBox).not.toBeNull();
          expect(lastIndexBox!.x + lastIndexBox!.width).toBeLessThanOrEqual(width);

          let aboveFoldCount = 0;
          for (let i = 0; i < Math.min(10, rowCount); i++) {
            const cell = rows.nth(i).locator('[role="rowheader"], [role="gridcell"]').last();
            const box = await cell.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(48);
            expect(box!.height).toBeLessThanOrEqual(72);
            if (box!.y + box!.height <= 900) aboveFoldCount += 1;
          }
          // Below the name index, whose keys are 44px phone targets in two rows of seven.
          expect(aboveFoldCount).toBeGreaterThanOrEqual(5);
        }

        await fits(page, `Console /people ${width} ${theme}`);
        await expectAxe(page, `Console /people ${width} ${theme}`);
        await shot(page, `people--${width}-${theme}`);

        if (width === 390) {
          await assertZeroOverflowAt320(page);
        }

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`Console /people/$id renders RecordPattern (P3) at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, { theme });
      try {
        await page.goto(`/people/${SAEON_HERO_ID}`);
        const pattern = page.locator('[data-pattern="record"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1, name: saeonUniverse.hero.name })).toBeVisible();
        await expect(pattern).toContainText(saeonUniverse.hero.employeeNumber);
        await expect(pattern).toContainText(saeonUniverse.hero.rrnMasked);
        await expect(pattern).toContainText(fmtDate(saeonUniverse.heroDetails.scheduledEvent.effectiveDate, { style: "iso" }));

        await fits(page, `Console /people/$id ${width} ${theme}`);
        await expectAxe(page, `Console /people/$id ${width} ${theme}`);
        await withFullPage(page, () => shot(page, `people-detail--${width}-${theme}`));

        if (width === 1440) {
          const corMark = pattern.locator('button[data-k="cor"]').first();
          await expect(corMark).toBeVisible();
          expect(await corMark.evaluate(el => getComputedStyle(el).borderTopStyle)).toBe("solid");
          await corMark.hover();
          expect(await corMark.evaluate(el => getComputedStyle(el).borderTopStyle)).toBe("solid");
          await expect(pattern.locator("#s4")).toContainText(
            `${t("exit.next", { step: t("exit.step.HR_CONFIRMED") })} · ${t("exit.next.current")}`,
          );
          await expect(pattern.locator("#s4")).not.toContainText(t("exit.next.mine"));
        }

        if (width === 390) {
          const sec5Buttons = await pattern.locator("#s5 button").all();
          for (const btn of sec5Buttons) {
            const box = await btn.boundingBox();
            if (box) expect(box.height).toBeLessThanOrEqual(48);
          }
          await assertZeroOverflowAt320(page);
          const sec5Rects320 = await pattern.locator("#s5 button").evaluateAll(buttons =>
            buttons.map(btn => {
              const rect = btn.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(btn);
              return {
                text: btn.textContent?.trim() ?? "",
                height: rect.height,
                lineRects: range.getClientRects().length,
              };
            }),
          );
          expect(sec5Rects320.length).toBeGreaterThan(0);
          for (const info of sec5Rects320) {
            expect(info.height, `320px button "${info.text}" height`).toBeLessThanOrEqual(48);
            expect(info.lineRects, `320px button "${info.text}" lineRects`).toBe(1);
          }
          const sec5Cells320 = await pattern.locator("#s5").evaluate(sec => ({
            scrollWidth: sec.scrollWidth,
            clientWidth: sec.clientWidth,
            cells: Array.from(sec.querySelectorAll("td")).map(td => ({
              text: td.textContent?.trim() ?? "",
              scrollWidth: td.scrollWidth,
              clientWidth: td.clientWidth,
            })),
          }));
          expect(sec5Cells320.scrollWidth).toBeLessThanOrEqual(sec5Cells320.clientWidth);
          expect(sec5Cells320.cells.length).toBeGreaterThan(0);
          for (const cell of sec5Cells320.cells) {
            expect(cell.scrollWidth, `320px #s5 td "${cell.text}"`).toBeLessThanOrEqual(cell.clientWidth);
          }
        }

        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /people interactive filters (StatRow, FilterRail, IndexBar), side-pane tabs, EXITED retention, and openInTab work cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonPeople(page);
  try {
    await page.goto("/people");
    const pattern = page.locator('[data-pattern="list-record"]');
    const rows = pattern.locator('[role="row"][data-row-id]');
    await expect(rows.first()).toBeVisible();

    // Click hero row to open Console side record pane
    await pattern.locator(`[role="row"][data-row-id="${SAEON_HERO_ID}"]`).click();
    const sidePane = page.locator('aside[data-pane="record"]');
    await expect(sidePane).toBeVisible();
    await expect(sidePane).toContainText(saeonUniverse.hero.name);

    // Switch side-pane sub-tabs
    await sidePane.getByRole("tab", { name: t("people.panel.tab.history"), exact: true }).click();
    await expect(sidePane).toContainText(t("people.panel.sec.allHistory"));
    await sidePane.getByRole("tab", { name: new RegExp(`^${t("people.panel.tab.docs")}`) }).click();
    await expect(sidePane).toContainText(t("people.panel.certsCount", { count: 2 }));
    await sidePane.getByRole("tab", { name: t("people.panel.tab.basic"), exact: true }).click();

    // FilterRail: check CONTRACT employment type across full roster, then reset with Clear button
    const summaryPrefix = t("people.foot.viewSummary", { count: 12345 }).split("12,345")[0] ?? "";
    const viewSummary = pattern.locator("strong").filter({ hasText: summaryPrefix }).first();
    const parseViewCount = async () => Number((await viewSummary.innerText()).replace(/[^\d]/g, ""));
    const regularFooter = pattern.getByText(t("people.foot.typeCount", { label: t("enum.employmentType.REGULAR"), count: 0 }), { exact: true });
    const beforeContract = await parseViewCount();
    expect(beforeContract).toBeGreaterThan(0);
    await page.getByRole("checkbox", { name: t("enum.employmentType.CONTRACT"), exact: true }).check();
    await expect(regularFooter).toBeVisible();
    const contractCount = await parseViewCount();
    expect(contractCount).toBeGreaterThan(0);
    expect(contractCount).toBeLessThan(saeonUniverse.counts.active);
    await page.getByRole("button", { name: t("people.rail.clear"), exact: true }).click();
    await expect(regularFooter).toHaveCount(0);
    await expect.poll(() => parseViewCount()).toBeGreaterThanOrEqual(beforeContract);

    // IndexBar: chosung buttons across full roster filter cleanly and keep aria-pressed state
    const indexButtons = page.locator(`[role="region"][aria-label="${t("people.index.label")}"] button[aria-pressed]`);
    for (const { idx, initialIndices } of [
      { idx: 0, initialIndices: [0, 1] },
      { idx: 6, initialIndices: [9, 10] },
      { idx: 7, initialIndices: [11] },
      { idx: 13, initialIndices: [18] },
    ]) {
      const btn = indexButtons.nth(idx);
      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
      await expect(rows.first()).toBeVisible();
      const firstText = await rows.first().innerText();
      const matchesInitial = firstText.split("\n").some(line => {
        const cp = line.trim().charCodeAt(0);
        return cp >= 0xac00 && cp <= 0xd7a3 && initialIndices.includes(Math.floor((cp - 0xac00) / 588));
      });
      expect(matchesInitial).toBe(true);
    }
    const indexLast = indexButtons.nth(13);
    await indexLast.click();
    await expect(indexLast).toHaveAttribute("aria-pressed", "false");

    // Search q stays strictly in memory (never in URL, localStorage, or sessionStorage)
    const searchInput = page.getByPlaceholder(t("people.find.placeholder"));
    await searchInput.fill(saeonUniverse.hero.name);
    await expect(rows).toHaveCount(1);
    expect(page.url()).not.toContain(encodeURIComponent(saeonUniverse.hero.name));
    expect(page.url()).not.toContain(saeonUniverse.hero.name);
    const storageDump = await page.evaluate(() => JSON.stringify({ ls: localStorage, ss: sessionStorage }));
    expect(storageDump).not.toContain(saeonUniverse.hero.name);
    expect(storageDump).not.toContain(saeonUniverse.hero.rrn);
    await searchInput.fill("");
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(8);

    // StatRow Exited tile switches to EXITED retention view and shows ExitPeek in side pane
    await page.getByRole("button", { name: new RegExp(t("people.stat.exited")) }).click();
    const exitedRow = pattern.locator(`[role="row"][data-row-id="${SAEON_EXITED_ID}"]`);
    await expect(exitedRow).toBeVisible();
    await expect(exitedRow).toContainText("2029-11-01");
    await exitedRow.click();
    await expect(sidePane).toContainText("2029-11-01");

    // Return to active, open hero, and use open-in-tab link to reach /people/$id (P3)
    await page.getByRole("button", { name: new RegExp(t("people.stat.exited")) }).click();
    await pattern.locator(`[role="row"][data-row-id="${SAEON_HERO_ID}"]`).click();
    await sidePane.getByRole("button", { name: t("uiFlexibleColumns.openInTab"), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/people/${SAEON_HERO_ID}`));
    await expect(page.locator('[data-pattern="record"]')).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Step-up RRN reveal succeeds with passkey, keeps PII out of URL/storage, and handles 401/403 refusals cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // 1) Authorized passkey step-up reveal
  const okFixture = await setupConsoleSaeonPeople(page, { passkeyStepUpMode: "ok" });
  try {
    await page.goto(`/people/${SAEON_HERO_ID}`);
    await page.getByRole("button", { name: t("empCard.reveal.open", { field: t("empCard.f.rrn") }), exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await chooseRadio(dialog, new RegExp(saeonUniverse.reasonCodes.rrn_reveal[0]!.labelKo));
    await dialog.getByRole("button", { name: t("empCard.reveal.primary"), exact: true }).click();
    await expect(page.locator("code", { hasText: saeonUniverse.hero.rrn })).toBeVisible();
    expect(page.url()).not.toContain(saeonUniverse.hero.rrn);
    const storage = await page.evaluate(() => JSON.stringify({ ls: localStorage, ss: sessionStorage }));
    expect(storage).not.toContain(saeonUniverse.hero.rrn);
    expect(consoleErrors.join("\n")).not.toContain(saeonUniverse.hero.rrn);
    expect(okFixture.unexpected).toEqual([]);
  } finally {
    okFixture.release();
  }

  // 2) 401 step_up_required and 403 forbidden refusal feedback
  for (const mode of ["step_up_required", "refused"] as const) {
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const refusedFixture = await setupConsoleSaeonPeople(page, { passkeyStepUpMode: mode });
    try {
      await page.goto(`/people/${SAEON_HERO_ID}`);
      await page.getByRole("button", { name: t("empCard.reveal.open", { field: t("empCard.f.rrn") }), exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await chooseRadio(dialog, new RegExp(saeonUniverse.reasonCodes.rrn_reveal[0]!.labelKo));
      await dialog.getByRole("button", { name: t("empCard.reveal.primary"), exact: true }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page.locator("code", { hasText: saeonUniverse.hero.rrn })).toHaveCount(0);
      expect(refusedFixture.unexpected).toEqual([]);
    } finally {
      refusedFixture.release();
    }
  }
});

test("Capability-gated peek queries do not fire 403s for read-only users and EXITED card shows retention band", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonPeople(page, { canManage: false });
  const forbiddenUrls: string[] = [];
  const directoryCalls: string[] = [];
  page.on("response", res => {
    if (res.status() === 403) forbiddenUrls.push(res.url());
  });
  page.on("request", req => {
    if (req.url().includes("/api/v1/directory/people")) directoryCalls.push(req.url());
  });
  try {
    await page.goto("/people");
    const listPattern = page.locator('[data-pattern="list-record"]');
    await expect(listPattern).toBeVisible();
    await listPattern.locator(`[role="row"][data-row-id="${SAEON_HERO_ID}"]`).click();
    const sidePane = page.locator('aside[data-pane="record"]');
    await expect(sidePane).toBeVisible();
    await expect(sidePane).toContainText(saeonUniverse.hero.name);
    await expect(sidePane).toContainText(t("people.panel.summary.monthAtt", { month: 11 }));

    await page.goto(`/people/${SAEON_EXITED_ID}`);
    const pattern = page.locator('[data-pattern="record"]');
    await expect(pattern).toBeVisible();
    await expect(pattern).toContainText(saeonUniverse.statusSamples.exited.retentionInstrument);
    await expect(pattern).toContainText(fmtDate(saeonUniverse.statusSamples.exited.keptUntil, { style: "iso" }));
    expect(forbiddenUrls).toEqual([]);
    expect(directoryCalls).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Baseline experience preserves legacy /people and /people/$id DOM unaltered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await setupConsoleSaeonPeople(page, { experience: "baseline" });
  try {
    await page.goto("/people");
    await expect(page.getByRole("navigation", { name: t("roster.head.title"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(t("people.stat.activeViewing")) })).toHaveCount(0);
    await fits(page, "Baseline /people 1440");

    await page.goto(`/people/${SAEON_HERO_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: saeonUniverse.hero.name })).toBeVisible();
    expect(await page.locator('button[data-k="cor"]').first().evaluate(el => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    await fits(page, "Baseline /people/$id 1440");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#s5 [data-card]")).toHaveCount(0);
    await fits(page, "Baseline /people/$id 390");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

for (const state of ["loading", "empty", "failed", "refused"] as const) {
  test(`Console /people state sweep (${state}) stays accessible`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.experience", "console"));
    const fixture = await mockScreen(page, screens[1], state);
    if (state === "empty") {
      await mockRoute(page, "get", "/api/v1/employees/facets", {
        status: 200,
        json: {
          total: 0,
          status: [],
          employment_type: [],
          legal_entity: [],
          workplace: [],
          review: {
            identity_review_required: 0,
            register_review_required: 0,
            home_branch_review_required: 0,
            lifecycle_apply_failed: 0,
            contract_ended: 0,
            contract_ending_before: 0,
          },
        },
      });
    }
    try {
      await page.goto("/people");
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator("[aria-busy='true'], [data-skeleton]").first()).toBeVisible();
      } else if (state === "empty") {
        await expect(main.getByText(t("roster.first.title"), { exact: true })).toBeVisible();
        await expectAxe(page, "Console /people empty");
      } else if (state === "refused") {
        await expect(main.getByRole("heading", { level: 2, name: t("common.denied.title.plain"), exact: true })).toBeVisible();
        await expectAxe(page, "Console /people refused");
      } else {
        await expect(main.getByRole("alert")).toBeVisible();
        await expectAxe(page, "Console /people failed");
      }
      await fits(page, `Console /people ${state}`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Console /people/$id #s5 multi-date spans wrap cleanly inside 320x844 mobile cards (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const fixture = await setupConsoleSaeonPeople(page, { theme });
    const baseRecords = saeonPersonRecords(SAEON_HERO_ID);
    await mockRoute(page, "get", "/api/v1/employees/{id}/records", {
      status: 200,
      json: {
        ...baseRecords,
        items: [
          ...baseRecords.items,
          {
            id: "00000000-0000-4000-8800-000000000091",
            section: "EDUCATION",
            version: 1,
            voided: false,
            source: "MANUAL",
            created_at: "2026-01-01T00:00:00Z",
            revised_at: "2026-01-01T00:00:00Z",
            fields: {
              school: "Saeon Tech University",
              level: "BACHELOR",
              major: "Mechanical",
              entered_on: "2011-03-01",
              ended_on: "2015-02-25",
              status: "GRADUATED",
            },
          },
          {
            id: "00000000-0000-4000-8800-000000000092",
            section: "TRAINING",
            version: 1,
            voided: false,
            source: "MANUAL",
            created_at: "2026-01-01T00:00:00Z",
            revised_at: "2026-01-01T00:00:00Z",
            fields: {
              course: "Safety Training",
              provider: "Safety Institute",
              started_on: "2024-06-03",
              ended_on: "2024-06-07",
              status: "COMPLETED",
            },
          },
        ],
      },
    });
    try {
      await page.goto(`/people/${SAEON_HERO_ID}`);
      const sec5 = page.locator('[data-pattern="record"] #s5');
      await expect(sec5).toBeVisible();
      await expect(sec5).toContainText("2017-01-02 ~ 2019-02-28");
      await expect(sec5).toContainText("2011-03-01 ~ 2015-02-25");
      await expect(sec5).toContainText("2024-06-03 ~ 2024-06-07");

      await assertZeroOverflowAt320(page);
      const metrics = await sec5.evaluate(sec => ({
        scrollWidth: sec.scrollWidth,
        clientWidth: sec.clientWidth,
        cells: Array.from(sec.querySelectorAll("td")).map(td => ({
          text: td.textContent?.trim() ?? "",
          scrollWidth: td.scrollWidth,
          clientWidth: td.clientWidth,
        })),
        buttons: Array.from(sec.querySelectorAll("button")).map(btn => {
          const rect = btn.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(btn);
          return {
            text: btn.textContent?.trim() ?? "",
            height: rect.height,
            lineRects: range.getClientRects().length,
          };
        }),
      }));

      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.cells.length).toBeGreaterThan(0);
      for (const cell of metrics.cells) {
        expect(cell.scrollWidth, `320px #s5 td "${cell.text}"`).toBeLessThanOrEqual(cell.clientWidth);
      }
      expect(metrics.buttons.length).toBeGreaterThan(0);
      for (const btn of metrics.buttons) {
        expect(btn.height, `320px #s5 button "${btn.text}" height`).toBeLessThanOrEqual(48);
        expect(btn.lineRects, `320px #s5 button "${btn.text}" lineRects`).toBe(1);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}
