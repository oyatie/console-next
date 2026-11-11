// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { failure, id, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { box, receipt, revealUnit } from "../structure-flows";
import { screens } from "../states/registry";

const opened = "2021-03-02";
const day = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${opened}T00:00:00+09:00`));

test.beforeAll(() => loadCatalog("ko"));

const applied = { status: 201 as const, json: { batch_id: id(501), change_mode: "SETUP", units: [{ op_index: 0, org_unit_id: id(500), version: 1 }] } };
type Answer = typeof applied | { status: 422; json: ReturnType<typeof failure> };

/** A setup company with one empty workplace; `answer` is the batch POST's reply. */
async function setupTree(page: Page, answer: (body: { ops: { name: string }[] }) => Answer) {
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "SETUP";
  const parent = tree.entities[0]!.children[0]!;
  parent.children = [];
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: [] } });
  const sent: unknown[] = [];
  await mockRoute(page, "post", "/api/v1/org-structure/batches", request => {
    const body = request.postDataJSON() as { ops: { name: string }[] };
    sent.push(body);
    const reply = answer(body);
    if (reply.status === 201) parent.children.push({ ...parent, id: id(500), kind: "DEPARTMENT", name: body.ops[0]!.name, children: [] });
    return reply;
  });
  await page.goto("/org");
  await revealUnit(page, parent.name);
  await page.keyboard.press("a");
  return { fixture, parent, sent };
}

async function pickDay(page: Page) {
  await page.getByRole("button", { name: "적용일 · 오늘" }).click();
  const pop = page.getByRole("dialog", { name: "적용일", exact: true });
  await pop.getByRole("textbox", { name: /^적용일/ }).fill(opened);
  await pop.getByRole("textbox", { name: /^적용일/ }).press("Enter");
  await expect(page.getByRole("button", { name: `적용일 · ${day}` })).toBeVisible();
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`a department added during setup can be dated an earlier day at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const { fixture, parent, sent } = await setupTree(page, () => applied);
    try {
      await pickDay(page);
      const field = page.getByRole("textbox", { name: `${parent.name} 아래 새 부서 이름` });
      await field.fill("개발팀");
      await page.screenshot({ path: test.info().outputPath(`dated-${width}-${theme}.png`) });
      await field.press("Enter");
      await expect(box(page, "개발팀")).toHaveCount(1);
      expect(sent).toEqual([{ ops: [expect.objectContaining({ op: "CREATE", name: "개발팀" })], effective_date: opened }]);
      await expect(receipt(page)).toContainText(`적용일 ${day}`);
      await fits(page, `setup date/${width}/${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("an untouched setup add sends no day, as before", async ({ page }) => {
  const { fixture, parent, sent } = await setupTree(page, () => applied);
  try {
    const field = page.getByRole("textbox", { name: `${parent.name} 아래 새 부서 이름` });
    await field.fill("개발팀");
    await field.press("Enter");
    await expect(box(page, "개발팀")).toHaveCount(1);
    expect(sent).toEqual([{ ops: [expect.objectContaining({ op: "CREATE", name: "개발팀" })] }]);
    await expect(receipt(page)).not.toContainText("적용일");
  } finally { await page.close(); fixture.release(); }
});

for (const code of ["org_setup_date_future", "org_setup_date_before_parent", "org_setup_date_before_current"] as const) {
  test(`the server's ${code} refusal reads beside the change`, async ({ page }) => {
    const body = failure(code);
    body.error.errors = [{ field: "effective_date", code }];
    const { fixture, parent } = await setupTree(page, () => ({ status: 422 as const, json: body }));
    try {
      await pickDay(page);
      const field = page.getByRole("textbox", { name: `${parent.name} 아래 새 부서 이름` });
      await field.fill("개발팀");
      await field.press("Enter");
      await expect(page.getByText(t(`common.failed.code.${code}`))).toBeVisible();
      await expect(box(page, "개발팀")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${code}.png`) });
    } finally { await page.close(); fixture.release(); }
  });
}

test("a move picked by keyboard during setup takes a day too", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(2);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: [] } });
  const sent: unknown[] = [];
  await mockRoute(page, "post", "/api/v1/org-structure/batches", request => {
    sent.push(request.postDataJSON());
    return applied;
  });
  try {
    await page.goto("/org");
    await revealUnit(page, "검증부서 2");
    await page.keyboard.press("m");
    const picker = page.getByRole("dialog", { name: "검증부서 2 이동" });
    await picker.getByRole("row", { name: /^검증부서 1/ }).click();
    await pickDay(page);
    await picker.getByRole("button", { name: "검증부서 1 아래로 이동" }).click();
    await expect.poll(() => sent).toEqual([{ ops: [expect.objectContaining({ op: "MOVE", org_unit_id: id(101) })], effective_date: opened }]);
    await expect(receipt(page)).toContainText(`적용일 ${day}`);
  } finally { await page.close(); fixture.release(); }
});
