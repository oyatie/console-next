// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./step-line.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/step-line-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/step-line/step-line.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  // Axe opens a second page of its own, which a browser-owned default context refuses.
  page = await (await browser.newContext()).newPage();
  await page.route("**/step-line-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Step line</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const STAGES = ["attendance", "calculate", "exceptions", "approval", "payment", "delivery"] as const;
const IMPORT = ["upload", "preview", "dryrun", "done"] as const;
type Read = { label: string; state?: "done" | "waiting"; current?: true };

/** What each step gives a screen reader (its named state, whether it is the current one) and what it draws as text. */
async function steps(query: string, name: string) {
  await page.goto(`${server.resolvedUrls!.local[0]}step-line-test${query}`);
  const items = page.getByRole("list", { name, exact: true }).getByRole("listitem");
  await items.first().waitFor();
  return Promise.all((await items.all()).map(async item => {
    const read: Read = { label: await item.innerText() };
    for (const state of ["done", "waiting"] as const) if (await item.getByRole("img", { name: t(`uiStepLine.state.${state}`), exact: true }).count()) read.state = state;
    if (await item.getAttribute("aria-current") === "step") read.current = true;
    return read;
  }));
}

test("a finished import tells a screen reader that every step is done, and draws no extra word", async () => {
  expect(await steps("", t("import.steps"))).toEqual(IMPORT.map(key => ({ label: t(`import.step.${key}`), state: "done" })));
});

test("a payroll line with every stage done reads each as done, and one with every stage waiting reads each as waiting", async () => {
  expect(await steps(`?states=${STAGES.map(() => "done")}`, t("payroll.stages.title"))).toEqual(STAGES.map(key => ({ label: t(`payroll.stage.${key}`), state: "done" })));
  expect(await steps(`?states=${STAGES.map(() => "waiting")}`, t("payroll.stages.title"))).toEqual(STAGES.map(key => ({ label: t(`payroll.stage.${key}`), state: "waiting" })));
});

test("a run in progress reads done, current and waiting stages apart, the boxes still draw a check or a number, and axe passes", async () => {
  const label = (key: typeof STAGES[number]) => t(`payroll.stage.${key}`);
  expect(await steps("?states=done,done,current,waiting,waiting,waiting", t("payroll.stages.title"))).toEqual([
    { label: label("attendance"), state: "done" }, { label: label("calculate"), state: "done" },
    // The current stage is marked by aria-current alone: its text stays the label, and its box stays hidden.
    { label: label("exceptions"), current: true },
    { label: label("approval"), state: "waiting" }, { label: label("payment"), state: "waiting" }, { label: label("delivery"), state: "waiting" },
  ]);
  const boxes = page.getByRole("listitem").locator("[data-n]");
  expect(await boxes.evaluateAll(all => all.map(box => box.querySelector("svg") ? "check" : getComputedStyle(box, "::before").content)))
    .toEqual(["check", "check", '"3"', '"4"', '"5"', '"6"']);
  await element(boxes.nth(2)).toHaveAttribute("aria-hidden", "true");
  // The check is not read: the state of a done stage is the name of its box.
  await element(boxes.first().locator("svg")).toHaveAttribute("aria-hidden", "true");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(" ")}`)).toEqual([]);
});
