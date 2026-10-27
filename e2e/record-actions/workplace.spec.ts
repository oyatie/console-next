import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate, option } from "../flows";
import { NAMES, soloWorld } from "./world";
import { box } from "../structure-flows";


// The fact rows only (the panel's other lists, such as headcounts, differ by design).
const rowsOf = (panel: Locator) => panel.locator("dl").filter({ has: panel.getByRole("term").filter({ hasText: /^사업장 이름$/ }) }).first().getByRole("term").allInnerTexts();

async function edit(page: Page, panel: Locator, field: string, value: string | null, reason: string) {
  await panel.getByRole("button", { name: `${field} 수정`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `${field} 수정` });
  await expect(sheet.getByRole("textbox", { name: /^사업장 이름/ })).toHaveCount(field === "사업장 이름" ? 1 : 0); // that fact only
  if (value !== null) await sheet.getByRole("textbox", { name: new RegExp(`^${field}`) }).fill(value);
  await sheet.getByLabel("적용일").fill(kstDate());
  await option(page, "변경 사유", reason).click();
  return sheet;
}

for (const live of [false, true]) {
  test(`one 사업장 panel from the 법인 page and the org chart, each fact its own 수정: ${live ? "live tenant" : "setup phase"}`, { tag: "@record-actions" }, async ({ browser }) => {
    const w = await soloWorld(browser, live ? "ra-wp-live" : "ra-wp", live ? "보람상사" : "새봄상사", live);
    const { admin } = w;
    // From the 법인 page: the 사업장 tab (1), then 사업장 이름 수정 (2).
    await go(admin, `/org/entities/${w.entityId}`);
    await admin.getByRole("tab", { name: /^사업장 1/ }).click();
    const fromEntity = admin.getByRole("complementary", { name: NAMES.workplace });
    const entityRows = await rowsOf(fromEntity);
    // 종류 and 본점·대표 are structure acts: from the 법인 page their 수정 opens the chart with that sheet over it.
    await fromEntity.getByRole("button", { name: "종류 수정", exact: true }).click();
    await expect(admin.getByRole("dialog", { name: new RegExp(`${NAMES.workplace} 종류 변경`) })).toBeVisible();
    await admin.keyboard.press("Escape");
    await go(admin, `/org/entities/${w.entityId}`);
    await admin.getByRole("tab", { name: /^사업장 1/ }).click();
    const sheet = await edit(admin, fromEntity, "사업장 이름", "가람허브", "이름 변경");
    await expect(sheet.getByText(live ? "바로 반영 · 이력으로 남습니다" : "바로 반영 (설정 단계)")).toBeVisible();
    await expectAccessible(admin, "workplace name sheet");
    await sheet.getByRole("button", { name: "변경 저장" }).click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    await expect(admin.getByRole("complementary", { name: "가람허브" })).toBeVisible();

    // From the org chart: the node (1), the same rows, then one optional fact recorded and emptied (비움 from its ⋯).
    await go(admin, "/org");
    await box(admin, "가람허브").click();
    const fromChart = admin.getByRole("complementary").filter({ has: admin.getByRole("heading", { name: "가람허브" }) });
    await expect(fromChart.getByRole("button", { name: "사업장 이름 수정", exact: true })).toBeVisible();
    for (const r of entityRows) expect(await rowsOf(fromChart), `the chart panel draws 「${r}」 as the 법인 page does`).toContain(r);
    await expectAccessible(admin, "org chart workplace panel");
    const rep = await edit(admin, fromChart, "사업장 대표자", "이대표", "연락처 변경");
    await rep.getByRole("button", { name: "변경 저장" }).click();
    await expect(rep).toBeHidden({ timeout: 15_000 });
    await expect(fromChart.getByRole("definition").filter({ hasText: /^이대표$/ })).toBeVisible();
    await fromChart.getByRole("button", { name: "사업장 대표자 더보기" }).click();
    if (live) await expect(admin.getByRole("menuitem", { name: "삭제" })).toHaveCount(0);
    await admin.getByRole("menuitem", { name: "비움" }).click();
    const clear = admin.getByRole("dialog", { name: "사업장 대표자 비움" });
    await expect(clear.getByRole("textbox", { name: /^사업장 대표자/ })).toHaveValue("");
    await clear.getByLabel("적용일").fill(kstDate());
    await option(admin, "변경 사유", "연락처 변경").click();
    await clear.getByRole("button", { name: "변경 저장" }).click();
    await expect(clear).toBeHidden({ timeout: 15_000 });
    await expect(fromChart.getByRole("definition").filter({ hasText: /^이대표$/ })).toHaveCount(0);

    // A stale save (another tab renamed it first) is refused (409) and said in the sheet; the other tab's name stands.
    const other = await admin.context().newPage();
    await go(other, `/org/entities/${w.entityId}`);
    await other.getByRole("tab", { name: /^사업장 1/ }).click();
    const mine = await edit(admin, fromChart, "사업장 이름", "가람본부", "이름 변경");
    const theirs = await edit(other, other.getByRole("complementary", { name: "가람허브" }), "사업장 이름", "가람타워", "이름 변경");
    await theirs.getByRole("button", { name: "변경 저장" }).click();
    await expect(theirs).toBeHidden({ timeout: 15_000 });
    await mine.getByRole("button", { name: "변경 저장" }).click();
    await expect(mine.getByRole("alert")).toBeVisible();
    await expect(mine).toBeVisible();
    await other.close();
  });
}
