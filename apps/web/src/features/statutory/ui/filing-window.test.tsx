// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { filingTask } from "../../../../../../e2e/mock/filings";
import { FilingWindow } from "./filing-deadline";

beforeAll(() => loadCatalog("ko"));

test("the rule disclosure owns its review status exactly once", () => {
  const task = { ...filingTask, dates: {
    opens_on: "2026-09-01", target_on: "2026-09-01", due_on: "2026-09-15", legal_latest_candidate: null,
    conservative: true, without_delay: false, holiday_roll_unverified: true,
  } };
  const html = renderToStaticMarkup(<FilingWindow task={task} />);
  expect(html.split(t("statutory.hold"))).toHaveLength(2);
  expect(html.indexOf(t("statutory.hold"))).toBeGreaterThan(html.indexOf("<details>"));
  expect(html.split(t("statutory.conservative"))).toHaveLength(2);
  expect(html.indexOf(t("statutory.conservative"))).toBeGreaterThan(html.indexOf("<details>"));

  const fallback = renderToStaticMarkup(<FilingWindow task={{ ...task, basis: null }} />);
  expect(fallback).toContain(t("statutory.hold"));
  expect(fallback).toContain(t("statutory.conservative"));
  expect(fallback).not.toContain("<details>");
  expect(fallback).not.toContain("<a");
});
