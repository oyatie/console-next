import { expect, type Page } from "@playwright/test";
import type { clickCounter } from "../clicks";
import { go, plain } from "../flows";
import { pickKind, typeAddress } from "../setup-flows";
import { box, findPressable } from "../structure-flows";

type C = Pick<ReturnType<typeof clickCounter>, "click">;

// The 회사 구조 editor (S5 사업장, S6 부서, S8 bulk move) as a user reaches it: a box on the chart opens its panel,
// a panel action opens its sheet. Every helper clicks what a person would click.

/** The selection's side panel (a 사업장 or a 부서), named by its title. */
export const panel = (page: Page, name: string) => page.getByRole("complementary", { name, exact: true });
/** An open sheet, named by its title. */
export const sheet = (page: Page, title: string | RegExp) => page.getByRole("dialog", { name: title });

/** Opens a unit's panel from the chart (its row in the chart's tree). */
export async function openUnit(page: Page, name: string, c: C = plain) {
  if (!new URL(page.url()).pathname.endsWith("/org")) await go(page, "/org");
  // Already open (clicking its row again would close it).
  if (await panel(page, name).isVisible()) return panel(page, name);
  // The chart's find brings a unit inside a collapsed branch into view; selecting its box opens its panel.
  await findPressable(page, name);
  await c.click(box(page, name));
  await expect(panel(page, name)).toBeVisible();
  return panel(page, name);
}

/** Deletes a never-used 부서 from its panel's 삭제 · 폐지 sheet (in setup or after go-live, CRUD: decided by use). */
export async function deleteUnusedDept(page: Page, name: string, c: C = plain) {
  const p = await openUnit(page, name, c);
  const selected = new URL(page.url()).searchParams.get("sel");
  await c.click(p.locator("#act-dept-delete"));
  const s = sheet(page, `${name} 삭제 · 폐지`);
  await c.click(s.getByRole("button", { name: `${name} 삭제` }));
  await expect(s).toBeHidden();
  await expect(box(page, name)).toHaveCount(0);
  // The chart then selects the parent: a navigation that would undo one a caller makes before it lands.
  await page.waitForURL((u) => u.searchParams.get("sel") !== selected && !u.searchParams.has("act"));
}

/** 사업장 추가 for the 법인 `entity`, from its record (the chart's own 「+ 새 사업장」 slot is the chart's). */
export async function addWorkplaceFromEntity(page: Page, entity: RegExp, c: C = plain) {
  await go(page, "/org/entities");
  await c.click(page.getByRole("row", { name: entity }));
  await c.click(page.getByRole("button", { name: /^사업장 \d/ }));
  await c.click(page.getByRole("link", { name: "사업장 추가" }).first());
  await expect(sheet(page, "사업장 추가")).toBeVisible();
  return sheet(page, "사업장 추가");
}

/** Adds 부서 under a panel's unit in setup, one after another (Enter keeps the field open for the next). */
export async function addDepts(page: Page, parent: string, names: readonly string[], c: C = plain) {
  const p = await openUnit(page, parent, c);
  await c.click(p.getByRole("button", { name: /부서 추가$/ }));
  const field = p.getByRole("textbox", { name: new RegExp(`^${parent} 아래 새 부서 이름`) });
  for (const n of names) {
    await field.fill(n);
    // The chart beside the panel redraws from its re-read before the next name is typed (a person reads the result).
    const redrawn = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/org-structure");
    await field.press("Enter");
    await expect(field).toHaveValue("");
    await expect(page.getByRole("status").filter({ hasText: `${parent} 아래에 ${n}` }).first()).toBeAttached();
    await redrawn;
  }
  await field.press("Escape");
}

/** A further 사업장 with no certificate yet (linked later): its address, 원천징수 with the head office, 4대보험 later. */
export async function quickWorkplace(page: Page, entity: RegExp, name: string, address: { road: string; zip: string }) {
  const add = await addWorkplaceFromEntity(page, entity);
  await add.getByLabel("사업장 이름").fill(name);
  await pickKind(add);
  await add.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await add.getByRole("radiogroup", { name: /^4대보험/ }).getByText("모두 성립 · 번호는 나중에", { exact: true }).click();
  await typeAddress(page, "소재지", address.road, address.zip);
  await add.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: `${name} 사업장을 등록했습니다` })).toBeAttached();
}
