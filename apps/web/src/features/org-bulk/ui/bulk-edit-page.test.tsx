// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "../../../lib/browser-test";
import type { LegalEntity } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { entitiesRef, kindsRef } from "../../../reference/entity/api";
import { BulkEditPage } from "./bulk-edit-page";
import { BulkHead } from "./bulk-head";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

const entity: LegalEntity = {
  id: "first-entity", needs_confirmation: false, identity_locked: true, founding: false, can_manage: true,
  head_office_has_no_workplace: false, scheduled: [], registrations: [], workplaces: [],
  regular_workers: { status: "HOLD", basis: "LSA_DECREE_7_2", missing: [], live_headcount: 0 },
};

async function render(items: typeof entity[], head?: { crumb?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  await client.fetchQuery({ ...entitiesRef, queryFn: async () => ({ items }) });
  await client.fetchQuery({ ...kindsRef, queryFn: async () => ({ items: [] }) });
  const root = createRootRoute({ component: () => head ? <BulkHead title="제목" crumb={head.crumb} under="대상"><span>{t("orgBulk.import.step.file")}</span></BulkHead> : <BulkEditPage /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  await page.setContent(renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
}

test("no legal entities offers registration without a dead bulk action", async () => {
  await render([]);
  expect(await page.getByRole("heading", { name: "등록된 법인이 없습니다" }).count()).toBe(1);
  expect(await page.getByRole("link", { name: "법인 등록" }).getAttribute("href")).toBe("/org/entities/new");
  expect(await page.getByRole("button", { name: /일괄 수정/ }).count()).toBe(0);
});

test("entities without open workplaces offer creation under the first returned entity", async () => {
  await render([entity, { ...entity, id: "second-entity" }]);
  expect(await page.getByRole("heading", { name: "열린 사업장이 없습니다" }).count()).toBe(1);
  const href = await page.getByRole("link", { name: "사업장 추가" }).getAttribute("href");
  const url = new URL(href!, "http://localhost");
  expect(url.pathname).toBe("/org");
  expect(url.searchParams.get("sel")).toBe(entity.id);
  expect(url.searchParams.get("act")).toBe("wp-create");
  expect(await page.getByRole("button", { name: /일괄 수정/ }).count()).toBe(0);
});

test("a head without a crumb has just one breadcrumb level", async () => {
  await render([], {});
  expect(await page.locator("nav li").count()).toBe(1);
  expect(await page.locator("nav").textContent()).toBe("조직 구조");
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  expect(await page.getByRole("link", { name: "닫고 조직 구조로" }).getAttribute("href")).toBe("/org");
});

test("a supplied crumb keeps the current level, context and wizard steps", async () => {
  await render([], { crumb: "가져오기" });
  expect(await page.locator('nav [aria-current="page"]').textContent()).toBe("가져오기");
  expect(await page.locator("nav li:empty").count()).toBe(0);
  expect(await page.getByText("대상", { exact: true }).count()).toBe(1);
  expect(await page.getByText(t("orgBulk.import.step.file"), { exact: true }).count()).toBe(1);
});
