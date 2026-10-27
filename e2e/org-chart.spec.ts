// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { openTenant } from "./helpers/tenant";
import { koDate, kstDate } from "./flows";
import { setupCompany } from "./setup-flows";

test("failed chart reads are unknown, with one retry and explained inert actions", { tag: ["@org", "@regression", "@negative"] }, async ({ browser }) => {
  const page = await openTenant(browser, "org-chart-read-failure", "조직읽기확인");
  await page.setViewportSize({ width: 390, height: 844 });
  const reference = "org-chart-read-reference";
  const reads = ["/api/v1/org-structure", "/api/v1/org-structure/change-dates", "/api/v1/legal-entities"];
  const counts = new Map<string, number>();
  // Keep shell reads healthy: PhaseBand's independent outage notice belongs to SHELL-IA.
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || !reads.includes(path)) return route.fallback();
    counts.set(path, (counts.get(path) ?? 0) + 1);
    // A long server Retry-After leaves recovery to the person's explicit retry.
    await route.fulfill({ status: 503, headers: { "operation-id": reference, "retry-after": "60" }, json: { error: { code: "service_unavailable", message: "조직 읽기에 실패했습니다." } } });
  });
  try {
    await page.goto("/org");
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toHaveCount(1);
    await expect(main.getByText(reference, { exact: true })).toBeVisible();
    await expect(main.getByText(/없습니다/)).toHaveCount(0);
    const retry = main.getByRole("button", { name: /다시 (불러오기|시도)/ });
    await expect(retry).toHaveCount(1);
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(main.getByText("조직 정보를 불러오지 못했습니다.", { exact: true })).toHaveCount(1);
    await expect(main.getByRole("navigation", { name: "조직 구조 보기", exact: true }).getByRole("link", { name: "변경 이력", exact: true })).toHaveAttribute("href", "/org?tab=changes");
    for (const name of ["내보내기", "가져오기", "기준일 비교"]) {
      const control = main.getByRole("button", { name, exact: true });
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute("aria-disabled", "true");
      await expect(control).toHaveAccessibleDescription("조직 정보를 불러오지 못했습니다.");
    }
    const dateControl = main.locator('section[aria-label="기준일"]');
    await expect(dateControl.getByRole("textbox", { name: /^기준일/ })).toBeEditable();
    await expect(dateControl.getByRole("button", { name: "오늘", exact: true })).toBeEnabled();
    counts.clear();
    await retry.click();
    for (const path of reads) await expect.poll(() => counts.get(path)).toBe(1);
    await expect(retry).toHaveCount(1);
    await page.unrouteAll({ behavior: "wait" });
    await retry.click();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "첫 법인을 등록합니다" })).toBeVisible();
    const compare = main.getByRole("button", { name: "기준일 비교", exact: true });
    await expect(compare).toBeEnabled();
    await compare.click();
    await expect(main.getByRole("textbox", { name: /^날짜 A/ })).toBeEditable();
    await expect(page).toHaveURL(/compare_a=/);
  } finally {
    await page.context().close();
  }
});

test("a change-dates outage leaves a loaded chart fresh with one inline retry", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "org-chart-date-history", "조직변경일확인");
  try {
    await setupCompany(page, "조직변경일확인", "본사");
    await page.route("**/api/v1/org-structure/change-dates?*", route => route.fulfill({
      status: 503, headers: { "operation-id": "dates-read-reference", "retry-after": "60" },
      json: { error: { code: "service_unavailable", message: "변경일 읽기에 실패했습니다." } },
    }));
    await page.goto("/org");
    const main = page.getByRole("main");
    await expect(main.getByRole("tree", { name: /조직도$/ })).toBeVisible();
    await expect(main.locator('[data-dimmed="true"]')).toHaveCount(0);
    await expect(main.getByRole("status").filter({ hasText: "선택한 시점을 읽지 못했습니다" })).toHaveCount(1);
    await expect(main.getByText("dates-read-reference", { exact: true })).toBeVisible();
    await expect(main.getByText(/최신 내용을 확인하지 못했습니다/)).toHaveCount(0);
    const retry = main.getByRole("button", { name: "다시 불러오기", exact: true });
    await expect(retry).toHaveCount(1);
    await page.unrouteAll({ behavior: "wait" });
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(main.getByRole("tree", { name: /조직도$/ })).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("an invalid as-of date can be corrected or returned to today", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const page = await openTenant(browser, "org-chart-invalid-date", "조직날짜복구");
  try {
    await setupCompany(page, "조직날짜복구", "본사");
    for (const recovery of ["input", "today"] as const) {
      const refused = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/org-structure" && r.status() === 422);
      await page.goto("/org?as_of=2025-02-30");
      await refused;
      const date = page.getByRole("region", { name: "기준일", exact: true });
      const field = date.getByRole("textbox", { name: /^기준일/ });
      await expect(field).toBeEditable();
      await field.focus();
      await expect(field).toBeFocused();
      if (recovery === "input") {
        await field.fill(kstDate());
        await field.blur();
      } else {
        await date.getByRole("button", { name: "오늘", exact: true }).click();
      }
      await expect(page).not.toHaveURL(/as_of=/);
      await expect(page.getByRole("tree", { name: /조직도$/ })).toBeVisible();
      await expect(field).toHaveValue(koDate(kstDate()));
    }
    await page.route(url => url.pathname === "/api/v1/org-structure" && url.searchParams.has("as_of"), route =>
      route.fulfill({ status: 503, headers: { "retry-after": "60" }, json: { error: { code: "service_unavailable", message: "조직 읽기에 실패했습니다." } } }));
    await page.goto(`/org?as_of=${kstDate(-1)}`);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(1);
    await page.getByRole("button", { name: "오늘로", exact: true }).click();
    await expect(page).not.toHaveURL(/as_of=/);
    await expect(page.getByRole("tree", { name: /조직도$/ })).toBeVisible();
  } finally {
    await page.context().close();
  }
});
