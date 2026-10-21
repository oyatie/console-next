// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, koDate } from "./flows";
import { openTenant } from "./helpers/tenant";
import { setupCompany } from "./setup-flows";

test("the entities as-of field uses Korean format with an en-US browser locale", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "date-locale", "날짜 서식", "en-US");
  expect(await page.evaluate(() => navigator.language)).toBe("en-US");
  await page.getByRole("banner").getByLabel(/^(언어|Language)$/).selectOption("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");

  await setupCompany(page, "날짜 서식", "본점");
  await go(page, "/org/entities");
  const asOf = page.getByRole("region", { name: "기준일", exact: true });
  const input = asOf.getByLabel(/^기준일/);
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveValue(/^\d{4}\. \d{2}\. \d{2}\.$/);
});


test("typing an as-of date commits one navigation on blur or Enter", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "date-typing", "날짜 입력");
  await setupCompany(page, "날짜 입력", "본점");
  await go(page, "/org/entities");
  const asOf = page.getByRole("region", { name: "기준일", exact: true });
  const input = asOf.getByLabel(/^기준일/);
  const navigations: string[] = [];
  await page.exposeFunction("recordDateNavigation", (url: string) => { navigations.push(url); });
  await page.evaluate(() => {
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (...args) => {
        const before = location.href;
        original(...args);
        if (location.href !== before && new URL(location.href).searchParams.has("as_of")) {
          void (window as unknown as { recordDateNavigation: (url: string) => Promise<void> }).recordDateNavigation(location.href);
        }
      };
    }
  });
  for (const [draft, iso, commit] of [["20261115", "2026-11-15", "blur"], ["2026. 11. 25.", "2026-11-25", "Enter"]] as const) {
    const before = page.url();
    const count = navigations.length;
    await input.fill("");
    await input.pressSequentially(draft);
    await expect(input).toHaveValue(draft);
    expect(page.url()).toBe(before);
    expect(navigations).toHaveLength(count);
    await expect(asOf.getByText("날짜가 올바르지 않습니다", { exact: false })).toHaveCount(0);
    if (commit === "blur") await input.blur();
    else { await input.press(commit); await input.blur(); }
    await expect(input).toHaveValue(koDate(iso));
    await expect(page).toHaveURL(new RegExp(`as_of=${iso}`));
    await expect.poll(() => navigations.length).toBe(count + 1);
  }
});
