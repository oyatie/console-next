import { expect, type Locator, type Page } from "@playwright/test";

type Click = (l: Locator) => Promise<void>;
const plain: Click = (l) => l.click();

/** A cold reload reads the phase before the record; assert its UI after that owned record response. */
export async function reloadRecord(page: Page, path: string) {
  const id = new URL(path, page.url()).pathname.split("/").at(-1);
  const read = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/employees/${id}`);
  await page.goto(path);
  expect((await read).status()).toBe(200);
}

/**
 * The personnel card's HR actions (the 발령 menu; E2-card) and its action history tab. The lifecycle journeys act and
 * read through these, so a change to the card's verbs is one edit here.
 */
export const cardVerbs = (page: Page) => page.getByRole("group", { name: "인사카드 동작" });

/** Opens the 발령 menu (a click; spec §5 counts 발령 → 퇴직 as two) and returns it. */
export async function hrMenu(page: Page, click: Click = plain) {
  await click(cardVerbs(page).getByRole("button", { name: "발령" }));
  return page.getByRole("menu", { name: "발령" });
}

/** One action in the open menu, by its full name; an unavailable one carries its reason in its name. */
export const hrItem = (menu: Locator, name: string) => menu.getByRole("menuitem", { name: new RegExp(`^${name}`) });

/** Opens 발령 and picks one action by its full name (e.g. "휴직 처리"). */
export async function hrAct(page: Page, name: string, click: Click = plain) {
  await click((await hrMenu(page, click)).getByRole("menuitem", { name, exact: true }));
}

/** The actions listed are exactly `names`, in order (unavailable ones stay listed with their reason). */
export async function expectHrActs(page: Page, names: string[]) {
  const menu = await hrMenu(page);
  await expect(menu.getByRole("menuitem")).toHaveText(names.map((n) => new RegExp(`^${n}`)));
  await page.keyboard.press("Escape");
}

/** No HR action at all (an exited person, or a viewer without the grant). */
export const expectNoHrActs = (page: Page) => expect(cardVerbs(page).getByRole("button", { name: "발령" })).toHaveCount(0);

/** Switches the record back to its 인사카드 tab (sections, the exit card). */
export const openCard = (page: Page) => page.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: "인사카드", exact: true }).click();

/** Switches the record to its 발령 이력 tab, where the action history (region 인사 이력) lives. */
export const openHistory = (page: Page) => page.getByRole("navigation", { name: "인사카드 탭" }).getByRole("link", { name: /^발령 이력/ }).click();
