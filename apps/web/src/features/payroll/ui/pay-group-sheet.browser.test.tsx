// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { payGroupSchemas } from "../api";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/pay-group-browser-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "pay-group-test", resolveId: id => id === "/setup-test.js" ? "\0setup-test" : undefined,
      load: id => id === "\0setup-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {loadCatalog} from '@console/i18n';
        import {PayGroupSheet} from '/apps/web/src/features/payroll/ui/pay-group-sheet.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(PayGroupSheet,{entities:[{id:'synthetic',name:'모의상사'}],onClose:()=>{},onSaved:()=>{}})));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html"); res.end('<html lang="ko"><body><div id="root"></div><script type="module" src="/setup-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]!);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("the sheet starts blank and required fields explain an incomplete submission", async () => {
  const sheet = page.getByRole("dialog", { name: "급여 그룹 추가", exact: true });
  await dom(sheet).toBeVisible();
  for (const control of await sheet.getByRole("combobox").all()) await dom(control).toHaveValue("");
  await dom(sheet.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await dom(sheet.getByText("법인과 모든 급여 규칙을 직접 선택하십시오. 미리 선택된 값은 없습니다.", { exact: true })).toHaveCount(1);
  await dom(sheet.getByRole("heading", { name: "효과", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "급여 그룹 저장", exact: true }).click();
  await dom(sheet.getByRole("alert")).toHaveText("선택하지 않은 필수 항목이 있습니다.");
  await dom(sheet.getByLabel("그룹 이름", { exact: false })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("name bounds and every rule choice use the generated contract", async () => {
  const sheet = page.getByRole("dialog");
  const rules = payGroupSchemas.PayGroupRules.properties;
  const payDate = rules.pay_date_rule.properties;
  const period = payGroupSchemas.PayGroupPeriodRule.properties;
  const values = async (control: ReturnType<Page["locator"]>) => control.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
  const name = sheet.getByLabel(t("payroll.setup.name"), { exact: false });
  await dom(name).toHaveAttribute("maxlength", String(rules.name.maxLength));
  await dom(name).toHaveAttribute("minlength", String(rules.name.minLength));
  const pay = sheet.getByRole("group", { name: t("payroll.payDateRule"), exact: false });
  const range = ({ minimum, maximum }: { minimum: number; maximum: number }) => Array.from({ length: maximum - minimum + 1 }, (_, n) => String(n + minimum));
  expect(await values(pay.getByLabel(t("payroll.setup.month"), { exact: false }))).toEqual(payDate.month_offset.enum.map(String));
  expect(await values(pay.getByLabel(t("payroll.setup.day"), { exact: false }))).toEqual([...range(payDate.day.oneOf[0]), ...payDate.day.oneOf[1].enum]);
  expect(await values(pay.getByLabel(t("payroll.setup.holiday"), { exact: false }))).toEqual(payDate.non_business_day.enum);
  for (const key of ["payroll.basePeriod", "payroll.variablePeriod"] as const) {
    const group = sheet.getByRole("group", { name: t(key), exact: false });
    expect(await values(group.getByLabel(t("payroll.setup.month"), { exact: false }))).toEqual(period.month_offset.enum.map(String));
    expect(await values(group.getByLabel(t("payroll.setup.startDay"), { exact: false }))).toEqual([...period.start_day.oneOf[1].enum, ...range(period.start_day.oneOf[0]).slice(1)]);
  }
  expect(await values(sheet.getByLabel(t("payroll.proration"), { exact: false }))).toEqual(rules.proration.enum);
  expect(await values(sheet.getByLabel(t("payroll.channel"), { exact: false }))).toEqual(rules.channel.enum);
  await dom(sheet.getByRole("checkbox")).toHaveCount(payGroupSchemas.PayGroupPayBases.items.enum.length);
});
