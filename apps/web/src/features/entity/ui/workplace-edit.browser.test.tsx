// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { INFO_LABEL } from "../present";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/workplace-edit-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      hmr: false,
      fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] },
    },
    plugins: [
      {
        name: "workplace-edit-test",
        enforce: "pre",
        resolveId: (id, importer) =>
          id === "/workplace-edit-test.js"
            ? "\0workplace-edit-test"
            : /(?:^|\/)lib\/react\/command(?:\.ts)?$/.test(id)
              ? "\0command-stub"
              : (id === "../api" && importer?.includes("/features/entity/")) || /(?:^|\/)features\/entity\/api(?:\.ts)?$/.test(id)
                ? "\0entity-api-stub"
                : undefined,
        load: (id) =>
          id === "\0command-stub"
            ? `
          import { useState } from 'react';
          export function useCommand(opts) {
            const [isPending, setPending] = useState(false);
            return {
              isPending,
              error: null,
              mutate: async (v) => {
                setPending(true);
                try {
                  const res = await opts.run(v, 'idem-key');
                  window.announcedMsg = opts.announce?.(res, v) ?? '';
                  opts.onSuccess?.(res, v);
                } finally {
                  setPending(false);
                }
              },
            };
          }
        `
            : id === "\0entity-api-stub"
              ? `
          import { read } from '/apps/web/src/lib/query.ts';
          export class ApiError extends Error {}
          export const ENTITY_READS = [];
          export const stepKey = (k, n) => k + ':' + n;
          export const unserved = () => false;
          export const isStale = () => false;
          export const fieldIssues = () => [];
          export const addressQuery = () => read('/api/v1/regions', async () => ({ items: [] }));
          export const codesQuery = () => read('/api/v1/branches', async () => ({ items: [] }));
          export const reviseInsurance = async () => ({});
          export const reviseWorkplace = async (_key, workplaceId, body) => {
            window.savedBody = { workplaceId, body };
            return {};
          };
        `
              : id === "\0workplace-edit-test"
                ? `
          import { createElement as h } from 'react';
          import { createRoot } from 'react-dom/client';
          import { loadCatalog } from '@console/i18n';
          import { WorkplaceEdit } from '/apps/web/src/features/entity/ui/workplace-edit.tsx';
          import '/apps/web/src/app.css';
          await loadCatalog('ko');
          const mode = new URLSearchParams(location.search).get('mode') ?? 'first';
          const field = mode === 'phone' ? 'phone' : 'openedOn';
          const w = {
            id: 'wp-1',
            registration_id: null,
            not_registered_reason: null,
            is_abstract: false,
            insurance: [],
            current: {
              version: 2,
              effective_from: '2026-01-01',
              name: '본사',
              opened_on: mode === 'first' ? null : '2020-01-01',
              status: 'CONTINUING',
              is_construction_site: false,
              address: { source: 'MANUAL_UNVERIFIED', road_addr_part1: '서울특별시 종로구 세종대로 209' },
            },
          };
          const e = { id: 'ent-1', registrations: [], workplaces: [w] };
          window.closedFlag = false;
          createRoot(document.getElementById('root')).render(
            h(WorkplaceEdit, {
              e,
              w,
              field,
              setup: true,
              onClose: () => { window.closedFlag = true; },
            }),
          );
        `
                : undefined,
        configureServer: (vite) => {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/workplace-edit-test") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<html lang="ko"><title>Workplace edit</title><div id="root"></div><script type="module" src="/workplace-edit-test.js"></script></html>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  page.setDefaultTimeout(10_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("workplace first entry saves openedOn without asking effective date or reason", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}workplace-edit-test?mode=first`);
  const openedLabel = t("workplace.field.openedOn");
  const title = t("uiRecordActions.of", { field: openedLabel, verb: t("composer.verb.enter") });
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();

  expect(await dialog.getByRole("textbox", { name: new RegExp(`^${openedLabel}`) }).count()).toBe(1);
  expect(await dialog.getByRole("textbox", { name: new RegExp(`^${t("entity.edit.from")}`) }).count()).toBe(0);
  expect(await dialog.getByRole("radiogroup", { name: new RegExp(t("entity.edit.reason")) }).count()).toBe(0);
  expect(await dialog.getByText(t("entityOps.info.openedIsCorrection")).count()).toBe(0);
  expect(await dialog.getByText(/처음 기록\s*$/).count()).toBe(0);

  const enterButton = dialog.getByRole("button", { name: t("composer.verb.enter"), exact: true });
  expect(await enterButton.getAttribute("aria-disabled")).toBe("true");

  const openedBox = dialog.getByRole("textbox", { name: new RegExp(`^${openedLabel}`) });
  await openedBox.fill("2020-03-02");
  await openedBox.blur();
  expect(await enterButton.getAttribute("aria-disabled")).toBeNull();
  await enterButton.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { closedFlag?: boolean }).closedFlag)).toBe(true);

  const saved = await page.evaluate(() => (window as unknown as { savedBody?: unknown }).savedBody);
  expect(saved).toEqual({
    workplaceId: "wp-1",
    body: expect.objectContaining({
      name: "본사",
      opened_on: "2020-03-02",
      effective_from: "2026-01-01",
      reason_code: "ENTRY_CORRECTION",
      expected_version: 2,
    }),
  });
  expect(await page.evaluate(() => (window as unknown as { announcedMsg?: string }).announcedMsg)).toBe(
    t("entityRecord.revise.entered", { field: openedLabel }),
  );
});

