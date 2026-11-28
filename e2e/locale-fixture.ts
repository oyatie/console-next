// SPDX-License-Identifier: LicenseRef-Proprietary
import { test as base } from "@playwright/test";
import { i18n, loadCatalog, LOCALES } from "@console/i18n";

export const test = base.extend<{ _catalog: void }>({
  _catalog: [async ({ locale }, use, info) => {
    const testLocale = catalogLocale(locale);
    await loadCatalog(testLocale);
    i18n.set(testLocale);
    try {
      await use();
    } finally {
      i18n.set(catalogLocale(info.project.use.locale));
    }
  }, { auto: true }],
});

function catalogLocale(locale?: string) {
  return LOCALES.find(value => locale?.startsWith(value)) ?? LOCALES[0]!;
}
