import { expect, test } from "@playwright/test";
import { openTenant } from "../helpers/tenant";
import { go } from "../flows";
import { registerEntity } from "../setup-flows";
import { capture, inspect } from "./capture";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

test("parity copy: entity change and correction editor labels", async ({ browser }) => {
  const a = await openTenant(browser, "parity-copy-verbs", "문구확인");
  await go(a, "/org/entities/new");
  await registerEntity(a, "문구확인");
  await a.getByRole("button", { name: "대표전화 수정", exact: true }).click();
  const s = a.getByRole("dialog", { name: "대표전화 수정", exact: true });
  const what = s.getByRole("radiogroup", { name: /무엇을 기록합니까/ });
  await what.getByText(/바뀌었습니다 · 변경$/).click();
  await expect(s.getByRole("button", { name: "변경 기록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(s.getByRole("textbox", { name: /^대표전화/ })).toBeVisible();
  await capture(a, "entities", ["S3-entity-revise"], "Changed fact: 변경 selected, date unselected, no write. Inspect the new-value heading and section name against the selected act; not a completed dated-change fixture.");
  await inspect(a, "entities", "change-label");
  await what.getByText(/· 정정$/).click();
  await expect(s.getByRole("button", { name: "정정 기록", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(s.getByRole("textbox", { name: /^대표전화/ })).toBeVisible();
  await s.getByRole("button", { name: "취소", exact: true }).click();
  await expect(s).toBeHidden();
});
