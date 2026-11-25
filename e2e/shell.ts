// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { bootKo } from "../packages/i18n/src/catalogs/boot";

const shells = {
  baseline: { banner: ".top", account: ".top__name", accountText: ".top__name span", search: ".top__jump", searchText: ".top__jumpText", spacer: ".top__spacer" },
};

export function shellSelectors() {
  return Object.entries(shells).find(([id]) => id === process.env.E2E_EXPERIENCE)?.[1] ?? shells.baseline;
}

/** Look-specific selectors stay here; shared landmarks and command names stay in the specs. */
export function shell(page: Page) {
  const selectors = shellSelectors();
  return {
    banner: page.getByRole("banner"), navigation: page.getByRole("navigation", { name: bootKo["shell.nav"], exact: true }),
    account: page.locator(selectors.account), accountText: page.locator(selectors.accountText),
    search: page.locator(selectors.search), searchText: page.locator(selectors.searchText), spacer: page.locator(selectors.spacer),
  };
}

const signOutName = { name: bootKo["shell.logout"], exact: true };
// Any name but the module overflow's, which Console's bar also shows collapsed when its modules do not fit.
const notOverflow = new RegExp(`^(?!${bootKo["shell.nav.more"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$)`);

/**
 * The signed-in account control in either style: Classic's bar holds the sign-out command itself; Console's bar
 * holds the account menu, whose trigger is named after the person, so it is the collapsed button of a bar with no
 * sign-out, other than the module overflow. A signed-out page has no bar.
 */
export function accountControl(page: Page) {
  const banner = page.getByRole("banner");
  return banner.getByRole("button", signOutName).or(banner.filter({ hasNot: page.getByRole("button", signOutName) }).getByRole("button", { expanded: false, name: notOverflow }));
}

/** A session that ends in use keeps its screen, bar included, under the sign-in-again dialog, which only makes it inert. */
export async function expectSignedIn(page: Page, options?: { timeout?: number }) {
  await expect(accountControl(page)).toBeVisible(options);
  await expect(page.getByRole("dialog", { name: bootKo["idle.reauth.title"], exact: true })).toBeHidden();
}

/** Signs out from the bar: Classic offers the command there, Console inside the account menu. */
export async function signOut(page: Page) {
  const command = page.getByRole("banner").getByRole("button", signOutName);
  await expectSignedIn(page);
  if (!(await command.isVisible())) await accountControl(page).click();
  await command.click();
}
