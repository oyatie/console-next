import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { setupCompany } from "./setup-flows";
import { addDepartments, box, findBox, leaveScreen, receipt } from "./structure-flows";

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`floating chart chrome never clips a bottom band at ${viewport.width}×${viewport.height}`, { tag: "@org" }, async ({ browser }) => {
    const v = await vendorPage(browser);
    await go(v, "/platform");
    await v.getByRole("button", { name: "고객 계정 개설" }).click();
    await v.getByLabel("고객 이름").fill("캔버스그룹");
    await tenantSlugField(v).fill(unique(`canvas-${viewport.width}`));
    await tenantOnboardSubmit(v).click();
    const admin = await firstSignIn(browser, await takeCode(v));
    await admin.setViewportSize(viewport);
    await setupCompany(admin, "캔버스정밀", "본사");
    await go(admin, "/org");
    await addDepartments(admin, "본사", ["생산부", "품질부", "영업부"]);
    const canvas = admin.getByRole("region", { name: "조직도", exact: true });
    const tree = canvas.getByRole("tree");
    const bottom = canvas.getByRole("group", { name: "확대·축소" }).locator("..");
    // Escape restores a taller receipt after search: the revealed box must still take a press.
    const find = admin.getByRole("searchbox", { name: "조직 찾기" });
    await find.fill("생산부");
    await find.press("Enter");
    await expect(box(admin, "생산부")).toHaveAttribute("data-s", /\bnow\b/);
    const short = (await bottom.boundingBox())!, found = (await box(admin, "생산부").boundingBox())!;
    await pan(admin, tree.locator(".."), 0, short.y - found.y - found.height - 10);
    await find.press("Escape");
    await expect.poll(async () => (await bottom.boundingBox())!.height).toBeGreaterThan(short.height);
    await expect.poll(async () => {
      const r = (await box(admin, "생산부").boundingBox())!;
      return r.y + r.height - (await bottom.boundingBox())!.y;
    }).toBeLessThanOrEqual(-8);
    await expect(admin.getByRole("group", { name: "변경일" })).not.toHaveAttribute("aria-busy", "true");
    // Floating controls can overlap different edges as the viewport wraps; probe an exposed point.
    const production = box(admin, "생산부");
    const point = await production.evaluate((el) => {
      const { left, top, width, height } = el.getBoundingClientRect();
      for (const y of [4, height / 2, height - 4]) {
        for (const x of [4, width / 2, width - 4]) {
          if (document.elementFromPoint(left + x, top + y)?.closest("[data-box]") === el) return { x, y };
        }
      }
      return null;
    });
    expect(point, "visible chart node has an exposed pointer point").not.toBeNull();
    await production.click({ trial: true, position: point! });
    await receipt(admin).getByRole("button", { name: "알림 닫기", exact: true }).click();
    await go(admin, "/org"); // Deselect the unit, giving the canvas its full column.
    await admin.getByRole("button", { name: "부서 모두", exact: true }).click();
    const fit = canvas.getByRole("group", { name: "확대·축소" }).getByRole("button", { name: "화면에 맞춤" });
    await fit.click();
    await expect(box(admin, "생산부")).toBeVisible();
    await admin.screenshot({ path: `reports/canvas-clip/${process.env.CANVAS_CLIP_CAPTURE ?? "after"}-${viewport.width}x${viewport.height}.png` });

    // The native viewport fills the canvas interior, even while a corner overview is drawn.
    const dimensions = await tree.evaluate((el) => {
      const viewport = el.parentElement!, canvas = viewport.parentElement!;
      return { viewport: viewport.clientHeight, canvas: canvas.clientHeight };
    });
    expect(dimensions.viewport).toBe(dimensions.canvas);
    const visible = (await tree.locator("..").boundingBox())!;
    for (const node of await tree.locator("[data-box]").all()) {
      const r = (await node.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(visible.x);
      expect(r.y).toBeGreaterThanOrEqual(visible.y);
      expect(r.x + r.width).toBeLessThanOrEqual(visible.x + visible.width);
      expect(r.y + r.height).toBeLessThanOrEqual(visible.y + visible.height);
    }
    // A root action partly under the floating header must not leave a tiny exposed pointer target.
    const actions = canvas.locator('[role="group"]:has(> a[href="/org/entities/new"])');
    await expect(actions).toBeVisible();
    const row = (await actions.boundingBox())!;
    const chrome = (await canvas.locator("nav").locator("..").boundingBox())!;
    await pan(admin, tree.locator(".."), 0, chrome.y + chrome.height - row.y - 6);
    await expect(actions).toHaveCount(0);
    await fit.click();
    await expect(actions).toBeVisible();
    await leaveScreen(admin);
    await expectAccessible(admin, "fitted full-height chart");

    // Focus this branch to give the overview its corner at both viewport widths.
    await findBox(admin, "주식회사 캔버스정밀");
    await box(admin, "주식회사 캔버스정밀").press("f");
    await expect(canvas.getByRole("tree")).toHaveAttribute("aria-label", "주식회사 캔버스정밀 조직도");
    for (let n = 0; n < 10; n++) await canvas.getByRole("button", { name: "확대", exact: true }).click();
    const collapse = canvas.getByRole("button", { name: "전체 지도 접기" });
    const expand = canvas.getByRole("button", { name: "전체 지도 펼치기" });
    await expect(collapse).toBeVisible();
    const mini = collapse.or(expand).locator("../..");
    const map = (await mini.boundingBox())!;
    const node = box(admin, "생산부");
    const before = (await node.boundingBox())!;
    const draw = (await canvas.getByRole("tree").locator("..").boundingBox())!;
    const dx = map.x - before.width / 2 - before.x;
    const dy = map.y + 70 - before.height / 2 - before.y;
    const moved = await pan(admin, tree.locator(".."), dx, dy);
    await expect.poll(async () => (await node.boundingBox())!.y).toBeCloseTo(before.y + moved, 0);
    const panned = (await node.boundingBox())!;
    expect(panned.y).toBeGreaterThan(map.y);
    expect(panned.x + panned.width).toBeGreaterThan(map.x);
    expect(panned.y + panned.height).toBeLessThan(draw.y + draw.height);
    // Its exposed half remains drawn and takes a pointer below the overview's top.
    expect(await node.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + 4, r.top + r.height / 2)?.closest("[data-box]") === el;
    })).toBe(true);
    await admin.screenshot({ path: `reports/canvas-clip/panned-${viewport.width}x${viewport.height}.png` });
    await findBox(admin, "생산부");
    const revealed = (await node.boundingBox())!, corner = (await mini.boundingBox())!;
    expect(revealed.x + revealed.width <= corner.x || revealed.y + revealed.height <= corner.y || revealed.x >= corner.x + corner.width || revealed.y >= corner.y + corner.height).toBe(true);
    await collapse.click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(mini.locator(":scope > svg")).toBeHidden();
    await leaveScreen(admin);
    await expectAccessible(admin, "collapsed overview");
    await admin.reload();
    for (let n = 0; n < 10; n++) await canvas.getByRole("button", { name: "확대", exact: true }).click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.focus();
    await admin.keyboard.press("Space");
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await expect(mini.locator(":scope > svg")).toBeVisible();
    await leaveScreen(admin);
    await expectAccessible(admin, "expanded overview");
  });
}

