// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "vitest";
import { expect as element, type Page } from "@playwright/test";
import { columnsFixture } from "./flexible-columns.browser-fixture";

const recordColumn = (page: Page) => page.getByRole("complementary", { name: "직원 상세", exact: true });

const columnTest = columnsFixture(`
  import React, { useLayoutEffect, useRef, useState } from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { loadCatalog, t } from '@console/i18n';
  import { Button } from '/apps/web/src/ui/button/button.tsx';
  import { Dialog } from '/apps/web/src/ui/dialog.tsx';
  import { FlexibleColumns } from '/apps/web/src/ui/flexible-columns/flexible-columns.tsx';
  import '/apps/web/src/app.css';
  await loadCatalog('ko');
  function App() {
    const [sel, setSel] = useState(null);
    const [full, setFull] = useState(new URLSearchParams(location.search).has("full"));
    const [sel2, setSel2] = useState(null);
    const [opened, setOpened] = useState(null);
    const [dialog, setDialog] = useState(false);
    const findRef = useRef(null);
    const rowA = useRef(null), rowB = useRef(null);
    const unitBtn = useRef(null);
    useLayoutEffect(() => { if (sel === 'b' && new URLSearchParams(location.search).has('enterOnCommit')) rowB.current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, [sel]);
    const selectRow = id => { setSel(id); setSel2(prev => (id === sel ? prev : null)); };
    return React.createElement('main', { className: 'main', 'data-opened': opened ?? '', 'data-selected': sel ?? '' },
      React.createElement(FlexibleColumns, {
        full, onFull: new URLSearchParams(location.search).has("fixed") ? undefined : setFull,
        onSelect: selectRow,
        onOpen: id => setOpened(id),
        onFind: () => findRef.current?.focus(),
        list: React.createElement('section', { 'aria-label': '목록 영역' },
          React.createElement('input', { ref: findRef, type: 'search', 'aria-label': '목록 검색' }),
          React.createElement(Button, { ref: rowA, 'data-row-id': 'a', onClick: () => selectRow('a') }, '직원 A'),
          React.createElement(Button, { ref: rowB, 'data-row-id': 'b', onClick: () => selectRow('b') }, '직원 B'),
          React.createElement('div', { role: 'tree', 'aria-label': '부서' },
            React.createElement('div', { role: 'treeitem', tabIndex: 0, 'data-id': 'tree-a' }, '부서 A'),
            React.createElement('div', { role: 'treeitem', tabIndex: -1, 'data-id': 'tree-b' }, '부서 B'),
          ),
        ),
        record: sel && {
          id: sel,
          label: '직원 상세',
          closeLabel: t('roster.panel.close'),
          onClose: () => { setSel(null); setSel2(null); setFull(false); },
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
          onClose: () => { setSel2(null); setFull(false); },
          returnFocus: () => unitBtn.current,
          children: React.createElement('div', null, '부서원 12명'),
        },
      }),
      React.createElement(Dialog, { open: dialog, title: '확인', onClose: () => setDialog(false) },
        React.createElement(Button, { onClick: () => setDialog(false) }, '닫기'),
      ),
    );
  }
  const root = createRoot(document.getElementById('root'));
  let revision = 0;
  window.mountColumns = search => {
    history.replaceState(null, '', '/columns-test' + search);
    flushSync(() => root.render(React.createElement(App, { key: ++revision })));
  };
  window.mountColumns('');
`);

