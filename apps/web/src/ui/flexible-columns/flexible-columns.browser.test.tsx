// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/flexible-columns-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{
      name: "flexible-columns-test",
      resolveId: id => id === "/flexible-columns-test.js" ? "\0flexible-columns-test" : undefined,
      load: id => id === "\0flexible-columns-test" ? `
        import React, { useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog, t } from '@console/i18n';
        import { Button } from '/apps/web/src/ui/button/button.tsx';
        import { Dialog } from '/apps/web/src/ui/dialog.tsx';
        import { FlexibleColumns } from '/apps/web/src/ui/flexible-columns/flexible-columns.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function App() {
          const [sel, setSel] = useState(null);
          const [sel2, setSel2] = useState(null);
          const [opened, setOpened] = useState(null);
          const [dialog, setDialog] = useState(false);
          const findRef = useRef(null);
          const rowA = useRef(null);
          const rowB = useRef(null);
          const unitBtn = useRef(null);
          const selectRow = id => { setSel(id); setSel2(prev => (id === sel ? prev : null)); };
          return React.createElement('main', { className: 'main', 'data-opened': opened ?? '' },
            React.createElement(FlexibleColumns, {
              onSelect: selectRow,
              onOpen: id => setOpened(id),
              onFind: () => findRef.current?.focus(),
              list: React.createElement('section', { 'aria-label': '목록 영역' },
                React.createElement('input', { ref: findRef, type: 'search', 'aria-label': '목록 검색' }),
                React.createElement(Button, { ref: rowA, 'data-row-id': 'a', onClick: () => selectRow('a') }, '직원 A'),
                React.createElement(Button, { ref: rowB, 'data-row-id': 'b', onClick: () => selectRow('b') }, '직원 B'),
              ),
              record: sel && {
                id: sel,
                label: '직원 상세',
                closeLabel: t('roster.panel.close'),
                onClose: () => { setSel(null); setSel2(null); },
                returnFocus: () => (sel === 'b' ? rowB.current : rowA.current),
                children: React.createElement('div', null,
                  React.createElement('h2', null, sel === 'b' ? '상세 B' : '상세 A'),
                  React.createElement(Button, { ref: unitBtn, onClick: () => setSel2('unit-1') }, '인사팀 열기'),
                  React.createElement(Button, { onClick: () => setDialog(true) }, '모달 열기'),
                  React.createElement(Button, { 'aria-expanded': 'true' }, '열린 메뉴'),
                  React.createElement('input', { 'aria-label': '내부 입력' }),
                ),
              },
              related: sel && sel2 && {
                id: sel2,
                label: '소속 부서 상세',
                title: '인사팀',
                crumb: '본사 › 인사팀',
                expand: React.createElement('a', { href: '/org?sel=unit-1', className: 'btn' }, '전체 화면으로 열기'),
                closeLabel: t('common.closeRelated'),
                onClose: () => setSel2(null),
                returnFocus: () => unitBtn.current,
                children: React.createElement('div', null, '부서원 12명'),
              },
            }),
            React.createElement(Dialog, { open: dialog, title: '확인', onClose: () => setDialog(false) },
              React.createElement(Button, { onClick: () => setDialog(false) }, '닫기'),
            ),
          );
        }
        createRoot(document.getElementById('root')).render(React.createElement(App));
      ` : undefined,
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/columns-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Columns</title><div id="root"></div><script type="module" src="/flexible-columns-test.js"></script></html>' }));
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

const openFixture = async (width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("about:blank");
  await page.goto(`${server.resolvedUrls!.local[0]}columns-test`);
  await element(page.getByRole("button", { name: "직원 A", exact: true })).toBeVisible();
};

test("renders 1, 2, and 3 side-by-side columns at 1440px without overlapping the list", async () => {
  await openFixture(1440);
  const list = page.getByRole("region", { name: "목록 영역", exact: true });
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = page.getByRole("complementary", { name: "직원 상세", exact: true });
  await element(record).toBeVisible();
  await element(record.getByRole("button", { name: "돌아가기", includeHidden: true })).toBeHidden();
  await element(record.getByRole("button", { name: "직원 상세 닫기", exact: true })).toBeVisible();
  const list2 = (await list.boundingBox())!;
  const rec2 = (await record.boundingBox())!;
  expect(list2.x + list2.width).toBeLessThanOrEqual(rec2.x + 1);

  await record.getByRole("button", { name: "인사팀 열기", exact: true }).click();
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
  await element(related).toBeVisible();
  await element(related.getByRole("link", { name: "전체 화면으로 열기", exact: true })).toHaveAttribute("href", "/org?sel=unit-1");
  const list3 = (await list.boundingBox())!;
  const rec3 = (await record.boundingBox())!;
  const rel3 = (await related.boundingBox())!;
  expect(list3.x + list3.width).toBeLessThanOrEqual(rec3.x + 1);
  expect(rec3.x + rec3.width).toBeLessThanOrEqual(rel3.x + 1);
  expect(rel3.x + rel3.width).toBeLessThanOrEqual(1440);
});

