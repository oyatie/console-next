// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, test } from "vitest";
import { expect } from "@playwright/test";
import { chromium, openBrowserTestPage, type Browser, type Page } from "../../../lib/browser-test";
import { pickerTestServer } from "../../../ui/server-picker/browser-test";

let server: Awaited<ReturnType<typeof pickerTestServer>>;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await pickerTestServer("attendance-evidence", `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { loadCatalog } from '@console/i18n';
    import { EvidenceField } from '/apps/web/src/features/attendance/ui/evidence-field.tsx';
    import { EMPTY_EVIDENCE, evidenceOf } from '/apps/web/src/features/attendance/domain/evidence.ts';
    import '/apps/web/src/app.css';
    await loadCatalog('ko');
    const client = new QueryClient();
    function Demo() {
      const [value, onChange] = useState(EMPTY_EVIDENCE);
      return h(QueryClientProvider, {client},
        h(EvidenceField, {value, onChange}), h('output', {id:'wire'}, JSON.stringify(evidenceOf(value))));
    }
    createRoot(document.getElementById('root')).render(h(Demo));
  `);
  browser = await chromium.launch();
  page = await browser.newPage();
  const port = (server.httpServer!.address() as { port: number }).port;
  await openBrowserTestPage(page, `http://localhost:${port}/attendance-evidence`, page.locator("#wire"));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("work output keeps the shared explicit evidence selection and note", async () => {
  await expect(page.locator("#wire")).toHaveText("null");
  const choice = page.getByRole("radio", { name: "작업 기록 · 결과물", exact: true });
  await expect(choice).not.toBeChecked();
  await choice.locator("xpath=ancestor::label[1]").click();
  await page.getByRole("textbox", { name: /^메모/ }).fill("  작업 기록 대조  ");
  await expect(page.locator("#wire")).toHaveText(JSON.stringify({ kind: "WORK_OUTPUT", note: "작업 기록 대조" }));
});
