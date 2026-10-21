import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, registerEmployee } from "./flows";
import { addDepts, openUnit } from "./helpers/structure";
import { registerBranch, startOperations, tenantInSetup } from "./setup-flows";
import { shot } from "./shots";
import { leaveScreen } from "./structure-flows";

// UX-R3 STRUCT org-01 (P0), org-30: moving a 부서 to another 사업장 on the day one of its people was placed. Submit runs
// the same check as the preflight, so the move is refused with its cause and fix named (시행일 the next day), never the
// generic 「요청이 현재 상태와 충돌합니다」; the one draft it leaves opens with that fix, and no second draft is made.
// regression: on the parent the preflight passed, submit answered 409 {code: conflict} and each try left a draft.

test("regression: a move on a placement day names its fix and leaves one draft, never a generic conflict (org-01)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "ocmovetoday", "오늘이동");
  await registerBranch(admin, "오늘이동", "판교연구소", "0008512347");
  await addDepts(admin, "본점", ["경영지원본부"]);
  await addDepts(admin, "판교연구소", ["개발팀"]);
  await registerEmployee(admin, { name: "오늘입사", unit: "개발팀", hired: kstDate(0) });
  await startOperations(admin);
  await leaveScreen(admin);

  const dev = await openUnit(admin, "개발팀");
  await dev.getByRole("button", { name: "이동" }).first().click();
  await expect(admin).toHaveURL(/\/org\/move\?ids=/);
  await expect(admin.getByRole("heading", { level: 1 })).toContainText("개발팀 이동"); // org-20
  await admin.getByRole("treegrid", { name: "어디로" }).getByRole("row", { name: /^경영지원본부/ }).click();
  await admin.getByRole("main").getByRole("button", { name: /^오늘/ }).first().click();
  await admin.getByRole("main").getByRole("textbox", { name: /^사유/ }).first().fill("개발팀 본점 이전");
  await admin.getByRole("button", { name: /^반영 · 항목 1개/ }).click();

  // The draft's record names the cause and the fix; nothing speaks of a generic conflict.
  await expect(admin).toHaveURL(/\/org\/changes\/[^/?]+/);
  const main = admin.getByRole("main");
  await expect(main.getByRole("alert")).toContainText("진행하지 못했습니다");
  await expect(main).toContainText(`시행일을 ${kstDate(1)}로 바꾸십시오`);
  await expect(admin.getByText("요청이 현재 상태와 충돌합니다.")).toHaveCount(0);
  await expectAccessible(admin, "org change: a refused move names its fix");
  await shot(admin, "after-org-01-refusal-names-fix");

  // One draft, not one per try; 개발팀 stayed under 판교연구소 and its person did not move.
  await go(admin, "/org/changes");
  await expect(admin.getByRole("main").getByRole("link", { name: /^OC-\d{4}-\d{4}/ })).toHaveCount(1);
  const unit = await openUnit(admin, "개발팀");
  await expect(unit).toContainText("판교연구소");
});
