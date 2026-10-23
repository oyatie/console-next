import { expect, type Page } from "@playwright/test";
import { go } from "../flows";
import { shot } from "./shot";
import { cutRecordUpdates, openByNumber, pick, restoreRecordUpdates, sheet } from "./steps";
import { reasonChip } from "../helpers/lifecycle";
import { holdRead } from "../helpers/read";
import { HERO } from "./universe";

// E4 sheets on the hero, E2-cancel from the reservation they make, E9 voids, E12 denied and conflict.
export async function sheetFrames(a: Page) {
  const verbs = a.getByRole("group", { name: "인사카드 동작" });
  await a.getByRole("button", { name: "입사일 수정", exact: true }).click();
  await sheet(a).getByRole("textbox", { name: "입사일" }).fill("2019-03-04");
  await pick(sheet(a), /왜 정정합니까/, "원본 서류와 다름").click();
  await shot(a, "E4-hire-correct");
  await sheet(a).getByText(/이 정정으로 함께 바뀌는 기록/).scrollIntoViewIfNeeded();
  await shot(a, "E4-hire-correct--below");
  await sheet(a).getByRole("button", { name: "닫기", exact: true }).last().click();
  await a.getByRole("button", { name: "직급 수정" }).click();
  await shot(a, "E4-grade-initial");
  await sheet(a).getByText("직급이 바뀝니다 · 변경 (발령)").click();
  await sheet(a).getByRole("button", { name: "다음" }).click();
  await pick(sheet(a), /^새 직급/, "대리").click();
  await sheet(a).getByRole("radiogroup", { name: /언제부터/ }).getByText(/^다음 달 1일/).click();
  await pick(sheet(a), /사유/, "정기 승진").click();
  await pick(sheet(a), /직위도/, "직위도 대리로").click();
  await shot(a, "E4-grade-change");
  await shot(a, "E4-grade-change--dark", { dark: true });
  await sheet(a).getByRole("button", { name: "승진 1명 예약" }).click();
  await expect(sheet(a)).toBeHidden();
  await a.getByRole("button", { name: "예약 취소 ›" }).first().click();
  await expect(sheet(a)).toBeVisible();
  await shot(a, "E2-cancel");
  await a.keyboard.press("Escape");
  await verbs.getByRole("button", { name: "정정", exact: true }).click();
  await sheet(a).getByRole("textbox", { name: "직무" }).fill("생산·조립 (CNC 가공)");
  await sheet(a).getByRole("textbox", { name: "생년월일" }).fill("1994-08-12");
  await pick(sheet(a), /사유/, "원본 서류와 다름").click();
  await shot(a, "E4-multi");
  await sheet(a).getByRole("button", { name: "닫기", exact: true }).last().click();
  await a.getByRole("button", { name: "사번 변경", exact: true }).click();
  await sheet(a).getByRole("textbox", { name: "새 사번" }).fill("10422");
  await expect(sheet(a).getByText(/이미 쓰는 사번입니다/)).toBeVisible();
  await shot(a, "E4-empno-change");
  await sheet(a).getByRole("button", { name: "닫기", exact: true }).last().click();

  // E12-conflict: the same person saved first in another tab; this tab's quick edit meets the 409 and keeps its value.
  await expect(a.getByText(/예약했습니다|정정했습니다/)).toHaveCount(0, { timeout: 20_000 });
  await cutRecordUpdates(a);
  const other = await a.context().newPage();
  await other.goto(a.url());
  await other.getByRole("button", { name: "개인 이메일 수정" }).click();
  await other.getByRole("textbox", { name: "개인 이메일" }).fill("hajun.yoon@mail.example");
  await other.getByRole("textbox", { name: "개인 이메일" }).press("Enter");
  await expect(other.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  await other.close();
  await a.getByRole("button", { name: "개인 이메일 수정" }).click();
  await a.getByRole("textbox", { name: "개인 이메일" }).fill("hajun@example.com");
  await a.getByRole("textbox", { name: "개인 이메일" }).press("Enter");
  const clash = a.getByRole("group", { name: /먼저 변경했습니다|다른 칸을 변경했습니다/ });
  // The 409 re-reads the person: the other value is there to choose, the field itself having moved.
  await expect(clash.getByText(/^그 값 사용 · hajun\.yoon@mail\.example/)).toBeVisible({ timeout: 15_000 });
  await shot(a, "E12-conflict");
  await clash.getByText(/^그 값 사용/).click();
  await clash.getByRole("button", { name: "선택대로 저장" }).click();
  await expect(clash).toBeHidden();
  await restoreRecordUpdates(a);
  // E12-conflict-sheet: a sheet open while the person changes elsewhere; the save meets the 409 and shows three values.
  await a.getByRole("button", { name: "성별 수정" }).click();
  await pick(sheet(a), /^성별/, "여").click();
  await pick(sheet(a), /왜 정정합니까/, "입력 실수").click();
  const third = await a.context().newPage();
  await third.goto(a.url().split("?")[0]!);
  await third.getByRole("button", { name: "업무 이메일 수정" }).click();
  await third.getByRole("textbox", { name: "업무 이메일" }).fill("hajun@saeon.example");
  await third.getByRole("textbox", { name: "업무 이메일" }).press("Enter");
  await expect(third.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  await third.close();
  await sheet(a).getByRole("button", { name: "인사 정보 1명 정정", exact: true }).click();
  await expect(sheet(a).getByText(/시트를 연 뒤 다른 사람이/)).toBeVisible();
  await shot(a, "E12-conflict-sheet");
  await a.keyboard.press("Escape");

  // E9 (CRUD's 등록 취소 sheet from the ⋯ menu): a registration made by mistake (30135, registered today), then one that cannot be
  // cancelled (an exit).
  await openByNumber(a, "30135", "김민서");
  await verbs.getByRole("button", { name: "더 보기" }).click();
  await a.getByRole("menuitem", { name: /등록 취소/ }).click();
  await shot(a, "E9-void");
  await sheet(a).getByRole("button", { name: "돌아가기", exact: true }).click();
  await openByNumber(a, "10201", "최도현", "EXITED");
  await verbs.getByRole("button", { name: "더 보기" }).click();
  await a.getByRole("menuitem", { name: /등록 취소/ }).click();
  await expect(sheet(a)).toContainText("등록 취소할 수 없는 기록입니다");
  await shot(a, "E9-void-blocked");
  await a.keyboard.press("Escape");
  // E1-jump-alias: a dated number change keeps the old number as an alias that still finds the person.
  await openByNumber(a, "30135", "김민서");
  await verbs.getByRole("button", { name: "더 보기" }).click();
  await a.getByRole("menuitem", { name: "사번 변경" }).click();
  await sheet(a).getByRole("textbox", { name: "새 사번" }).fill("30901");
  await pick(sheet(a), /언제부터/, "오늘부터").click();
  await reasonChip(sheet(a), "사번 체계 변경", "사유").click();
  const account = await holdRead(a, /\/api\/v1\/directory\/people\?.*search=30901(?:&|$)/);
  await sheet(a).getByRole("button", { name: "사번 1명 변경", exact: true }).click();
  await account.requested;
  try {
    await expect(sheet(a)).toBeHidden();
    await a.keyboard.press("ControlOrMeta+k");
    await a.getByRole("searchbox", { name: "찾기와 이동" }).fill("30135");
  } finally {
    await account.release();
  }
  await expect(a.getByText(/예전 30135 → 지금 30901/)).toBeVisible();
  await shot(a, "E1-jump-alias");
  await a.keyboard.press("Escape");
  // E11-access: the HR lead's record linked to their console account; roles and scopes are read in 사람별 권한.
  await openByNumber(a, "10094", "문지호");
  await a.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "권한", exact: true }).click();
  await a.getByRole("combobox", { name: /연결할 계정/ }).fill("운영 계정");
  await a.getByRole("option", { name: /운영 계정/ }).click();
  await a.getByRole("button", { name: "계정 연결" }).click();
  await expect(a.getByRole("link", { name: "사람별 권한" })).toBeVisible();
  await shot(a, "E11-access");
  await shot(a, "E11-access--full", { full: true });
  await go(a, `/people/00000000-0000-4000-8000-000000000000`);
  await expect(a.getByRole("heading", { name: "볼 권한이 없는 인사카드입니다" })).toBeVisible();
  await shot(a, "E12-denied");
  void HERO;
}
