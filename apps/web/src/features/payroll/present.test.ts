// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { rateValue, referenceStatus } from "./present";
import { rate } from "../../../../../e2e/mock/payroll";
beforeAll(() => loadCatalog("ko"));
for (const field of ["instrument_ko", "article_ko", "promulgation_ko", "enforced_on", "source_url", "retrieved_on", "provenance_ko"] as const) test(`missing ${field} hides the figure`, () => {
  expect(rateValue({ ...rate, [field]: "" })).toBe("근거 확인 필요");
});
test("unsafe source URLs hide the figure", () => {
  expect(rateValue({ ...rate, source_url: "javascript:alert(1)" })).toBe("근거 확인 필요");
});
test("cited rates show their supplied value", () => { expect(rateValue(rate)).toBe(rate.value); });
test("no adopted pack never falls back to Korean rates", () => {
  expect(referenceStatus({ adopted: false, country_code: "US", items: [rate] })).toBe("기준표 없음");
});
test("held rates hide the figure even with a complete citation", () => {
  expect(rateValue({ ...rate, status: "HELD" })).toBe("근거 확인 필요");
});
