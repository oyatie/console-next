// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible, fits } from "./a11y";
import { tenantWithExecutive } from "./setup-flows";
import { COMPANY, importPeople } from "./people-directory.fixture";
import { forgetResize } from "./stability";

test("directory headers sort server pages, survive reload, and fit the roster and personnel card", { tag: "@hr" }, async ({ browser }, info) => {
  test.setTimeout(600_000);
  const { admin } = await tenantWithExecutive(browser, "directorysort", COMPANY);
  await importPeople(admin);
  await admin.setViewportSize({ width: 1440, height: 900 });
  await forgetResize(admin);
  await admin.goto("/people");
  const grid = admin.getByRole("grid", { name: "직원" });
  await expect(grid.getByRole("rowheader", { name: "D-0001", exact: true })).toBeVisible();
  expect(await grid.getByRole("row").count()).toBeLessThan(60);
  await expect(grid.getByRole("columnheader", { name: "이름", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await expect(admin.getByRole("combobox", { name: "정렬", exact: true })).toHaveCount(0);

  const hired = grid.getByRole("columnheader", { name: "입사일", exact: true });
  const sorted = admin.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === "/api/v1/employees" && url.searchParams.get("sort") === "hire_date";
  });
  await hired.click();
  expect((await sorted).ok()).toBeTruthy();
  await expect(hired).toHaveAttribute("aria-sort", "ascending");
  await expect(admin).toHaveURL(/sort=hire_date/);
  await hired.focus();
  await hired.press("Enter");
  await expect(hired).toHaveAttribute("aria-sort", "descending");
  await expect(admin).toHaveURL(/sort=-hire_date/);
  await admin.reload();
  await expect(hired).toHaveAttribute("aria-sort", "descending");

  // The second page must use the cursor returned by this order, never an offset.
  const ascending = admin.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === "/api/v1/employees" && url.searchParams.get("sort") === "employee_number";
  });
  await grid.getByRole("columnheader", { name: "사번", exact: true }).click();
  expect((await ascending).ok()).toBeTruthy();
  const descending = admin.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === "/api/v1/employees" && url.searchParams.get("sort") === "-employee_number";
  });
  await grid.getByRole("columnheader", { name: "사번", exact: true }).click();
  const firstPage = await (await descending).json();
  expect(firstPage.next_cursor).toBeTruthy();
  const next = admin.waitForRequest(r => {
    const url = new URL(r.url());
    return url.pathname === "/api/v1/employees" && url.searchParams.get("cursor") === firstPage.next_cursor;
  });
  await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const nextUrl = new URL((await next).url());
  expect(nextUrl.searchParams.has("offset")).toBeFalsy();
  await expect(admin.getByText("200 / 2,000줄", { exact: true })).toBeVisible();

  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 900 });
    await forgetResize(admin);
    await grid.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
    await expect(grid.getByText("D-2000", { exact: true })).toBeVisible();
    await fits(admin, `directory ${width}`);
    await expectAccessible(admin, `directory sorted ${width}`);
    for (const theme of ["light", "dark"]) {
      await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await info.attach(`people-${width}-${theme}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  }
  await grid.getByText("D-2000", { exact: true }).click();
  await admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }).click();
  await expect(admin).toHaveURL(/\/people\/[a-f0-9-]+/);
  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 900 });
    await forgetResize(admin);
    await expect(admin.getByRole("heading", { level: 1 })).toContainText("가상직원2000");
    await fits(admin, `personnel card ${width}`);
    await expectAccessible(admin, `personnel card ${width}`);
    for (const theme of ["light", "dark"]) {
      await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await info.attach(`card-${width}-${theme}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  }
  await admin.context().close();
});
