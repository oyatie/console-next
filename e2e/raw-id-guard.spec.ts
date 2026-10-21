import { expect, test } from "@playwright/test";
import { newContext } from "./flows";

// The raw-id guard (e2e/raw-id-guard.ts) is on in every context newContext makes: these prove it can fail, and that
// dotted text that is not a catalog id never trips it.

test("a catalog id painted raw, even for a moment, fails the spec", { tag: "@regression" }, async ({ browser }) => {
  test.fail(true, "the guard must fail this spec: it paints idle.warn.body raw");
  const page = await (await newContext(browser)).newPage();
  await page.goto("/login");
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "idle.warn.body";
    document.body.append(p);
    p.remove(); // gone before anyone looks: still painted, still a failure
  });
  // The report crosses to the test before this round trip returns (one ordered channel).
  await page.evaluate(() => new Promise(requestAnimationFrame));
});

test("dotted text that is no catalog id never trips the guard", async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await page.goto("/login");
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "hong@acme.example · v1.2.3 · idle.warn.nothing · auth.idle_timeout_minutes";
    document.body.append(p);
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText("hong@acme.example")).toBeVisible();
});
