import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { addWorkplaceFromEntity, deleteUnusedDept } from "./helpers/structure";
import { pickKind, SETUP_DEPARTMENT, tenantInSetup, typeAddress } from "./setup-flows";
import { addDepartments, box, revealUnit } from "./structure-flows";

// The chart's order and the list's conditions (S2-chart-menu, S11-invalid-move, S2-registry), from an empty tenant:
// Alt+↑↓ and the ⋯ menu put a 부서 one place earlier or later; a 사업장 is dragged only between its 법인's 사업장 (a drop
// anywhere else says why and changes nothing); the list narrows to 부서장 공석 and downloads the rows as an org sheet.

test.use({ viewport: { width: 1440, height: 900 } });

/** Drags box `from` onto box `to` with the mouse, past the 5 px threshold; `drop: false` lets go with Esc first. */
async function drag(page: Page, from: string, to: string, drop = true) {
  const a = (await box(page, from).boundingBox())!;
  const b = (await box(page, to).boundingBox())!;
  await page.mouse.move(a.x + 12, a.y + a.height - 4);
  await page.mouse.down();
  await page.mouse.move(a.x + 32, a.y + a.height - 12, { steps: 4 });
  await page.mouse.move(b.x + 40, b.y + 20, { steps: 10 });
  if (!drop) await page.keyboard.press("Escape");
  await page.mouse.up();
}
const top = async (page: Page, name: string) => (await box(page, name).boundingBox())!.y;

test("order on the chart and the list's conditions", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "order", "순서회사");
  // This walk orders its own two 부서 under 본점: the setup helper's 부서 (sorted between 가팀 and 나팀) goes first.
  await deleteUnusedDept(admin, SETUP_DEPARTMENT);
  const add = await addWorkplaceFromEntity(admin, /순서회사/);
  await add.getByLabel("사업장 이름").fill("판교지점");
  await pickKind(add);
  await add.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await option(admin, "4대보험", "아직 없음").click();
  await typeAddress(admin, "소재지", "경기도 성남시 분당구 판교역로 166", "13529");
  await add.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(add).toBeHidden();

  await go(admin, "/org");
  await addDepartments(admin, "본점", ["가팀", "나팀"]);
  await addDepartments(admin, "가팀", ["가1팀"]);
  await admin.keyboard.press("Escape");

  // 1. Alt+↓ puts 가팀 after 나팀; the ⋯ menu then offers only 순서 앞으로 (it is last), with its key.
  await revealUnit(admin, "가팀");
  await admin.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await top(admin, "가팀")) > (await top(admin, "나팀"))).toBe(true);
  await box(admin, "가팀").click({ button: "right" });
  const menu = admin.getByRole("menu", { name: "가팀 더 보기" });
  await expect(menu.getByRole("menuitem", { name: /순서 앞으로/ })).toContainText("Alt+↑");
  await expect(menu.getByRole("menuitem", { name: /순서 뒤로/ })).toHaveCount(0);
  await expectAccessible(admin, "structure chart (box menu with order)");
  await admin.keyboard.press("Escape");
  // At the end there is no further place: Alt+↓ again changes nothing.
  await revealUnit(admin, "가팀");
  await admin.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await top(admin, "가팀")) > (await top(admin, "나팀"))).toBe(true);

  // 2. A 사업장 dragged onto its sibling lands right after it (one 법인: its 사업장 stack under it).
  await admin.getByRole("button", { name: "사업장까지" }).click();
  // Bring every drag target inside the viewport; its DOM bounds can otherwise sit under the chart controls.
  await admin.getByRole("button", { name: "화면에 맞춤" }).click();
  expect(await top(admin, "본점")).toBeLessThan(await top(admin, "판교지점"));
  await drag(admin, "본점", "판교지점");
  await expect.poll(async () => (await top(admin, "판교지점")) < (await top(admin, "본점"))).toBe(true);

  // 3. Refused: onto the 법인 it says why while held, and the drop changes nothing.
  const a = (await box(admin, "판교지점").boundingBox())!;
  const b = (await box(admin, "주식회사 순서회사").boundingBox())!;
  await admin.mouse.move(a.x + 12, a.y + a.height - 4);
  await admin.mouse.down();
  await admin.mouse.move(a.x + 32, a.y + a.height - 12, { steps: 4 });
  await admin.mouse.move(b.x + 60, b.y + 30, { steps: 10 });
  await expect(box(admin, "주식회사 순서회사").getByRole("status")).toHaveText("사업장은 같은 법인의 다른 사업장 사이로만 이동합니다");
  await admin.mouse.up();
  await admin.waitForTimeout(500);
  expect(await top(admin, "판교지점")).toBeLessThan(await top(admin, "본점"));
  // Let go with Esc: nothing changes either.
  await drag(admin, "판교지점", "본점", false);
  await admin.waitForTimeout(500);
  expect(await top(admin, "판교지점")).toBeLessThan(await top(admin, "본점"));

  // 4. The list: 부서장 공석만 keeps the 부서 with the path to them; the rows download as an org sheet.
  await admin.getByRole("button", { name: "목록", exact: true }).click();
  const vacant = admin.getByRole("button", { name: "부서장 공석만" });
  await vacant.click();
  await expect(vacant).toHaveAttribute("aria-pressed", "true");
  const table = admin.getByRole("grid", { name: "조직 구조 목록" });
  await expect(table.getByRole("row", { name: /가1팀/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /판교지점/ })).toHaveCount(0);
  await expectAccessible(admin, "structure list (head vacant only)");
  const [file] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("button", { name: "조직 시트 내려받기" }).click()]);
  expect(file.suggestedFilename()).toMatch(/^조직 시트 \d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(csv.split("\r\n")[0]).toBe("﻿단계,법인,사업장,부서,코드,장,인원,기준일,알려진 시점");
  expect(csv).toContain("부서,주식회사 순서회사,본점,가팀 > 가1팀,,,0");
});
