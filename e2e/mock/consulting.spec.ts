// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";

type S = components["schemas"];
const collection = "/api/v1/consulting/engagements";
const record = "/api/v1/consulting/engagements/{engagement_id}";
const detail = `/consulting/engagements/${id(1)}`;
const initial: S["ConsultingEngagementDetail"] = {
  id: id(1), customer_id: id(2), title: "North handover", version: 1, status: "DRAFT", created_at: AT, updated_at: AT,
  diagnostics: [], findings: [], initiatives: [], observations: [],
};
async function mount(page: Page, access: "read" | "write" | "create" | "denied") {
  await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
  const screen = await mockScreen(page, screens[0], "populated");
  const cap = (feature: string): S["MeAuthzCapability"] => ({ feature, permission: "allow", org_wide: true, scoped: true, branch_scope: { kind: "all" } });
  const capabilities = access === "denied" ? [] : [cap("served_consulting_entry"), ...(access === "create" ? [] : [cap("served_consulting")]), ...(access !== "read" ? [cap("served_consulting_manage")] : [])];
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities } });
  return screen;
}
function pageOf(items: S["ConsultingEngagement"][]) { return { status: 200 as const, json: { items, offset: 0, limit: 25, total: items.length } }; }
async function records(page: Page, row = structuredClone(initial)) {
  await mockRoute(page, "get", collection, () => pageOf([row]));
  await mockRoute(page, "get", record, () => ({ status: 200, json: row }));
  await mockRoute(page, "get", "/api/v1/consulting/engagements/{engagement_id}/history", { status: 200, json: [
    { id: id(7), event_type: "engagement.created", version: 1, occurred_at: AT, payload: {} },
  ] });
  return row;
}
for (const width of [1440, 390]) test(`read an engagement and its history by keyboard at ${width}px`, async ({ page }) => {
  const screen = await mount(page, "read");
  await records(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/consulting");
  const entry = page.getByRole("rowheader", { name: initial.title });
  await entry.focus(); await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "Engagement record" });
  await expect(link).toBeVisible(); await link.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: initial.title, level: 1 })).toBeVisible();
  await expect(page.getByText("Engagement created", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostic", exact: true })).toHaveCount(0);
  await fits(page, "consulting engagement"); await expectAxe(page, "consulting engagement");
  expect(screen.unexpected).toEqual([]);
});

