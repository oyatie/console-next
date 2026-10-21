import { expect, type Page } from "@playwright/test";
import { go } from "../flows";
import { shot } from "./shot";
import { HERO } from "./universe";

// E1 + E12 list frames, in 설정 단계 (spec §1.3a: the roster frames are drawn on the ops account in setup).
export async function rosterFrames(a: Page) {
  // E12-loading: the list read held back, so the skeleton (final geometry) is what shows.
  await a.route("**/api/v1/employees?*", async (r) => (await new Promise((f) => setTimeout(f, 8000)), r.continue().catch(() => undefined)));
  await a.goto("/people");
  await expect(a.getByRole("heading", { name: "직원", level: 1 })).toBeVisible();
  await a.waitForTimeout(400); // past the skeleton delay, so the placeholder rows show
  await shot(a, "E12-loading");
  await a.unrouteAll({ behavior: "ignoreErrors" });
  await a.reload();
  await expect(a.getByText(HERO.name).first()).toBeVisible({ timeout: 20_000 });
  await shot(a, "E1-roster");
  await shot(a, "E1-roster--dark", { dark: true });
  await a.getByRole("rowheader", { name: "김태현" }).click();
  await expect(a.getByRole("complementary").getByRole("heading", { name: /김태현/ })).toBeVisible();
  await expect(a.getByRole("complementary").getByText(/빠짐$|모두 있음$/).first()).toBeVisible();
  await shot(a, "E1-peek");
  await a.keyboard.press("Escape");
  const find = a.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("김민서");
  await find.press("Enter");
  await expect(a.getByRole("rowheader", { name: "김민서" })).toHaveCount(2);
  await shot(a, "E1-dup");
  await find.fill("없는사람");
  await find.press("Enter");
  await expect(a.getByText(/과 맞는 사람이 없습니다/)).toBeVisible();
  await shot(a, "E1-empty");
  await find.fill("");
  await find.press("Enter");
  await a.getByRole("button", { name: /^재직 \d/ }).click();
  // The row box's label takes the press (its input is visually hidden).
  const tick = (row: ReturnType<Page["getByRole"]>) => row.locator("label", { has: a.getByRole("checkbox") }).click();
  await tick(a.getByRole("row", { name: /김은지/ }));
  await tick(a.getByRole("row", { name: /김태현/ }));
  await shot(a, "E1-select");
  await tick(a.getByRole("grid").getByRole("row").first());
  await shot(a, "E1-selectall");
  await a.getByRole("button", { name: "선택 해제" }).click();
  await a.getByRole("button", { name: /^재직 \d/ }).click();
  await a.getByRole("button", { name: /^열 \d/ }).click();
  await expect(a.getByRole("heading", { name: "열 선택" })).toBeVisible();
  await a.getByRole("button", { name: "고용형태 열을 앞으로" }).click();
  await shot(a, "E1-views");
  await a.keyboard.press("Escape");
  await a.getByRole("button", { name: /^범위 · 전체 · 변경/ }).click();
  await expect(a.getByRole("option", { name: /^평택공장/ })).toBeVisible();
  await shot(a, "E1-scope");
  await a.keyboard.press("Escape");
  // E12-error: the server stops answering the list; the screen says so, with the way to try again.
  await a.route("**/api/v1/employees?*", (r) => r.fulfill({ status: 503, body: "{}" }));
  await a.getByRole("button", { name: "입사 예정", exact: true }).click();
  await expect(a.getByRole("alert").getByRole("button", { name: "다시 시도" })).toBeVisible();
  await shot(a, "E12-error");
  await a.unrouteAll({ behavior: "ignoreErrors" });
  await a.getByRole("button", { name: "전체 (퇴직 제외)" }).click();
  // ⌘K: two people of one name told apart; a name nobody in scope has; then the key map.
  await a.keyboard.press("ControlOrMeta+k");
  await a.getByRole("searchbox", { name: "찾기와 이동" }).fill("김민서");
  await expect(a.getByRole("option", { name: /^김민서 3/ })).toHaveCount(2);
  await shot(a, "E1-jump");
  await a.getByRole("searchbox", { name: "찾기와 이동" }).fill("박지성");
  await expect(a.getByText(/맞는 사람이 내 권한 범위에 없습니다/)).toBeVisible();
  await shot(a, "E1-jump-empty");
  await a.keyboard.press("Escape");
  await a.getByRole("heading", { name: "직원", level: 1 }).click();
  await a.keyboard.press("?");
  await expect(a.getByRole("heading", { name: "단축키" })).toBeVisible();
  await shot(a, "E1-keys");
  await a.keyboard.press("Escape");
  // 퇴직 · 3년 보관 (E9-exited) and the 근로자 명부 export (E10-register).
  await a.getByRole("button", { name: /^퇴직 · 3년 보관/ }).click();
  await expect(a.getByText(/보존 기한 = /)).toBeVisible();
  await expect(a.getByRole("row", { name: /최도현/ })).toBeVisible();
  // The read-only peek of one exit: retention, what happens past it, the other ways on.
  await a.getByRole("rowheader", { name: "최도현" }).click();
  await expect(a.getByRole("complementary").getByText("보존 기한", { exact: true })).toBeVisible();
  await expect(a.getByRole("complementary").getByText(/빠짐$|모두 있음$/).first()).toBeVisible();
  await shot(a, "E9-exited");
  await a.keyboard.press("Escape");
  await go(a, "/people?export=register");
  await a.getByRole("radiogroup", { name: /사업장/ }).getByText(/평택공장/).click();
  await a.getByRole("radiogroup", { name: /왜 내보냅니까/ }).getByText("감사 대응", { exact: true }).click();
  await expect(a.getByText(/근로자 [1-9]\d*명/)).toBeVisible();
  await expect(a.getByRole("table", { name: "명부 미리 보기" }).getByRole("row")).not.toHaveCount(1);
  await expect(a.getByRole("table", { name: "명부 미리 보기" })).not.toContainText("…", { timeout: 15_000 });
  await shot(a, "E10-register");
  await shot(a, "E10-register--full", { full: true });
  await shot(a, "E10-register--dark", { dark: true });
  await shot(a, "E10-register--dark--full", { dark: true, full: true });
  await a.getByRole("button", { name: "닫고 직원 목록으로" }).click();
}
