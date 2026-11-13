// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { chromium, firefox } from "@playwright/test";
import { createServer } from "vite";

export const columnWidths = { name: 120, status: 100, fact: 160, action: 120 };

// Stratified pages and repeated end-jumps, fixed seed so the old blank-viewport failure is reproducible.
export const paging = (() => {
  let seed = 0x4d4f42;
  const next = () => (seed = (Math.imul(seed, 1664525) + 0x3c6ef35f) >>> 0);
  return [1, ...Array.from({ length: 6 }, (_, i) => 2 + i * 3 + next() % 3), 20]
    .map(n => ({ loaded: n * 100, jumps: 1 + next() % 3 }));
})();

export async function phoneTableTest() {
  const server = await createServer({
    configFile: false, cacheDir: ".cache/phone-tables", logLevel: "error",
    define: { "process.env.VIRT_ON": JSON.stringify("1") },
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react-dom/client", "react-aria-components", "intl-messageformat", "@tanstack/react-query"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "phone-tables-test",
      resolveId: (id) => id === "/phone-tables.js" ? "\0phone-tables" : undefined,
      load: (id) => id === "\0phone-tables" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { i18n, loadCatalog } from '@console/i18n';
        import { Table } from '/apps/web/src/ui/table.tsx';
        import { LongTable } from '/apps/web/src/ui/long-table/long-table.tsx';
        import { NO_SELECTION } from '/apps/web/src/ui/long-table/selection.ts';
        import { RosterTable } from '/apps/web/src/features/people/ui/roster-table.tsx';
        import { OPTIONAL_COLUMNS } from '/apps/web/src/features/people/domain/columns.ts';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        i18n.set('en');
        const client = new QueryClient({defaultOptions: {queries: {enabled: false}}});
        const rows = Array.from({length: 100}, (_, i) => ({id: 'MOB-' + i}));
        const columns = [
          {id: 'name', header: 'Name', rowHeader: true, cell: r => r.id, width: ${columnWidths.name}},
          {id: 'status', header: 'Status', card: 'status', cell: () => 'Active', width: ${columnWidths.status}},
          ...['Unit', 'Position', 'Hired', 'Extra'].map(id => ({id, header: id, cell: () => 'Long unbroken value '.repeat(4), width: ${columnWidths.fact}})),
          {id: 'action', header: 'Action', card: 'action', cell: r => h('button', {onClick: () => document.getElementById('action').textContent = r.id}, 'Open ' + r.id), width: ${columnWidths.action}}
        ];
        const pagedRows = Array.from({length: 2000}, (_, i) => ({id: 'PAGE-' + i}));
        const paging = ${JSON.stringify(paging)};
        function Paged() {
          const [step, setStep] = useState(0);
          const loaded = paging[step].loaded;
          const [loadingMore, setLoadingMore] = useState(false);
          const rowMode = location.hash === '#paged-rows';
          const pagedColumns = columns.slice(0, -1).map(({card, ...column}) => ({...column,
            ...(rowMode ? {} : {card}), cell: r => column.id === 'name' ? r.id : 'A fictional department and position'}));
          return h('main', {'data-loaded': loaded, 'data-loading': loadingMore}, h('h1', null, 'Paged people'),
            h(LongTable, {label: 'Paged', rows: pagedRows.slice(0, loaded), columns: pagedColumns, rowId: r => r.id,
              density: location.hash === '#paged-compact' ? 'compact' : 'regular',
              hasMore: loaded < pagedRows.length, loadingMore, empty: 'Empty', onLoadMore() {
                if (loadingMore) return;
                setLoadingMore(true);
                requestAnimationFrame(() => {setStep(n => Math.min(n + 1, paging.length - 1)); setLoadingMore(false);});
              }}));
        }
        function App() {
          const [selected, select] = useState('');
          const [selection, setSelection] = useState(NO_SELECTION);
          const [open, setOpen] = useState('');
          if (location.hash.startsWith('#paged')) return h(Paged);
          if (location.hash === '#uncontained') return h('main', null,
            h('h1', null, 'Tables without cards'),
            ...['short', 'long'].map(kind => h('div', {id: kind + '-flex', style: {display: 'flex', containerType: 'inline-size', containerName: 'list-table'}},
              kind === 'short' ? h(Table, {label: 'Uncontained short', rows: rows.slice(0, 3), columns: columns.map(({card, ...c}) => ({...c, width: innerWidth / columns.length})), rowId: r => r.id})
              : h(LongTable, {label: 'Uncontained long', rows: rows.slice(0, 3), columns: columns.map(({card, ...c}) => ({...c, width: innerWidth / columns.length})), rowId: r => r.id, hasMore: false, onLoadMore() {}, empty: 'Empty'}))));
          if (location.hash === '#stack') return h('main', null, h('h1', null, 'Stack'), h(LongTable, {
            label: 'Stacked', caption: '2', find: {label: 'Find', onFind() {}}, rows: rows.slice(0, 2), columns, rowId: r => r.id, hasMore: false, onLoadMore() {}, empty: 'Empty'}));
          if (location.hash === '#roster') return h(QueryClientProvider, {client}, h('main', null,
            h('h1', null, 'People roster'), h(RosterTable, {label: 'Roster', today: '2026-01-01', density: 'compact', shown: OPTIONAL_COLUMNS,
              rows: [{id: 'roster-0', employee_number: 'MOB-ROSTER', name: '박모바일', company: '가상상사', org_unit: '아주긴가상지점소속부서', position: '사원', employment_type: 'REGULAR', status: 'ON_LEAVE', hire_date: '2025-01-01'}],
              hasMore: false, onLoadMore() {}, empty: 'Empty', selection, onSelectionChange: setSelection})));
          return h('main', null,
            h('h1', null, 'Phone tables'),
            h('div', {id: 'container'},
              h(Table, {label: 'Short', rows: rows.slice(0, 2), columns, rowId: r => r.id, selected, onSelect: select,
                detail: r => r.id === selected && h('span', null, 'Detail ' + r.id)}),
              h(LongTable, {label: 'Long', rows, columns, rowId: r => r.id, hasMore: false, onLoadMore() {}, empty: 'Empty',
                selection, onSelectionChange: setSelection, onRowAction: setOpen, rowKeys: {}})),
            h('output', {id: 'action'}, selected), h('output', {id: 'open'}, open));
        }
        createRoot(document.getElementById('root')).render(h(App));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/phone-tables") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone tables</title><div id="root"></div><script type="module" src="/phone-tables.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  const browser = await (process.env.E2E_XBROWSER === "1" ? firefox : chromium).launch();
  const page = await (await browser.newContext()).newPage();
  return { server, browser, page };
}
