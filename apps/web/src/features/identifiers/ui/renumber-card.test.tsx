// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import { chromium, type Browser, type Page } from "../../../lib/browser-test";
import { RenumberCard } from "./renumber-card";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

async function render(phase: "SETUP" | "OPERATING") {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <RenumberCard scopes={[{ kind: "TENANT", label: t("identifiers.scope.tenant") }]} phase={phase} />
  </QueryClientProvider>);
  await page.setContent(`<main>${html}</main>`);
  client.clear();
  return page.getByRole("region", { name: t("identifiers.renumber.title"), exact: true });
}

test("OPERATING replaces bulk renumbering with only the one-person path", async () => {
  const card = await render("OPERATING");
  expect(await card.locator("p").allTextContents()).toEqual([t("identifiers.renumber.whyAfter")]);
  expect(await card.locator("input,select,textarea,button").count()).toBe(0);
  expect(await card.getByRole("button", { name: t("identifiers.renumber.preview"), exact: true }).count()).toBe(0);
});

test("SETUP retains the scope, scheme, date, reason and preview form", async () => {
  const card = await render("SETUP");
  expect(await card.innerText()).toContain(t("identifiers.renumber.why"));
  expect(await card.innerText()).not.toContain(t("identifiers.renumber.whyAfter"));
  for (const key of ["scope", "width"] as const) expect(await card.getByRole("combobox", { name: t(`identifiers.renumber.${key}`) }).count()).toBe(1);
  expect(await card.getByRole("textbox", { name: t("identifiers.renumber.prefix") }).count()).toBe(1);
  expect(await card.getByLabel(t("identifiers.renumber.effective"), { exact: false }).count()).toBe(1);
  expect(await card.getByRole("radiogroup", { name: t("identifiers.renumber.reason") }).count()).toBe(1);
  expect(await card.getByRole("button", { name: t("identifiers.renumber.preview"), exact: true }).count()).toBe(1);
});
