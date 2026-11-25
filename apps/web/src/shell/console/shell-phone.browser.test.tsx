// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { t } from "@console/i18n";
import type { Page } from "../../lib/browser-test";
import { frames, nameMismatches, pageFrame, phoneShellFixture } from "./shell-phone.browser-fixture";

let shell: Awaited<ReturnType<typeof phoneShellFixture>>;
let page: Page;

beforeAll(async () => {
  shell = await phoneShellFixture();
  page = shell.page;
}, 60_000);

afterAll(async () => {
  await shell?.close();
});

const openPhoneShell = (...args: Parameters<typeof shell.open>) => shell.open(...args);

const screenEntry = async () => Number(await page.locator("[data-phone-screen]").getAttribute("data-entry"));

test("the self-service certificates tab opens the employee's own certificates, and closing it leaves no extra Back", async () => {
  const nav = await openPhoneShell();
  const expectCurrent = async (href: string, label: string) => {
    await expect.poll(async () => await nav.locator('a[aria-current="page"]').count()).toBe(1);
    await expect.poll(async () => await nav.locator('a[aria-current="page"]').getAttribute("href")).toBe(href);
    await expect.poll(async () => (await nav.locator('a[aria-current="page"]').textContent())?.trim()).toBe(label);
  };
  const tab = nav.getByRole("link", { name: t("shell.link.certificates"), exact: true });

  // An employee on the self-service nav holds no HR grant, so the HR certificate list would only refuse them.
  expect(await tab.getAttribute("href")).toBe("/account?sheet=certificates");
  await expectCurrent("/account", t("shell.link.profile"));
  // The self-service bar still names "/" Home; only the desk bar calls it To-dos.
  expect(await nav.getByRole("link", { name: t("shell.link.home"), exact: true }).getAttribute("href")).toBe("/");
  const first = await screenEntry();

  await tab.click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
  await expect.poll(() => page.locator('[data-phone-screen="Account"]').getAttribute("data-sheet")).toBe("certificates");
  expect(await screenEntry()).toBe(first + 1);

  // Closing a sheet the tab opened unwinds the entry the tab pushed: the next Back leaves /account, not reopens it.
  await page.getByRole("button", { name: "close-sheet", exact: true }).click();
  await expectCurrent("/account", t("shell.link.profile"));
  expect(await screenEntry()).toBe(first);

  // Back from an open sheet closes it.
  await tab.click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
  await page.getByRole("button", { name: "go-back", exact: true }).click();
  await expectCurrent("/account", t("shell.link.profile"));
  expect(await screenEntry()).toBe(first);

  await page.getByRole("button", { name: "go-certificates", exact: true }).click();
  await expectCurrent("/account?sheet=certificates", t("shell.link.certificates"));
});

test("an account with no employee record has no certificates tab, since it holds no certificates of its own", async () => {
  const nav = await openPhoneShell("UNLINKED");
  await expect.poll(async () => await nav.getByRole("link", { name: t("shell.link.profile"), exact: true }).count()).toBe(1);
  expect(await nav.getByRole("link", { name: t("shell.link.certificates"), exact: true }).count()).toBe(0);
});

/** Appends `html` to the phone screen and returns each `[data-probe]` element's page offset. */
async function grow(html: string) {
  return page.evaluate(markup => {
    document.querySelector("[data-phone-screen]")!.insertAdjacentHTML("beforeend", markup);
    return Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-probe]")]
      .map(element => [element.dataset.probe!, element.getBoundingClientRect().top + window.scrollY]));
  }, html);
}
const hitIn = (x: number, y: number, selector: string) =>
  page.evaluate(([px, py, sel]) => Boolean(document.elementFromPoint(px, py)?.closest(sel)), [x, y, selector] as const);

