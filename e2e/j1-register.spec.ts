import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, kstDate, registerEmployee, registerSheet, submitRegistration } from "./flows";
import { todayPreset } from "./sheet";
import { staffedTenant } from "./setup-flows";

// J1 인원 등록 (spec employee-ux E3): the sheet over the roster, nothing preselected, errors only after a commit
// attempt, the foot naming what registering does, a namesake asked about, and the receipt.
test("J1 register: the sheet asks for nothing in advance, names every gap on commit, and registers in one call", { tag: ["@smoke", "@hr"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "j1co", "등록주식회사");
  const c = clickCounter();

  await go(admin, "/people");
  await c.click(admin.getByRole("link", { name: "직원 등록", exact: true }).first());
  const s = registerSheet(admin);
  // Nothing is chosen: no type, no date, no place; the foot lists what is still to fill and nothing is red.
  await expect(s.getByRole("radiogroup", { name: /^고용형태/ }).getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(s.getByRole("button", { name: /^오늘/ })).toHaveAttribute("aria-pressed", "false");
  await expect(s).toContainText("채울 것 2개");
  await expect(s.getByRole("alert")).toHaveCount(0);
  await expectAccessible(admin, "J1: empty register sheet");

  // A commit attempt names every gap, moves to the first, and keeps what was typed; 13월 is named as such.
  await s.getByRole("textbox", { name: /^생년월일/ }).fill("1999.11.03");
  await s.getByRole("textbox", { name: /^생년월일/ }).blur();
  await expect(s.getByRole("textbox", { name: /^생년월일/ })).toHaveValue(koDate("1999-11-03"));
  await s.getByRole("textbox", { name: /^입사일/ }).fill("2026-13-01");
  await c.click(s.getByRole("button", { name: /^직원 등록 1명 반영 · 다음 직원/ }));
  await expect(s.getByRole("alert").filter({ hasText: "2개를 수정해야 등록됩니다" })).toBeVisible();
  await expect(s).toContainText("13월은 올바르지 않습니다.");
  await expect(s.getByRole("textbox", { name: /^이름/ })).toBeFocused();
  await expect(s.getByRole("textbox", { name: /^생년월일/ })).toHaveValue(koDate("1999-11-03"));
  await expectAccessible(admin, "J1: register sheet with errors");
  // 20271012 is read as a date too; a future date registers the person as 입사 예정.
  const hired = s.getByRole("textbox", { name: /^입사일/ });
  await hired.fill("20261115");
  await todayPreset(s).click();
  await expect(hired).toHaveValue(koDate(kstDate()));
  await hired.fill("2026-13-01");
  await hired.blur();
  await hired.fill("20271012");
  // A real commit click must blur and commit the draft before registration reads it.
  await s.getByRole("button", { name: /^직원 등록 1명 반영 · 다음 직원/ }).click();
  await expect(s.getByRole("alert").filter({ hasText: "1개를 수정해야 등록됩니다" })).toBeVisible();
  await expect(hired).toHaveValue(koDate("2027-10-12"));
  await expect(s).toContainText("입사 예정");
  await s.getByRole("button", { name: /^닫기$/ }).last().click();
  c.done("J1 explore");

  // One person placed in a unit: open, place, date, type, register (spec §5 row 2: 6).
  // Optional phone, title and pay are also recorded without another click.
  await registerEmployee(admin, { name: "정입사", number: "J1-0001", hired: "2025-03-03" }, c);
  expect(c.done("J1 register a placed person")).toBeLessThanOrEqual(7);
  await expect(admin.getByRole("group", { name: "소속" })).toContainText("2025. 03. 03.");

  await registerEmployee(admin, { name: "한계약", number: "J1-0002", hired: "2026-03-02", contractEnd: "2027-03-01" }, c);
  c.done("J1 register contract employee");
  const profile = admin.getByRole("region", { name: "재직·배치" });
  await expect(profile).toContainText("2026. 03. 02.");
  await expect(profile).toContainText("계약 종료일");
  await expect(profile).toContainText("2027. 03. 01.");

  // Left automatic, the server assigns the next number and the receipt names it.
  await registerEmployee(admin, { name: "무번호", hired: "2026-04-01" }, c);
  await expect(admin.getByRole("heading", { name: /무번호/, level: 1 }).locator("..")).toContainText("E-000001");

  // A namesake with the same phone is a question with no default: the search the server ran, side by side, and the
  // primary stays readable but points at the choice until it is made.
  await submitRegistration(admin, { name: "정입사", hired: "2026-05-04" }, c);
  const dup = registerSheet(admin).getByRole("status").filter({ hasText: "같은 사람일 수 있습니다" });
  await expect(dup).toContainText("J1-0001");
  await expect(dup.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(registerSheet(admin).getByRole("button", { name: /^직원 등록 1명 반영 · 다음 직원/ })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "J1: possible duplicate asked before registering");
  await c.click(dup.getByText("다른 사람입니다 · 동명이인으로 등록"));
  await c.click(dup.getByRole("radiogroup", { name: /동명이인으로 등록하는 사유/ }).getByRole("radio").first().locator("xpath=ancestor::label[1]"));
  const note = dup.getByRole("textbox", { name: /사유 설명/ });
  if (await note.isVisible()) await note.fill("이름만 같은 다른 사람 (휴대전화는 회사 공용)");
  await c.click(registerSheet(admin).getByRole("button", { name: /^직원 등록 1명 반영(?: ⌘|$)/ }));
  await expect(registerSheet(admin)).toBeHidden();
  await expect(admin.getByRole("status").filter({ hasText: /정입사.* 등록했습니다 · 사번 E-000002/ })).toBeVisible();
  c.done("J1 namesake");

  // The roster lists both (the search the helpers typed is cleared first).
  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  await expect(admin.getByRole("row", { name: /J1-0001/ })).toContainText("2025. 03. 03.");
  await expect(admin.getByRole("row", { name: /E-000002/ })).toContainText("정입사");
});
