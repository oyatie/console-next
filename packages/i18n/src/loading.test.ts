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