test("on a phone the top bar and bottom nav stay on screen while a long page scrolls, and focus stops clear of both", async () => {
  const nav = await openPhoneShell();
  const at = await grow('<div style="block-size: 1200px"></div><button data-probe="near-top">near top</button><div style="block-size: 1800px"></div><button data-probe="near-nav">near nav</button><div style="block-size: 1200px"></div>');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1200);

  const navBox = (await nav.boundingBox())!;
  const topBox = (await page.locator('header[data-surface="chrome"]').boundingBox())!;
  expect(Math.round(navBox.y + navBox.height)).toBe(844);
  expect(topBox.y).toBe(0);

  // A control half under the top bar, then one half under the nav: focusing each brings it clear of the bar.
  const nearTop = page.getByRole("button", { name: "near top", exact: true });
  const nearNav = page.getByRole("button", { name: "near nav", exact: true });
  await page.evaluate(y => window.scrollTo(0, y), at["near-top"]! - topBox.height / 2);
  await nearTop.focus();
  expect((await nearTop.boundingBox())!.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 0.5);
  await nearTop.blur();
  await page.evaluate(y => window.scrollTo(0, y), at["near-nav"]! - navBox.y);
  await nearNav.focus();
  const nearNavBox = (await nearNav.boundingBox())!;
  expect(nearNavBox.y + nearNavBox.height).toBeLessThanOrEqual(navBox.y + 0.5);
});

