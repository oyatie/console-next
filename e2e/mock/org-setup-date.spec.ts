// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { id, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { box, receipt, revealUnit } from "../structure-flows";
import { screens } from "../states/registry";

const opened = "2021-03-02";

test("a department added during setup can be dated an earlier day, and the receipt names it", async ({ page }) => {
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
    parent.children.push({ ...parent, id: id(500), kind: "DEPARTMENT", name: body.ops[0]!.name, children: [] });
    return { status: 201, json: { batch_id: id(501), change_mode: "SETUP", units: [{ op_index: 0, org_unit_id: id(500), version: 1 }] } };
  });
  try {
    await page.goto("/org");
    await revealUnit(page, parent.name);
    await page.keyboard.press("a");
    await page.getByRole("button", { name: "적용일 · 오늘" }).click();
    const pop = page.getByRole("dialog", { name: "적용일", exact: true });
    await pop.getByRole("textbox", { name: /^적용일/ }).fill(opened);
    await pop.getByRole("textbox", { name: /^적용일/ }).press("Enter");
    const day = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${opened}T00:00:00+09:00`));
    await expect(page.getByRole("button", { name: `적용일 · ${day}` })).toBeVisible();
    const field = page.getByRole("textbox", { name: `${parent.name} 아래 새 부서 이름` });
    await field.fill("개발팀");
    await field.press("Enter");
    await expect(box(page, "개발팀")).toHaveCount(1);
    expect(sent).toEqual([{ ops: [expect.objectContaining({ op: "CREATE", name: "개발팀" })], effective_date: opened }]);
    await expect(receipt(page)).toContainText(`적용일 ${day}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
