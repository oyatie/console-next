import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { openTenant } from "./helpers/tenant";
import { editName, setName } from "./helpers/entity";
import { registerSheet } from "./helpers/register";
import { brnDisplay, fillEntity, REGISTRATION_FIXTURES, setupCompany } from "./setup-flows";

test("one 법인명: ① edits the name every surface shows, and the 약칭 and 영문명 stay secondary", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const p = await openTenant(browser, "name-source", "법인명 단일 출처");
  await setupCompany(p, "누리", "본점");
  const record = new URL(p.url()).pathname;
  await setName(p, "약칭", "NURI");
  await setName(p, "영문명", "Nuri Co., Ltd.");

  // The guards, each with its own reason and nothing saved: a 대표자 as 약칭, Korean in the 영문명, a 41st character.
  for (const [label, value, reason] of [["약칭", "홍길동", "약칭에 대표자 이름이나"], ["영문명", "누리 Co., Ltd.", "영문명에는 영문, 숫자"]] as const) {
    const d = await editName(p, label);
    await d.getByRole("textbox", { name: label }).fill(value);
    await expect(d).toContainText(reason);
    await expect(d.getByRole("button", { name: "정정 기록" })).toHaveAttribute("aria-disabled", "true");
    await expectAccessible(p, `${label} refusal`);
    await d.getByRole("button", { name: "취소", exact: true }).click();
    await expect(d).toBeHidden();
  }
  const long = await editName(p, "약칭");
  await long.getByRole("textbox", { name: "약칭" }).fill("가".repeat(41));
  await expect(long.getByRole("textbox", { name: "약칭" })).toHaveValue("가".repeat(40));
  await long.getByRole("button", { name: "취소", exact: true }).click();

  // regression (0h): the 등록증's ① showed its own copy while its 수정 edited the 법인명.
  await p.getByRole("button", { name: /^사업자등록증/ }).click();
  await setName(p, "법인명(단체명)", "주식회사 다온테크");
  const title = p.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("주식회사 다온테크 · NURI · Nuri Co., Ltd.");
  const cert = p.locator("section.card").filter({ has: p.getByRole("button", { name: "법인명(단체명) 수정", exact: true }) });
  await expect(cert).toContainText("주식회사 다온테크");
  await expect(cert).not.toContainText("주식회사 누리");

  await go(p, "/org/entities");
  const row = p.getByRole("row").filter({ hasText: "주식회사 다온테크" });
  await expect(row).toContainText("주식회사 다온테크 · NURI · Nuri Co., Ltd.");
  await expect(p.getByRole("row").filter({ hasText: "주식회사 누리" })).toHaveCount(0);
  await expectAccessible(p, "법인 list: 법인명 first, aliases secondary");

  // The employee placement picker reads the same name, and finds the 법인 by its 약칭 and its 영문명.
  await go(p, "/people/new");
  const sheet = registerSheet(p);
  await sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByText("사업장 직속 · 부서 없이", { exact: true }).click();
  const place = sheet.getByPlaceholder("사업장 찾기 · 법인 › 사업장");
  for (const q of ["NURI", "Nuri Co", "다온테크"]) {
    await place.fill(q);
    await expect(p.getByRole("option").filter({ hasText: "주식회사 다온테크 · NURI · Nuri Co., Ltd." })).toBeVisible();
  }
  await go(p, record);
  await expect(title).toHaveText("주식회사 다온테크 · NURI · Nuri Co., Ltd.");
});

