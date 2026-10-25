// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { changeLine, fieldLabel } from "./present";

test.each(["ko", "en"] as const)("%s: history field aliases reuse the shared labels", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    expect(fieldLabel("priority_support")).toBe(t("entityRecord.vat.priority"));
    expect(fieldLabel("biz_kind")).toBe(t("entity.field.bizKind"));
    expect(fieldLabel("main_ksic_label")).toBe(t("entityRecord.vat.mainKsic"));
    expect(fieldLabel("co_owners")).toBe(t("entity.field.coOwners"));
    expect(fieldLabel("sub_serial")).toBe(t("workplace.field.subSerial"));
  } finally {
    i18n.set("ko");
  }
});

test.each(["ko", "en"] as const)("%s: certificate moves hide UUIDs and keep the sub-workplace serial detail", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    const line = changeLine({ field: "registration_id", before: "0b5f1c9e-0000-4000-8000-000000000001", after: "0b5f1c9e-0000-4000-8000-000000000002" });
    expect(line).toBe(locale === "ko" ? "사업자등록증 변경" : "Certificate changed");
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(changeLine({ field: "sub_serial", before: "0001", after: "0002" })).toBe(`${t("workplace.field.subSerial")}: 0001 → 0002`);
  } finally {
    i18n.set("ko");
  }
});
