import { expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { openByNumber, pick, savedToast, sheet } from "./steps";
import { HERO } from "./universe";

// E2 frames on the hero's 인사카드 (운영 중): quick edit, reveal, 이력 rows and their void, restricted, history, cert.
export async function cardFrames(a: Page) {
  await openByNumber(a, HERO.no, HERO.name);
  // The hero's record as HR keeps it: 성별 recorded (정정만), mobile and work e-mail fixed in place.
  // The import derives sex from the resident number; the card must show that recorded value.
  await expect(a.locator("#f-sex")).toContainText("남");
  for (const [field, value] of [["휴대전화", "010-1234-0050"], ["업무 이메일", "hajun.yoon@saeon-precision.example"]] as const) {
    await a.getByRole("button", { name: `${field} 수정` }).click();
    await a.getByRole("textbox", { name: field }).fill(value);
    await a.getByRole("textbox", { name: field }).press("Enter");
    await savedToast(a);
  }
  // 주소 as first written (정정 of an empty value), through the address field's typed entry (no outside lookup, MVP).
  await a.getByRole("button", { name: "주소 수정" }).click();
  await sheet(a).getByText("처음부터 잘못 적었습니다 · 정정").click();
  await sheet(a).getByRole("button", { name: "다음" }).click();
  await sheet(a).getByRole("button", { name: "주소를 직접 입력" }).first().click();
  await sheet(a).getByLabel("도로명주소").fill("경기도 평택시 포승읍 새온로 118");
  await sheet(a).getByLabel("우편번호 (5자리)").fill("17960");
  await sheet(a).getByRole("button", { name: "이 주소로 저장" }).click();
  await pick(sheet(a), /왜 정정합니까/, "원본 서류와 다름").click();
  await sheet(a).getByRole("button", { name: "정정", exact: true }).click();
  await expect(sheet(a)).toBeHidden();
  await expect(a.getByRole("status").filter({ hasText: /정정했습니다|저장했습니다/ })).toHaveCount(0, { timeout: 20_000 });
  await a.getByRole("heading", { name: HERO.name, level: 1 }).scrollIntoViewIfNeeded();
  await a.getByRole("button", { name: "성명 한자 · 영문 수정" }).click();
  await a.getByRole("textbox", { name: "성명 한자 · 영문" }).fill("YOON HAJUN");
  await shot(a, "E2-inline");
  await a.getByRole("textbox", { name: "성명 한자 · 영문" }).press("Enter");
  await savedToast(a);
  await expect(a.getByRole("status").filter({ hasText: "저장했습니다" })).toBeHidden({ timeout: 15_000 });
  await shot(a, "E2-card");
  // 이력: two 학력 rows and three 자격 rows typed in place (Enter saves and opens the next row).
  const records = a.getByRole("region", { name: "이력" });
  await records.getByRole("button", { name: "학력 추가" }).click();
  const row = a.getByRole("group", { name: "새 학력 줄" });
  await row.getByRole("textbox", { name: "학교" }).fill("한국폴리텍대학 아산캠퍼스");
  await row.getByRole("combobox", { name: "과정" }).selectOption("ASSOCIATE");
  await row.getByRole("textbox", { name: "전공" }).fill("기계과");
  await row.getByRole("combobox", { name: "상태" }).selectOption("GRADUATED");
  await shot(a, "E2-records");
  await row.getByRole("button", { name: "저장" }).click();
  await expect(records.getByText("한국폴리텍대학 아산캠퍼스")).toBeVisible();
  await row.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: "자격·면허 추가" }).click();
  const q = a.getByRole("group", { name: "새 자격·면허 줄" });
  for (const name of ["컴퓨터응용선반기능사", "지게차운전기능사"]) {
    await q.getByRole("textbox", { name: "자격·면허" }).fill(name);
    await q.getByRole("combobox", { name: "구분" }).selectOption("NATIONAL_TECHNICAL");
    await q.getByRole("textbox", { name: "발급" }).fill("한국산업인력공단");
    await q.getByRole("button", { name: "저장" }).click();
    await expect(records.getByText(name)).toBeVisible();
  }
  await q.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: "지게차운전기능사 더보기" }).click();
  await a.getByRole("menuitem", { name: "무효화" }).click();
  await pick(a, /왜 무효화합니까/, "다른 사람 기록을 잘못 붙임").click();
  await a.getByRole("button", { name: "무효화", exact: true }).click();
  await expect(records.getByRole("row").filter({ hasText: "지게차운전기능사" })).toContainText("무효화");
  await records.scrollIntoViewIfNeeded();
  await shot(a, "E2-records-void");
  await shot(a, "E2-records-void--full", { full: true });
  await a.getByRole("region", { name: "제한 항목" }).scrollIntoViewIfNeeded();
  await shot(a, "E2-restricted");
  await a.getByRole("region", { name: "인적사항" }).scrollIntoViewIfNeeded();
  await a.getByRole("heading", { name: HERO.name, level: 1 }).scrollIntoViewIfNeeded();
  await shot(a, "E2-card--full", { full: true });
  await shot(a, "E2-card--dark", { dark: true });
  await shot(a, "E2-card--dark--full", { dark: true, full: true });
  // E2-reveal: the 주민등록번호 (decisions #25), its reason picked, the log line it leaves; not yet opened.
  await a.getByRole("button", { name: "주민등록번호 보기 · 사유를 선택합니다" }).click();
  await a.getByRole("radiogroup", { name: /왜 봅니까/ }).locator("label").first().click();
  await shot(a, "E2-reveal");
  await a.keyboard.press("Escape");
  const verbs = a.getByRole("group", { name: "인사카드 동작" });
  await verbs.getByRole("button", { name: "증명서" }).click();
  await pick(sheet(a), /종류/, "재직증명서").click();
  await shot(a, "E2-cert");
  await sheet(a).getByRole("button", { name: "취소" }).click();
  await verbs.getByRole("button", { name: "인사카드 인쇄" }).click();
  await shot(a, "E10-print");
  await shot(a, "E10-print--full", { full: true });
  await a.getByRole("button", { name: "닫고 인사카드로" }).click();
  await a.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "변경 이력", exact: true }).click();
  await shot(a, "E2-history");
  await a.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "인사카드", exact: true }).click();
}
