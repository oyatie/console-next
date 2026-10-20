// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const source = readFileSync(new URL("./main.rs", import.meta.url), "utf8");
const html = source.match(/const HTML: &str = r#"([\s\S]*?)"#;/)?.[1];

test("desktop callbacks require confirmation at both native entry points", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-callbacks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    copyFileSync(new URL(`../${file}`, import.meta.url), join(dir, file));
  }
  // Compile unchanged production bodies against mocks of window/thread/browser boundaries.
  const window = source.slice(source.indexOf("fn window("), source.indexOf("/// The console needs"));
  const external = source.slice(source.indexOf("mod external {"));
  const config = readFileSync(new URL("./config.rs", import.meta.url), "utf8");
  const policy = config.slice(config.indexOf("pub fn same_origin("), config.indexOf("/// `<scheme>"));
  const fixture = readFileSync(new URL("./main.callbacks.test.rs", import.meta.url), "utf8");
  writeFileSync(join(dir, "src/lib.rs"), fixture
    .replace("// PRODUCTION_POLICY", () => policy)
    .replace("// PRODUCTION_WINDOW", () => window)
    .replace("// PRODUCTION_EXTERNAL", () => external.replace("mod external {", "mod external {\nuse crate::{tauri, tauri_plugin_opener, threads as std};")));
  try {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--locked", "--lib", "--manifest-path", join(dir, "Cargo.toml")], {
      env: { ...process.env, RUSTC_WRAPPER: "sccache" },
    });
    t.diagnostic(stdout);
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}\n${error.stderr ?? error.message}`);
  }
});

test("desktop interstitial requires an explicit trusted decision", async (t) => {
  assert.ok(html, "the shell must provide its local confirmation page");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const destination = "https://external.test/path?q=%22%3Cscript%3E#section";
  const initial = `data:text/html,${encodeURIComponent(html)}#${encodeURIComponent(destination)}`;

  await page.goto(initial);
  assert.equal(await page.locator("#destination").textContent(), destination);
  assert.equal(await page.locator("a").count(), 0);
  assert.equal(page.url(), initial, "no automatic handoff");
  await page.getByRole("button", { name: "이동", exact: true }).evaluate((button) => button.click());
  assert.equal(page.url(), initial, "synthetic clicks cannot confirm");

  await Promise.all([
    page.waitForURL("about:blank?external-confirm"),
    page.getByRole("button", { name: "이동", exact: true }).click(),
  ]);

  await page.goto(initial);
  await page.getByRole("button", { name: "이동", exact: true }).focus();
  await Promise.all([
    page.waitForURL("about:blank?external-confirm"),
    page.keyboard.press("Enter"),
  ]);

  await page.goto(initial);
  assert.equal(await page.locator(":focus").textContent(), "취소");
  await Promise.all([
    page.waitForURL("about:blank?external-cancel"),
    page.getByRole("button", { name: "취소", exact: true }).click(),
  ]);
});
