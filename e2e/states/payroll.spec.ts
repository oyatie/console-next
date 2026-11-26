// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { experienceState } from "../experience";
import { mockScreen } from "../mock/screen";
import { id } from "../mock/fixtures";
import { mockPayroll, payGroups, rate } from "../mock/payroll";
import { payrollScreens, type PayrollState } from "./payroll";

test.beforeAll(() => loadCatalog("ko"));
type PayGroup = (typeof payGroups.items)[number];
const entityOf = (group: PayGroup) => payGroups.legal_entities.find(entity => entity.id === group.legal_entity_id)!.name!;
const runsOf = (page: Page, group: PayGroup) => page.getByRole("main").getByRole("grid", { name: t("payroll.runs", { name: group.name }), exact: true });

/** A pay group's card on the payroll home: Classic draws every group's card; Console the one chosen in its group list. */
async function groupCard(page: Page, group: PayGroup) {
  const main = page.getByRole("main");
  const card = main.getByRole("region", { name: group.name, exact: true });
  const choice = main.getByRole("navigation", { name: t("payroll.home.groups"), exact: true }).getByRole("button", { name: `${group.name} · ${entityOf(group)}`, exact: true });
  await expect(card.or(choice).first()).toBeVisible();
  if (await choice.count() && (await choice.getAttribute("aria-pressed")) !== "true") await choice.click();
  await expect(card).toBeVisible();
  return card;
}

