import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go } from "./flows";
import { openTenant } from "./helpers/tenant";
import { registerEntity, setupCompany } from "./setup-flows";
import { addDepartments, revealUnit } from "./structure-flows";

test("Home waits for the checklist arrival read before offering cached actions", async ({ browser }) => {
  const admin = await openTenant(browser, "railarrival", "첫읽기");
  await admin.locator('[data-step][aria-current="step"]').getByRole("link", { name: "법인 등록", exact: true }).click();
  await registerEntity(admin, "첫읽기");
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route("**/api/v1/onboarding/checklist", async (r) => {
    const response = await r.fetch();
    requested = true;
    await held;
    await r.fulfill({ response });
  });
  try {
    await go(admin, "/");
    await expect.poll(() => requested).toBe(true);
    await expect(admin.getByRole("heading", { name: "운영 준비", exact: true })).toBeHidden();
  } finally {
    release();
  }
  await expect(admin.getByRole("heading", { name: "운영 준비", exact: true })).toBeVisible();
  await expectAccessible(admin, "Home: checklist arrival read settled");
});

test("adding a department on a slow read keeps the next input and department actions in place", async ({ browser }) => {
  const admin = await openTenant(browser, "orgarrival", "자리유지");
  await setupCompany(admin, "자리유지", "본점");
  await go(admin, "/org");
  await addDepartments(admin, "본점", ["지원부"]);
  await revealUnit(admin, "지원부");
  await admin.keyboard.press("a");
  const input = admin.getByRole("textbox", { name: "지원부 아래 새 부서 이름" });
  await input.fill("인사팀");
  const add = admin.getByRole("complementary", { name: "지원부", exact: true }).getByRole("button", { name: "하위 부서 추가", exact: true });
  const before = [await input.boundingBox(), await add.boundingBox()];
  expect(before.every(Boolean)).toBe(true);
  await admin.route("**/api/v1/org-structure", async (r) => {
    const response = await r.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await r.fulfill({ response });
  });
  await input.press("Enter");
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  const after = [await input.boundingBox(), await add.boundingBox()];
  for (const [i, box] of after.entries()) {
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x - before[i]!.x)).toBeLessThan(1);
    expect(Math.abs(box!.y - before[i]!.y)).toBeLessThan(1);
  }
  await expectAccessible(admin, "org: slow child read keeps controls in place");
});
