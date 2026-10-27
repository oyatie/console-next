import { expect, test, type Request } from "@playwright/test";
import { go } from "./flows";
import { openTenant } from "./helpers/tenant";

// The range comes from a shared comparison link, so an invalid deep link must have a usable remedy.
test("an invalid effective-date range refuses without writes and can be cleared", {
  tag: ["@org", "@first-run", "@regression"],
}, async ({ browser }) => {
  const admin = await openTenant(browser, "asof-refusal", "기간거절");
  const writes: string[] = [];
  const observe = (r: Request) => {
    if (!["GET", "HEAD"].includes(r.method()) && new URL(r.url()).pathname.startsWith("/api/v1/org-changes")) writes.push(r.url());
  };
  admin.on("request", observe);
  const refused = admin.waitForResponse((r) => r.request().method() === "GET"
    && new URL(r.url()).pathname === "/api/v1/org-changes"
    && new URL(r.url()).searchParams.get("effective_from") === "2026-04-02");
  await go(admin, "/org/changes?view=done&effective_from=2026-04-02&effective_to=2026-04-01");
  const response = await refused;
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "validation" } });
  await expect(admin.getByRole("alert")).toBeVisible();
  const remedy = admin.getByRole("button", { name: /기간 조건 초기화$/ });
  await expect(remedy).toBeVisible();
  await remedy.click();
  await expect(admin).toHaveURL(/\/org\?tab=changes&filter=done$/);
  await expect(admin.getByText("완료된 조직 변경이 없습니다", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  admin.off("request", observe);
});