test("drag-resize and keyboard arrow keys resize columns via CSS custom properties", async () => {
  await openFixture(1440);
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = page.getByRole("complementary", { name: "직원 상세", exact: true });
  const splitter = page.getByRole("separator", { name: "열 너비 조절" }).first();
  await element(splitter).toBeVisible();
  const initial = (await record.boundingBox())!.width;

  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2);
  await page.mouse.up();
  const dragged = (await record.boundingBox())!.width;
  expect(dragged).toBeGreaterThan(initial + 40);

  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  expect((await record.boundingBox())!.width).toBeLessThan(dragged);
  await page.keyboard.press("Home");
  expect(Math.round((await record.boundingBox())!.width)).toBe(Math.round(initial));
});

test("collapses to 2 visible columns below 1280px and single column + Back at 390px", async () => {
  await openFixture(1024);
  const list = page.getByRole("region", { name: "목록 영역", exact: true });
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = page.getByRole("complementary", { name: "직원 상세", exact: true });
  await element(list).toBeVisible();
  await element(record).toBeVisible();

  await record.getByRole("button", { name: "인사팀 열기", exact: true }).click();
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
  await element(list).toBeHidden();
  await element(record).toBeVisible();
  await element(related).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);

  await openFixture(390);
  const rowA = page.getByRole("button", { name: "직원 A", exact: true });
  await rowA.click();
  await element(list).toBeHidden();
  await element(record).toBeVisible();
  await element(record.getByRole("button", { name: "돌아가기", exact: true })).toBeVisible();
  await element(record.getByRole("button", { name: "직원 상세 닫기", includeHidden: true })).toBeHidden();

  await record.getByRole("button", { name: "인사팀 열기", exact: true }).click();
  await element(record).toBeHidden();
  await element(related).toBeVisible();
  await element(related.getByRole("button", { name: "돌아가기", exact: true })).toBeVisible();
  await element(related.getByRole("button", { name: "연관 항목 닫기", includeHidden: true })).toBeHidden();

  await related.getByRole("button", { name: "돌아가기", exact: true }).click();
  await element(related).toHaveCount(0);
  await element(record).toBeVisible();

  await record.getByRole("button", { name: "돌아가기", exact: true }).click();
  await element(record).toHaveCount(0);
  await element(list).toBeVisible();
  await element(rowA).toBeFocused();
});

test("Escape closes only the rightmost column, respects nested overlays/inputs, and '/' focuses search", async () => {
  await openFixture(1440);
  const rowA = page.getByRole("button", { name: "직원 A", exact: true });
  await rowA.click();
  const record = page.getByRole("complementary", { name: "직원 상세", exact: true });
  const unitBtn = record.getByRole("button", { name: "인사팀 열기", exact: true });
  await unitBtn.click();
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
  await element(related).toBeVisible();

  await record.getByRole("button", { name: "모달 열기", exact: true }).click();
  await element(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await element(page.getByRole("dialog")).toHaveCount(0);
  await element(related).toBeVisible();

  await record.getByRole("button", { name: "열린 메뉴", exact: true }).press("Escape");
  await element(related).toBeVisible();
  await record.getByRole("textbox", { name: "내부 입력", exact: true }).press("Escape");
  await element(related).toBeVisible();

  await related.getByRole("link", { name: "전체 화면으로 열기", exact: true }).focus();
  await page.keyboard.press("/");
  await element(page.getByRole("searchbox", { name: "목록 검색", exact: true })).toBeFocused();

  await related.getByRole("link", { name: "전체 화면으로 열기", exact: true }).focus();
  await page.keyboard.press("Escape");
  await element(related).toHaveCount(0);
  await element(record).toBeVisible();
  await element(unitBtn).toBeFocused();

  await page.keyboard.press("Escape");
  await element(record).toHaveCount(0);
  await element(rowA).toBeFocused();
});

test("J/K and arrow keys move through list rows while record follows, and Enter opens then expands", async () => {
  await openFixture(1440);
  const rowA = page.getByRole("button", { name: "직원 A", exact: true });
  const rowB = page.getByRole("button", { name: "직원 B", exact: true });
  const record = page.getByRole("complementary", { name: "직원 상세", exact: true });

  await rowA.focus();
  await page.keyboard.press("Enter");
  await element(record.getByRole("heading", { level: 2, name: "상세 A", exact: true })).toBeVisible();

  await page.keyboard.press("j");
  await element(rowB).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 B", exact: true })).toBeVisible();

  await page.keyboard.press("k");
  await element(rowA).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 A", exact: true })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await element(rowB).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 B", exact: true })).toBeVisible();

  await page.keyboard.press("Enter");
  await element(page.locator("main")).toHaveAttribute("data-opened", "b");
});
