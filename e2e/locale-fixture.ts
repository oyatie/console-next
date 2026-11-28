// SPDX-License-Identifier: LicenseRef-Proprietary
import { test as base } from "@playwright/test";
import { i18n, loadCatalog, LOCALES } from "@console/i18n";

const catalogFor = (locale?: string) => LOCALES.find(value => locale?.startsWith(value)) ?? LOCALES[0]!;

export const test = base.extend<{ _catalog: void }>({
  _catalog: [async ({ locale }, use, info) => {
    const defaultLocale = catalogFor(locale);
    await loadCatalog(defaultLocale);
    i18n.set(defaultLocale);
    try {
      await use();
    } finally {
      i18n.set(catalogFor(info.project.use.locale));
    }
  }, { auto: true }],
});