async function pan(page: Page, viewport: Locator, dx: number, dy: number) {
  const draw = (await viewport.boundingBox())!, size = page.viewportSize()!;
  // Whole pixels inside the drawing: a fractional edge let a rounded end point land half a pixel outside it.
  const left = Math.ceil(Math.max(draw.x + 4, 4)), right = Math.floor(Math.min(draw.x + draw.width - 4, size.width - 4));
  const top = Math.ceil(Math.max(draw.y + 4, 4)), bottom = Math.floor(Math.min(draw.y + draw.height - 4, size.height - 4));
  const start = await viewport.evaluate((el, bounds) => {
    const xMin = bounds.dx < 0 ? bounds.left - bounds.dx : bounds.left;
    const xMax = bounds.dx > 0 ? bounds.right - bounds.dx : bounds.right;
    const yMin = bounds.dy < 0 ? bounds.top - bounds.dy : bounds.top;
    const yMax = bounds.dy > 0 ? bounds.bottom - bounds.dy : bounds.bottom;
    for (let row = 0; row <= 8; row++) for (let col = 0; col <= 8; col++) {
      const x = Math.round(xMin + (xMax - xMin) * col / 8);
      const y = Math.round(yMin + (yMax - yMin) * row / 8);
      const target = document.elementFromPoint(x, y);
      if (target && el.contains(target) && !target.closest("[data-box], button, input, a, [role=menu]")) return { x, y };
    }
    return null;
  }, { left, right, top, bottom, dx, dy });
  expect(start, "canvas pan starts on exposed background inside the viewport").not.toBeNull();
  const { x, y } = start!;
  const endX = Math.round(x + dx), endY = Math.round(y + dy);
  expect(x).toBeGreaterThanOrEqual(left);
  expect(x).toBeLessThanOrEqual(right);
  expect(endX).toBeGreaterThanOrEqual(left);
  expect(endX).toBeLessThanOrEqual(right);
  expect(y).toBeGreaterThanOrEqual(top);
  expect(y).toBeLessThanOrEqual(bottom);
  expect(endY).toBeGreaterThanOrEqual(top);
  expect(endY).toBeLessThanOrEqual(bottom);
  // Keep mouseup inside Firefox's viewport; an outside release can leave the canvas dragging.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 3 });
  await page.mouse.up();
  return endY - y;
}
