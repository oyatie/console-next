// SPDX-License-Identifier: LicenseRef-Proprietary
import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";
import type { LegalEntity } from "@console/api/pending";
import { go, kstDate, option } from "./flows";
import { tenantInSetup } from "./setup-flows";

async function readEntity(page: Page, id: string): Promise<LegalEntity> {
  const read = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/legal-entities/${id}`);
  await go(page, `/org/entities/${id}`);
  return (await read).json();
}

async function load(page: Page, mode: "paste" | "import", rows: string[][]) {
  await go(page, `/org/entities?bulk=${mode}`);
  if (mode === "paste") {
    await page.getByLabel("법인 목록", { exact: true }).fill(rows.map((r) => r.join("\t")).join("\n"));
    await page.getByRole("button", { name: "열 연결", exact: true }).click();
  } else {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("기록");
    rows.forEach((r) => sheet.addRow(r));
    await page.locator('input[type="file"]').setInputFiles({ name: "기록.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  }
  await page.getByRole("button", { name: "입력값 확인" }).click();
}

for (const mode of ["paste", "import"] as const) {
  test(`entity ${mode}: refusal, full-state revisions, create, receipt and undo @org`, async ({ browser }) => {
    const { admin: page } = await tenantInSetup(browser, `record${mode}`, "기록상사", false, "본사");
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const before = await readEntity(page, id);
    const workplace = before.workplaces[0]!;
    const headers = ["법인 이름", "종류", "대표자", "작업 구분", "수정할 기록", "사업장 이름", "수정할 버전"];
    const revised = ["주식회사 기록물산", "CORPORATION", "홍길동", "REVISE_ENTITY", id, "", ""];
    const rows = [headers, ["신설단체", "ID_NUMBER_ORG", "김대표", "CREATE_ENTITY", "", "", ""], revised,
      ["", "", "", "REVISE_WORKPLACE", workplace.id, "새 본사", ""]];
    await load(page, mode, [headers, ["", "", "", "CREATE_WORKPLACE", "", "새 사업장", ""]]);
    await expect(page.getByRole("link", { name: "사업장 등록 · 원천징수·보험 확인" })).toHaveAttribute("href", "/org/paste");
    await expect(page.getByRole("button", { name: "등록 미리보기" })).toHaveAttribute("aria-disabled", "true");
    await load(page, mode, [headers, [...revised.slice(0, -1), "999"]]);
    await page.getByLabel("변경일", { exact: true }).fill(kstDate());
    await page.getByRole("textbox", { name: "변경 사유" }).fill("이름 변경");
    await page.getByRole("button", { name: "등록 미리보기" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /기록 .*건 반영/ })).toHaveCount(0);
    await load(page, mode, rows);
    const nameRow = page.locator("details").filter({ hasText: "새 본사" });
    await nameRow.locator("summary").click();
    await nameRow.getByRole("textbox", { name: "사업장 이름", exact: true }).fill("수정 본사");
    await expect(nameRow.getByRole("textbox", { name: "사업장 이름", exact: true })).toHaveValue("수정 본사");
    await page.getByLabel("변경일", { exact: true }).fill(kstDate());
    await page.getByRole("textbox", { name: "변경 사유" }).fill("이름 변경");
    await page.getByRole("button", { name: "등록 미리보기" }).click();
    await expect(page.getByRole("button", { name: "기록 3건 반영" })).toBeVisible();
    await expect(nameRow).toContainText("본사 → 수정 본사");
    await page.getByRole("button", { name: "기록 3건 반영" }).click();
    await expect(page.getByRole("status").filter({ hasText: "기록됨" })).toContainText("기록 3건을 반영했습니다");
    const observer = await page.context().newPage();
    const applied = await readEntity(observer, id);
    const changedWorkplace = applied.workplaces.find((w) => w.id === workplace.id)!;
    expect(changedWorkplace.current?.name).toBe("수정 본사");
    expect(changedWorkplace.current?.opened_on).toBe(workplace.current?.opened_on);
    expect(changedWorkplace.registration_id).toBe(workplace.registration_id);
    expect(changedWorkplace.sub_serial).toBe(workplace.sub_serial);
    expect(applied.current?.representatives).toEqual(before.current?.representatives);
    expect(applied.current?.incorporated_on).toEqual(before.current?.incorporated_on);
    await observer.close();
    await page.getByRole("button", { name: "되돌리기", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "기록됨" })).toContainText("되돌렸습니다");
    const after = await readEntity(page, id);
    expect(after.current?.capital_won).toEqual(before.current?.capital_won);
    expect(after.current?.representatives).toEqual(before.current?.representatives);
    expect(after.workplaces.find((w) => w.id === workplace.id)?.current?.name).toEqual(workplace.current?.name);
  });
}

test("registration change: unchanged hold, unlink through the dated sheet @org", async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "regchange", "등록상사", false, "본사");
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const before = await readEntity(page, id);
  const workplace = before.workplaces[0]!;
  await go(page, `/org/entities/${id}?wp=${workplace.id}`);
  await page.getByRole("button", { name: "본사 사업자등록 변경" }).click();
  const sheet = page.getByRole("dialog", { name: "본사 사업자등록 변경" });
  await expect(sheet.getByRole("button", { name: "등록 변경", exact: true })).toHaveAttribute("aria-disabled", "true");
  await option(page, "변경할 사업자등록", "등록증 연결 안 함").click();
  await sheet.getByRole("textbox", { name: "변경 사유" }).fill("연결 해제");
  const other = await page.context().newPage();
  await go(other, `/org/entities/${id}?wp=${workplace.id}`);
  await other.getByRole("button", { name: "본사 사업자등록 변경" }).click();
  const otherSheet = other.getByRole("dialog", { name: "본사 사업자등록 변경" });
  await option(other, "변경할 사업자등록", "등록증 연결 안 함").click();
  await otherSheet.getByRole("textbox", { name: "변경 사유" }).fill("연결 해제");
  await otherSheet.getByRole("button", { name: "등록 변경", exact: true }).click();
  await expect(otherSheet).toBeHidden();
  await sheet.getByRole("button", { name: "등록 변경", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("지금 연결된 사업자등록과 같습니다");
  await other.close();
  const after = await readEntity(page, id);
  expect(after.workplaces.find((w) => w.id === workplace.id)?.registration_id).toBeNull();
});
