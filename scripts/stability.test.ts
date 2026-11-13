// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { recordShifts, SHIFT_BUDGET } from "../e2e/stability";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(recordShifts);
  await page.route("https://stability.test/**", route => route.fulfill({
    contentType: "text/html",
    body: '<button id="command">Save</button><div id="content" style="height:500px;background:gray">Record</div>',
  }));
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each(["auth/token/refresh", "auth/privacy-consent/status", "background/status"])("counts cold-load shifts immediately after POST %s", async path => {
  await page.goto("https://stability.test/");
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(async path => {
    await fetch(`/api/v1/${path}`, { method: "POST" });
    document.getElementById("content")!.style.marginTop = "200px";
  }, path);
  await expect.poll(() => page.evaluate(() => window.__shifts?.reduce((total, shift) => total + shift.value, 0) ?? 0)).toBeGreaterThan(SHIFT_BUDGET);
});

test("a user command still exempts its own result", async () => {
  await page.goto("https://stability.test/");
  await page.evaluate(() => {
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      document.getElementById("content")!.style.marginTop = "200px";
    };
  });
  await page.click("#command");
  await page.waitForFunction(() => document.getElementById("content")!.style.marginTop === "200px");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__shifts)).toEqual([]);
});

test.each(["GET", "POST"])("a command waits for its slow %s refresh before the rendering window", async method => {
  await page.goto("https://stability.test/");
  await page.route("**/api/v1/refresh", async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ json: {} });
  });
  await page.evaluate(method => {
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      const refresh = fetch("/api/v1/refresh", { method });
      setTimeout(() => { document.getElementById("content")!.style.marginTop = "100px"; }, 1100);
      await refresh;
      await new Promise(resolve => setTimeout(resolve, 600));
      document.getElementById("content")!.style.marginTop = "200px";
    };
  }, method);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("content")!.style.marginTop === "200px");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__shifts)).toEqual([]);
  await page.unroute("**/api/v1/refresh");
});

test("a read started after the command continuation window still counts", async () => {
  await page.goto("https://stability.test/");
  await page.evaluate(() => {
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      await new Promise(resolve => setTimeout(resolve, 1100));
      await fetch("/api/v1/background");
      document.getElementById("content")!.style.marginTop = "200px";
    };
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("content")!.style.marginTop === "200px");
  await expect.poll(() => page.evaluate(() => window.__shifts?.reduce((total, shift) => total + shift.value, 0) ?? 0)).toBeGreaterThan(SHIFT_BUDGET);
});

test("a refresh answer cannot promote a background POST to a command", async () => {
  await page.goto("https://stability.test/");
  await page.route("**/api/v1/refresh", async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/v1/background", async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ json: {} });
  });
  await page.evaluate(() => {
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      await fetch("/api/v1/refresh");
      await fetch("/api/v1/background", { method: "POST" });
      document.getElementById("content")!.style.marginTop = "200px";
    };
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("content")!.style.marginTop === "200px");
  await expect.poll(() => page.evaluate(() => window.__shifts?.reduce((total, shift) => total + shift.value, 0) ?? 0)).toBeGreaterThan(SHIFT_BUDGET);
  await page.unroute("**/api/v1/refresh");
  await page.unroute("**/api/v1/background");
});

test.each([0, 450])("a read chain spaced %i ms apart cannot hide a control moving 4 s after the write", async spacing => {
  await page.goto("https://stability.test/");
  await page.route("**/api/v1/chain/*", async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: {} });
  });
  await page.evaluate(spacing => {
    const content = document.getElementById("content")!;
    const button = document.createElement("button");
    button.textContent = "Continue";
    content.append(button);
    document.getElementById("command")!.onclick = async () => {
      await fetch("/api/v1/record", { method: "POST" });
      setTimeout(() => { content.style.marginTop = "150px"; }, 4000);
      for (let i = 0; i < 20; i++) {
        await fetch(`/api/v1/chain/${i}`);
        await new Promise(resolve => setTimeout(resolve, spacing));
      }
      content.dataset.chainComplete = "true";
    };
  }, spacing);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("content")!.dataset.chainComplete === "true");
  await expect.poll(() => page.evaluate(() => window.__shifts?.some(shift => shift.control) ?? false)).toBe(true);
  await page.unroute("**/api/v1/chain/*");
}, 60_000);
