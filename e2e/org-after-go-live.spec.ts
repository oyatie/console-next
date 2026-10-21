import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { tenantWithExecutive } from "./setup-flows";
import { box } from "./structure-flows";

// Setup registered a workplace (its 사업장 joins the tree) after the tree was last read. Drawn from that cache, the
// page showed the empty company, then flipped to the chart when the re-read landed and opened the card again empty:
// a name typed right after go-live vanished. The tree a command changed is now drawn only once re-read.
test("a proposal typed right after go-live keeps what was typed", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "golive", "개시물산");
  await go(admin, "/org");
  await box(admin, "본점").click();
  await admin.keyboard.press("a");
  const name = admin.getByRole("dialog", { name: "부서 신설" }).getByLabel("부서 이름");
  await name.fill("총무부");
  await expect(box(admin, "본점")).toBeVisible();
  await expect(name).toHaveValue("총무부");
});
