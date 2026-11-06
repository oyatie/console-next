// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { chromium, type Browser, type Page } from "../../../lib/browser-test";
import { AccessLogFiltersForm } from "./access-log-filters";

let browser: Browser;
let page: Page;
beforeAll(async () => { await loadCatalog(); browser = await chromium.launch(); page = await browser.newPage(); }, 60_000);
afterAll(async () => { await browser?.close(); });

test.each([
  ["2026-02-10", "2026-02-28", false, false],
  ["2026-02-10", "2026-02-09", false, true],
  ["2026-01-31", "2026-03-01", true, true],
])("filter dates %s–%s use the server's monthly boundaries and labels", async (from, to, invalidFrom, invalidTo) => {
  const html = renderToStaticMarkup(<AccessLogFiltersForm value={{ from, to }}
      options={{ actors: [{ id: "actor-1", label: "김민수" }], actions: [], target_types: [] }}
      period={{ from: "2026-02-01", to: "2026-03-01" }} onApply={() => {}} />);
  await page.setContent(html);
  expect(await page.getByLabel("시작일", { exact: true }).getAttribute("aria-invalid")).toBe(invalidFrom ? "true" : null);
  expect(await page.getByLabel("종료일", { exact: true }).getAttribute("aria-invalid")).toBe(invalidTo ? "true" : null);
  expect(await page.getByRole("option", { name: "김민수", exact: true }).getAttribute("value")).toBe("actor-1");
});
