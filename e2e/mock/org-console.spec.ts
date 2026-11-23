// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { homeSetupChecklist } from "../states/home-setup";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { previewData } from "./onboarding";
import { mockRoute } from "./route";
import { failure, id, screenAccess, checklist as baseChecklist, employees as baseEmployees } from "./fixtures";
import { saeonAdminUser, saeonApprovalOrgChange, saeonLegalEntities, saeonOrgStructure, saeonOrgUnits, saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark", fullPage = true) => {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  if (fullPage) {
    await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
  } else {
    await page.screenshot({ path: `${dir}/${name}--${width}-${theme}.png`, fullPage: false });
  }
};

function saeonGoLivePreview(phase: "OPERATING" | "SETUP") {
  const base = previewData(phase === "SETUP" ? "ready" : "receipt");
  const primaryEntity = saeonUniverse.entities[0]!;
  const breakdown = [
    {
      kind: "legal_entity" as const,
      id: primaryEntity.id,
      legal_entity_id: primaryEntity.id,
      name: primaryEntity.name,
      people: primaryEntity.headcount,
      units: primaryEntity.workplaces.reduce((sum, w) => sum + w.departments.length, 0),
    },
    ...primaryEntity.workplaces.map((w) => ({
      kind: "workplace" as const,
      id: w.id,
      legal_entity_id: primaryEntity.id,
      name: w.name,
      people: Math.max(1, Math.floor(primaryEntity.headcount / primaryEntity.workplaces.length)),
      units: w.departments.length,
    })),
  ];
  return {
    ...base,
    breakdown,
    roles_becoming_active: base.roles_becoming_active.map((r) => ({
      ...r,
      holders: [{ id: saeonAdminUser().id, name: saeonUniverse.adminActor.name }],
    })),
    access_admin_holders: [{ id: saeonAdminUser().id, name: saeonUniverse.adminActor.name }],
    facts: {
      ...base.facts,
      entities: saeonUniverse.entities.length,
      workplaces: saeonUniverse.entities.reduce((sum, e) => sum + e.workplaces.length, 0),
      org_units: saeonOrgUnits().filter((u) => u.kind === "DEPARTMENT").length,
      employees: saeonUniverse.counts.active,
      employees_starting_later: saeonUniverse.counts.joining,
    },
  };
}

