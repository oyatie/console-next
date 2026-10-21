import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, option, registerEmployee } from "./flows";
import { sheet, signOff } from "./sheet";
import { startOperations, tenantInSetup } from "./setup-flows";
import { box, leaveScreen } from "./structure-flows";
import { shot } from "./shots";

// UX-R3 STRUCT company-01 (P0), company-02, company-14: a 법인 that employed someone closes once they have left. The close
// sheet asks the 종료 사유 first, names who still keeps it open (linked, with what remains for them), and once their exit is
// HR-confirmed the 법인 counts nobody, the 「재직자」 blocker is gone and 종료일 opens; the confirm is the danger action.
// regression: on the parent the 사업장/법인 count kept the exited person, so 「재직자 1명」 never cleared (a dead end).

for (const lastDay of [-1, 0]) {
test(`regression: after the only person's exit (${lastDay}) the 법인 counts nobody and its close opens 종료일 (company-01)`, { tag: ["@regression", "@org"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, `entexit${lastDay + 1}`, "퇴직회사", false, "본사");
  await registerEmployee(admin, { name: "떠날사람", number: "EX-0001", hired: "2024-03-04", unit: "본사" });
  const record = new URL(admin.url()).pathname;
  await startOperations(admin);
  await leaveScreen(admin);

  // Before the exit: the blocker names the person, linked, and what remains (no exit yet); 종료일 stays locked.
  await go(admin, "/org/entities");
  await admin.getByRole("row", { name: /퇴직회사/ }).click();
  await admin.getByRole("button", { name: "법인 종료 계획 보기" }).click();
  let s = sheet(admin, "법인 종료");
  // 종료 사유 comes first, before anything blocks (company-14).
  await expect(s.getByRole("radiogroup", { name: /종료 사유/ })).toBeVisible();
  await expect(s).toContainText("재직자 1명");
  const staff = s.getByRole("list", { name: "아직 재직 중인 사람" });
  await expect(staff.getByRole("link", { name: "떠날사람" })).toBeVisible();
  await expect(staff).toContainText("퇴직 처리 전");
  await expect(s.getByRole("textbox", { name: /^종료일/ })).toHaveCount(0);
  await expectAccessible(admin, "entity close: the people who keep it open, by name");
  await shot(admin, "after-company-01-close-names-staff");
  await admin.keyboard.press("Escape");
  await expect(s).toBeHidden();

  // The exit: reported, then HR-confirmed (the employee leaves at once).
  await go(admin, record);
  const exitPanel = admin.getByRole("region", { name: "퇴직", exact: true });
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const report = admin.getByRole("dialog");
  await report.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(lastDay));
  await report.getByLabel("퇴직 경위").fill("개인 사정");
  await report.getByRole("button", { name: /퇴직 보고$/ }).click();
  await expect(exitPanel).toContainText("보고됨");
  await exitPanel.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /인사 확인하고/ }).click();
  await expect(exitPanel).toContainText("인사 확인됨");

  // Live counts drop the confirmed exit; a dated read still includes the last working day.
  await go(admin, "/org");
  await expect(box(admin, "본사")).toHaveAccessibleName(/, 0명(?:,|$)/);
  await expect(admin.getByRole("treeitem", { name: /퇴직회사, 법인,/ })).toHaveAccessibleName(/, 0명(?:,|$)/);
  await go(admin, `/org?as_of=${kstDate(lastDay)}`);
  await expect(box(admin, "본사")).toHaveAccessibleName(/, 1명(?:,|$)/);
  await expect(admin.getByRole("treeitem", { name: /퇴직회사, 법인,/ })).toHaveAccessibleName(/, 1명(?:,|$)/);
  await go(admin, "/org");
  await expect(box(admin, "본사")).toHaveAccessibleName(/, 0명(?:,|$)/);

  // The 법인 list and record count nobody; the close has no 재직자 blocker and 종료일 opens.
  await leaveScreen(admin);
  await go(admin, "/org/entities");
  const row = admin.getByRole("row", { name: /퇴직회사/ });
  await expect(row).toContainText("0명");
  await row.click();
  // The record, opened again, counts nobody either (company-01: it kept 「1명」).
  await expect(admin.getByRole("main")).toContainText("인원 0명");
  await admin.getByRole("button", { name: "법인 종료 계획 보기" }).click();
  s = sheet(admin, "법인 종료");
  await expect(s).not.toContainText("재직자");
  await option(admin, "종료 사유", "해산").click();
  await s.getByRole("textbox", { name: /^종료일/ }).fill(kstDate(0));
  const confirm = s.getByRole("button", { name: "법인 종료", exact: true });
  await expect(confirm).toHaveClass(/btn--danger/);
  await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "entity close: ready once its people left");
  await shot(admin, "after-company-01-close-opens-date");
  await confirm.click();
  await expect(s).toBeHidden();
  await expect(admin.getByRole("main")).toContainText(/종료/);
});
}
