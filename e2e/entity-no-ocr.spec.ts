import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";

// Uploads remain evidence; the MVP does not read their contents or look up registration details.

const PDF = { name: "사업자등록증.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

test("an uploaded 사업자등록증 fills nothing, and the screens never promise it", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "no-ocr", "새온");

  // The empty list and the setup step name the act (법인 등록), not the upload, and say nothing is read.
  await go(admin, "/org/entities");
  const main = admin.getByRole("main");
  await expect(main).toContainText("글자를 읽어 오지는 않습니다");
  await expect(main).not.toContainText(/채워 드립|사업자등록증 올리기/);
  await admin.getByRole("link", { name: "법인 등록" }).first().click();

  await option(admin, "사업자 구분", "법인사업자").click();
  await admin.getByLabel("법인명(단체명)").fill("주식회사 새온정밀");
  await admin.getByRole("button", { name: "다음", exact: true }).click();

  // The upload is optional and says so before and after it lands.
  const original = admin.getByRole("region", { name: "원본" });
  await expect(original).toContainText("원본 첨부(선택)");
  await expect(original.getByRole("button", { name: /파일 선택/ })).toBeEnabled();
  await original.locator('input[type="file"]').setInputFiles(PDF);
  await expect(original.getByRole("status")).toHaveText(/값은 등록증을 보며 직접 입력하십시오/);
  await expect(original).toContainText(PDF.name);

  // Negative: every certificate field is still empty after the upload.
  for (const field of [admin.getByLabel("사업자등록번호"), admin.getByRole("textbox", { name: /^법인등록번호/ }), admin.getByRole("textbox", { name: /^대표자/ }), admin.getByLabel("개업연월일"), admin.getByLabel("관할 세무서")])
    await expect(field).toHaveValue("");
  await expectAccessible(admin, "entity wizard: original uploaded, nothing filled");
});
