// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { bootEn, bootKo } from "./catalogs/boot";

test("bootstrap copy is available while sign-in and shell copy await the locale catalog", async () => {
  vi.resetModules();
  const { i18n, loadCatalog, t } = await import("./index");
  expect(t("common.loading")).toBe(bootKo["common.loading"]);
  expect(t("common.crashed.action")).not.toBe("common.crashed.action");
  expect(t("auth.login.title")).toBe("auth.login.title");
  for (const locale of ["ko", "en"] as const) {
    await loadCatalog(locale);
    i18n.set(locale);
    const catalog = locale === "ko" ? bootKo : bootEn;
    for (const [id, text] of Object.entries(catalog)) {
      if (!text.includes("{")) expect(t(id as keyof typeof catalog), id).toBe(text);
    }
  }
});

for (const locale of ["ko", "en"] as const) test(`boot-only loading in ${locale} is deduplicated and leaves screen copy unloaded`, async () => {
  vi.resetModules();
  const { i18n, loadBootCatalog, loadCatalog, t } = await import("./index");
  i18n.set(locale);
  const first = loadBootCatalog(locale);
  expect(loadBootCatalog(locale)).toBe(first);
  await first;
  const catalog = locale === "ko" ? bootKo : bootEn;
  expect(t("auth.login.title")).toBe(catalog["auth.login.title"]);
  expect(t("uiField.valueMissing")).toBe("uiField.valueMissing");
  await loadCatalog(locale);
  expect(t("uiField.valueMissing")).not.toBe("uiField.valueMissing");
});

test("a failed boot-only fetch can be retried", async () => {
  vi.resetModules();
  vi.doMock("./catalogs/boot-en", () => {
    throw new Error("offline");
  });
  try {
    const { loadBootCatalog, i18n, t } = await import("./index");
    await expect(loadBootCatalog("en")).rejects.toThrow();
    vi.doMock("./catalogs/boot-en", () => ({ bootEn }));
    await loadBootCatalog("en");
    i18n.set("en");
    expect(t("auth.login.title")).toBe(bootEn["auth.login.title"]);
  } finally { vi.doUnmock("./catalogs/boot-en"); }
});
