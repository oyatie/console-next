import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAccessible } from "./a11y";
import { cellOf, openMonth } from "./helpers/attendance-records";
import { forbiddenText, securityWorld, underPrincipal } from "./helpers/attendance-security";
import { chooseRadio, go } from "./flows";

test.beforeAll(() => loadCatalog("ko"));

for (const kind of ["different-tenant", "lower-grant"] as const) {
  test(`${kind}: all five record commands show real refusals and preserve records and drafts`, { tag: ["@hr", "@security"] }, async ({ browser }) => {
    test.setTimeout(600_000);
    const w = await securityWorld(browser, `attsecw-${kind === "different-tenant" ? "foreign" : "lower"}`, kind);
    const { admin, date, other, month, restrictedToken } = w;
    const before = await w.history();
    const isForeign = kind === "different-tenant";
    let grid = admin.getByRole("grid", { name: "월간 근무표" });
    await cellOf(admin, "윤하준", other).click();
    await admin.keyboard.type("9-18");
    await admin.keyboard.press("Enter");
    const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
    await underPrincipal(admin, "/attendance/entries/preview", restrictedToken, async () => {
      await grid.focus();
      await admin.keyboard.press("ControlOrMeta+s");
    }, isForeign ? 200 : 403, isForeign ? "not_on_roster" : "forbidden", isForeign ? t("attendanceRecords.refusal.not_on_roster") : forbiddenText());
    await expect(save.getByRole("button", { name: /칸 저장/ })).toHaveAttribute("aria-disabled", "true");
    expect(await w.history()).toEqual(before);
    await save.getByRole("button", { name: "닫기", exact: true }).last().click();
    // The same draft becomes saveable again after returning to the permitted principal.
    await grid.focus();
    await admin.keyboard.press("ControlOrMeta+s");
    await chooseRadio(save, /출근부 \(종이\)/);
    await expect(save.getByRole("button", { name: "1칸 저장", exact: true })).toBeEnabled();
    await underPrincipal(admin, "/attendance/entries", restrictedToken, async () => {
      await save.getByRole("button", { name: "1칸 저장", exact: true }).click();
    }, isForeign ? 422 : 403, isForeign ? "cells_refused" : "forbidden", isForeign ? t("attendanceRecords.refusal.cells_refused") : forbiddenText());
    if (isForeign) await expect(save.getByText(t("attendanceRecords.refusal.not_on_roster"))).toBeVisible();
    expect(await w.history()).toEqual(before);
    await expect(save).toBeVisible();
    await save.getByRole("button", { name: "닫기", exact: true }).last().click();
    await expect(admin.getByRole("toolbar").getByRole("status")).toContainText(t("attendanceRecords.toolbar.unsaved", { count: 1, refused: 0 }));

    await admin.getByRole("button", { name: "일괄 취소", exact: true }).first().click();
    const undo = admin.getByRole("dialog", { name: "일괄 취소", exact: true });
    await undo.getByRole("textbox", { name: /^사유/ }).fill("권한 거절 확인");
    const saved = (await w.history())[0] as { entry: { batch_id: string } };
    await underPrincipal(admin, `/attendance/batches/${saved.entry.batch_id}/undo`, restrictedToken, async () => {
      await undo.getByRole("button", { name: "1칸 일괄 취소" }).click();
    }, isForeign ? 404 : 403, isForeign ? "batch_not_found" : "forbidden", isForeign ? t("attendanceRecords.refusal.batch_not_found") : forbiddenText());
    expect(await w.history()).toEqual(before);
    await expect(undo.getByRole("textbox", { name: /^사유/ })).toHaveValue("권한 거절 확인");
    await undo.getByRole("button", { name: "닫기", exact: true }).last().click();
    for (const mode of ["correct", "void"] as const) {
      grid = await openMonth(admin, month);
      await cellOf(admin, "윤하준", date).click();
      await admin.keyboard.press("p");
      const day = admin.getByRole("complementary", { name: /하루 기록/ });
      await day.getByRole("button", { name: mode === "correct" ? "정정" : "기록 취소", exact: true }).click();
      const form = admin.getByRole("complementary", { name: mode === "correct" ? "기록 정정" : "기록 취소", exact: true });
      if (mode === "correct") await form.getByRole("textbox", { name: /^정정할 값/ }).fill("9-17");
      await form.getByRole("textbox", { name: /^사유/ }).fill("권한 거절 확인");
      await chooseRadio(form, /출근부 \(종이\)/);
      const entry = ((await w.history())[0] as { entry: { id: string } }).entry.id;
      await underPrincipal(admin, `/attendance/entries/${entry}/${mode}`, restrictedToken, async () => {
        await form.getByRole("button", { name: mode === "correct" ? "정정 기록" : "기록 취소", exact: true }).click();
      }, isForeign ? 404 : 403, isForeign ? "entry_not_found" : "forbidden", isForeign ? t("attendanceRecords.refusal.entry_not_found") : forbiddenText());
      expect(await w.history()).toEqual(before);
      await expect(form.getByRole("textbox", { name: /^사유/ })).toHaveValue("권한 거절 확인");
      await expectAccessible(admin, `${kind} ${mode} refusal`);
      await form.getByRole("button", { name: "닫기", exact: true }).last().click();
      await day.getByRole("button", { name: "닫기", exact: true }).last().click();
    }
    await admin.context().close();
  });

  test(`${kind}: day, month and person reads show scope refusals without leaking records`, { tag: ["@hr", "@security"] }, async ({ browser }) => {
    test.setTimeout(600_000);
    const w = await securityWorld(browser, `attsecr-${kind === "different-tenant" ? "foreign" : "lower"}`, kind);
    const { admin, month, date, person, workplace, restrictedToken } = w;
    const before = await w.history();
    const isForeign = kind === "different-tenant";
    const code = isForeign ? "scope_not_found" : "forbidden";
    const text = isForeign ? t("attendance.refusal.scope_not_found") : forbiddenText();
    // Uncached explicit workplace reads target live data belonging to the original tenant.
    for (const [path, search] of [["days", `tab=day&date=${date}`], ["month", `tab=month&month=${month}`]] as const) {
      await underPrincipal(admin, `/attendance/${path}`, restrictedToken, async () => {
        await go(admin, `/attendance?${search}&wp=${workplace}`);
      }, isForeign ? 404 : 403, code, text);
      await expect(admin.getByRole("grid", { name: "월간 근무표" })).toHaveCount(0);
      await expect(admin.getByRole("row", { name: /윤하준/ })).toHaveCount(0);
      expect(await w.history()).toEqual(before);
    }
    // Restore an allowed grid before opening a person; the failed lookup has no cached person data.
    await go(admin, `/attendance?tab=month&month=${month}`);
    await expect(admin.getByRole("grid", { name: "월간 근무표" })).toBeVisible();
    await underPrincipal(admin, `/attendance/people/${person}/month`, restrictedToken, async () => {
      await cellOf(admin, "윤하준", date).click();
      await admin.keyboard.press("p");
    }, isForeign ? 404 : 403, code, text);
    const day = admin.getByRole("complementary", { name: /하루 기록/ });
    await expect(day.getByRole("button", { name: "정정", exact: true })).toHaveCount(0);
    expect(await w.history()).toEqual(before);
    await expectAccessible(admin, `${kind} person read refusal`);
    await admin.context().close();
  });
}
