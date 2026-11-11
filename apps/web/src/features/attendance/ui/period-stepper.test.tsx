// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { PeriodStepper } from "./period-stepper";

afterEach(() => i18n.set("ko"));

test.each([
  ["2026-10-04", "2026. 09. 28.", "2026. 10. 04."],
  ["2026-10-05", "2026. 10. 05.", "2026. 10. 11."],
  ["2027-01-01", "2026. 12. 28.", "2027. 01. 03."],
  ["2028-02-29", "2028. 02. 28.", "2028. 03. 05."],
])("the week containing %s shows both inclusive dates", async (value, start, end) => {
  await loadCatalog("ko");
  const html = renderToStaticMarkup(<PeriodStepper unit="week" value={value} onChange={() => {}} />);
  expect(html).toContain(`${start} – ${end}`);
  expect(html).toContain("이번 주");
});

test.each(["ko", "en"] as const)("year and current-period controls use the %s catalog", async locale => {
  await loadCatalog(locale);
  i18n.set(locale);
  const year = renderToStaticMarkup(<PeriodStepper unit="year" value="2025" onChange={() => {}} />);
  expect(year).toContain(locale === "ko" ? "2025년" : "2025");
  expect(year).toContain(locale === "ko" ? "올해" : "This year");
  const month = renderToStaticMarkup(<PeriodStepper unit="month" value="2026-11" onChange={() => {}} />);
  expect(month).toContain(locale === "ko" ? "이번 달" : "This month");
});
