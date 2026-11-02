// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/date-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client", "react-aria-components", "intl-messageformat", "lucide-react", "@internationalized/date"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "date-test",
      resolveId: id => id === "/date-test.js" ? "\0date-test" : undefined,
      load: id => id === "\0date-test" ? `
        import { createElement as h, StrictMode, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { DateInput } from '/apps/web/src/ui/date/date-input.tsx';
        import { AsOfControl } from '/apps/web/src/ui/asof-control/asof-control.tsx';
        await loadCatalog('ko');
        function App() {
          const [value, setValue] = useState('2026-11-15');
          return h(DateInput, { value, onChange: setValue, label: '시행일', today: '2026-11-15',
            min: '2026-11-10', max: '2026-11-20', disabledDates: ['2026-11-16'] });
        }
        function AsOf() {
          const [point, setPoint] = useState({ value: '2026-11-15', knownAt: '2026-11-01T12:34:56+09:00' });
          return h(AsOfControl, { ...point, today: '2026-11-15', changeDates: ['2026-11-01', '2026-11-15'],
            onChange: (value, knownAt) => setPoint({ value, knownAt }) });
        }
        createRoot(document.getElementById('root')).render(h(StrictMode, null, h(location.search ? AsOf : App)));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (!/^\/date-test(?:\?|$)/.test(req.url ?? "")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<html lang="ko"><title>Date</title><div id="root"></div><script type="module" src="/date-test.js"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
}, 60_000);

afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

test("the deferred calendar preserves bounds, blocked dates, keyboard selection and focus return", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}date-test`);
  const trigger = page.getByRole("button", { name: "달력 열기", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const calendar = page.getByRole("dialog", { name: "날짜 선택", exact: true });
  const day = (n: number) => calendar.getByRole("button", { name: new RegExp(`2026년 11월 ${n}일`) });
  await expectElement(day(15)).toBeFocused();
  for (const n of [9, 16, 21]) await expectElement(day(n)).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expectElement(calendar).toBeVisible();
  await expectElement(page.getByRole("textbox", { name: "시행일" })).toHaveValue("2026. 11. 15.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expectElement(calendar).toHaveCount(0);
  await expectElement(page.getByRole("textbox", { name: "시행일" })).toHaveValue("2026. 11. 17.");
  await expectElement(trigger).toBeFocused();
});

test("the compact as-of picker keeps exact knowledge links and rejects invalid dates before returning to today", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}date-test?asof`);
  const control = page.getByRole("region", { name: "기준일", exact: true });
  const trigger = control.getByRole("button", { name: /^기준일 · / });
  await expectElement(control.getByRole("textbox")).toHaveCount(0);
  await trigger.press("Enter");
  const picker = page.getByRole("dialog", { name: "기준일", exact: true });
  const input = picker.getByRole("textbox");
  await input.fill("20260230");
  await input.press("Tab");
  await expectElement(input).toHaveAttribute("aria-invalid", "true");
  await expectElement(trigger).toContainText("2026. 11. 15.");
  await input.fill("20261101");
  await input.press("Enter");
  await expectElement(picker).toHaveCount(0);
  await expectElement(trigger).toBeFocused();
  await expectElement(control).toContainText("2026. 11. 01. 12:34 KST");
  await control.getByRole("button", { name: "오늘로", exact: true }).click();
  await expectElement(trigger).toContainText("2026. 11. 15.");
  await expectElement(control).not.toContainText("알려진 대로");
});
