import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { registerEntity, registerWorkplace, SECOND } from "./setup-flows";
import { box, leaveScreen } from "./structure-flows";

// The tenant is the customer account; its legal entities are the top-level organization nodes.

test.use({ viewport: { width: 1440, height: 900 } });

const TENANT = "group";
const chart = (page: Page) => page.getByRole("tree", { name: "전체 조직도" });

/** Every chart box's level and top edge, top first. */
const boxes = (page: Page) =>
  page.locator("[role=treeitem][data-level]").evaluateAll((els) =>
    els.map((el) => ({ level: el.getAttribute("data-level"), y: el.getBoundingClientRect().y, bg: getComputedStyle(el).backgroundColor, text: el.textContent ?? "" })),
  );

async function expectNoCompanyNode(page: Page) {
  const tree = chart(page);
  await expect(tree).toBeVisible();
  // Negative: no node carries the account's name or a 회사 kind label (a node's name reads "name, level, headcount").
  await expect(tree.getByRole("treeitem", { name: new RegExp(TENANT) })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: /(^|, )회사(\(그룹\))?(,|$)/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "보고 있는 위치" })).not.toContainText(TENANT);
  await expect(page.getByRole("main")).not.toContainText(/회사\(그룹\)/);
  // The root is an unboxed header, and the 법인 are the top boxes.
  const all = await boxes(page);
  const root = all.find((b) => b.level === "tenant")!;
  expect(root.bg).toBe("rgba(0, 0, 0, 0)");
  expect(root.text).not.toContain(TENANT);
  const drawn = all.filter((b) => b.level !== "tenant");
  const top = Math.min(...drawn.map((b) => b.y));
  expect(drawn.filter((b) => b.y === top).map((b) => b.level)).toEqual(drawn.filter((b) => b.level === "entity").map(() => "entity"));
}

test("the account's name is never a company node: the 법인 are the top of the structure", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  // The vendor names a customer account, not a company: the hint says where 법인 names come from.
  await expect(v.getByRole("textbox", { name: /^고객 이름/ })).toBeVisible();
  await expect(v.getByText("회사 이름이 아닙니다", { exact: false })).toHaveCount(0);
  await v.getByLabel("고객 이름").fill(TENANT);
  await tenantSlugField(v).fill(unique("group"));
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  // The empty structure opens on the first 법인's slot: no box stands above it.
  await go(admin, "/org");
  await expect(admin.getByRole("heading", { name: "첫 법인을 등록합니다" })).toBeVisible();
  await expect(admin.getByRole("main")).not.toContainText(TENANT);
  await admin.getByRole("link", { name: "법인 추가" }).click();
  await expect(admin.getByText("1번째 법인", { exact: true })).toBeVisible();
  await registerEntity(admin, "가나정밀");
  await go(admin, "/org");
  await admin.getByRole("link", { name: "사업장 추가" }).click();
  await registerWorkplace(admin, "가나정밀", "천안공장");

  // One 법인: it is the top box, under the plain 「전체 · 법인 1개」 header.
  await go(admin, "/org");
  await leaveScreen(admin);
  await expect(box(admin, "주식회사 가나정밀")).toBeVisible();
  await expect(box(admin, "천안공장")).toBeVisible();
  await expect(admin.locator('[data-box][data-level="tenant"]')).toContainText("전체 · 법인 1개");
  await expectNoCompanyNode(admin);
  await expectAccessible(admin, "structure chart (one 법인, no company root)");

  // Two 법인: side by side under 「전체 · 법인 2개」, still no company node; added from the header's own entries.
  await admin.getByRole("group", { name: "전체에 추가" }).getByRole("link", { name: "법인 추가" }).click();
  await expect(admin.getByText("2번째 법인", { exact: true })).toBeVisible();
  await registerEntity(admin, "가나물류", false, undefined, SECOND);
  await go(admin, "/org");
  await leaveScreen(admin);
  await expect(box(admin, "주식회사 가나물류")).toBeVisible();
  await expect(admin.locator('[data-box][data-level="tenant"]')).toContainText("전체 · 법인 2개");
  await expectNoCompanyNode(admin);
  await expectAccessible(admin, "structure chart (two 법인, no company root)");

  // The paper and the list say the same: the whole is 「전체」, never the account's name.
  await admin.getByRole("button", { name: "내보내기" }).click();
  const exp = admin.getByRole("dialog", { name: "조직도 내보내기" });
  await expect(exp.getByRole("textbox", { name: "제목" })).toHaveValue("전체 조직도");
  await expect(exp).not.toContainText(TENANT);
  await admin.keyboard.press("Escape");
  await admin.getByRole("button", { name: "목록", exact: true }).click();
  await expect(admin.getByRole("grid", { name: "조직 구조 목록" })).not.toContainText(TENANT);
});
