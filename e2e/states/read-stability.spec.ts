// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAccessible } from "../a11y";
import { AT, failure, id, screenAccess, structure, token, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { expectStable, recordShifts } from "../stability";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/people?view=accounts", ...["wp-create", "wp-edit", "wp-close", "wp-move"].map(act => `/org?act=${act}`)]) {
  for (const width of [1440, 390]) test(`${path}: failed reads retain the loading region and controls at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
    const held = Promise.withResolvers<void>();
    const read = path.startsWith("/people") ? "/api/v1/directory/people" : "/api/v1/org-structure";
    await mockRoute(page, "get", read, async () => {
      await held.promise;
      return { status: 503, json: failure("service_unavailable") };
    });
    try {
      await page.goto(path);
      const main = page.getByRole("main");
      await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
      if (path.startsWith("/people")) await expect(main.getByRole("combobox", { name: t("accounts.search.label"), exact: true })).toBeVisible();
      else await expect(main.getByRole("region", { name: t("asof.label"), exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const before = await main.locator("h1, input, .split").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
      held.resolve();
      await expect(main.getByRole("alert")).toContainText(t("common.loadFailed.title"), { timeout: 15_000 });
      expect(await main.locator("h1, input, .split").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(before);
      await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
      await expectAccessible(page, `${path}: loading to failed`);
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });
}

test("org: late fonts preserve loading and failed controls @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  const fonts = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  await page.route("**/*.woff2", async route => { await fonts.promise; await route.continue(); });
  await mockRoute(page, "get", "/api/v1/org-structure", async () => {
    await read.promise;
    return { status: 503, json: failure("service_unavailable") };
  });
  try {
    await page.goto("/org?act=wp-move", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("region", { name: t("asof.label"), exact: true })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByRole("status")).toHaveText(t("structure.loading"));
    const controls = main.locator("h1, input, .page__head button, section[aria-label] button");
    const loading = await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    fonts.resolve();
    await page.evaluate(() => document.fonts.ready);
    expect(await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(loading);
    await expectStable(page, "org: late fonts during loading");
    read.resolve();
    await expect(main.getByRole("alert")).toContainText(t("common.loadFailed.title"), { timeout: 15_000 });
    expect(await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(loading);
    await expectAccessible(page, "org: late fonts loading to failed");
    expect(fixture.unexpected).toEqual([]);
  } finally { fonts.resolve(); read.resolve(); await page.close(); fixture.release(); }
});

for (const name of [user.display_name, "u01234567@platform", user.display_name.repeat(16)]) for (const path of ["/platform", "/org"]) for (const width of [1440, 1024, 800, 390]) test(`${path}: late fonts preserve ${name} and shell controls at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  const pair = token();
  const [header, payload] = pair.access_token.split(".");
  pair.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: path === "/platform", name })).toString("base64url")}.mock`;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: pair });
  await mockRoute(page, "get", "/api/platform/orgs", { status: 503, json: failure("service_unavailable") });
  await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
  const fonts = Promise.withResolvers<void>();
  await page.route("**/*.woff2", async route => { await fonts.promise; await route.continue(); });
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".top__name")).toHaveText(name);
    await expect(page.getByRole("main").locator(path === "/platform" ? '[role="alert"]' : '[role="tree"]')).toBeVisible({ timeout: 15_000 });
    const controls = page.locator(".top button, .top a, .top select");
    const before = await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    fonts.resolve();
    await page.evaluate(() => document.fonts.ready);
    expect(await controls.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(before);
    const bar = await page.locator(".top").boundingBox();
    const nameSlot = await page.locator(".top__name").boundingBox();
    expect(nameSlot!.width).toBeLessThanOrEqual(bar!.width / 4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const logout = await page.getByRole("button", { name: t("shell.logout"), exact: true }).boundingBox();
    expect(logout).not.toBeNull();
    expect(logout!.x + logout!.width).toBeLessThanOrEqual(width);
    if (width >= 800) {
      const fitted = await page.locator(".top__name span").evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { slot: el.getBoundingClientRect().width, text: range.getBoundingClientRect().width, compact: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-6")) * 2 };
      });
      expect(fitted.slot).toBeLessThanOrEqual(Math.max(fitted.text, fitted.compact) + 1);
      if (path === "/org") {
        const jump = page.locator(".top__jump");
        const actual = await jump.boundingBox();
        // Compare with the populated base's intrinsic name sizing, without a fixed-width reserve.
        await page.locator(".top__name span").evaluate(el => { (el as HTMLElement).style.minInlineSize = "calc(var(--space-6) * 2)"; });
        expect(await jump.boundingBox()).toEqual(actual);
      }
    }
    await expectAccessible(page, `${path}: late fonts at ${width}px`);
    expect(fixture.unexpected).toEqual([]);
  } finally { fonts.resolve(); await page.close(); fixture.release(); }
});

for (const width of [1440, 1024, 390]) test(`org: populated, loading and failed heads share one action row at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  const held = Promise.withResolvers<void>();
  let state: "populated" | "loading" | "failed" = "populated";
  await mockRoute(page, "get", "/api/v1/org-structure", async () => {
    if (state === "loading") await held.promise;
    return state === "failed" ? { status: 503, json: failure("service_unavailable") } : { status: 200, json: structure(3) };
  });
  const geometry = () => page.locator(`.page__head, #structure-import, section[aria-label="${t("asof.label")}"], section[aria-label="${t("asof.compare")}"]`).evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  }));
  try {
    await page.goto("/org");
    await expect(page.getByRole("button", { name: t("structure.export.open"), exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    const populated = await geometry();
    const head = page.locator('.page__head').last();
    const headBox = await head.boundingBox();
    const asof = await page.getByRole("region", { name: t("asof.label"), exact: true }).boundingBox();
    const gap = await head.evaluate(el => parseFloat(getComputedStyle(el.parentElement!).rowGap));
    expect(asof!.y).toBe(headBox!.y + headBox!.height + gap);
    if (width === 1440) {
      const chart = await page.getByRole("region", { name: t("structure.chart.label"), exact: true }).boundingBox();
      expect(chart!.height).toBeGreaterThan(0);
      expect(await page.getByRole("tree").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8);
      const tree = await page.getByRole("tree").boundingBox();
      expect(tree!.y + tree!.height).toBeLessThanOrEqual(chart!.y + chart!.height);
      expect(tree!.y + tree!.height).toBeLessThanOrEqual(900);
      expect(chart!.y + chart!.height).toBeLessThanOrEqual(900);
    }
    if (width > 960) {
      const views = await page.getByRole("group", { name: t("structure.views"), exact: true }).boundingBox();
      const action = await page.getByRole("button", { name: t("structure.export.open"), exact: true }).boundingBox();
      expect(action!.y).toBeGreaterThanOrEqual(views!.y);
      expect(action!.y + action!.height).toBeLessThanOrEqual(views!.y + views!.height);
    }
    state = "loading";
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("group", { name: t("structure.views"), exact: true })).toBeVisible();
    await expect(page.getByRole("main").locator('[aria-busy="true"]').last()).toBeVisible();
    const phase = page.locator('.page__head [data-loading]');
    await expect(phase).toHaveText(t("structure.effect.operating"));
    await expect(phase).toBeHidden();
    expect(await geometry()).toEqual(populated);
    await expectStable(page, "org: loading head");
    state = "failed";
    held.resolve();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(head.getByText(t("structure.readFailed"), { exact: true })).toBeVisible();
    expect(await geometry()).toEqual(populated);
    await expectStable(page, "org: failed head");
    await expect(page.getByRole("button", { name: t("structure.export.open"), exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: t("structure.export.open"), exact: true })).toHaveAccessibleDescription(t("structure.readFailed"));
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) test(`shell: failed session restore keeps recovery controls at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", async () => {
    await held.promise;
    return { status: 503, json: failure("service_unavailable") };
  });
  try {
    await page.goto("/org");
    await expect(page.locator(".top")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".top").getByRole("button")).toHaveCount(0);
    held.resolve();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(t("common.read.sessionRestoreReason"));
    await expect(page.locator(".top")).not.toHaveAttribute("aria-busy");
    await expect(page.getByRole("combobox", { name: t("shell.locale"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("shell.theme.toDark"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("shell.logout"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
    if (width === 390) {
      await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
      await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

for (const width of [1440, 1024, 390]) test(`org: normal fonts never move painted controls at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    const previous = new WeakMap<Element, { text: string | null; x: number; y: number }>();
    const moves: string[] = [];
    Object.assign(window, { fontControlMoves: moves });
    const sample = () => {
      for (const el of document.querySelectorAll(".top button, .top a, .top select, main .page__head button, main section[aria-label] input, main section[aria-label] button")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const before = previous.get(el);
        const now = { text: el.textContent, x: r.x, y: r.y };
        if (before && before.text === now.text && (Math.abs(now.x - before.x) > 0.5 || Math.abs(now.y - before.y) > 0.5)) moves.push(`${now.text}: ${before.x},${before.y} → ${now.x},${now.y}`);
        previous.set(el, now);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.addInitScript(recordShifts);
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    // Natural font requests: the late-font cases below intentionally hold them.
    await page.goto("/org");
    await expect(page.getByRole("tree")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectAccessible(page, `org: normal fonts at ${width}px`);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await page.evaluate(() => (window as unknown as { fontControlMoves: string[] }).fontControlMoves)).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});


test("org: a short setup canvas keeps its workplace selectable @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
  const tree = structure(1);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", { status: 404, json: failure("not_found") });
  const entity = tree.entities[0]!, workplace = entity.children[0]!;
  workplace.children = [];
  entity.children.push({ ...workplace, id: id(5), name: `${workplace.name} 2` });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  try {
    await page.goto("/org");
    const site = page.getByRole("treeitem", { name: new RegExp(`^${workplace.name},`) });
    await expect(site).toBeVisible();
    const find = page.getByRole("searchbox", { name: t("structure.find.label"), exact: true });
    await find.fill(workplace.name);
    await find.press("Enter");
    await expect(site).toHaveAttribute("data-s", /\bnow\b/);
    await find.press("Escape");
    const contained = await site.evaluate(el => {
      const canvas = el.closest("section[aria-label]")!;
      const style = getComputedStyle(canvas);
      return { node: el.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON(),
        tolerance: Math.max(parseFloat(style.borderLeftWidth), parseFloat(style.borderTopWidth), 1 / devicePixelRatio) };
    });
    expect(contained.node.x).toBeGreaterThanOrEqual(contained.canvas.x - contained.tolerance);
    expect(contained.node.y).toBeGreaterThanOrEqual(contained.canvas.y - contained.tolerance);
    expect(contained.node.right).toBeLessThanOrEqual(contained.canvas.right + contained.tolerance);
    expect(contained.node.bottom).toBeLessThanOrEqual(contained.canvas.bottom + contained.tolerance);
    await site.click({ trial: true, timeout: 5000 });
    await site.click({ timeout: 5000 });
    await expect(site).toHaveAttribute("aria-selected", "true");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