test("correcting an existing workplace openedOn requires ENTRY_CORRECTION", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}workplace-edit-test?mode=correct`);
  const openedLabel = t("workplace.field.openedOn");
  const title = t("uiRecordActions.of", { field: openedLabel, verb: t("uiRecordVerbs.verb.correct") });
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();

  await dialog.getByRole("textbox", { name: new RegExp(`^${openedLabel}`) }).fill("2020-03-02");
  await dialog.getByRole("textbox", { name: new RegExp(`^${t("entity.edit.from")}`) }).fill("2026-04-01");
  const reasonGroup = dialog.getByRole("radiogroup", { name: new RegExp(t("entity.edit.reason")) });
  await reasonGroup.getByText(t("workplace.reason.RENAME"), { exact: true }).click();

  expect(await dialog.getByText(t("entityOps.info.openedIsCorrection")).count()).toBe(1);
  const saveButton = dialog.getByRole("button", { name: t("entity.edit.save"), exact: true });
  expect(await saveButton.getAttribute("aria-disabled")).toBe("true");

  await reasonGroup.getByText(t("workplace.reason.ENTRY_CORRECTION"), { exact: true }).click();
  expect(await dialog.getByText(t("entityOps.info.openedIsCorrection")).count()).toBe(0);
  expect(await saveButton.getAttribute("aria-disabled")).toBeNull();
});

test("revising another workplace field when openedOn is unchanged allows CONTACT_CHANGE", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}workplace-edit-test?mode=phone`);
  const phoneLabel = INFO_LABEL.phone();
  const title = t("uiRecordActions.of", { field: phoneLabel, verb: t("uiRecordActions.edit") });
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();

  await dialog.getByRole("textbox", { name: new RegExp(`^${phoneLabel}`) }).fill("02-1234-5678");
  await dialog.getByRole("textbox", { name: new RegExp(`^${t("entity.edit.from")}`) }).fill("2026-04-01");
  const reasonGroup = dialog.getByRole("radiogroup", { name: new RegExp(t("entity.edit.reason")) });
  await reasonGroup.getByText(t("workplace.reason.CONTACT_CHANGE"), { exact: true }).click();

  expect(await dialog.getByText(t("entityOps.info.openedIsCorrection")).count()).toBe(0);
  const saveButton = dialog.getByRole("button", { name: t("entity.edit.save"), exact: true });
  expect(await saveButton.getAttribute("aria-disabled")).toBeNull();
});
