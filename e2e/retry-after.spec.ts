import { expect, test } from "@playwright/test";

// TS-28: a shed (503) or rate-limited (429) command says when to try again, in words, and is never retried behind
// the user's back (no retry storm into an overloaded server); the user's own retry is the next request.
const REDEEM = "**/api/v1/auth/otp/redeem";

test("a sign-in refused with 429 + Retry-After says when to try again and is not retried on its own", { tag: "@negative" }, async ({ page }) => {
  let posts = 0;
  await page.route(REDEEM, (r) => {
    posts++;
    return r.fulfill({ status: 429, headers: { "retry-after": "30", "content-type": "application/json" }, body: JSON.stringify({ error: { code: "rate_limited", message: "요청이 너무 많습니다." } }) });
  });
  await page.goto("/login");
  await page.locator("summary").filter({ hasText: "처음이면 일회용 코드" }).click();
  await page.getByLabel("일회용 코드").fill("ABCDEFGH");
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  await expect(page.getByRole("alert")).toContainText("30초 뒤에 다시 시도하십시오");
  await page.waitForTimeout(1_500);
  expect(posts).toBe(1);

  // A 503 from a proxy with no envelope: the status text, then the wait.
  await page.unrouteAll();
  await page.route(REDEEM, (r) => (posts++, r.fulfill({ status: 503, headers: { "retry-after": "2" }, body: "" })));
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  await expect(page.getByRole("alert")).toContainText("2초 뒤에 다시 시도하십시오");
  await page.waitForTimeout(2_500); // past the Retry-After: still the one request
  expect(posts).toBe(2);
});
