// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let origin: string;

// Serve the real sheet and controls; only HTTP responses are substituted.
const entry = "/__identifier-sheet-test.tsx";
const harness = `
  import "/apps/web/src/app.css";
  import { createElement, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { i18n, loadCatalog } from "@console/i18n";
  import { IdentifierSheet } from "/apps/web/src/features/entity/ui/record-identifier-sheet";
  import { bindAnnouncer } from "/apps/web/src/lib/react/announce";
  await loadCatalog("en");
  i18n.set("en");
  bindAnnouncer((text) => document.querySelector("output").textContent = text);
  const e = { id: "entity", current: { name: "Example" }, workplaces: [], registrations: [{ id: "registration" }] };
  function App() {
    const [open, setOpen] = useState(true);
    return open ? createElement(IdentifierSheet, { e, field: new URLSearchParams(location.search).get("field"),
      registrationId: "registration", operating: true, onClose: () => setOpen(false) }) : null;
  }
  createRoot(document.querySelector("main")).render(createElement(QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(App)));
`;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/vite-identifier-sheet-test",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), realpathSync("node_modules")] } },
    plugins: [{
      name: "identifier-sheet-test",
      resolveId: (id) => id === entry ? entry : undefined,
      load: (id) => id === entry ? harness : undefined,
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(`<main></main><output></output><script type="module" src="${entry}"></script>`);
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  // The hosted Ubuntu CI image already supplies Chrome; local E2E uses Playwright's Chromium.
  browser = await chromium.launch({ channel: process.env.CI ? "chrome" : undefined });
  const warm = await open("crn", "PENDING");
  await warm.page.close();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(field: "crn" | "brn", outcome: "PENDING" | "GOVERNED") {
  const page = await browser.newPage();
  page.setDefaultTimeout(1000);
  const requests: { url: string; body: unknown }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/identifier-corrections")) {
      requests.push({ url: request.url(), body: request.postDataJSON() });
      await route.fulfill({ status: outcome === "PENDING" ? 202 : 200, json: outcome === "PENDING"
        ? { status: "PENDING", exception_id: "exception", payload_hash: "a".repeat(64) }
        : { change_mode: "GOVERNED", record: {} } });
    } else if (request.method() === "POST") {
      await route.fulfill({ status: 201, json: { id: "evidence", file_name: "evidence.pdf" } });
    } else {
      await route.fulfill({ json: { items: [] } });
    }
  });
  await page.goto(`${origin}?field=${field}`, { waitUntil: "commit" });
  await page.evaluate(`import(${JSON.stringify(entry)})`);
  await page.getByRole("dialog").waitFor();
  return { page, requests };
}

async function submit(page: Page, field: "crn" | "brn") {
  await page.getByRole("textbox").fill(field === "crn" ? "1101110012345" : "2208162521");
  await page.getByText("Document misread", { exact: true }).click();
  await browserExpect(page.getByRole("radio", { name: "Document misread", exact: true })).toBeChecked();
  await page.locator('input[type="file"]').setInputFiles({ name: "evidence.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 test") });
  const save = page.getByRole("button", { name: "Correct number", exact: true });
  await browserExpect(save).not.toHaveAttribute("aria-disabled", "true");
  await save.click();
  return save;
}

test.each(["crn", "brn"] as const)("a PENDING %s correction renders its receipt and prevents a second submission", async (field) => {
  const { page, requests } = await open(field, "PENDING");
  try {
    const save = await submit(page, field);
    const notice = "Correction requested; the identifier is unchanged until another eligible person approves. Exception: exception";
    await browserExpect(page.getByRole("dialog").getByRole("status")).toHaveText(notice);
    await browserExpect(page.locator("output")).toHaveText(notice);
    await browserExpect(save).toHaveAttribute("aria-disabled", "true");
    await browserExpect(save).not.toHaveAttribute("disabled");
    // aria-disabled stays focusable; use the mouse to exercise the click guard.
    const bounds = (await save.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(field === "crn" ? "/legal-entities/entity/" : "/business-registrations/registration/");
    expect(requests[0]!.body).toMatchObject({ document_id: "evidence", reason_code: "REGISTRY_DIFFERS" });
  } finally { await page.close(); }
});

test.each(["crn", "brn"] as const)("an applied %s correction closes and announces the saved identifier", async (field) => {
  const { page, requests } = await open(field, "GOVERNED");
  try {
    await submit(page, field);
    await browserExpect(page.getByRole("dialog")).toHaveCount(0);
    await browserExpect(page.locator("output")).toHaveText(/^Corrected the /);
    expect(requests).toHaveLength(1);
  } finally { await page.close(); }
});
