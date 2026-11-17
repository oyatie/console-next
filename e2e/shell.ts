// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";

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
    banner: page.getByRole("banner"), navigation: page.getByRole("navigation", { name: "주 메뉴", exact: true }),
    account: page.locator(selectors.account), accountText: page.locator(selectors.accountText),
    search: page.locator(selectors.search), searchText: page.locator(selectors.searchText), spacer: page.locator(selectors.spacer),
  };
}
