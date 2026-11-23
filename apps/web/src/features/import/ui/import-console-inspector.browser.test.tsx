// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { expect as visible } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../../lib/browser-test";
import { rrn } from "../../../../../../e2e/helpers/import-layouts";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

const HARNESS_CODE = `
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure } from '@console/api';
import { loadCatalog } from '@console/i18n';
import { ImportConsoleInspector } from '/apps/web/src/features/import/ui/import-console-inspector.tsx';
import { initialPicks } from '/apps/web/src/features/import/domain/steps.ts';
import '/apps/web/src/app.css';
configure({ baseUrl: location.origin, refresh: { kind: 'cookie' }, passkeys: { get: async () => ({ id: 'proof' }), create: async () => null } });
await loadCatalog('ko');
const rows = [
  { source_key: 'S1:2', sheet: 'S1', row: 2, name: 'RowA', outcome: 'insert', new_person: { status: 'PRE_HIRE', id_type: 'NOT_ISSUED', hire_date: '2026-12-01', migrated_former: false, employee_number: '10001' } },
  { source_key: 'S1:3', sheet: 'S1', row: 3, name: 'RowB', outcome: 'insert', new_person: { status: 'PRE_HIRE', id_type: 'NOT_ISSUED', hire_date: '2026-12-01', migrated_former: false, employee_number: '10002' } },
];
function Harness() {
  const [idx, setIdx] = useState(0);
  const [dry, setDry] = useState({
    run_id: 'run-1', input_rows: 2, candidate_rows: 2, preserved_rows: 0,
    insert_candidates: 2, update_candidates: 0, unchanged_rows: 0, excluded_rows: 0, unsettled_rows: 0,
    companies: [], org_unit_bound_rows: 2, org_unit_unbound_rows: 0, unresolved_org_units: [],
    dry_run_digest: 'a'.repeat(64), decisions: {}, remembered: [], auto_mapped: [],
    employment_type_empty_rows: 0, unplaced: { rows: 0, by_reason: {} }, phone_unstored_rows: 0,
    review: { count: 0, blocking: 0, items: [], groups: [] }, rows,
  });
  return createElement('div', null,
    createElement('button', { type: 'button', 'data-testid': 'switch-a', onClick: () => setIdx(0) }, 'RowA'),
    createElement('button', { type: 'button', 'data-testid': 'switch-b', onClick: () => setIdx(1) }, 'RowB'),
    createElement(ImportConsoleInspector, {
      dry, picks: initialPicks(), currentItem: undefined, activeRow: dry.rows[idx],
      sexMapped: false, busy: false, onResolve: () => undefined, onSheets: () => undefined, onDryRun: setDry,
    }),
  );
}
createRoot(document.getElementById('root')).render(
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Harness)),
);
`;

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/inspector-row-id-test",
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "inspector-row-id-plugin",
      resolveId: (id) => (id === "/harness.js" ? "\0harness" : undefined),
      load: (id) => (id === "\0harness" ? HARNESS_CODE : undefined),
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><html lang="ko"><head><title>Inspector</title></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  await page.route("**/api/v1/auth/passkey/step-up/start", (route) =>
    route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } }),
  );
});

afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("switching activeRow unmounts RowIdentifierControl and clears value, idType, derivedSex, and error; 503 rrn_vault_unavailable stays retryable", async () => {
  let attempts = 0;
  await page.route("**/api/v1/employees/import/run-1/rows/*/identifier", (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({ status: 503, json: { error: { code: "rrn_vault_unavailable", message: "vault unavailable" } } });
    }
    if (attempts === 2) {
      return route.fulfill({ status: 422, json: { error: { code: "rrn_mod11_invalid", message: "bad check digit" } } });
    }
    return route.fulfill({ status: 200, json: { run_id: "run-1", source_key: "S1:3", id_type: "DOMESTIC_RESIDENCE", recorded: true, sex_derived: "FEMALE" } });
  });
  await page.route("**/api/v1/employees/import/run-1/dry-run", (route) =>
    route.fulfill({
      status: 200,
      json: {
        run_id: "run-1",
        input_rows: 2,
        candidate_rows: 2,
        preserved_rows: 0,
        insert_candidates: 2,
        update_candidates: 0,
        unchanged_rows: 0,
        excluded_rows: 0,
        unsettled_rows: 0,
        companies: [],
        org_unit_bound_rows: 2,
        org_unit_unbound_rows: 0,
        unresolved_org_units: [],
        dry_run_digest: "b".repeat(64),
        decisions: {},
        remembered: [],
        auto_mapped: [],
        employment_type_empty_rows: 0,
        unplaced: { rows: 0, by_reason: {} },
        phone_unstored_rows: 0,
        review: { count: 0, blocking: 0, items: [], groups: [] },
        rows: [
          { source_key: "S1:2", sheet: "S1", row: 2, name: "RowA", outcome: "insert", new_person: { status: "PRE_HIRE", id_type: "NOT_ISSUED", hire_date: "2026-12-01", migrated_former: false, employee_number: "10001" } },
          { source_key: "S1:3", sheet: "S1", row: 3, name: "RowB", outcome: "insert", new_person: { status: "PRE_HIRE", id_type: "DOMESTIC_RESIDENCE", sex: "FEMALE", hire_date: "2026-12-01", migrated_former: false, employee_number: "10002" } },
        ],
      },
    }),
  );

  await openBrowserTestPage(page, server.resolvedUrls!.local[0]!, page.getByRole("combobox"));

  const idSelect = page.getByRole("combobox");
  const rrnInput = page.locator("input").first();
  const submitBtn = page.getByRole("button").last();

  const synthetic = rrn("1995-05-05", 6, 12345);
  await rrnInput.fill(synthetic);
  await idSelect.selectOption("DOMESTIC_RESIDENCE");
  await submitBtn.click();

  await expect.poll(() => attempts).toBe(1);
  await page.getByRole("alert").waitFor();

  // Retry after 503 rrn_vault_unavailable must NOT be locked
  await rrnInput.fill(synthetic);
  await visible(submitBtn).toBeEnabled();
  await submitBtn.click();
  await expect.poll(() => attempts).toBe(2);
  await visible(page.getByRole("alert")).toBeVisible();

  // Leave partial RRN digits and manual idType on RowA, then switch to RowB: state must reset completely
  await rrnInput.fill("950505-6");
  await page.getByTestId("switch-b").click();

  await visible(idSelect).toHaveValue("");
  await visible(rrnInput).toHaveValue("");
  await visible(page.getByRole("alert")).toHaveCount(0);

  // Recording on RowB succeeds and derives FEMALE
  await rrnInput.fill(synthetic);
  await idSelect.selectOption("DOMESTIC_RESIDENCE");
  await submitBtn.click();
  await expect.poll(() => attempts).toBe(3);
  await visible(page.getByText(t("import.rows.sexDerived", { sex: t("import.sex.FEMALE") }))).toBeVisible();
});
