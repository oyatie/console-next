// SPDX-License-Identifier: LicenseRef-Proprietary
import { test as base } from "@playwright/test";
import { i18n, loadCatalog, LOCALES } from "@console/i18n";

export const test = base.extend<{ _catalog: void }>({
  _catalog: [async ({ locale }, use) => {
    const defaultLocale = LOCALES.find(value => locale?.startsWith(value)) ?? LOCALES[0]!;
    await loadCatalog(defaultLocale);
    i18n.set(defaultLocale);
    try {
      await use();
    } finally {
      i18n.set(defaultLocale);
    }
  }, { auto: true }],
});
