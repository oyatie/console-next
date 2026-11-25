// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { t } from "@console/i18n";
import type { Page } from "../../lib/browser-test";
import { frames, nameMismatches, pageFrame, phoneShellFixture, type Held } from "./shell-phone.browser-fixture";

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

/** Where each drawn part of the desktop chrome sits, by its look and, for tabs and status segments, its text. */
const chromePlaces = () => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll("[data-console-shell] header > *, [data-console-shell] li, [data-console-shell] footer *")]
    .map(el => [el.className + (el.matches("header > *") ? "" : `|${el.textContent}`), el.getBoundingClientRect()] as const)
    .filter(([, r]) => r.width > 0)
    .map(([key, r]) => [key, `${Math.round(r.x)},${Math.round(r.y)}`]),
));

const desktopHolds: [string, (hold: Held) => Parameters<typeof openPhoneShell>[1]][] = [
  ["the session restores", hold => ({ restore: hold })],
  ["/api/v1/users/me lands", hold => ({ held: { ...hold, path: "/api/v1/users/me" } })],
  ["/api/v1/users/me fails", hold => ({ held: { ...hold, path: "/api/v1/users/me" }, refused: "/api/v1/users/me" })],
  ["/api/v1/access/me lands", hold => ({ held: { ...hold, path: "/api/v1/access/me" } })],
  ["/api/v1/users/me lands after /api/v1/access/me fails", hold => ({ held: { ...hold, path: "/api/v1/users/me" }, refused: "/api/v1/access/me" })],
];

for (const [what, hold] of desktopHolds) test(`on a desktop neither the page nor any chrome drawn moves when ${what}`, async () => {
  const requested = Promise.withResolvers<void>(), answered = Promise.withResolvers<void>();
  const options = { ...hold({ asked: requested.resolve, done: answered.promise }), width: 1440 };
  // A refused read falls back to the menu a returning reader was last shown, so the reader has opened the page before.
  // With no menu remembered, the top bar draws the read's failure notice and grows taller; these cases do not cover that.
  if (options.refused) await (await openPhoneShell("LINKED", { width: 1440 })).getByRole("link").first().waitFor();
  const opened = openPhoneShell("LINKED", options);
  // A failure before the release below closes the page under this open; its own error would only repeat that one.
  opened.catch(() => {});
  try {
    await requested.promise;
    await page.locator("#main").waitFor();
    await frames(page);
    // The app's first paint waits for its UI font or keeps the system face for good (lib/fonts); this page has no such
    // gate, so the place to hold is read once the font its text asked for has loaded, not from the fallback face before it.
    await page.evaluate(() => document.fonts.ready);
    const [before, frame] = [await chromePlaces(), await pageFrame(page)];

    answered.resolve();
    // Settled once the tabs, the brand and the menu draw: the brand is the tenant's name, or the product's when the
    // reader's own read is refused.
    await page.locator("[data-workspace-tab]").first().waitFor();
    await page.getByRole("link", { name: options.refused === "/api/v1/users/me" ? t("app.name") : "Saeon", exact: true }).waitFor();
    await page.getByRole("navigation", { name: t("shell.nav"), exact: true }).getByRole("link").first().waitFor();
    await frames(page);
    const after = await chromePlaces();
    expect(Object.fromEntries(Object.keys(before).map(key => [key, after[key] ?? "gone"]))).toEqual(before);
    expect(await pageFrame(page)).toEqual(frame);
  } finally { answered.resolve(); }
});

// The frame never sends the tenant reader's read for an operator, so waiting on it would hold the chrome for good.
test("on a desktop an operator's chrome draws without the tenant reader's read", async () => {
  await openPhoneShell("LINKED", { width: 1440, operator: true });
  await page.locator("[data-workspace-tab]").first().waitFor();
  await expect.poll(() => page.locator("[data-console-shell] footer").count()).toBe(1);
});

const menu = () => page.getByRole("navigation", { name: t("shell.nav"), exact: true });

test("on a desktop the to-do link says when its count is still loading or cannot be read, as Classic's does", async () => {
  const asked = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  const opened = openPhoneShell("LINKED", { width: 1440, held: { path: "/api/v1/me/action-inbox", asked: asked.resolve, done: done.promise } });
  opened.catch(() => {});
  try {
    await asked.promise;
    await element(menu().locator('a[href="/"]')).toHaveAccessibleName(t("shell.needsMe.loading"));
    expect(await nameMismatches(page)).toEqual([]);
  } finally { done.resolve(); }
  await opened;

  await openPhoneShell("LINKED", { width: 1440, refused: "/api/v1/me/action-inbox" });
  const todo = menu().locator('a[href="/"]');
  await element(todo).toHaveAccessibleName(t("shell.needsMe.unknown"));
  await element(todo.locator("data")).toHaveCount(0);
  expect(await nameMismatches(page)).toEqual([]);
});

test("on a desktop a counted to-do link is named as drawn and described in Classic's words, a lower bound with its plus", async () => {
  await openPhoneShell("LINKED", { width: 1440, inbox: { total: 1234, exact: false } });
  const todo = menu().locator('a[href="/"]');
  await element(todo).toHaveAccessibleName(`${t("shell.link.todo")} 1,234+`);
  await element(todo).toHaveAccessibleDescription(t("shell.needsMe.countMoreDescription", { count: 1234 }));
  await element(todo.locator("data")).toHaveText("1,234+");
  expect(await nameMismatches(page)).toEqual([]);

  await openPhoneShell("LINKED", { width: 1440, inbox: { total: 3, exact: true } });
  await element(menu().locator('a[href="/"]')).toHaveAccessibleName(t("shell.needsMe.count", { count: 3 }));
  await element(menu().locator('a[href="/"]')).toHaveAccessibleDescription(t("shell.needsMe.countDescription", { count: 3 }));
  expect(await nameMismatches(page)).toEqual([]);
});
