import { expect, test } from "@playwright/test";
import { registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { reasonBox, sheet, todayPreset } from "../sheet";
import { reasonChip } from "../helpers/lifecycle";
import { hrAct } from "../record";

// An act opened right after another one, while the person's own re-read is still on its way, must not say
// 「이 직원의 기록이 방금 바뀌었습니다」 for the change the user just made (that line pushed the sheet's controls down under
// load in hcm and j2-transfer); the sheet waits for that re-read before it opens. This guard holds the re-read back
// 2.5 s; it does not reproduce the loaded-server timing that failed (it passes on the parent too), so it is not tagged
// regression.
test("an act right after another opens on the person as recorded: no 'record changed' notice for the user's own change", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin } = await staffedTenant(browser, "aftco", "연속발령주식회사");
  await registerEmployee(admin, { name: "연속이", number: "AA-0001" });
  const history = admin.getByRole("region", { name: "인사 이력" });

  await hrAct(admin, "전보");
  const transfer = sheet(admin, "연속이 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("채용팀 합류");
  // The person's re-read after this act is held back, as a loaded server answers it late.
  await admin.route(/\/api\/v1\/employees\/[0-9a-f-]{36}$/, async (r) => (r.request().method() === "GET" ? (await new Promise((ok) => setTimeout(ok, 2_500)), r.continue()) : r.continue()));
  await transfer.getByRole("button", { name: /오늘 전보/ }).click();
  await expect(history.getByText(/연속이를 .*채용팀으로 전보했습니다/).first()).toBeVisible({ timeout: 15_000 });

  await hrAct(admin, "승진 처리");
  const promote = sheet(admin, "연속이 승진 처리");
  await expect(promote).toBeVisible({ timeout: 15_000 });
  // Long enough for the held re-read to land under an open sheet.
  await admin.waitForTimeout(3_000);
  await expect(promote.getByText("이 직원의 기록이 방금 바뀌었습니다")).toHaveCount(0);
  await admin.unroute(/\/api\/v1\/employees\/[0-9a-f-]{36}$/);
});
