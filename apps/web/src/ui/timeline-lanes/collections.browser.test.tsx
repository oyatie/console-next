// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/collections-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react-dom/client", "intl-messageformat", "lucide-react", "react-aria-components"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "collections-test",
      resolveId: id => id === "/collections-test.js" ? "\0collections-test" : undefined,
      load: id => id === "\0collections-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { TimelineLanes } from '/apps/web/src/ui/timeline-lanes/timeline-lanes.tsx';
        import { RevisionItems } from '/apps/web/src/features/entity/ui/history-tab.tsx';
        import { ItemList } from '/apps/web/src/ui/item-list/item-list.tsx';
        import { Card } from '/apps/web/src/ui/card/card.tsx';
        import { KeyValue } from '/apps/web/src/ui/key-value/key-value.tsx';
        import { TreeView } from '/apps/web/src/ui/tree/tree.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const initial = Array.from({length: 2000}, (_, i) => ({key: 'event-' + i, id: 'ev-' + i, date: '2026-10-01', title: 'Event ' + i}));
        const nodes = [{id: 'alpha', name: 'Alpha', children: [{id: 'beta', name: 'Beta', children: []}]}, {id: 'zulu', name: 'Zulu', children: []}];
        function Demo() {
          const [items, setItems] = useState(initial);
          const [expanded, setExpanded] = useState(new Set(['alpha']));
          const mode = new URLSearchParams(location.search).get('mode');
          if (mode === 'history') return h('section', {className: 'card panel'}, h(RevisionItems, {items: [{
            version: 1, effective_from: '2026-10-26', recorded_at: '2026-10-26T12:14:00Z', change_mode: 'SETUP',
            changes: [
              {field: 'vat_unit_mode', before: null, after: 'OWN'},
              {field: 'insurance.IACI.mgmt_no', before: null, after: '12345678901'},
              {field: 'trade_name', before: '이전 상호', after: '현재 상호'},
            ],
          }]}));
          const tree = {label: 'Organization', roots: nodes, childrenOf: n => n.children, textValue: n => n.name, row: n => n.name, onSelect: () => {}, expanded, onExpandedChange: setExpanded};
          return h('main', null,
            h('button', {id: 'insert', onClick: () => setItems(xs => [{key: 'new', id: 'ev-new', date: '2026-10-02', title: 'New event'}, ...xs])}, 'Insert'),
            h(TimelineLanes, mode === 'single' ? {items} : {upcoming: initial.map(x => ({...x, key: 'future-' + x.key, id: 'future-' + x.id})), past: items, labels: {upcoming: 'Upcoming', today: 'Today', past: 'Past'}}),
            h(TreeView, tree),
            h(TreeView, {...tree, label: 'Empty tree', roots: [], empty: 'Nothing here'}),
            h(TreeView, {...tree, label: 'Failed tree', roots: [], error: 'Unavailable'}),
            h(ItemList, {items: [{key: 'select', text: 'Select', onSelect: () => {}}]}),
            h(Card, {title: 'Loading', loading: true}),
            h(KeyValue, {label: 'Empty facts', items: [], empty: 'Nothing here'}));
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/collections-test?")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="ko"><title>Collections</title><div id="root"></div><script type="module" src="/collections-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(5000);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
const open = async (mode = "single") => {
  await page.goto(`${server.resolvedUrls!.local[0]}collections-test?mode=${mode}`);
  await page.locator("#insert").waitFor();
};

test.each(["single", "dual"])("%s: every one of 2,000 events is reachable with a bounded DOM", async mode => {
  await open(mode);
  const lane = mode === "single" ? page.locator("main") : page.getByRole("region", { name: "Past", exact: true });
  const seen: string[] = [];
  for (;;) {
    const rows = lane.locator('li[id^="ev-"]');
    expect(await rows.count()).toBeLessThanOrEqual(50);
    seen.push(...await rows.evaluateAll(xs => xs.map(x => x.id)));
    const next = lane.getByRole("button", { name: "다음 페이지", exact: true });
    if (await next.isDisabled()) break;
    await next.click();
  }
  expect(seen).toEqual(Array.from({ length: 2000 }, (_, i) => `ev-${i}`));
  if (mode === "dual") expect(await page.getByRole("region", { name: "Upcoming", exact: true }).getByRole("navigation").count()).toBe(1);
}, 30_000);

test.each(["single", "dual"])("%s: a live insert keeps the first visible record and keyboard focus", async mode => {
  await open(mode);
  const lane = mode === "single" ? page.locator("main") : page.getByRole("region", { name: "Past", exact: true });
  await lane.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await page.locator("#ev-51").focus();
  // A background update must not take focus like a pointer click would.
  await page.locator("#insert").dispatchEvent("click");
  await page.waitForFunction(() => document.querySelector(".pager")?.textContent?.includes("2,001") || [...document.querySelectorAll(".pager")].some(el => el.textContent?.includes("2,001")));
  expect(await lane.locator('li[id^="ev-"]').first().getAttribute("id")).toBe("ev-50");
  expect(await page.locator("#ev-51").evaluate(el => el === document.activeElement)).toBe(true);
  await lane.getByRole("button", { name: "이전 페이지", exact: true }).click();
  expect(await lane.locator('li[id^="ev-"]').first().getAttribute("id")).toBe("ev-new");
});

test.each(["single", "dual"])("%s: the first page follows new records without moving focus", async mode => {
  await open(mode);
  const lane = mode === "single" ? page.locator("main") : page.getByRole("region", { name: "Past", exact: true });
  await page.locator("#ev-1").focus();
  await page.locator("#insert").dispatchEvent("click");
  await page.locator("#ev-new").waitFor();
  expect(await lane.locator('li[id^="ev-"]').first().getAttribute("id")).toBe("ev-new");
  expect(await lane.getByRole("button", { name: "이전 페이지", exact: true }).isDisabled()).toBe(true);
  expect(await page.locator("#ev-1").evaluate(el => el === document.activeElement)).toBe(true);
});

test("tree supports arrows, Home, End and type-ahead; empty and error keep named widgets", async () => {
  await open();
  const tree = page.getByRole("treegrid", { name: "Organization", exact: true });
  const rows = tree.getByRole("row");
  await rows.first().focus();
  for (const [key, name] of [["ArrowDown", "Beta"], ["ArrowUp", "Alpha"], ["End", "Zulu"], ["Home", "Alpha"], ["z", "Zulu"]]) {
    await page.keyboard.press(key!);
    expect(await tree.getByRole("row", { name: name!, exact: true }).evaluate(el => el === document.activeElement || el.contains(document.activeElement))).toBe(true);
  }
  expect(await page.getByRole("treegrid", { name: "Empty tree" }).textContent()).toContain("Nothing here");
  expect(await page.getByRole("treegrid", { name: "Failed tree" }).getByRole("alert").textContent()).toContain("Unavailable");
  expect(await page.locator('dl[aria-label="Empty facts"]').textContent()).toContain("Nothing here");
});

test("selectable list rows have visible focus and card skeletons have a height", async () => {
  await open();
  await page.getByRole("button", { name: "Select", exact: true }).focus();
  expect(await page.getByRole("button", { name: "Select", exact: true }).evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  const skeleton = page.locator('section[aria-busy="true"] [role="status"] > div').first();
  expect((await skeleton.boundingBox())!.height).toBeGreaterThan(0);
});

test.each(["light", "dark"])("390 px entity history keeps Korean field labels within two lines (%s)", async theme => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.resolvedUrls!.local[0]}collections-test?mode=history`);
  await page.locator("dt").first().waitFor();
  await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
  await page.evaluate(() => document.fonts.ready);
  const labels = await page.locator("dt").evaluateAll(elements => elements.map(el => ({
    text: el.textContent,
    lines: el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
  })));
  expect(labels.map(label => label.text)).toEqual(["부가가치세 신고 단위", "산재보험 관리번호", "상호"]);
  for (const label of labels) expect(label.lines, label.text!).toBeLessThanOrEqual(2);
});