/** Chooses a legal entity on the reference page: Console lists them at desk widths; Classic opens its select. */
async function chooseEntity(page: Page, name: string) {
  const main = page.getByRole("main");
  const list = main.getByRole("navigation", { name: t("payroll.reference.entities"), exact: true });
  const select = main.getByRole("button", { name: t("payroll.entity"), exact: false });
  await expect(list.or(select).first()).toBeVisible();
  if (await list.count()) return list.getByRole("button", { name, exact: true }).click();
  await select.click();
  await page.getByRole("option", { name, exact: true }).click();
}
for (const screen of payrollScreens) for (const state of Object.keys(screen.states) as PayrollState[]) for (const width of [1440, 390]) {
  if (screen.key === "payroll" && (state === "held" || state === "unsupported")) continue;
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [], writes: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/v1/payroll/") && request.method() !== "GET") writes.push(request.url()); });
    const fixture = await mockScreen(page, screen, state);
    const reference = screen.key === "payroll-reference";
    try {
      await page.goto(screen.path + (reference ? `?entity=${id(800)}` : ""));
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1, name: t(reference ? "payroll.reference.title" : "payroll.title"), exact: true })).toBeVisible();
      if (state === "loading") {
        await expect(main.locator('[data-read-layout="list"][aria-busy="true"]').last()).toBeVisible();
        await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      } else if (reference) {
        if (state === "unsupported" || state === "empty") {
          await expect(main.getByText(t(state === "unsupported" ? "payroll.reference.noPack" : "payroll.reference.empty"), { exact: true })).toBeVisible();
          await expect(main.getByText(state === "unsupported" ? t("payroll.reference.noPackReason", { country: "US" }) : t("payroll.reference.emptyReason"), { exact: true })).toBeVisible();
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
        } else if (state === "held") {
          await expect(main.getByText(t("payroll.reference.held"), { exact: true }).first()).toBeVisible();
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
          await expect(main.getByRole("link").and(page.locator(`[href="${rate.source_url}"]`))).toHaveCount(0);
        } else {
          await expect(main.getByText(rate.value, { exact: true })).toBeVisible();
          await expect(main.getByRole("link", { name: `${rate.instrument_ko} · ${rate.article_ko} · ${rate.promulgation_ko}`, exact: true })).toHaveCount(0);
          await expect(main.getByText(`${rate.instrument_ko} · ${rate.article_ko} · ${rate.promulgation_ko} · ${new URL(rate.source_url).href}`, { exact: true })).toBeVisible();
          await expect(main.getByText(rate.provenance_ko, { exact: false })).toHaveCount(0);
        }
      } else if (state === "empty") {
        await expect(main.getByRole("region", { name: t("payroll.setup.title") })).toBeVisible();
      } else {
        for (const group of payGroups.items) {
          const card = await groupCard(page, group);
          for (const field of ["basePeriod", "variablePeriod", "payDateRule", "proration", "channel"] as const)
            await expect(card.getByText(t(`payroll.${field}`), { exact: true })).toBeVisible();
          await expect(card.getByText(t(`payroll.rule.${group.proration}`), { exact: true })).toBeVisible();
          await expect(card.getByText(t(`payroll.rule.${group.channel}`), { exact: true })).toBeVisible();
        }
        const overseas = await groupCard(page, payGroups.items[2]!);
        await expect(overseas).toContainText("모의상사 해외법인");
        await expect(runsOf(page, payGroups.items[2]!)).toContainText(t("payroll.run.VOID"));
        await expect(runsOf(page, payGroups.items[2]!)).not.toContainText(t("payroll.run.STAGED"));
      }
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      if (state === "loading" || state === "failed") {
        await mockPayroll(page, screen, "populated", Promise.resolve());
        fixture.release();
        if (state === "failed") await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(reference ? main.getByText(rate.value, { exact: true }) : main.getByRole("region", { name: payGroups.items[0]!.name, exact: true })).toBeVisible();
      }
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("reference selection keeps unsupported entities separate and payroll readiness controls the rail", async ({ page }) => {
  const screen = payrollScreens[1];
  const fixture = await mockScreen(page, screen, "populated");
  await page.goto(screen.path);
  const main = page.getByRole("main");
  await chooseEntity(page, payGroups.legal_entities[1]!.name!);
  await expect(main.getByText(t("payroll.reference.noPack"), { exact: true })).toBeVisible();
  await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
  const rail = page.getByRole("navigation", { name: t("shell.nav") });
  await expect(rail.getByRole("link", { name: t("payroll.title"), exact: true })).toBeVisible();
  await page.route("**/api/v1/onboarding/modules", route => route.fulfill({ json: [] }));
  await page.reload();
  await expect(main.getByText(t("payroll.reference.noPack"), { exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: t("payroll.title"), exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("an unknown reference entity makes no rates request and can be replaced with an available entity", async ({ page }) => {
  const screen = payrollScreens[1];
  const fixture = await mockScreen(page, screen, "populated");
  const reads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === screen.read) reads.push(url.searchParams.get("legal_entity_id")!);
  });
  try {
    await page.goto(`${screen.path}?entity=${id(899)}`);
    const main = page.getByRole("main");
    await expect(main.getByText(t("payroll.reference.pickReason"), { exact: true })).toBeVisible();
    // No entity is chosen: the page asks for one, and Console's list presses none.
    await expect(main.getByText(t("payroll.reference.pick"), { exact: true }).first()).toBeVisible();
    await expect(main.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
    expect(reads).toEqual([]);
    await chooseEntity(page, payGroups.legal_entities[0]!.name!);
    await expect(main.getByText(rate.value, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${new URL(screen.path, page.url())}?entity=${id(800)}`);
    expect(reads).toEqual([id(800)]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("payroll home paginates over 100 runs with server pay_group_id filter @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const manyRuns = Array.from({ length: 120 }, (_, n) => ({
    id: id(9000 + n),
    legal_entity_id: payGroups.items[0]!.legal_entity_id,
    pay_group_id: payGroups.items[0]!.id,
    kind: "REGULAR" as const,
    attribution_month: `2026-${String((n % 12) + 1).padStart(2, "0")}`,
    pay_date: "2026-10-25",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    variable_period_start: "2026-09-16",
    variable_period_end: "2026-10-15",
    source_label: `Synthetic bulk run ${n + 1}`,
    status: "CALCULATED" as const,
    calculation_enabled: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  }));
  const seenOffsets: number[] = [];
  await page.route(url => url.pathname === "/api/v1/payroll/runs", route => {
    const q = new URL(route.request().url()).searchParams;
    const groupId = q.get("pay_group_id");
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    if (groupId === payGroups.items[0]!.id) seenOffsets.push(offset);
    const matched = groupId === payGroups.items[0]!.id ? manyRuns : [];
    return route.fulfill({ json: { items: matched.slice(offset, offset + limit), total: matched.length, limit, offset } });
  });
  try {
    await page.goto("/payroll");
    await groupCard(page, payGroups.items[0]!);
    const grid = runsOf(page, payGroups.items[0]!);
    await expect(grid).toBeVisible();
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => seenOffsets).toContain(50);
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => seenOffsets).toContain(100);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) test(`the Classic payroll home draws every pay group's card with its runs at ${width}px @baseline`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  try {
    await page.goto("/payroll");
    for (const group of payGroups.items) {
      const card = page.getByRole("main").getByRole("region", { name: group.name, exact: true });
      await expect(card).toBeVisible();
      if (group === payGroups.items[2]) await expect(card.getByRole("grid", { name: t("payroll.runs", { name: group.name }), exact: true })).toBeVisible();
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("the Classic reference page asks for an entity before it reads any rates @baseline", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[1], "populated");
  await page.goto(payrollScreens[1].path);
  const main = page.getByRole("main");
  await expect(main.getByText(t("payroll.reference.pick"), { exact: true }).last()).toBeVisible();
  await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

// The payroll home and the reference page are not drawn on a board, so these values are the Console render's.
test.describe("console payroll home and reference", () => {
  test.use({ storageState: experienceState("console") });

  test("the Console payroll home shows one pay group at a time, the first chosen", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockScreen(page, payrollScreens[0], "populated");
    try {
      await page.goto("/payroll");
      const main = page.getByRole("main");
      const groups = main.getByRole("navigation", { name: t("payroll.home.groups"), exact: true }).getByRole("button");
      await expect(groups).toHaveText(payGroups.items.map(group => `${group.name} · ${entityOf(group)}`));
      await expect(groups.first()).toHaveAttribute("aria-pressed", "true");
      await expect(main.getByRole("region", { name: payGroups.items[0]!.name, exact: true })).toBeVisible();
      for (const group of payGroups.items.slice(1)) await expect(main.getByRole("region", { name: group.name, exact: true })).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test("the Console reference page opens on the first entity", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockScreen(page, payrollScreens[1], "populated");
    await page.goto(payrollScreens[1].path);
    const entities = page.getByRole("main").getByRole("navigation", { name: t("payroll.reference.entities"), exact: true }).getByRole("button");
    await expect(entities.and(page.locator('[aria-pressed="true"]'))).toHaveText([payGroups.legal_entities[0]!.name!]);
    expect(fixture.unexpected).toEqual([]);
  });
});
