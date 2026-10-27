import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { go, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { box, revealUnit } from "./structure-flows";
import { reasonBox, sheet, signOff, todayPreset } from "./sheet";
import { hrAct } from "./record";

// J7 조직 폐지 after go-live (UX-R2 org-04, org-05, org-06, org-31; regression): ONE sheet, blockers first — where each
// member goes (everyone to the parent by default, anyone elsewhere through the searchable tree), the head post and the
// grants scoped to the unit — then one change that moves the people (a dated 전보 each; someone on leave keeps their
// status) and closes the unit on its date. No 결재 (decisions #26), no tick list after: the unit leaves today's chart, the
// user stays on it with a receipt, and the record counts the people it moved.
test("J7 dissolve: one sheet sends each member somewhere, closes the unit on its date and counts who moved", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000); // a staffed tenant, two people (one on leave), one dissolution and five screens read
  const { admin } = await staffedTenant(browser, "j7co", "폐지주식회사");
  const c = clickCounter();
  await registerEmployee(admin, { name: "이동이", unit: "채용팀" });
  await hrAct(admin, "휴직 처리");
  const leave = sheet(admin, "이동이 휴직 처리");
  await leave.getByText("개인 사유", { exact: true }).click();
  await todayPreset(leave).click();
  await reasonBox(leave).fill("개인 사유 휴직");
  await signOff(leave);
  await leave.getByRole("button", { name: "휴직 1명 적용", exact: true }).click();
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("이동이를 휴직 처리했습니다");
  await registerEmployee(admin, { name: "이동일", unit: "채용팀" });
  const moved = new URL(admin.url()).pathname;

  // 1. Someone on leave still belongs to the unit: it counts them and lists them.
  await go(admin, "/org");
  await revealUnit(admin, "채용팀");
  const panel = admin.getByRole("complementary", { name: "채용팀" });
  await expect(panel.getByRole("region", { name: "직속 구성원 2" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "이동이" })).toBeVisible();

  // 2. 폐지 opens the one dissolution sheet (no 「삭제 · 폐지」 sheet first, org-06).
  await c.click(panel.getByRole("button", { name: "부서 폐지", exact: true }));
  const dissolve = sheet(admin, "채용팀 폐지");
  await expect(sheet(admin, "채용팀 삭제 · 폐지")).toHaveCount(0);
  await expect(dissolve).toContainText("구성원은 모두 본사 › 인사부로 갑니다 · 바로 위 조직(기본)");
  await expect(dissolve.getByRole("region", { name: "본사 › 인사부로 2명" })).toBeVisible();
  await expect(dissolve).toContainText("부서장이 없습니다");
  await expect(dissolve).toContainText("이 부서 범위로 준 권한이 없습니다");
  await expect(dissolve).not.toContainText(/이 서버가|삭제됩니다|기안|상신|결재/);
  // Nothing is defaulted that the user must decide: the date and reason are named until given (negative).
  const submit = dissolve.getByRole("button", { name: "부서 폐지 1개 적용" });
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await expect(submit).toHaveAccessibleDescription(/시행일, 사유/);
  await expectAccessible(admin, "J7: dissolution sheet, blockers first");

  // 3. 이동일 goes elsewhere: straight under 본사 (사업장 직속), picked in the searchable tree.
  await c.click(dissolve.getByRole("button", { name: "이동일님은 다른 곳으로" }));
  const tree = dissolve.getByRole("treegrid", { name: "이동일님이 갈 곳" });
  await tree.getByRole("searchbox").or(dissolve.getByRole("searchbox", { name: "이동일님이 갈 곳 찾기" })).first().fill("본사");
  await c.click(tree.getByRole("row", { name: /^본사/ }).first());
  await expect(dissolve.getByRole("region", { name: "본사 › 인사부로 1명" })).toBeVisible();
  await expect(dissolve.getByRole("region", { name: "본사 직속으로 1명" })).toBeVisible();
  await c.click(dissolve.getByRole("button", { name: /^오늘/ }));
  await dissolve.getByLabel("사유").fill("채용 기능 인사부로 통합");
  await expect(dissolve).toContainText("채용팀이 폐지되고, 직속 구성원 2명이 지정한 곳으로 각자 전보되며");
  await atPhoneWidth(admin, () => fits(admin, "J7: dissolution"));
  await c.click(submit);

  // 4. Back on the chart with a receipt; the unit is off today's chart (org-05), no tick list anywhere.
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  const receipt = admin.getByRole("status").filter({ hasText: "채용팀 폐지를 반영했습니다" });
  await expect(receipt).toBeVisible();
  expect(c.done("J7 dissolve in one sheet")).toBeLessThanOrEqual(7);
  await revealUnit(admin, "인사부");
  await expect(box(admin, "채용팀")).toHaveCount(0);
  await go(admin, "/org?view=list");
  await expect(admin.getByRole("row").filter({ hasText: "채용팀" })).toHaveCount(0);
  await go(admin, "/org");
  await admin.getByRole("status").getByRole("link", { name: /기록 보기$/ }).click();
  await expect(admin.getByRole("main")).toContainText("2명 · 이 변경으로 소속이나 사업장이 바뀐 사람"); // org-04: was 0명
  await expect(admin.getByRole("region", { name: "정리 항목" })).toHaveCount(0);
  await expectAccessible(admin, "J7: the applied dissolution's record");

  // 5. Each person went where the sheet said: 이동일 with a dated 전보 in their history (org-04), 이동이 still on leave.
  await go(admin, `${moved}?tab=events`);
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("전보");
  await go(admin, "/people");
  await expect(admin.getByRole("row", { name: /이동일/ })).toContainText("본사");
  await expect(admin.getByRole("row", { name: /이동일/ })).not.toContainText("인사부");
  await expect(admin.getByRole("row", { name: /이동이/ })).toContainText("인사부");
  await expect(admin.getByRole("row", { name: /이동이/ })).toContainText("휴직"); // moved, still on leave
});
