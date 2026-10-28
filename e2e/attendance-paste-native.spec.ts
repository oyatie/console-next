// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay, pasteText } from "./helpers/attendance-records";
import { go, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { shotSet } from "./shots";

for (const surface of ["month", "day"] as const) {
  test(`${surface}: a single-value paste inserts at the text cursor without opening a preview`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    test.setTimeout(600_000);
    const { admin } = await staffedTenant(browser, `attnative${surface}`, "붙여넣기검증주식회사");
    const bearer = bearerOf(admin);
    try {
      await registerEmployee(admin, { name: "윤하준", number: "P-0001", hired: kstDate(-60) });
      await officeSchedule(admin);
      const api = apiOf(admin, bearer);
      const response = await api("/employees?limit=10");
      expect(response.ok()).toBe(true);
      const people = (await response.json()) as { items: { id: string; name: string }[] };
      const person = people.items.find(p => p.name === "윤하준")!.id;
      const { month, date } = await pastWorkDay(api, person);
      if (surface === "month") {
        await openMonth(admin, month);
        await cellOf(admin, "윤하준", date).click();
        await admin.keyboard.type("9");
      } else {
        await go(admin, `/attendance?tab=day&date=${date}`);
        await admin.getByRole("button", { name: "자세히", exact: true }).click();
      }
      const input = admin.getByRole("textbox", { name: surface === "month" ? new RegExp(`^윤하준 ${date}`) : /^윤하준 입력/, includeHidden: true });
      if (surface === "day") {
        await input.click();
        await expect(input).toBeFocused();
      }
      // Copy through the keyboard: synthetic paste events cannot prove the browser inserts text.
      await input.fill("-18");
      await input.press("ControlOrMeta+a");
      await admin.keyboard.press("ControlOrMeta+c");
      await input.fill("9");
      await input.press("End");
      await admin.keyboard.press("ControlOrMeta+v");
      const preview = admin.getByRole("dialog", { name: "붙여넣기 미리보기" });
      await expect(preview).toHaveCount(0);
      await expect(input).toHaveValue("9-18");
      if (surface === "month") {
        await input.press("Enter");
        await expect(cellOf(admin, "윤하준", date)).toHaveAccessibleName(/초안 9-18/);
        return;
      }

      await expectAccessible(admin, "Day detail native paste");
      // A matrix pasted into the same input still requires review and changes no draft until acceptance.
      await input.focus();
      await pasteText(admin, `사번\t${date}\nP-0001\t9-17`);
      await expect(preview).toBeVisible();
      await expect(input).toHaveValue("9-18");
      await expectAccessible(admin, "Day paste preview");
      await shotSet(admin, "day-detail-paste-preview");
      await admin.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(input).toHaveValue("9-18");
      await shotSet(admin, "day-detail-native-paste");
      await input.focus();
      await pasteText(admin, "P-0001\t9-17");
      await preview.getByRole("button", { name: "초안에 1칸 반영" }).click();
      await expect(input).toHaveValue("9-17");
      await admin.getByRole("button", { name: "저장", exact: true }).click();
      const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
      await save.getByRole("radio", { name: /출근부 \(종이\)/ }).press("Space");
      const commit = save.getByRole("button", { name: "1칸 저장" });
      await expect(commit).not.toHaveAttribute("aria-disabled", "true");
      await commit.press("Enter");
      await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
      await expect(input).toHaveValue("");
      const saved = (await (await api(`/attendance/people/${person}/month?month=${month}`)).json()) as { days: { date: string; entry: unknown }[] };
      expect(saved.days.find(d => d.date === date)?.entry).toMatchObject({ kind: "TIMES", segments: [{ start: 540, end: 1020 }] });
    } finally {
      await admin.context().close();
    }
  });
}
