// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { i18n, loadCatalog, t } from "@console/i18n";
import { afterEach, beforeAll, expect, test } from "vitest";
import { failureText } from "./refusal";

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]), 60_000);
afterEach(() => i18n.set("ko"));

for (const locale of ["ko", "en"] as const) {
  test(`filing_citation_source_url_invalid has actionable copy (${locale})`, () => {
    i18n.set(locale);
    const copy = failureText(new ApiError(422, "filing_citation_source_url_invalid", "invalid"));
    expect(copy).toBe(t("common.failed.code.filing_citation_source_url_invalid"));
    expect(copy).toContain("https://www.law.go.kr/");
    expect(copy).not.toBe("common.failed.code.filing_citation_source_url_invalid");
  });
}
