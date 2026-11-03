import { expect, test, type Browser } from "@playwright/test";
import { newContext } from "./flows";

// The guard runs on an isolated document so catalog detection needs no backend or authentication.
async function guardedDocument(browser: Browser) {
  const page = await (await newContext(browser)).newPage();
  await page.route("http://localhost/guard", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("http://localhost/guard");
  return page;
}

test("non-translatable diagnostic code may equal a catalog id", { tag: "@regression" }, async ({ browser }) => {
  const page = await guardedDocument(browser);
  await page.evaluate(() => {
    const code = document.createElement("code");
    code.translate = false;
    code.innerHTML = "<span>lifecycle.refuse.close_blocked</span>";
    document.body.append(code);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('code[translate="no"]')).toHaveText("lifecycle.refuse.close_blocked");
  await page.evaluate(() => { document.querySelector("code span")!.firstChild!.textContent = "idle.warn.body"; });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('code[translate="no"]')).toHaveText("idle.warn.body");
});

for (const markup of ["<code>idle.warn.body</code>", '<div translate="no">idle.warn.body</div>', '<code translate="no">lifecycle.refuse.close_blocked</code><p>idle.warn.body</p>']) {
  test(`untranslated copy still fails beside diagnostic metadata: ${markup}`, { tag: "@regression" }, async ({ browser }) => {
    test.fail(true, "ordinary catalog copy must still trip the guard");
    const page = await guardedDocument(browser);
    await page.evaluate(html => {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.innerHTML = html;
      document.body.append(alert);
    }, markup);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole("alert")).toContainText("idle.warn.body");
  });
}

test("a catalog id painted raw, even for a moment, fails the spec", { tag: "@regression" }, async ({ browser }) => {
  test.fail(true, "the guard must fail this spec: it paints idle.warn.body raw");
  const page = await guardedDocument(browser);
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "idle.warn.body";
    document.body.append(p);
    p.remove(); // gone before anyone looks: still painted, still a failure
  });
  // The report crosses to the test before this round trip returns (one ordered channel).
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText("idle.warn.body", { exact: true })).toHaveCount(0);
});

test("dotted text that is no catalog id never trips the guard", async ({ browser }) => {
  const page = await guardedDocument(browser);
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "hong@acme.example · v1.2.3 · idle.warn.nothing · auth.idle_timeout_minutes";
    document.body.append(p);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText("hong@acme.example")).toBeVisible();
});