test("create using a customer and collect diagnostic, finding, initiative and observation with eligible references", async ({ page }) => {
  const screen = await mount(page, "write");
  const row = await records(page);
  row.status = "IMPLEMENTED";
  const optionIds: Record<string, string> = { CUSTOMER: id(2), EVIDENCE: id(3), DOCUMENT: id(4), KPI_DEFINITION: id(5) };
  await mockRoute(page, "get", "/api/v1/consulting/options", req => {
    const kind = new URL(req.url()).searchParams.get("kind")!;
    return { status: 200, json: { items: optionIds[kind] ? [{ id: optionIds[kind]!, label: `Eligible ${kind}`, recorded_at: null }] : [], next_offset: null } };
  });
  await mockRoute(page, "post", collection, req => {
    expect(req.postDataJSON()).toMatchObject({ customerId: id(2), title: initial.title, idempotencyKey: req.headers()["idempotency-key"] });
    return { status: 201, json: row };
  });
  await mockRoute(page, "post", "/api/v1/consulting/engagements/{engagement_id}/diagnostics", req => {
    expect(req.postDataJSON()).toEqual({ summary: "Handover varies", documentId: id(4) });
    const d = { id: id(10), summary: "Handover varies", document_id: id(4), created_at: AT };
    row.diagnostics.push(d); return { status: 201, json: d };
  });
  await mockRoute(page, "post", "/api/v1/consulting/engagements/{engagement_id}/findings", req => {
    expect(req.postDataJSON()).toEqual({ diagnosticId: id(10), statement: "No handover log", evidenceId: id(3) });
    const f = { id: id(11), diagnostic_id: id(10), statement: "No handover log", evidence_id: id(3), created_at: AT };
    row.findings.push(f); return { status: 201, json: f };
  });
  await mockRoute(page, "post", "/api/v1/consulting/engagements/{engagement_id}/initiatives", req => {
    expect(req.postDataJSON()).toEqual({ findingId: id(11), title: "Use shared log", hypothesis: "Less delay", kpiDefinitionId: id(5), targetDirection: "DECREASE" });
    const i: S["ConsultingInitiative"] = { id: id(12), finding_id: id(11), title: "Use shared log", hypothesis: "Less delay", kpi_definition_id: id(5), target_direction: "DECREASE", created_at: AT };
    row.initiatives.push(i); return { status: 201, json: i };
  });
  await mockRoute(page, "post", "/api/v1/consulting/engagements/{engagement_id}/observations", req => {
    const body = req.postDataJSON(); expect(body).toEqual({ initiativeId: id(12), kpiDefinitionId: id(5), evidenceId: id(3), observedAt: "2026-11-11T00:00:00.000Z", note: "Log in use" });
    const o = { id: id(13), initiative_id: id(12), kpi_definition_id: id(5), evidence_id: id(3), observed_at: body.observedAt, note: body.note, created_at: AT };
    row.observations.push(o); return { status: 201, json: o };
  });
  await page.goto("/consulting"); await page.getByRole("button", { name: "Create engagement", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Engagement name").fill(initial.title);
  await dialog.getByRole("combobox", { name: "Customer" }).selectOption(id(2));
  await dialog.getByRole("button", { name: /^record$/i }).click();
  await expect(page).toHaveURL(new RegExp(detail));
  const start = async (name: string) => { await page.getByRole("button", { name, exact: true }).click(); };
  const submit = async () => { await dialog.getByRole("button", { name: /^record$/i }).click(); await expect(dialog).toHaveCount(0); };
  await start("Diagnostic"); await dialog.getByLabel("Diagnostic summary").fill("Handover varies");
  await dialog.getByRole("combobox", { name: "Reviewed document" }).selectOption(id(4)); await submit();
  await start("Finding"); await dialog.getByRole("combobox", { name: "Diagnostic" }).selectOption(id(10));
  await dialog.getByLabel("Finding statement").fill("No handover log"); await dialog.getByRole("combobox", { name: "Reviewed evidence" }).selectOption(id(3)); await submit();
  await start("Initiative"); await dialog.getByRole("combobox", { name: "Finding" }).selectOption(id(11));
  await dialog.getByLabel("Initiative name").fill("Use shared log"); await dialog.getByLabel("Hypothesis").fill("Less delay");
  await dialog.getByRole("combobox", { name: "Reviewed KPI definition" }).selectOption(id(5)); await dialog.getByRole("combobox", { name: "Target direction" }).selectOption("DECREASE"); await submit();
  await start("Benefit observation"); await dialog.getByRole("combobox", { name: "Initiative" }).selectOption(id(12));
  await dialog.getByLabel("Observation note").fill("Log in use"); await dialog.getByRole("combobox", { name: "Reviewed evidence" }).selectOption(id(3));
  await dialog.getByLabel("Observed at (Korea time)").fill("2026-11-11T09:00"); await submit();
  await expect(page.getByText("Log in use", { exact: true })).toBeVisible(); expect(screen.unexpected).toEqual([]);
});

test("approve with an eligible independent authorization for this engagement and its opened version", async ({ page }) => {
  const screen = await mount(page, "write"); const row = await records(page); row.status = "PROPOSED"; row.version = 2;
  await mockRoute(page, "get", "/api/v1/consulting/options", req => {
    expect(new URL(req.url()).searchParams.get("engagementId")).toBe(row.id);
    return { status: 200, json: { items: [{ id: id(20), label: "Request 7", recorded_at: AT }], next_offset: null } };
  });
  await mockRoute(page, "post", "/api/v1/consulting/engagements/{engagement_id}/transition", req => {
    expect(req.postDataJSON()).toEqual({ expectedVersion: 2, toStatus: "APPROVED", approvalId: id(20), reason: "Reviewed proposal" });
    row.status = "APPROVED"; row.version++; row.approval_id = id(20); return { status: 200, json: row };
  });
  await page.goto(detail); await page.getByRole("button", { name: "Change stage" }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByLabel("Reason for transition").fill("Reviewed proposal");
  await dialog.getByRole("combobox", { name: "Approved request" }).selectOption(id(20));
  await dialog.getByRole("button", { name: /^change$/i }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});

test("an unavailable register can be retried to an actual empty result", async ({ page }) => {
  const screen = await mount(page, "read"); let ready = false;
  await installFaultClock(page, req => new URL(req.url()).pathname === collection);
  await mockRoute(page, "get", collection, () => ready ? pageOf([]) : { status: 503, json: failure("unavailable") });
  await page.goto("/consulting"); const retry = page.getByRole("button", { name: "Reload", exact: true }); await expect(retry).toBeVisible(); ready = true;
  await retry.click(); await expect(page.getByText("No engagements match", { exact: true })).toBeVisible(); expect(screen.unexpected).toEqual([]);
});

test("unenrolled tenants cannot read either register or record", async ({ page }) => {
  const screen = await mount(page, "denied");
  for (const url of ["/consulting", detail]) {
    await page.goto(url); await expect(page.getByRole("main")).toContainText(/permission|access/i);
    await expect(page.getByRole("button", { name: "Create engagement" })).toHaveCount(0);
  }
  expect(screen.unexpected).toEqual([]);
});


test("create-only users receive their receipt without reading the register or opening a record", async ({page}) => {
  const screen=await mount(page,"create");
  await mockRoute(page,"get","/api/v1/consulting/options",req=>({status:200,json:{items:new URL(req.url()).searchParams.get("kind")==="CUSTOMER"?[{id:id(2),label:"Customer A",recorded_at:null}]:[],next_offset:null}}));
  await mockRoute(page,"post",collection,{status:201,json:initial});
  await page.goto("/consulting");
  await expect(page.getByText("Consulting read access is required.")).toBeVisible();
  await page.getByRole("button",{name:"Create engagement"}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByLabel("Engagement name").fill(initial.title);
  await dialog.getByRole("combobox",{name:"Customer"}).selectOption(id(2));
  await dialog.getByRole("button",{name:"Record",exact:true}).click();
  await expect(page.getByText(`Created engagement “${initial.title}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/consulting$/);expect(screen.unexpected).toEqual([]);
});