test("an individual's 상호 is the one name its record, list and header show", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const p = await openTenant(browser, "name-individual", "상호 단일 출처");
  await go(p, "/org/entities?add=true");
  const d = p.getByRole("dialog", { name: "법인 추가" });
  await option(p, "사업자 구분", "개인사업자").click();
  await d.getByLabel("상호").fill("새온공방");
  await d.getByLabel("성명").fill("이대표");
  await d.getByLabel("약칭").fill("이대표");
  await expect(d).toContainText("약칭에 대표자 이름이나");
  await d.getByLabel("약칭").fill("새온");
  await d.getByRole("button", { name: "법인 등록", exact: true }).click();
  await expect(d).toBeHidden();
  const row = p.getByRole("row").filter({ hasText: "새온공방" });
  await expect(row).toContainText("새온공방 · 새온");
  await expect(row).toContainText("등록증 확인 필요");
  await row.getByRole("link", { name: "확인" }).click();
  // The record names the individual's own name row 「명칭」 (P0-TRADENAME-INDIVIDUAL: 「상호」 is the certificate's
  // trade name, and this 개인사업자 has no certificate yet); it is the one value the list and the header show.
  await setName(p, "명칭", "새온목공방");
  await expect(p.getByRole("heading", { level: 1 })).toHaveText("새온목공방 · 새온");
  await go(p, "/org/entities");
  await expect(p.getByRole("row").filter({ hasText: "새온목공방 · 새온" })).toHaveCount(1);
  await expect(p.getByRole("row").filter({ hasText: "새온공방" })).toHaveCount(0);
  await expectAccessible(p, "individual 상호 list");
});

test("a branch primary is refused until its explicit certificate reason is recorded", { tag: "@org" }, async ({ browser }) => {
  const p = await openTenant(browser, "name-branch", "등록번호 검증");
  await go(p, "/org/entities/new");
  await fillEntity(p, "지점검증", undefined, REGISTRATION_FIXTURES.branch_primary);
  const reply = p.waitForResponse((r) => r.request().method() === "POST" && /registrations$/.test(r.url()));
  await p.getByRole("button", { name: "법인만 등록" }).click();
  const response = await reply;
  expect(response.status()).toBe(422);
  expect(JSON.stringify(await response.json())).toContain("registration_classification_reason_required");
  await expect(p.getByRole("alert")).toContainText("예외 사유를 입력하십시오");
  await expectAccessible(p, "primary branch classification refusal");
  await p.getByRole("button", { name: "이전", exact: true }).click();
  await p.getByRole("button", { name: "이전", exact: true }).click();
  await expect(p.getByLabel("사업자등록번호")).toHaveValue(brnDisplay(REGISTRATION_FIXTURES.branch_primary.brn));
  await p.getByLabel("등록번호 구분 예외 사유").fill("본점 등록증을 요청했고 지점임을 확인했습니다");
  await p.getByRole("button", { name: "다음: 등기·대표자" }).click();
  await p.getByRole("button", { name: "다음", exact: true }).click();
  await p.getByRole("button", { name: "법인만 등록" }).click();
  await expect(p.getByRole("heading", { level: 1 })).toHaveText("주식회사 지점검증");
});

// The client holds a 대표자 name before it is sent; the server's own guard still refuses one that gets past it
// (a stale tab, another client). The request is rewritten on the wire so the server's code reaches the UI.
test("the server refuses a 대표자 as 법인명 or 영문명 and the sheet says why, saving nothing", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const p = await openTenant(browser, "name-person-wire", "대표자 이름 거절");
  await setupCompany(p, "누리", "본점");
  const title = p.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("주식회사 누리");
  const revise = /\/api\/v1\/legal-entities\/[\w-]+$/;
  for (const [label, field, valid, code, reason] of [
    ["영문명", "english_name", "Nuri Co., Ltd.", "english_name_is_person", "영문명에 대표자 이름이나 성명 목록을 입력할 수 없습니다"],
    ["법인명(단체명)", "name", "주식회사 다온테크", "legal_name_is_person", "법인명에 대표자 이름이나 성명 목록을 입력할 수 없습니다"],
  ] as const) {
    if (field === "name") await p.getByRole("button", { name: /^사업자등록증/ }).click();
    await p.route(revise, (r) => r.request().method() === "PUT" ? r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), [field]: "홍길동" }) }) : r.fallback());
    const d = await editName(p, label);
    await d.getByRole("textbox", { name: label }).fill(valid);
    const reply = p.waitForResponse((r) => r.request().method() === "PUT" && revise.test(r.url()));
    await d.getByRole("button", { name: "정정 기록", exact: true }).click();
    const response = await reply;
    expect(response.status()).toBe(422);
    expect(JSON.stringify(await response.json())).toContain(code);
    await expect(d).toContainText(reason);
    await expectAccessible(p, `server ${code}`);
    await p.unroute(revise);
    await d.getByRole("button", { name: "취소", exact: true }).click();
    await expect(d).toBeHidden();
    await expect(title).toHaveText("주식회사 누리");
  }
});