async function setupConsoleOrg(
  page: Page,
  options: { theme?: "light" | "dark"; experience?: "console" | "baseline"; phase?: "OPERATING" | "SETUP"; refusalOnChangeRefetch?: boolean } = {},
) {
  const { theme = "light", experience = "console", phase = "OPERATING", refusalOnChangeRefetch = false } = options;
  const fixture = await setupConsoleSaeonPeople(page, { theme, experience });
  const orgPaths = ["/org", "/org/move", "/org/paste", "/org/import", "/org/workplaces/edit", "/org/entities/new", "/setup/go-live", "/people"];
  const baseEntries = orgPaths.flatMap((p) => screenAccess(p, phase).entries);
  const accessEntries = [
    ...baseEntries,
    {
      domain: "tenant" as const,
      level: "approve" as const,
      enforcement: "ENFORCED" as const,
      scope: { kind: "TENANT" as const, include_descendants: true },
      grant_id: id(90),
      role_id: id(91),
      role_name_ko: baseEntries[0]?.role_name_ko ?? "QA Role",
      valid_from: "2026-01-01T00:00:00Z",
      caveats: [],
    },
  ];
  const accessDecisions = Object.assign({}, ...orgPaths.map((p) => screenAccess(p, phase).decisions));
  const deduped = accessEntries.filter(
    (entry, idx) => accessEntries.findIndex((o) => o.domain === entry.domain && o.level === entry.level && o.scope.kind === entry.scope.kind) === idx,
  );
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...screenAccess("/org", phase), phase, is_ops: phase === "SETUP", decisions: accessDecisions, entries: deduped },
  });
  if (phase === "SETUP") {
    const admin = saeonAdminUser();
    await mockRoute(page, "get", "/api/v1/users/me", {
      status: 200,
      json: {
        ...admin,
        is_tenant_ops: true,
        tenant: { ...admin.tenant, name: saeonUniverse.tenantName, phase: "SETUP", go_live_at: null },
      },
    });
  }
  await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", {
    status: 200,
    json: { list: { key: "brn_classification", status: "NOT_LOADED" }, items: [] },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", {
    status: 200,
    json: phase === "SETUP" ? homeSetupChecklist("all-done") : { ...baseChecklist, phase },
  });
  const orgTree = { ...saeonOrgStructure(), phase };
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: orgTree });
  const units = saeonOrgUnits();
  await mockRoute(page, "get", "/api/v1/org-units", {
    status: 200,
    json: { items: units, draftableIds: units.map((u) => u.id) },
  });
  const entities = saeonLegalEntities();
  const detailMap = new Map(entities.items.map((e) => [e.id, e]));
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: entities });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", (req) => {
    const entityId = new URL(req.url()).pathname.split("/").pop()!;
    const found = detailMap.get(entityId) ?? entities.items[0]!;
    return { status: 200, json: found };
  });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/documents", { status: 200, json: { items: [] } });
  await page.route("**/api/v1/legal-entities/*/history", (route) => route.fulfill({ status: 200, json: { items: [] } }));
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", { status: 200, json: { items: [] } });
  await page.route("**/api/v1/legal-entities/*/end-options", (route) =>
    route.fulfill({ status: 200, json: { delete: { allowed: false, refusal: "record_in_use" }, close: { allowed: true, refusal: null } } }),
  );
  await mockRoute(page, "get", "/api/v1/registration-checks/availability", { status: 200, json: { available: true, reason: null } });
  const change = saeonApprovalOrgChange();
  await mockRoute(page, "get", "/api/v1/org-changes", { status: 200, json: { items: [change], total: 1 } });
  await page.route("**/api/v1/org-changes/counts", (route) =>
    route.fulfill({ status: 200, json: { open: 1, mine: 0, approval: 1, ready: 0, done: 0, closed: 0, all: 1 } }),
  );
  let changeReads = 0;
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", () => {
    changeReads++;
    if (refusalOnChangeRefetch && changeReads > 1) return { status: 403, json: failure("forbidden") };
    return { status: 200, json: change };
  });
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/preflight", { status: 200, json: change });
  await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", {
    status: 200,
    json: saeonGoLivePreview(phase),
  });
  const terms = { version: "2026-10-01", sha256: "a".repeat(64), body: "Terms of service" };
  await mockRoute(page, "get", "/api/v1/onboarding/terms", {
    status: 200,
    json: { ...terms, privacy: { ...terms, policy_url: "https://example.test/privacy", review_pending: false } },
  });
  await mockRoute(page, "get", "/api/v1/requests/{key}", (req) => {
    const key = new URL(req.url()).pathname.split("/").pop()!;
    if (key === "missing-req") return { status: 404, json: failure("request_not_found") };
    return {
      status: 200,
      json: {
        id: key,
        idempotency_key: key,
        command: "org.change.submit",
        state: "APPLIED" as const,
        created_at: "2026-11-10T09:00:00Z",
        settled_at: "2026-11-10T09:00:01Z",
        deadline: null,
        inputs_masked: {},
        masked: false,
        refusal_code: null,
        result: { kind: "ORG_CHANGE", id: change.id },
        touched: [{ type: "ORG_CHANGE", id: change.id, audit_id: id(90), branch_id: null }],
      },
    };
  });
  return { fixture, entities, change };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console Module 1 primary surfaces render cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture, entities, change } = await setupConsoleOrg(page, { theme });
      try {
        await page.goto("/org");
        await expect(page.locator('[data-pattern="canvas"]')).toBeVisible();
        await expect(page.locator("h1")).toHaveCount(1);
        await expect(page.getByRole("button", { name: t(`structure.view.${width === 390 ? "list" : "chart"}`), exact: true })).toHaveAttribute("aria-pressed", "true");
        await expectAxe(page, `/org/${width}/${theme}`);
        await fits(page, `/org/${width}/${theme}`);
        await capture(page, width, "org", theme, width === 1440);

        await page.goto("/org?view=list");
        await expect(page.locator('[data-pattern="canvas"]')).toBeVisible();
        await expect(page.getByRole("button", { name: t("structure.view.list"), exact: true })).toHaveAttribute("aria-pressed", "true");
        await fits(page, `/org-list/${width}/${theme}`);
        await capture(page, width, "org-list", theme, false);

        await page.goto("/org?tab=entities");
        await expect(page.locator('[data-pattern="list-record"]')).toBeVisible();
        await expect(page.locator("h1")).toHaveCount(1);
        await fits(page, `/org-entities/${width}/${theme}`);
        await capture(page, width, "org-entities", theme);

        await page.goto("/org?tab=changes");
        await expect(page.locator('[data-pattern="list-record"]')).toBeVisible();
        await fits(page, `/org-changes/${width}/${theme}`);
        await capture(page, width, "org-changes", theme);

        await page.goto(`/org/changes/${change.id}`);
        await expect(page.locator('[data-pattern="document-decision"]')).toBeVisible();
        await expect(page.getByRole("link", { name: t("orgChange.openApproval"), exact: true })).toHaveAttribute("href", new RegExp(`/approvals/org_change(?:%3A|:)${change.id}`));
        await expectAxe(page, `/org-change/${width}/${theme}`);
        await fits(page, `/org-change/${width}/${theme}`);
        await capture(page, width, "org-change", theme);

        const firstEntity = entities.items[0]!;
        await page.goto(`/org/entities/${firstEntity.id}`);
        await expect(page.locator('[data-pattern="record"]')).toBeVisible();
        await expectAxe(page, `/org-entity/${width}/${theme}`);
        await fits(page, `/org-entity/${width}/${theme}`);
        await capture(page, width, "org-entity", theme);

        await page.goto("/org/entities/new");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await fits(page, `/org-entity-new/${width}/${theme}`);
        await capture(page, width, "org-entity-new", theme);

        const deptId = saeonOrgStructure().entities[0]!.children[0]!.children[0]!.id;
        const targetSiteName = saeonUniverse.entities[0]!.workplaces[1]!.name;
        await page.goto(`/org/move?ids=${deptId}`);
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        const targetTree = page.getByRole("treegrid", { name: t("bulkMove.where"), exact: true });
        await targetTree.getByRole("row", { name: new RegExp(targetSiteName) }).click();
        await fits(page, `/org-move/${width}/${theme}`);
        await capture(page, width, "org-move", theme);

        await page.goto("/org/workplaces/edit");
        await expect(page.locator('[data-pattern="form"]')).toBeVisible();
        await fits(page, `/org-workplaces-edit/${width}/${theme}`);
        await capture(page, width, "org-workplaces-edit", theme);

        await page.goto("/requests");
        await expect(page.locator('[data-pattern="form"]')).toBeVisible();
        await fits(page, `/requests/${width}/${theme}`);
        await capture(page, width, "requests", theme);

        await page.goto("/requests/req-ok-1");
        await expect(page.locator('[data-pattern="record"]')).toBeVisible();
        await fits(page, `/request-detail/${width}/${theme}`);
        await capture(page, width, "request-detail", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console SETUP surfaces (/setup/go-live, /org/paste, /org/import) render cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const { fixture } = await setupConsoleOrg(page, { theme, phase: "SETUP" });
      try {
        await page.goto("/setup/go-live");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await expectAxe(page, `/setup/go-live/${width}/${theme}`);
        await fits(page, `/setup/go-live/${width}/${theme}`);
        await capture(page, width, "setup-go-live", theme);

        await page.goto("/org/paste");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await fits(page, `/org-paste/${width}/${theme}`);
        await capture(page, width, "org-paste", theme);

        await page.goto("/org/import");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await fits(page, `/org-import/${width}/${theme}`);
        await capture(page, width, "org-import", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("CloseSheet paginates >1k employees and chunks bulk exit submission <=500", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, entities } = await setupConsoleOrg(page, { theme: "light" });
  const targetEntity = { ...entities.items[0]!, id: saeonUniverse.entities[0]!.id };
  const employeeTemplate = baseEmployees(1)[0]!;
  const staff = Array.from({ length: 1250 }, (_, i) => ({
    ...employeeTemplate,
    id: `00000000-0000-4000-8350-${String(i + 1).padStart(12, "0")}`,
    employee_number: `E${String(i + 1).padStart(4, "0")}`,
    name: `Staff ${i + 1}`,
    status: "ACTIVE" as const,
    legal_entity_id: targetEntity.id,
    workplace_id: targetEntity.workplaces[0]!.id,
    org_unit_id: null,
  }));
  const employeeRequests: string[] = [];
  await mockRoute(page, "get", "/api/v1/employees", (req) => {
    const q = new URL(req.url()).searchParams;
    employeeRequests.push(q.toString());
    if (q.get("legal_entity_id") !== targetEntity.id) return { status: 200, json: { items: [], total: 0, limit: 100, offset: 0, next_cursor: null } };
    const cursor = q.get("cursor");
    const start = cursor ? staff.findIndex((p) => p.id === cursor) + 1 : 0;
    const limit = Number(q.get("limit") ?? 100);
    const slice = staff.slice(start, start + limit);
    return { status: 200, json: { items: slice, total: staff.length, limit, offset: start, next_cursor: start + limit < staff.length ? slice[slice.length - 1]!.id : null } };
  });
  const bulkPayloads: { sizes: number; key: string | null }[] = [];
  await mockRoute(page, "post", "/api/v1/hr/exit-cases/bulk", (req) => {
    const body = req.postDataJSON() as { items: { employee_id: string }[] };
    bulkPayloads.push({ sizes: body.items.length, key: req.headers()["idempotency-key"] ?? null });
    return { status: 200, json: { results: body.items.map((item) => ({ employee_id: item.employee_id, ok: true, id: item.employee_id })) } };
  });
  try {
    await page.goto(`/org/entities/${targetEntity.id}`);
    await expect(page.locator('[data-pattern="record"]')).toBeVisible();
    await page.locator("#act-entity-close").click();
    const dialog = page.getByRole("dialog").last();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1,250");
    await expect.poll(() => employeeRequests.some((q) => q.includes("cursor="))).toBe(true);
    await dialog.getByRole("button", { name: t("entityRecordClose.peopleFix") }).click();
    const exitsSection = dialog.getByRole("region", { name: t("entityRecordClose.peopleFix") });
    const dateInput = exitsSection.getByRole("textbox", { name: new RegExp(t("entityRecordClose.exits.lastDay")) });
    await dateInput.fill("2026-11-10");
    await dateInput.press("Tab");
    await exitsSection.getByText(t("entityRecordClose.exits.closure"), { exact: true }).click();
    await exitsSection.getByRole("button", { name: t("entityRecordClose.exits.submit", { count: 1250 }) }).click();
    await expect.poll(() => bulkPayloads.map((b) => b.sizes)).toEqual([500, 500, 250]);
    expect(new Set(bulkPayloads.map((b) => b.key)).size).toBe(3);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Baseline experience parity remains intact on /org and /org/entities/$id", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, entities } = await setupConsoleOrg(page, { theme: "light", experience: "baseline" });
  try {
    await page.goto("/org");
    await expect(page.locator('[data-pattern="canvas"]')).toHaveCount(0);
    await expect(page.locator("h1")).toBeVisible();

    await page.goto(`/org/entities/${entities.items[0]!.id}`);
    await expect(page.locator('[data-pattern="record"]')).toHaveCount(0);
    await expect(page.locator("h1")).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("PatternShell forwards keepOnLoss/back on /org/changes/$id and own/back on /requests/missing-req", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, change } = await setupConsoleOrg(page, { theme: "light", refusalOnChangeRefetch: true });
  try {
    await page.goto(`/org/changes/${change.id}`);
    await expect(page.locator('[data-pattern="document-decision"]')).toBeVisible();
    await expect(page.locator("main")).toContainText(change.code);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator('[data-pattern="document-decision"]')).toBeVisible();
    await expect(page.locator("main")).toContainText(change.code);

    await page.goto("/requests/missing-req");
    await expect(page.getByRole("link", { name: t("requestOutcome.lookup") }).first()).toBeVisible();
    await expect(page.locator('[data-pattern="record"]')).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /org/move locks body, saveDraft, AddMore, and Ctrl+Enter on 403 refusal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleOrg(page, { theme: "light" });
  const deptId = saeonOrgStructure().entities[0]!.children[0]!.children[0]!.id;
  let writes = 0;
  await mockRoute(page, "post", "/api/v1/org-changes", () => {
    writes++;
    return { status: 403, json: failure("org_change.refuse.missing_grant") };
  });
  try {
    await page.goto(`/org/move?ids=${deptId}`);
    const main = page.getByRole("main");
    const tree = main.getByRole("treegrid", { name: t("bulkMove.where"), exact: true });
    const targetSiteName = saeonUniverse.entities[0]!.workplaces[1]!.name;
    await tree.getByRole("row", { name: new RegExp(targetSiteName) }).click();
    await main.getByRole("button", { name: new RegExp(`^${t("uiDate.preset.today")}`) }).click();
    await main.getByRole("textbox", { name: new RegExp(`^${t("orgPropose.field.reason")}`) }).fill(saeonUniverse.approval.reason);
    const submit = main.getByRole("button", { name: commitLabel({ kind: "orgMove", mode: "apply", count: 1 }), exact: true });
    await submit.click();
    await expect(main.getByRole("alert")).toContainText(t("org_change.refuse.missing_grant"));
    await expect(main.getByRole("alert")).toBeFocused();
    await expect(submit).toBeDisabled();
    await expect(main.getByRole("button", { name: t("composer.saveDraft"), exact: true })).toBeDisabled();
    await expect(main.getByRole("button", { name: t("bulkMove.addMore"), exact: true })).toBeDisabled();
    expect(await tree.evaluate((el) => Boolean(el.closest("[inert]")))).toBe(true);
    await submit.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
    expect(writes).toBe(1);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