columnTest("renders 1, 2, and 3 side-by-side columns at 1440px without overlapping the list", 1440, async page => {
  const list = page.getByRole("region", { name: "목록 영역", exact: true });
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = recordColumn(page);
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

columnTest("drag-resize and keyboard arrow keys resize columns via CSS custom properties", 1440, async page => {
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = recordColumn(page);
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

columnTest("collapses to 2 visible columns below 1280px", 1024, async page => {
  const list = page.getByRole("region", { name: "목록 영역", exact: true });
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = recordColumn(page);
  await element(list).toBeVisible();
  await element(record).toBeVisible();

  await record.getByRole("button", { name: "인사팀 열기", exact: true }).click();
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
  await element(list).toBeHidden();
  await element(record).toBeVisible();
  await element(related).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
});

columnTest("shows one column and Back at 390px", 390, async page => {
  const list = page.getByRole("region", { name: "목록 영역", exact: true });
  const record = recordColumn(page);
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
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

columnTest("Escape closes only the rightmost column, respects nested overlays/inputs, and '/' focuses search", 1440, async page => {
  const rowA = page.getByRole("button", { name: "직원 A", exact: true });
  await rowA.click();
  const record = recordColumn(page);
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

for (const enterOnCommit of [false, true]) columnTest(`J/K and arrow keys move through list rows while record follows, and Enter opens then expands (Enter during commit: ${enterOnCommit})`, 1440, async page => {
  const rowA = page.getByRole("button", { name: "직원 A", exact: true });
  const rowB = page.getByRole("button", { name: "직원 B", exact: true });
  const record = recordColumn(page);

  await rowA.focus();
  await page.keyboard.press("Enter");
  await element(record.getByRole("heading", { level: 2, name: "상세 A", exact: true })).toBeVisible();

  await page.keyboard.press("j");
  await element(rowB).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 B", exact: true })).toBeVisible();
  // Enter during the commit must see the same selection as the rendered record.
  if (enterOnCommit) await element(page.locator("main")).toHaveAttribute("data-opened", "b");

  await page.keyboard.press("k");
  await element(rowA).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 A", exact: true })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await element(rowB).toBeFocused();
  await element(record.getByRole("heading", { level: 2, name: "상세 B", exact: true })).toBeVisible();

  await page.keyboard.press("Enter");
  await element(page.locator("main")).toHaveAttribute("data-opened", "b");
}, enterOnCommit ? "?enterOnCommit" : "");

for (const width of [1440, 1024]) for (const depth of [1, 2]) for (const close of ["Escape", "button"]) {
  columnTest(`rightmost full pane at ${width}px depth ${depth}: restore and close by ${close}`, width, async page => {
    const row = page.getByRole("button", { name: "직원 A", exact: true });
    await row.click();
    const record = recordColumn(page);
    const unit = record.getByRole("button", { name: "인사팀 열기", exact: true });
    if (depth === 2) await unit.click();
    const pane = depth === 2 ? page.getByRole("complementary", { name: "소속 부서 상세", exact: true }) : record;
    const toggle = pane.getByRole("button", { name: "전체 화면으로 보기", exact: true });
    await element(page.getByRole("button", { name: "전체 화면으로 보기", exact: true })).toHaveCount(1);
    await element(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await element(toggle).toHaveAttribute("aria-pressed", "true");
    await element(toggle).toBeFocused();
    await element(page.getByRole("region", { name: "목록 영역" })).toBeHidden();
    await element(page.getByRole("separator")).toHaveCount(0);
    if (depth === 2) await element(record).toBeHidden();
    const root = (await page.locator("[data-flexible-columns]").boundingBox())!;
    expect((await pane.boundingBox())!.width).toBeCloseTo(root.width, 0);
    if (close === "Escape") {
      for (const key of ["j", "k", "ArrowDown", "ArrowUp"]) await page.keyboard.press(key);
      await element(page.locator("main")).toHaveAttribute("data-selected", "a");
      await page.keyboard.press("Escape");
    } else {
      await toggle.click();
    }
    await element(toggle).toHaveAttribute("aria-pressed", "false");
    await element(toggle).toBeFocused();
    await element(record).toBeVisible();
    await element(page.getByRole("separator")).toHaveCount(depth);
    if (close === "Escape") {
      await page.keyboard.press("Escape");
    } else {
      await toggle.click();
      await pane.getByRole("button", { name: depth === 2 ? "연관 항목 닫기" : "직원 상세 닫기", exact: true }).click();
    }
    await element(pane).toHaveCount(0);
    await element(page.locator("[data-flexible-columns]")).not.toHaveAttribute("data-full");
    await element(depth === 2 ? unit : row).toBeFocused();
  });
}

columnTest("phone ignores full, hides the toggle and closes on the first Escape", 390, async page => {
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const record = recordColumn(page);
  await record.getByRole("button", { name: "인사팀 열기", exact: true }).click();
  const related = page.getByRole("complementary", { name: "소속 부서 상세", exact: true });
  await element(page.getByRole("button", { name: "전체 화면으로 보기", exact: true })).toHaveCount(0);
  await element(record).toBeHidden();
  expect((await related.boundingBox())!.width).toBeLessThanOrEqual(390);
  await related.getByRole("heading").press("Escape");
  await element(related).toHaveCount(0);
  await element(record).toBeVisible();
}, "?full=1");

columnTest("tree rows own their J/K, arrows, Enter and focus-follow", 1440, async page => {
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  const treeRow = page.getByRole("treeitem", { name: "부서 A", exact: true });
  await treeRow.focus();
  await page.waitForTimeout(250);
  await element(page.locator("main")).toHaveAttribute("data-selected", "a");
  for (const key of ["j", "k", "ArrowDown", "ArrowUp", "Enter"]) {
    await treeRow.press(key);
    await element(treeRow).toBeFocused();
    await element(page.locator("main")).toHaveAttribute("data-opened", "");
    await element(page.getByRole("heading", { name: "상세 A", exact: true })).toBeVisible();
  }
});

columnTest("surfaces without onFull keep their existing controls", 1440, async page => {
  await page.getByRole("button", { name: "직원 A", exact: true }).click();
  await element(page.getByRole("button", { name: "전체 화면으로 보기", exact: true })).toHaveCount(0);
}, "?fixed");