test("on a phone the page's last control scrolls fully clear of both bars, so nothing stays under one", async () => {
  const nav = await openPhoneShell();
  await grow('<div style="block-size: 2400px"></div><button data-probe="last">last</button>');
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  const last = page.locator("#main").locator("a[href], button, input, select, textarea, [tabindex]").last();
  await expect.poll(async () => await last.textContent()).toBe("last");
  const [box, topBox, navBox] = [(await last.boundingBox())!, (await page.locator('header[data-surface="chrome"]').boundingBox())!, (await nav.boundingBox())!];
  expect(box.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(navBox.y + 0.5);
});

test("on a phone the bars draw over the page's own raised layers, the skip link draws over the bars, and the account menu over the page", async () => {
  const nav = await openPhoneShell();
  // A record's section strip (z-index 4) and a sticky action bar (z-index 5), as the page draws them.
  const at = await grow('<div data-probe="strip" data-page-layer style="position: sticky; top: 0; z-index: 4; block-size: 400px; background: red"></div><div style="block-size: 2000px"></div><div data-probe="bar" data-page-layer style="position: sticky; bottom: 0; z-index: 5; block-size: 160px; background: red"></div><div style="block-size: 600px"></div>');
  const header = page.locator('header[data-surface="chrome"]');

  // At the top of the page the account menu opens over the strip.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#console-phone-account").click();
  const menu = page.getByRole("group", { name: t("shell.account"), exact: true });
  const menuBox = (await menu.boundingBox())!;
  expect(await hitIn(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, '[role="group"]')).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(async () => await menu.count()).toBe(0);

  await page.evaluate(y => window.scrollTo(0, y), at.strip! + 100);
  const topBox = (await header.boundingBox())!;
  expect(await hitIn(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2, 'header[data-surface="chrome"]')).toBe(true);

  await page.evaluate(y => window.scrollTo(0, y), at.bar! + 160 - 844 + 60);
  const navBox = (await nav.boundingBox())!;
  expect(await hitIn(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2, "nav")).toBe(true);

  const skip = page.getByRole("link", { name: "skip", exact: true });
  await skip.focus();
  const skipBox = (await skip.boundingBox())!;
  expect(skipBox.y).toBeLessThan(topBox.height);
  expect(await hitIn(skipBox.x + skipBox.width / 2, skipBox.y + skipBox.height / 2, "a.skip")).toBe(true);
});

/** The phone's top room while its bar cannot draw yet: the page's banner, marked busy, holding no control. */
async function expectBusyBar() {
  const banner = page.getByRole("banner");
  await element(banner).toHaveCount(1);
  await element(banner).toHaveAttribute("aria-busy", "true");
  await element(banner.locator("a, button")).toHaveCount(0);
}

/** How each bar's slot looks: its surface and the hairline on the side that meets the page. */
const barLook = () => page.locator("[data-pinned-bar] > *").evaluateAll(([top, nav]) => [top, nav].map((el, i) => {
  const style = getComputedStyle(el!);
  return [style.backgroundColor, i === 0 ? style.borderBottomColor : style.borderTopColor, i === 0 ? style.borderBottomWidth : style.borderTopWidth];
}));

test("on a phone the page keeps its place while the bars' code loads, since an empty bar holds each bar's room", async () => {
  const chunk = "**/console-phone-chrome.tsx*";
  let release!: () => void, asked!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const requested = new Promise<void>(done => { asked = done; });
  await page.route(chunk, async route => { asked(); await held; await route.continue(); });
  try {
    const opened = openPhoneShell();
    // A failure before the release below closes the page under this open; its own error would only repeat that one.
    opened.catch(() => {});
    // The new page has asked for the bars' code, so what is on screen now is that page, not the previous test's.
    await requested;
    await page.locator('[data-phone-screen="Account"]').waitFor();
    // The bars' code is still held back, so the screen is drawn without them: the top room is the bar, busy and bare.
    await expectBusyBar();
    const before = await pageFrame(page);
    const heldLook = await barLook();

    release();
    await opened;
    await Promise.all([page.locator('header[data-surface="chrome"]').waitFor(), page.getByRole("navigation", { name: t("shell.nav"), exact: true }).waitFor()]);
    expect(await pageFrame(page)).toEqual(before);
    // The held room looked like the bar that took its place, so nothing shows through a strip that takes no taps.
    expect(heldLook).toEqual(await barLook());
  } finally {
    release();
    await page.unroute(chunk);
  }
});

test("on a phone a reload keeps the page's place while the session restores, since the bars' room is held from the start", async () => {
  let done!: () => void, asked!: () => void;
  const restored = new Promise<void>(ok => { done = ok; });
  const requested = new Promise<void>(ok => { asked = ok; });
  const opened = openPhoneShell("LINKED", { restore: { asked, done: restored } });
  // A failure before the restore below closes the page under this open; its own error would only repeat that one.
  opened.catch(() => {});
  try {
    // The new page is restoring its session, so what is on screen now is that page, not the previous test's.
    await requested;
    await page.locator("#main").waitFor();
    // A restoring session is said on the bar itself, as the desk bar says it, with nothing on it to press yet.
    await expectBusyBar();
    const before = await pageFrame(page);

    done();
    await opened;
    await Promise.all([page.locator('header[data-surface="chrome"]').waitFor(), page.getByRole("navigation", { name: t("shell.nav"), exact: true }).waitFor()]);
    expect(await pageFrame(page)).toEqual(before);
  } finally {
    done();
  }
});


test("on a phone the to-do slot names its label before its count, as the desk bar does", async () => {
  // An account with no employee record works from the desk menu, so its bottom bar carries the to-do link.
  const nav = await openPhoneShell("UNLINKED", { inbox: { total: 3, exact: true } });
  await element(nav.locator('a[href="/"]')).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  await element(nav.locator('a[href="/"]')).toHaveAccessibleDescription(t("shell.needsMe.countDescription", { count: 3 }));
  expect(await nameMismatches(page)).toEqual([]);
});

test("on a phone My profile stays reachable while the menu loads, in the last of the bar's five places", async () => {
  const asked = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  const opened = openPhoneShell("UNLINKED", { held: { path: "/api/v1/access/me", asked: asked.resolve, done: done.promise } });
  opened.catch(() => {});
  let held: { x: number; y: number; width: number; height: number };
  try {
    await asked.promise;
    const profile = page.getByRole("navigation", { name: t("shell.nav"), exact: true }).getByRole("link", { name: t("shell.profile"), exact: true });
    await profile.waitFor();
    await frames(page);
    // Alone it would span the bar, then jump from under a thumb already on it when the menu lands.
    held = (await profile.boundingBox())!;
    expect(held).toMatchObject({ x: 312, width: 78 });
  } finally { done.resolve(); }
  const nav = await opened;
  await element(nav.locator('a[href="/"]')).toBeVisible();
  await frames(page);
  // The menu here lands with two places; the last of any menu up to five still covers the held place.
  expect(await hitIn(held.x + held.width / 2, held.y + held.height / 2, 'nav a[href="/account"]')).toBe(true);
}, 30_000);

test("on a phone a failed menu read leaves My profile in the place it held while the menu loaded", async () => {
  // The support read failing leaves the menu unread, as a failed access read does, when no earlier menu was kept.
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* A blank page keeps no storage. */ } });
  const nav = await openPhoneShell("UNLINKED", { refused: "/api/v1/support-sessions/active" });
  await element(page.getByText(t("shell.nav.failed"), { exact: true })).toBeVisible();
  await frames(page);
  expect(await nav.getByRole("link", { name: t("shell.profile"), exact: true }).boundingBox()).toMatchObject({ x: 312, width: 78 });
});

test("on a phone a failed menu read says so beside the bar and offers the retry, as it does on a desktop", async () => {
  await openPhoneShell("UNLINKED", { refused: "/api/v1/onboarding/modules" });
  const alert = page.getByRole("alert");
  await element(alert.getByRole("heading", { name: t("shell.nav.failed"), exact: true })).toBeVisible();
  await element(alert.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
