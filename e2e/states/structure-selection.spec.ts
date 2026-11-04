// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { authz, id, screenAccess, structure } from "../mock/fixtures";
import { orgPanelReads } from "../mock/org-work";
import { orgChange } from "../mock/org-changes";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { box, findBox, revealUnit } from "../structure-flows";
import { screens } from "./registry";
import { expectAxe, fits } from "../a11y";

test.beforeAll(() => loadCatalog("ko"));

async function reason(page: Page) {
  await page.getByRole("button", { name: new RegExp(`^${t("orgUnit.gov.reason")}(?: · |$)`) }).click();
  const pop = page.getByRole("dialog", { name: t("orgUnit.gov.reason"), exact: true });
  await pop.getByRole("textbox").fill("조직 운영 계획");
  await pop.getByRole("textbox").press("Escape");
}

async function operating(page: Page, allowed = true) {
  await page.clock.setFixedTime(new Date("2026-11-04T12:00:00+09:00"));
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "OPERATING";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "OPERATING"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities.filter(c => c.feature !== "org_change_draft"), ...(allowed ? [{ feature: "org_change_draft", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false }] : [])] } });
  return { fixture, workplace: tree.entities[0]!.children[0]!, dept: tree.entities[0]!.children[0]!.children[0]! };
}

