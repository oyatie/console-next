import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

// The directory reads (PEOPLE-B): the roster's employment-type column and chip counts from the facets read, a
// download that asks its purpose first and holds no personal identifiers, and the exit list's name search.
test("roster facets, employment type, purposeful download and exit search", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "reads", "명부상사");
  await registerEmployee(admin, { name: "고정규", number: "RD-0001", position: "사원" });
  await registerEmployee(admin, { name: "나계약", number: "RD-0002", position: "사원", contractEnd: kstDate(30) });

  await go(admin, "/people");
  await expect(admin.getByRole("button", { name: /^재직 2/ })).toBeVisible();
  await expect(admin.getByRole("row", { name: /고정규/ })).toContainText("정규직");
  await expect(admin.getByRole("row", { name: /나계약/ })).toContainText("계약직");
  // The contract ending within the window counts on its chip from the same facets read.
  await expect(admin.getByRole("button", { name: /^계약 종료 \d+일 이내 1/ })).toBeVisible();
  await expectAccessible(admin, "roster with the employment column");

  // The download asks why first, says it is logged, and carries no resident number or pay.
  await admin.getByRole("button", { name: "명부 내려받기" }).click();
  const dialog = admin.getByRole("dialog", { name: "직원 명부 내려받기" });
  await expect(dialog).toContainText("접속기록에 남습니다");
  await dialog.getByRole("button", { name: "2명 내려받기" }).click();
  await expect(dialog).toContainText("용도를 선택하십시오");
  await dialog.getByText("내부 검토", { exact: true }).click();
  await expectAccessible(admin, "roster download dialog");
  const download = admin.waitForEvent("download");
  await dialog.getByRole("button", { name: "2명 내려받기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`직원명부-${kstDate()}.csv`);
  const csv = await readFile((await file.path())!, "utf8");
  expect(csv).toContain("RD-0001");
  expect(csv).toContain("RD-0002");
  expect(csv.split("\n")[0]).not.toMatch(/rrn|resident|pay|account/i);
  await expect(dialog).toBeHidden();

  // An exit case is found by the person's name or number, and the chips count the search.
  await go(admin, "/people");
  await admin.getByRole("rowheader", { name: "나계약", exact: true }).click();
  await admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }).click();
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const sheet = admin.getByRole("dialog");
  await expect(sheet).toContainText("RD-0002");
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(7));
  await sheet.getByLabel("퇴직 경위").fill("계약 종료 전 이직");
  await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(sheet).toBeHidden();
  await expect(admin.getByRole("region", { name: "퇴직" }).last()).toContainText("보고됨");
  await go(admin, "/people/exits");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("RD-0001");
  await find.press("Enter");
  await expect(admin.getByText("조건에 맞는 퇴직 건이 없습니다")).toBeVisible();
  await find.fill("나계약");
  await find.press("Enter");
  await expect(admin.getByRole("rowheader", { name: /나계약/ })).toBeVisible();
  await expectAccessible(admin, "exit list searched by name");
});
