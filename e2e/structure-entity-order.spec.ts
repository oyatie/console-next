import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { tenantSlugField, firstSignIn, go, newContext, passkeyLogin, takeCode, unique, vendorPage } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { firstWorkplace } from "./helpers/entity";
import { quickWorkplace } from "./helpers/structure";
import { registerEntity, SECOND, setupRail } from "./setup-flows";
import { box, revealUnit } from "./structure-flows";

// Org sibling order: keyboard, menu, and transformed-canvas drags persist one pinned order for legal entities and workplaces.
// The other browser follows through the event stream; reload, lists, and the statutory picker read the same order. A stale
// drag shows the server's refusal and leaves the last read visible.

test.use({ viewport: { width: 1440, height: 900 } });

const HOLD = "주식회사 가나홀딩스";
const LAB = "주식회사 가나랩";
const left = async (page: Page, name: string) => (await box(page, name).boundingBox())!.x;
const top = async (page: Page, name: string) => (await box(page, name).boundingBox())!.y;
/** The 법인 order as the chart draws it (a row under the tenant). */
const chartFirst = async (page: Page) => ((await left(page, HOLD)) < (await left(page, LAB)) ? HOLD : LAB);
/** A legal entity stacks its 사업장 under the card. */
const chartFirstSite = async (page: Page) => ((await top(page, "본사")) < (await top(page, "기술센터")) ? "본사" : "기술센터");
const orderResponse = (page: Page) => page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/v1/org-structure/order");
async function zoomToForty(page: Page) {
  const controls = page.getByRole("group", { name: "확대·축소" });
  for (let i = 0; i < 6; i++) await controls.getByRole("button", { name: "축소" }).click();
  await expect(controls).toContainText("40%");
}
/** The same account on a second browser (its own context and stream), as live.spec's sameUserElsewhere. */
async function elsewhere(browser: Browser, page: Page) {
  const other = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(other)).import(await authenticatorOf(page).export());
  await other.goto("/login");
  await passkeyLogin(other);
  return other;
}
/** The 법인 the /statutory 사업장 picker lists first (가나랩 sorts first by name, so only the stored order puts 가나홀딩스 first). */
async function statutoryFirst(page: Page) {
  await go(page, "/statutory?tab=register");
  // go() changes the URL before the lazy screen renders: wait for it, or the click lands on the page before.
  await expect(page.getByRole("tab", { name: "근로자 명부", selected: true })).toBeVisible();
  await page.getByRole("button", { name: /사업장/ }).click();
  const first = await page.getByRole("option", { name: /주식회사 가나/ }).first().textContent();
  await page.keyboard.press("Escape");
  return first?.includes(LAB) ? LAB : HOLD;
}
const listRows = (page: Page) => page.getByRole("grid", { name: "법인 목록" }).getByRole("row", { name: /주식회사 가나/ });

async function orderWorld(browser: Browser, prefix: string) {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("가나그룹");
  await tenantSlugField(v).fill(unique(prefix));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "가나홀딩스");
  await firstWorkplace(admin, "가나홀딩스", "본사");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "가나랩", false, undefined, SECOND);
  await firstWorkplace(admin, "가나랩", "연구소");
  return admin;
}

test("keyboard and card menu reorder a legal entity", { tag: "@org" }, async ({ browser }) => {
  const admin = await orderWorld(browser, "ganaorderkeys");
  await go(admin, "/org");
  expect(await chartFirst(admin)).toBe(HOLD);
  await revealUnit(admin, HOLD);
  const keyboardMove = orderResponse(admin);
  await admin.keyboard.press("Alt+ArrowDown");
  expect((await keyboardMove).status()).toBe(200);
  await expect.poll(() => chartFirst(admin)).toBe(LAB);
  await box(admin, HOLD).click({ button: "right" });
  const menu = admin.getByRole("menu", { name: `${HOLD} 더 보기` });
  await expect(menu.getByRole("menuitem", { name: /순서 앞으로/ })).toContainText("Alt+↑");
  await expectAccessible(admin, "structure chart (legal entity menu with order)");
  const menuMove = orderResponse(admin);
  await menu.getByRole("menuitem", { name: /순서 앞으로/ }).click();
  expect((await menuMove).status()).toBe(200);
  await expect.poll(() => chartFirst(admin)).toBe(HOLD);
  await admin.reload();
  await expect(box(admin, HOLD)).toBeVisible();
  expect(await chartFirst(admin)).toBe(HOLD);
});