async function edit(page: Page, view: string, workplace: string, dept: string, rename = false) {
  await page.goto(`/org?view=${view === "panel" ? "chart" : view}`);
  if (view === "chart" || view === "panel") {
    await revealUnit(page, rename || view === "panel" ? dept : workplace);
    if (view === "panel") await page.getByRole("complementary", { name: dept, exact: true }).getByRole("button", { name: t(rename ? "orgUnit.rename.action" : "orgUnit.add.child"), exact: true }).click();
    else if (rename) await page.keyboard.press("F2");
    else await page.getByRole("toolbar", { name: t("structure.tools.label", { name: workplace }), exact: true }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
  } else if (view === "outline") {
    const tree = page.getByRole("tree", { name: t("structure.outline.label"), exact: true });
    if (rename) await tree.getByText(dept, { exact: true }).dblclick();
    else await tree.getByRole("treeitem", { name: new RegExp(`^${workplace}\\s`) }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
  } else if (rename) await page.getByRole("button", { name: `${dept} ${t("orgUnit.rename.action")}`, exact: true }).click();
  else await page.getByRole("row", { name: new RegExp(workplace) }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
  const label = view === "panel" ? t(rename ? "orgUnit.rename.label" : "orgUnit.add.label", rename ? { name: dept } : { parent: dept }) : t(rename ? "structure.edit.renameLabel" : "structure.edit.addLabel", rename ? { name: dept } : { parent: workplace });
  return page.getByRole("textbox", { name: new RegExp(`^${label}`) });
}

for (const view of ["chart", "outline", "list", "panel"]) {
  test(`org: ${view} requires a note for approval, refuses past 적용일, preserves same-name rename @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { fixture, workplace, dept } = await operating(page);
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [{ key: "approval.policy.org_structure", kind: { type: "code", allowed: ["route", "none"] }, default: "none", value: "route", looser_when: "neutral", governance: "tenant", legal_basis: null, version: "code_default", effective_from: null, scheduled: [], source: { layer: "code_default", scope_entity_id: null }, chain: [] }] } });
    const writes: unknown[] = [];
    await page.route("**/api/v1/org-changes", route => {
      if (route.request().method() !== "POST") return route.fallback();
      writes.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, json: { error: { code: "invalid_change", message: "Invalid change" } } });
    });
    try {
      let name = await edit(page, view, workplace.name, dept.name, true);
      await reason(page);
      await name.press("Enter");
      expect(writes).toEqual([]);
      if (await name.isVisible()) await name.press("Escape");
      name = await edit(page, view, workplace.name, dept.name);
      await name.fill("미래팀");
      const editor = view === "panel" ? page.getByRole("complementary", { name: dept.name, exact: true }) : name.locator("..");
      const save = editor.getByRole("button", { name: t("orgUnit.add.save"), exact: true });
      await expect(save).toBeDisabled();
      await expect(save).toHaveAccessibleDescription(t("orgUnit.gov.reasonForApproval"));
      await expect(page.getByRole("button", { name: `${t("orgUnit.gov.reason")} · ${t("orgUnit.gov.reasonRequired")}`, exact: true })).toBeVisible();
      await name.press("Enter");
      const reasonPop = page.getByRole("dialog", { name: t("orgUnit.gov.reason"), exact: true });
      await expect(reasonPop.getByRole("textbox")).toBeFocused();
      await reasonPop.getByRole("textbox").fill("조직 운영 계획");
      await reasonPop.getByRole("textbox").press("Escape");
      await expect(page.getByRole("button", { name: `${t("orgUnit.gov.reason")} · ${t("orgUnit.gov.reasonFilled")}`, exact: true })).toBeVisible();
      await page.getByRole("button", { name: `${t("orgUnit.gov.date")} · ${t("asof.today")}`, exact: true }).click();
      const date = page.getByRole("dialog", { name: t("orgUnit.gov.date"), exact: true }).getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.date")}`) });
      await date.fill("20261103");
      await date.press("Tab");
      await page.keyboard.press("Escape");
      await expect(save).toBeDisabled();
      await name.press("Enter");
      await expect(name).toHaveValue("미래팀");
      expect(writes).toEqual([]);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `${view}/guard/390/${theme}`);
        await expectAxe(page, `${view}/guard/390/${theme}`);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`org: ${view} hides edit affordances without the draft decision @ui-state`, async ({ page }) => {
    const { fixture, workplace, dept } = await operating(page, false);
    try {
      await page.goto(`/org?view=${view === "panel" ? "chart" : view}`);
      if (view === "panel" || view === "chart") {
        await revealUnit(page, dept.name);
        if (view === "chart") await page.keyboard.press("F2");
        const panel = page.getByRole("complementary", { name: dept.name, exact: true });
        await expect(panel.getByRole("button", { name: t("orgUnit.rename.action"), exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: t("orgUnit.add.child"), exact: true })).toHaveCount(0);
      } else {
        const surface = page.getByRole(view === "list" ? "grid" : "tree", { name: t(view === "list" ? "structure.list.label" : "structure.outline.label"), exact: true });
        await expect(surface.getByText(workplace.name, { exact: true }).first()).toBeVisible();
        await expect(surface.getByRole("button", { name: t("structure.tools.addDept"), exact: true })).toHaveCount(0);
        await surface.getByText(dept.name, { exact: true }).dblclick();
      }
      await expect(page.getByRole("textbox", { name: /이름/ })).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const view of ["chart", "panel"]) for (const outcome of ["draft", "preflight_blocked", "invalid_change"]) test(`org: inline ${view} ${outcome} without a note keeps the next action honest @ui-state`, async ({ page }) => {
  const { fixture, workplace, dept } = await operating(page);
  const draft = { ...orgChange("draft"), kind: "NEW" as const, reason: "NEW", effectiveDate: "2026-11-04" };
  let submitted = 0;
  const payloads: unknown[] = [];
  await page.route("**/api/v1/org-changes", route => {
    if (route.request().method() !== "POST") return route.fallback();
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: draft });
  });
  await page.route(`**/api/v1/org-changes/${draft.id}`, route => route.fulfill({ json: draft }));
  await page.route(`**/api/v1/org-changes/${draft.id}/submit`, route => {
    submitted++;
    return route.fulfill({ status: outcome === "preflight_blocked" ? 409 : 422, json: { error: { code: outcome, message: "Change refused" } } });
  });
  try {
    const name = await edit(page, view, workplace.name, dept.name);
    await name.fill("미래팀");
    await expect(page.getByRole("button", { name: `${t("orgUnit.gov.reason")} · ${t("orgUnit.gov.reasonNew")}`, exact: true })).toBeVisible();
    if (outcome === "draft") await page.getByRole("button", { name: t("composer.saveDraft"), exact: true }).click();
    else await name.press("Enter");
    if (outcome === "invalid_change") {
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(name).toHaveValue("미래팀");
      await expect(page).toHaveURL(/\/org(?:\?|$)/);
    } else {
      await expect(page).toHaveURL(new RegExp(`/org/changes/${draft.id}\\?done=drafted${outcome === "preflight_blocked" ? "&unsent=true" : "$"}`));
    }
    if (outcome !== "invalid_change") {
      const proposal = page.getByRole("region", { name: t("orgChange.proposal"), exact: true });
      await expect(proposal.locator("dd").first()).toHaveText(t("orgUnit.gov.reasonNew"));
      await expect(proposal.getByText("NEW", { exact: true })).toHaveCount(0);
    }
    expect(submitted).toBe(outcome === "draft" ? 0 : 1);
    expect(payloads).toEqual([expect.objectContaining({ kind: "NEW", reason: "NEW", effectiveDate: "2026-11-04" })]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const view of ["chart", "outline"] as const) test(`org: inline ${view} editor stays readable at 390px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "OPERATING";
  const workplace = tree.entities[0]!.children[0]!;
  const department = workplace.children[0]!;
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "OPERATING"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "org_change_draft", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
  try {
    await page.goto(`/org?view=${view}`);
    const surface = page.getByRole(view === "chart" ? "region" : "tree", { name: t(view === "chart" ? "structure.chart.label" : "structure.outline.label"), exact: true });
    for (const mode of ["add", "rename"] as const) {
      if (view === "chart") {
        await revealUnit(page, mode === "add" ? workplace.name : department.name);
        if (mode === "rename") await page.keyboard.press("F2");
        else await page.getByRole("toolbar", { name: t("structure.tools.label", { name: workplace.name }), exact: true }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
      } else if (mode === "rename") {
        await surface.getByText(department.name, { exact: true }).dblclick();
      } else {
        await surface.getByRole("treeitem", { name: new RegExp(`^${workplace.name}\\s`) }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
      }
      const input = page.getByRole("textbox", { name: mode === "add" ? t("structure.edit.addLabel", { parent: workplace.name }) : t("structure.edit.renameLabel", { name: department.name }), exact: true });
      await expect(input).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await expect.poll(async () => {
          const field = (await input.boundingBox())!;
          const area = (await surface.boundingBox())!;
          const editor = (await (view === "chart" ? input.locator("..") : input).boundingBox())!;
          return field.width > area.width / 2 && editor.x >= area.x && editor.x + editor.width <= area.x + area.width;
        }).toBe(true);
        await fits(page, `org inline ${view}/${mode}/390/${theme}`);
        await expectAxe(page, `org inline ${view}/${mode}/390/${theme}`);
      }
      await input.press("Escape");
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
  test(`org: select a setup workplace beside its hover action at ${viewport.width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    const tree = structure(1);
    tree.phase = "SETUP";
    const workplace = tree.entities[0]!.children[0]!;
    workplace.name = t("structure.node.headOffice");
    workplace.children = [];
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
    try {
      await page.goto("/org");
      await expect(box(page, workplace.name).getByText(workplace.name, { exact: true })).toHaveCount(2);
      await revealUnit(page, workplace.name);
      await expect(box(page, workplace.name)).toHaveAttribute("aria-selected", "true");
      await expect(box(page, workplace.name)).toBeFocused();
      const tools = page.getByRole("toolbar", { name: t("structure.tools.label", { name: workplace.name }), exact: true });
      await tools.getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
      await expect(page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) test(`org: multi-selection actions remain accessible at ${width}px in both themes @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(3);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
  try {
    await page.goto("/org");
    await page.getByRole("button", { name: t("structure.depth.all"), exact: true }).click();
    for (const name of ["검증부서 1", "검증부서 2"]) {
      await findBox(page, name);
      await box(page, name).click({ modifiers: ["Shift"] });
    }
    await expect(page.getByRole("region", { name: t("structure.selection.label"), exact: true })).toBeVisible();
    await expect(box(page, "검증부서 2").getByRole("button", { name: t("structure.menu.label", { name: "검증부서 2" }), exact: true })).toBeVisible();
    await expectAxe(page, `org/multi-selection/${width}`);
    await fits(page, `org/multi-selection/${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: post-go-live inline + add and rename in place carry 적용일 (default 오늘, changeable) without a dialog @ui-state", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-04T12:00:00+09:00"));
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(1);
  tree.phase = "OPERATING";
  const workplace = tree.entities[0]!.children[0]!;
  const dept = workplace.children[0]!;
  await page.route("**/api/v1/org-structure", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tree) }));
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "OPERATING"), is_ops: true } });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities, { feature: "org_change_draft", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [] } });

  const createdPayloads: Record<string, unknown>[] = [];
  let seq = 0;
  await page.route("**/api/v1/org-changes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    createdPayloads.push(body);
    seq += 1;
    const changeId = id(900 + seq);
    const code = `OC-2026-000${seq}`;
    const proposal = (body.proposal as { op: string; name?: string; orgUnitId?: string }[])[0]!;
    if (proposal.op === "CREATE_ORG_UNIT" && proposal.name) {
      workplace.children.push({ id: id(800 + seq), kind: "DEPARTMENT", name: proposal.name, version: 1, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [] });
    } else if (proposal.op === "RENAME_ORG_UNIT" && proposal.name) {
      const target = workplace.children.find((c) => c.id === proposal.orgUnitId);
      if (target) target.name = proposal.name;
    }
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: changeId, code, status: "DRAFT", kind: body.kind, target: body.target, proposal: body.proposal, events: [] }) });
  });
  await page.route("**/api/v1/org-changes/*/submit", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "IN_APPROVAL" }) });
  });
  await page.route("**/api/v1/org-changes/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const changeId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: changeId, code: `OC-2026-000${seq}`, status: "IN_APPROVAL", created_unit_ids: [id(800 + seq)], events: [] }) });
  });

  try {
    await page.goto("/org");
    await revealUnit(page, workplace.name);
    const tools = page.getByRole("toolbar", { name: t("structure.tools.label", { name: workplace.name }), exact: true });
    await tools.getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const addInput = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true });
    await expect(addInput).toBeFocused();
    await expect(page.getByRole("button", { name: `${t("orgUnit.gov.date")} · ${t("asof.today")}`, exact: true })).toBeVisible();

    await addInput.fill("전략팀");
    await addInput.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(1);
    expect(createdPayloads[0]).toMatchObject({
      kind: "NEW",
      reason: "NEW",
      effectiveDate: "2026-11-04",
      proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", name: "전략팀" }],
    });
    await expect(addInput).toHaveValue("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /OC-2026-0001/ })).toBeVisible();

    // Change 적용일 inline and add a future-dated department without opening a modal sheet.
    await page.getByRole("button", { name: `${t("orgUnit.gov.date")} · ${t("asof.today")}`, exact: true }).click();
    const datePop = page.getByRole("dialog", { name: t("orgUnit.gov.date"), exact: true });
    await datePop.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.date")}`) }).fill("20261201");
    await datePop.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.date")}`) }).press("Enter");
    await expect(page.getByRole("button", { name: `${t("orgUnit.gov.date")} · ${fmtDate("2026-12-01")}`, exact: true })).toBeVisible();
    await addInput.fill("미래팀");
    await addInput.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(2);
    expect(createdPayloads[1]).toMatchObject({
      kind: "NEW",
      effectiveDate: "2026-12-01",
      proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", name: "미래팀" }],
    });
    await addInput.press("Escape");

    // Rename in place on the chart via F2 without opening a dialog.
    await revealUnit(page, dept.name);
    await page.keyboard.press("F2");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const renameInput = page.getByRole("textbox", { name: t("structure.edit.renameLabel", { name: dept.name }), exact: true });
    await expect(renameInput).toBeVisible();
    await renameInput.fill("플랫폼팀");
    await renameInput.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(3);
    expect(createdPayloads[2]).toMatchObject({
      kind: "REORG",
      reason: "REORG",
      effectiveDate: "2026-11-04",
      proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: dept.id, name: "플랫폼팀" }],
    });

    // Side panel 이름 변경 also edits in place with 적용일 defaulted to 오늘 and changeable.
    const panel = page.getByRole("complementary", { name: "플랫폼팀", exact: true });
    await panel.getByRole("button", { name: t("orgUnit.rename.action"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await panel.getByRole("button", { name: `${t("orgUnit.gov.date")} · ${t("asof.today")}`, exact: true }).click();
    const panelDate = page.getByRole("dialog", { name: t("orgUnit.gov.date"), exact: true }).getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.date")}`) });
    await expect(panelDate).toHaveValue(fmtDate("2026-11-04"));
    await panelDate.fill("20261215");
    await panelDate.press("Enter");
    const panelName = panel.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.rename.label", { name: "플랫폼팀" })}`) });
    await panelName.fill("코어플랫폼팀");
    await panelName.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(4);
    expect(createdPayloads[3]).toMatchObject({
      kind: "REORG",
      reason: "REORG",
      effectiveDate: "2026-12-15",
      proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: dept.id, name: "코어플랫폼팀" }],
    });

    // Outline view: inline + add and F2 rename in place during OPERATING without a dialog.
    await page.goto("/org?view=outline");
    const outlineTree = page.getByRole("tree", { name: t("structure.outline.label"), exact: true });
    await outlineTree.getByRole("treeitem", { name: new RegExp(`^${workplace.name}\\s`) }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const outlineAdd = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true });
    await outlineAdd.fill("아웃라인팀");
    await expectAxe(page, "org operating outline editor");
    await outlineAdd.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(5);
    expect(createdPayloads[4]).toMatchObject({ kind: "NEW", reason: "NEW", effectiveDate: "2026-11-04", proposal: [{ op: "CREATE_ORG_UNIT", name: "아웃라인팀" }] });
    await outlineAdd.press("Escape");

    // List view: inline + add and inline rename button during OPERATING without a dialog.
    await page.goto("/org?view=list");
    await page.getByRole("row", { name: new RegExp(workplace.name) }).getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const listAdd = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true });
    await listAdd.fill("목록팀");
    await listAdd.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(6);
    expect(createdPayloads[5]).toMatchObject({ kind: "NEW", reason: "NEW", effectiveDate: "2026-11-04", proposal: [{ op: "CREATE_ORG_UNIT", name: "목록팀" }] });
    await listAdd.press("Escape");
    await page.getByRole("button", { name: `코어플랫폼팀 ${t("orgUnit.rename.action")}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const listRename = page.getByRole("textbox", { name: t("structure.edit.renameLabel", { name: "코어플랫폼팀" }), exact: true });
    await listRename.fill("목록개편팀");
    await listRename.press("Enter");
    await expect.poll(() => createdPayloads.length).toBe(7);
    expect(createdPayloads[6]).toMatchObject({ kind: "REORG", reason: "REORG", effectiveDate: "2026-11-04", proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: dept.id, name: "목록개편팀" }] });

    await fits(page, "org inline edit/1440/light");
    await expectAxe(page, "org inline edit/1440/light");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["held", "failed"] as const) test(`org: ${state} approval settings require a note before inline submission @ui-state`, async ({ page }) => {
  const { fixture, workplace, dept } = await operating(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/settings", async route => {
    if (state === "held") await held;
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Unavailable" } } });
  });
  const writes: unknown[] = [];
  await page.route("**/api/v1/org-changes", route => {
    if (route.request().method() !== "POST") return route.fallback();
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 422, json: { error: { code: "invalid_change", message: "Change refused" } } });
  });
  try {
    const name = await edit(page, "chart", workplace.name, dept.name);
    await name.fill("미래팀");
    await expect(page.getByRole("button", { name: `${t("orgUnit.gov.reason")} · ${t("orgUnit.gov.reasonRequired")}`, exact: true })).toBeVisible();
    await name.press("Enter");
    const note = page.getByRole("dialog", { name: t("orgUnit.gov.reason"), exact: true }).getByRole("textbox");
    await expect(note).toBeFocused();
    expect(writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { release(); await page.close(); fixture.release(); }
});
