import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";

test("bulk kinds wait for the picked employees before opening their controls", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "bulk-arrival", "일괄발령읽기");
  await registerEmployee(admin, { name: "김발령", number: "ARR-001" });
  await go(admin, "/people");
  await admin.getByRole("row", { name: /김발령/ }).locator("label", { has: admin.getByRole("checkbox") }).click();

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  await admin.route("**/api/v1/employees?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") !== "1000") return route.continue();
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await admin.getByRole("button", { name: "선택한 1명 일괄 발령" }).click();
    await reading;
    await expectAccessible(admin, "bulk appointment while the selected records are loading");
    const kinds = admin.getByRole("group", { name: "무엇을" });
    for (const name of ["전보", "승진"]) await expect(kinds.getByRole("button", { name, exact: true })).toBeDisabled();
    release();
    await expect(kinds.getByRole("button", { name: "승진", exact: true })).toBeEnabled();
    await kinds.getByRole("button", { name: "승진", exact: true }).click();
    await expect(admin.getByRole("table", { name: "1명 · 지금 → 새 직위" })).toContainText("김발령");
    await expectAccessible(admin, "bulk appointment opens on the selected records");
  } finally {
    release();
    await admin.unrouteAll({ behavior: "wait" });
  }
});
