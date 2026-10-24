// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { withLifecycleDate } from "./clock";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { startOperations, tenantInSetup } from "./setup-flows";
import { signOff } from "./sheet";
import { shot } from "./shots";
import { box, revealUnit } from "./structure-flows";

async function counts(page: Page, path: string, date: string, expected: number) {
  await go(page, path);
  await revealUnit(page, "본점");
  await expect(box(page, "본점")).toContainText(`${expected}명`);
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const exporting = page.getByRole("dialog", { name: "조직도 내보내기" });
  const preview = await exporting.getByRole("img").getAttribute("src");
  expect(preview).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(preview!.slice(preview!.indexOf(",") + 1));
  expect(svg).toMatch(new RegExp(`본점</text><text[^>]*>${expected}명</text>`));
  expect(svg).toContain(`${date} 기준`);
  await exporting.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.getByRole("grid", { name: "조직 구조 목록" }).getByRole("row", { name: /본점/ })).toBeVisible();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "조직 시트 내려받기" }).click(),
  ]);
  const csv = await (await file.createReadStream()).toArray().then((parts) => Buffer.concat(parts).toString("utf8"));
  const workplace = csv.split("\r\n").map((line) => line.split(",")).find((row) => row[0]?.startsWith("사업장") && row[2] === "본점");
  expect(workplace?.slice(6, 8)).toEqual([String(expected), date]);
  await shot(page, `exit-count-${date}-${path.includes("compare") ? "compare" : "chart"}`);
}

test("the reported last working day counts in live, compare, list and exports until the following day", { tag: ["@hr", "@org", "@regression", "@clock"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "exitcount", "퇴직경계");
  await registerEmployee(admin, { name: "경계직원", number: "EXIT-0001", unit: "본점", hired: kstDate(-30) });
  await startOperations(admin);
  await go(admin, "/people");
  await admin.getByRole("row", { name: /경계직원/ }).getByRole("rowheader", { name: "경계직원", exact: true }).click();
  await admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }).click();
  const record = new URL(admin.url()).pathname;
  const lastDay = kstDate(0), exitDay = kstDate(1), before = kstDate(-1);
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const report = admin.getByRole("dialog");
  await report.getByRole("textbox", { name: /^마지막 근무일/ }).fill(lastDay);
  await report.getByRole("textbox", { name: /^마지막 근무일/ }).press("Tab");
  await expect(report).toContainText(`퇴직일(근로기준법·퇴직금) ${koDate(exitDay)}`);
  await expect(report).toContainText(`4대보험 상실일 ${koDate(exitDay)}`);
  await shot(admin, "exit-last-working-day-report");
  await report.getByLabel("퇴직 경위").fill("개인 사정");
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await report.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  const exit = admin.getByRole("region", { name: "퇴직", exact: true });
  await exit.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  const confirm = admin.getByRole("dialog");
  await expect(confirm).toContainText(`${koDate(exitDay)}자로 퇴직 처리하도록 예약합니다`);
  await signOff(confirm.getByRole("group", { name: "확인 사항" }));
  await confirm.getByRole("button", { name: "퇴직 1명 예약" }).click();
  await expect(confirm).toBeHidden();
  await expect(exit).toContainText("효력 예정");
  await expect(exit).toContainText(`${koDate(exitDay)}에 퇴직 처리가 반영됩니다`);
  await exit.getByRole("link", { name: "퇴직 건 열기" }).click();
  await expect(admin.getByRole("main")).toContainText(`퇴직을 ${koDate(exitDay)}자로 예약했습니다`);
  await go(admin, record);
  await expectAccessible(admin, "exit on the last working day stays scheduled");
  await shot(admin, "exit-last-working-day-record");

  await counts(admin, "/org", lastDay, 1);
  await counts(admin, `/org?compare_a=${before}&compare_b=${lastDay}`, lastDay, 1);
  await counts(admin, `/org?as_of=${exitDay}`, exitDay, 0);
  await counts(admin, `/org?compare_a=${lastDay}&compare_b=${exitDay}`, exitDay, 0);

  await withLifecycleDate(exitDay, async () => {
    await go(admin, record);
    await expect(async () => {
      await expect(admin.getByRole("heading", { name: /경계직원/, level: 1 })).toBeVisible();
      await admin.reload();
      await expect(exit).toBeVisible({ timeout: 1_000 });
      await expect(exit).not.toContainText("효력 예정", { timeout: 1_000 });
    }).toPass({ intervals: [2_000, 3_000, 5_000], timeout: 30_000 });
  });
  await shot(admin, "exit-applied-record");
  await counts(admin, `/org?as_of=${lastDay}`, lastDay, 1);
  await counts(admin, `/org?as_of=${exitDay}`, exitDay, 0);
});