test("legal entities and workplaces reorder on the chart and every surface shows the one order", { tag: "@org" }, async ({ browser }) => {
  const admin = await orderWorld(browser, "ganaorder");
  const bearer = bearerOf(admin);
  const api = apiOf(admin, bearer);
  expect(await statutoryFirst(admin)).toBe(HOLD);

  // The same account on another browser stays on the 법인 목록: it must follow without a reload (§13.21).
  const other = await elsewhere(browser, admin);
  await go(other, "/org/entities");
  await expect(listRows(other).first()).toContainText(HOLD);

  // Creation order first; drag 가나홀딩스 after 가나랩 and verify the pinned order reached the backend.
  await go(admin, "/org");
  expect(await chartFirst(admin)).toBe(HOLD);
  // A drag previews the move, refuses a 사업장 target with a reason, then sends the pinned legal-entity reorder.
  await admin.getByRole("button", { name: "화면에 맞춤" }).click();
  await zoomToForty(admin);
  const a = (await box(admin, HOLD).boundingBox())!;
  const site = (await box(admin, "연구소").boundingBox())!;
  await admin.mouse.move(a.x + 12, a.y + a.height - 4);
  await admin.mouse.down();
  await admin.mouse.move(a.x + 32, a.y + a.height - 12, { steps: 4 });
  await expect(admin.getByRole("status").filter({ hasText: `${HOLD} 이동 중` })).toBeVisible();
  await expect(admin.locator('[class*="dragGhost"]')).toContainText(HOLD);
  await admin.mouse.move(site.x + 40, site.y + 20, { steps: 10 });
  await expect(box(admin, "연구소").getByRole("status")).toHaveText("법인은 다른 법인 사이에서 순서만 변경할 수 있습니다");
  const b = (await box(admin, LAB).boundingBox())!;
  await admin.mouse.move(b.x + 40, b.y + 20, { steps: 10 });
  await expect(box(admin, LAB)).toHaveAttribute("data-s", /\bdrop\b/);
  const entityBefore = (await (await api("/org-structure")).json()) as { entities: { id: string; name: string }[] };
  const entityIds = Object.fromEntries(entityBefore.entities.map((e) => [e.name, e.id]));
  const entityMove = orderResponse(admin);
  await admin.mouse.up();
  const entityResponse = await entityMove;
  expect(entityResponse.status()).toBe(200);
  expect((await entityResponse.json() as { children: string[] }).children).toEqual([entityIds[LAB], entityIds[HOLD]]);
  await expect.poll(() => chartFirst(admin)).toBe(LAB);
  await expect(listRows(other).first()).toContainText(LAB);

  // Add a second sibling workplace, then drag the first after it through the same canvas interaction.
  await quickWorkplace(admin, /가나홀딩스/, "기술센터", { road: "서울특별시 강남구 테헤란로 152", zip: "06236" });
  await go(admin, "/org");
  await zoomToForty(admin);
  await expect(box(admin, "기술센터")).toBeVisible();
  const main = (await box(admin, "본사").boundingBox())!;
  const center = (await box(admin, "기술센터").boundingBox())!;
  await admin.mouse.move(main.x + 12, main.y + main.height - 4);
  await expect(admin.getByRole("toolbar", { name: "본사 작업" })).toHaveAttribute("data-side", "inside");
  expect(await admin.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return { toolbar: target?.closest<HTMLElement>("[data-tools]")?.dataset.side, button: Boolean(target?.closest("button")) };
  }, { x: main.x + 12, y: main.y + main.height - 4 })).toEqual({ toolbar: "inside", button: true });
  await admin.mouse.down();
  await admin.mouse.move(main.x + 32, main.y + main.height - 12, { steps: 4 });
  await expect(admin.getByRole("status").filter({ hasText: "본사 이동 중" })).toBeVisible();
  await admin.mouse.move(center.x + 40, center.y + 20, { steps: 10 });
  await expect(box(admin, "기술센터")).toHaveAttribute("data-s", /\bdrop\b/);
  const siteBefore = (await (await api("/org-structure")).json()) as { entities: { id: string; name: string; children: { id: string; name: string }[] }[] };
  const holding = siteBefore.entities.find((e) => e.name === HOLD)!;
  const siteIds = Object.fromEntries(holding.children.map((e) => [e.name, e.id]));
  // Force a real stale pin first: the server refusal must be announced while the chart keeps its read order.
  await admin.route("**/api/v1/org-structure/order", async (route) => {
    await route.continue({
      postData: JSON.stringify({
        legal_entity_id: holding.id,
        children: [siteIds["기술센터"], siteIds["본사"]],
        expected_children: [],
      }),
    });
  });
  const staleSiteMove = orderResponse(admin);
  await admin.mouse.up();
  const refused = await staleSiteMove;
  expect(refused.status()).toBe(409);
  expect(await codeOf(refused)).toBe("children_changed");
  await expect(admin.getByText("그사이 다른 사람이 하위 목록을 변경했습니다. 다시 열어 순서를 정하십시오")).toBeVisible();
  expect(await chartFirstSite(admin)).toBe("본사");
  await admin.unroute("**/api/v1/org-structure/order");

  // Repeating the same real pointer drag succeeds with the current order pin.
  const mainAfterRefusal = (await box(admin, "본사").boundingBox())!;
  const centerAfterRefusal = (await box(admin, "기술센터").boundingBox())!;
  await admin.mouse.move(mainAfterRefusal.x + 12, mainAfterRefusal.y + mainAfterRefusal.height - 4);
  await admin.mouse.down();
  await admin.mouse.move(mainAfterRefusal.x + 32, mainAfterRefusal.y + mainAfterRefusal.height - 12, { steps: 4 });
  await admin.mouse.move(centerAfterRefusal.x + 40, centerAfterRefusal.y + 20, { steps: 10 });
  await expect(box(admin, "기술센터")).toHaveAttribute("data-s", /\bdrop\b/);
  const siteMove = orderResponse(admin);
  await admin.mouse.up();
  const siteResponse = await siteMove;
  expect(siteResponse.status()).toBe(200);
  expect((await siteResponse.json() as { children: string[] }).children).toEqual([siteIds["기술센터"], siteIds["본사"]]);
  expect((await (await api("/org-structure")).json() as { entities: { id: string; children: { id: string }[] }[] }).entities
    .find((e) => e.id === holding.id)?.children.map((e) => e.id)).toEqual([siteIds["기술센터"], siteIds["본사"]]);

  // The backend's order is what a chart reload reads, for both sibling levels.
  await admin.reload();
  await expect(box(admin, LAB)).toBeVisible();
  expect(await chartFirst(admin)).toBe(LAB);
  expect(await chartFirstSite(admin)).toBe("기술센터");

  // A second drag reverses the workplace order; its receipt undo restores that order after reload.
  await zoomToForty(admin);
  const centerToMove = (await box(admin, "기술센터").boundingBox())!;
  const mainToTarget = (await box(admin, "본사").boundingBox())!;
  await admin.mouse.move(centerToMove.x + 12, centerToMove.y + centerToMove.height - 4);
  await admin.mouse.down();
  await admin.mouse.move(centerToMove.x + 32, centerToMove.y + centerToMove.height - 12, { steps: 4 });
  await admin.mouse.move(mainToTarget.x + 40, mainToTarget.y + 20, { steps: 10 });
  await expect(box(admin, "본사")).toHaveAttribute("data-s", /\bdrop\b/);
  const reverseSiteMove = orderResponse(admin);
  await admin.mouse.up();
  const reversedSiteResponse = await reverseSiteMove;
  expect(reversedSiteResponse.status()).toBe(200);
  expect((await reversedSiteResponse.json() as { children: string[] }).children).toEqual([siteIds["본사"], siteIds["기술센터"]]);
  await expect.poll(() => chartFirstSite(admin)).toBe("본사");

  await expect(admin.getByRole("button", { name: "되돌리기" })).toBeVisible();
  const undoSiteMove = orderResponse(admin);
  await admin.getByRole("button", { name: "되돌리기" }).click();
  const undoneSiteResponse = await undoSiteMove;
  expect(undoneSiteResponse.status()).toBe(200);
  expect((await undoneSiteResponse.json() as { children: string[] }).children).toEqual([siteIds["기술센터"], siteIds["본사"]]);
  await expect.poll(() => chartFirstSite(admin)).toBe("기술센터");
  await admin.reload();
  await expect(box(admin, LAB)).toBeVisible();
  expect(await chartFirstSite(admin)).toBe("기술센터");

  // Every other surface reads that stored order too.
  await admin.getByRole("button", { name: "목록", exact: true }).click();
  const rows = admin.getByRole("grid", { name: "조직 구조 목록" }).getByRole("row", { name: /주식회사 가나/ });
  await expect(rows.first()).toContainText(LAB);
  await expect(rows.first().getByRole("button", { name: `${LAB} 위로` })).toBeDisabled();
  await expectAccessible(admin, "structure list (legal entity order)");
  await go(admin, "/org/entities");
  await expect(listRows(admin).first()).toContainText(LAB);
  await expect(listRows(other).first()).toContainText(LAB);
  expect(await statutoryFirst(admin)).toBe(LAB);

  // 5. Refused: a reorder pinned to the order before (another person's stale view) is 409 and changes nothing.
  const tree = (await (await api("/org-structure")).json()) as { entities: { id: string }[] };
  const now = tree.entities.map((e) => e.id);
  const stale = await api("/org-structure/order", "PUT", { children: [...now].reverse(), expected_children: [...now].reverse() }, { "Idempotency-Key": crypto.randomUUID() });
  expect([stale.status(), await codeOf(stale)]).toEqual([409, "children_changed"]);
  const after = (await (await api("/org-structure")).json()) as { entities: { id: string }[] };
  expect(after.entities.map((e) => e.id)).toEqual(now);
  await other.context().close();
});
