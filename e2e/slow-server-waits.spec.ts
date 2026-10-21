import { expect, test } from "@playwright/test";
import { faultNext, soloTenant } from "./chaos";
import { homeRail, registerEntity } from "./setup-flows";

// Regression (e2e-load-stall-dev): under host load a read takes as long as expect's 5 s, and the shared steps that
// waited a fixed time from a press failed 7–9 of 10 runs (registerEntity) or 3 of 6 (first-run-solo's rail). Each read
// is held 5 s here (chaos `slow`): a step that waits for the state its answer brings still passes; one that waits a
// fixed time fails.
test("Home's rail and the entity save wait for their reads, however slow", { tag: "@regression" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "slowreads", "느린서버");
  await faultNext(admin, /\/api\/v1\/onboarding\/checklist(\?.*)?$/, "slow", "GET");
  await admin.reload();
  const rail = await homeRail(admin);
  await expect(rail).toBeVisible();

  await rail.getByRole("link", { name: "법인 등록" }).first().click();
  await faultNext(admin, /\/api\/v1\/legal-entities\/[0-9a-f-]{36}(\?.*)?$/, "slow", "GET");
  await registerEntity(admin, "느린서버");
  await expect(admin.getByText("홍길동", { exact: true }).first()).toBeVisible();
});
