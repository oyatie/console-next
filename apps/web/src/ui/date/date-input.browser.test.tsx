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
        await loadCatalog('ko');
        function App() {
          const [value, setValue] = useState('2026-11-15');
          return h(DateInput, { value, onChange: setValue, label: '시행일', today: '2026-11-15',
            min: '2026-11-10', max: '2026-11-20', disabledDates: ['2026-11-16'] });
        }
        createRoot(document.getElementById('root')).render(h(StrictMode, null, h(App)));
      ` : undefined,
      configureServer: vite => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/date-test") return next();
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
