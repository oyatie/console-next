// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import path from "node:path";
import { loadCatalog, t } from "@console/i18n";
import { createServer, type Plugin } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const ENTRY_SRC = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadCatalog } from '@console/i18n';
import { NameBox } from '/apps/web/src/features/structure/ui/name-box.tsx';
import { DeptDetails } from '/apps/web/src/features/org/ui/dept-details.tsx';
import { WorkplaceMoveSheet } from '/apps/web/src/features/entity/ui/workplace-move-sheet.tsx';
import '/apps/web/src/app.css';
await loadCatalog('ko');
const sheet = new URLSearchParams(location.search).get('sheet');
const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ items: [] }) } } });
const box = { node: { id: 'site', kind: 'site', name: '본사', headcount: 0, chips: [], depth: 2, children: [] }, lod: 'm', x: 0, y: 0, w: 192, h: 108, ghost: true };
const parentBefore = { id: 'site', kind: 'site', name: '본사', headcount: 0, chips: [], depth: 2, children: [] };
          const parentAfter = {
            ...parentBefore,
            children: [{ id: 'created', kind: 'dept', name: '개발팀', headcount: 0, chips: [], depth: 3, children: [] }],
          };
          const deptBefore = { id: 'dept-1', kind: 'DEPARTMENT', name: '인사팀', code: 'HR-1', version: 1, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [] };
          const deptAfter = { ...deptBefore, code: 'HR-2', version: 2 };
          const wpBefore = {
            id: 'wp-1',
            registration_id: null,
            not_registered_reason: null,
            is_abstract: false,
            headcount: 0,
            insurance: [],
            current: {
              version: 2,
              effective_from: '2026-01-01',
              name: '본사',
              opened_on: '2020-01-01',
              status: 'CONTINUING',
              is_construction_site: false,
              address: { source: 'MANUAL_UNVERIFIED', road_addr_part1: '서울특별시 종로구 세종대로 209', zip_no: '03171' },
            },
          };
          const wpAfter = {
            ...wpBefore,
            current: {
              ...wpBefore.current,
              version: 3,
              address: { source: 'MANUAL_UNVERIFIED', road_addr_part1: '서울특별시 종로구 세종대로 209', detail: '3층', zip_no: '03171' },
            },
          };
          const entBefore = { id: 'ent-1', registrations: [], workplaces: [wpBefore] };
          const entAfter = { id: 'ent-1', registrations: [], workplaces: [wpAfter] };
          function Demo() {
            const [applied, setApplied] = useState(false);
            window.applyRefetch = () => flushSync(() => setApplied(true));
            if (sheet === 'move') {
              return h(
                QueryClientProvider,
                { client },
                h(WorkplaceMoveSheet, {
                  e: applied ? entAfter : entBefore,
                  w: applied ? wpAfter : wpBefore,
                  onClose: () => {},
                }),
              );
            }
            return h(
              QueryClientProvider,
              { client },
              h('div', null,
                h(NameBox, {
                  box,
                  parent: applied ? parentAfter : parentBefore,
                  pending: applied,
                  onSubmit: () => {},
                  onCancel: () => { window.cancelled = true; },
                }),
                h(DeptDetails, {
                  node: applied ? deptAfter : deptBefore,
                  onDone: () => {},
                }),
              ),
            );
          }
          createRoot(document.getElementById('root')).render(h(Demo));
`;

const harness: { baseUrl?: string; browser?: Browser; page?: Page; stop?: () => Promise<void> } = {};

const fixturePlugin: Plugin = {
  name: "relayout-fixture",
  enforce: "pre",
  resolveId(spec) {
    if (spec === "/entry.js") return "\0entry";
    if (/(?:^|\/)lib\/react\/command(?:\.ts)?$/.test(spec)) return "\0cmd";
    return undefined;
  },
  load(spec) {
    if (spec === "\0cmd") return "export const useCommand = () => ({ isPending: false, error: null, mutate: () => {} });";
    return spec === "\0entry" ? ENTRY_SRC : undefined;
  },
  configureServer(dev) {
    dev.middlewares.use("/relayout", (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end('<html lang="ko"><title>Relayout</title><div id="root"></div><script type="module" src="/entry.js"></script></html>');
    });
  },
};

beforeAll(async () => {
  await loadCatalog("ko");
  const vite = await createServer({
    cacheDir: ".cache/relayout-fixture",
    configFile: false,
    logLevel: "silent",
    optimizeDeps: browserTestOptimizeDeps,
    plugins: [fixturePlugin],
    resolve: { dedupe: ["react", "react-dom"] },
    server: { fs: { allow: [path.resolve("."), realpathSync("node_modules/pretendard")] }, hmr: false, host: "127.0.0.1", port: 0, watch: null },
  });
  await vite.listen();
  harness.baseUrl = vite.resolvedUrls!.local[0];
  harness.browser = await chromium.launch();
  harness.page = await harness.browser.newPage({ viewport: { width: 1440, height: 900 } });
  harness.page.setDefaultTimeout(10_000);
  harness.stop = () => vite.close();
}, 60_000);

afterAll(async () => {
  await harness.browser?.close();
  await harness.stop?.();
});

test("the inline name input keeps focus and Escape while a save is pending", async () => {
  const page = harness.page!;
  await page.goto(`${harness.baseUrl}relayout`);
  const input = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: "본사" }), exact: true });
  await input.fill("개발팀");
  await page.evaluate(() => (window as unknown as { applyRefetch: () => void }).applyRefetch());
  expect(await input.evaluate(el => el === document.activeElement)).toBe(true);
  await input.press("Escape");
  expect(await page.evaluate(() => (window as unknown as { cancelled?: boolean }).cancelled)).toBe(true);
});

test("refetched structure reads during settle do not flash duplicate-name alerts or nothing-changed blocks", async () => {
  const page = harness.page!;
  await page.goto(`${harness.baseUrl}relayout`);
  const nameInput = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: "본사" }), exact: true });
  await nameInput.fill("개발팀");
  const codeInput = page.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.fact.code")}`) });
  await codeInput.fill("HR-2");

  const submitDetails = page.getByRole("button", { name: /부서 정보/ });
  expect(await page.getByRole("alert").count()).toBe(0);
  expect(await submitDetails.getAttribute("aria-disabled")).toBeNull();

  await page.evaluate(() => (window as unknown as { applyRefetch: () => void }).applyRefetch());

  expect(await nameInput.getAttribute("aria-invalid")).toBeNull();
  expect(await page.getByRole("alert").count()).toBe(0);
  expect(await submitDetails.getAttribute("aria-disabled")).toBeNull();
});

test("workplace move sheet keeps its ready state when FreshEntity refetches before close", async () => {
  const page = harness.page!;
  await page.goto(`${harness.baseUrl}relayout?sheet=move`);
  await page.getByText(t("entityOps.move.mode.CORRECTION"), { exact: true }).click();
  await page.getByRole("textbox", { name: new RegExp(t("uiAddressField.detail")) }).fill("3층");

  const save = page.getByRole("button", { name: t("entityOps.move.save") });
  expect(await save.getAttribute("aria-disabled")).toBeNull();

  await page.evaluate(() => (window as unknown as { applyRefetch: () => void }).applyRefetch());

  expect(await save.getAttribute("aria-disabled")).toBeNull();
  expect(await page.getByText(t("entityOps.move.sameAddress")).count()).toBe(0);
});
