// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { payDateRule, periodRule, rateValue, referenceStatus } from "./present";
import { rate } from "../../../../../e2e/mock/payroll";
beforeAll(() => loadCatalog("ko"));
test("typed pay rules render every explicit choice without inferred dates", () => {
  expect(payDateRule({ day: "LAST_DAY", month_offset: 1, non_business_day: "NEXT" })).toBe("다음 달 말일 · 휴일이면 다음 영업일");
  expect(payDateRule({ day: 25, month_offset: 0, non_business_day: "PREVIOUS" })).toBe("당월 25일 · 휴일이면 이전 영업일");
  expect(periodRule({ start_day: "FIRST", month_offset: -1 })).toBe("전월 1일부터 한 달");
  expect(periodRule({ start_day: 16, month_offset: 0 })).toBe("당월 16일부터 한 달");
});
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
