// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { fits } from "../a11y";
import { experienceState } from "../experience";
import { test } from "../locale-fixture";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type S = components["schemas"];
const framePath = "/api/v1/compliance/frameworks";
const controlPath = "/api/v1/compliance/framework-controls";
const frame = (n: number): S["ComplianceFramework"] => ({
  id: id(n), code: "FW-" + n, name: "Synthetic framework " + n, framework_kind: "INTERNAL_CONTROL",
  version_label: "Q3", status: "DRAFT", metadata: {}, created_by: id(3), updated_by: id(3), created_at: AT, updated_at: AT,
});
async function mount(page: Page, lang: string, caps: string[], branch?: string) {
  const fixture = await mockScreen(page, screens[0], "empty");
  await page.addInitScript(locale => localStorage.setItem("console.locale",locale),lang);
  const scope: S["MeAuthzResponse"]["branch_scope"] = branch ? { kind: "branches", branches: [branch] } : { kind: "all" };
  await mockRoute(page,"get","/api/v1/me/authz",{status:200,json:{...authz,branch_scope:scope,
    capabilities:caps.map(feature=>({feature,permission:"allow" as const,branch_scope:scope,org_wide:!branch,scoped:!!branch}))}});
  await mockRoute(page,"get","/api/v1/branches",{status:200,json:[]});
  return fixture;
}

const read = "served_compliance_catalog", manage = "served_compliance_catalog_manage";
for (const style of ["baseline","console"] as const) for (const locale of ["ko","en"] as const) test.describe(`${style} ${locale}`, () => {
  test.use({ storageState: experienceState(style), locale: locale === "ko" ? "ko-KR" : "en-US" });
  test("catalog pages and the selected framework's controls preserve scope", async ({page})=>{
    const screen = await mount(page,locale,[read]);
    const rows = Array.from({length:26},(_,i)=>frame(601+i));
    await mockRoute(page,"get",framePath,req=>{
      const q=new URL(req.url()).searchParams; const offset=Number(q.get("offset")??0);
      return {status:200,json:{items:rows.slice(offset,offset+25),limit:25,offset,total:26}};
    });
    const framework = rows[25]!;
    await mockRoute(page,"get",controlPath,req=>{
      expect(new URL(req.url()).searchParams.get("framework_id")).toBe(framework.id);
      return {status:200,json:{items:[],total:0,limit:25,offset:0}};
    });
    await page.goto("/compliance");
    await page.getByRole("button",{name:t("common.page.next"),exact:true}).click();
    await page.getByText(framework.name,{exact:true}).first().click();
    await expect(page.getByText(framework.version_label,{exact:true})).toBeVisible();
    await page.getByRole("button",{name:t("compliance.view.controls"),exact:true}).click();
    await expect(page.getByText(t("compliance.empty"),{exact:true})).toBeVisible();
    await expect(page.getByRole("main").getByRole("link",{name:t("compliance.create")})).toHaveCount(0);
    await fits(page,"compliance catalog"); expect(screen.unexpected).toEqual([]);
  });
  test("manage-only operator saves an actual declared command with a stable receipt",async({page})=>{
    const screen = await mount(page,locale,[manage]);
    let writes=0;
    await mockRoute(page,"post",framePath,req=>{
      ++writes; expect(req.headers()["idempotency-key"]).toBeTruthy();
      expect(req.postDataJSON()).toMatchObject({name:"Review program",version_label:"2026",framework_kind:"AUDIT_PROGRAM"});
      return {status:200,json:frame(601)};
    });
    await page.goto("/compliance/new");
    await page.getByRole("textbox",{name:t("compliance.name")}).fill("Review program");
    await page.getByRole("textbox",{name:t("compliance.version")}).fill("2026");
    await page.getByRole("combobox",{name:t("compliance.frameworkKind")}).selectOption("AUDIT_PROGRAM");
    await page.getByRole("button",{name:t("compliance.save"),exact:true}).click();
    await expect(page.getByText(t("compliance.saved",{action:t("compliance.action.framework")}),{exact:true})).toBeVisible();
    expect(writes).toBe(1); expect(screen.unexpected).toEqual([]);
  });
});

test("a branch reader sees only that branch's obligations and cannot open a tenant-wide catalog or command",async({page})=>{
  const branch=id(71);
  const screen=await mount(page,"ko",[read],branch);
  let filtered=0;
  await mockRoute(page,"get","/api/v1/compliance/obligations",req=>{
    expect(new URL(req.url()).searchParams.get("branch_id")).toBe(branch); ++filtered;
    return {status:200,json:{items:[],total:0,offset:0,limit:25}};
  });
  await page.goto("/compliance");
  await expect(page.getByText(t("compliance.empty"),{exact:true})).toBeVisible();
  await expect(page.getByRole("combobox",{name:t("compliance.register")})).toHaveCount(0);
  await page.goto("/compliance/new");
  await expect(page.getByRole("main").getByText(t("denied.capability.served_compliance_catalog_manage"))).toBeVisible();
  expect(filtered).toBeGreaterThan(0); expect(screen.unexpected).toEqual([]);
});

test("a refused catalog read cannot present empty data",async({page})=>{
  await mount(page,"ko",[read]);
  await mockRoute(page,"get",framePath,{status:403,json:failure("forbidden")});
  await page.goto("/compliance");
  await expect(page.getByRole("heading",{name:t("common.denied.title.plain"),exact:true})).toBeVisible();
  await expect(page.getByText(t("compliance.empty"),{exact:true})).toHaveCount(0);
});

test("an initial catalog read stays loading, then a failed answer can be retried",async({page})=>{
  await mount(page,"ko",[read]);
  const release=Promise.withResolvers<void>();
  let recovered=false;
  let failures=0;
  const attempted=Promise.withResolvers<void>();
  await mockRoute(page,"get",framePath,async()=>{
    if (!recovered) {
      await release.promise;
      if (++failures === 3) attempted.resolve();
      return {status:503,json:failure("unavailable")};
    }
    return {status:200,json:{items:[frame(601)],limit:25,offset:0,total:1}};
  });
  const sent=page.waitForRequest(req=>new URL(req.url()).pathname===framePath);
  try {
    await page.goto("/compliance"); await sent;
    await expect(page.getByRole("main").locator('[aria-busy="true"]').first()).toBeVisible();
    release.resolve();
    await attempted.promise; // The shared read policy retries 503 twice before exposing manual retry.
    const retry=page.getByRole("main").getByRole("button",{name:t("common.retry")}).first();
    await expect(retry).toBeVisible(); recovered=true; await retry.click();
    await expect(page.getByText(frame(601).name,{exact:true}).first()).toBeVisible();
  } finally { release.resolve(); }
});

test("a branch manager can record a site obligation with its owning branch", async ({ page }) => {
  const branch = id(71), site = id(74);
  const screen = await mount(page, "ko", [manage], branch);
  await mockRoute(page, "post", "/api/v1/compliance/obligations", req => {
    const scope = { kind: "SITE" as const, scope_ref: site, site_id: site, branch_id: branch };
    expect(req.postDataJSON()).toMatchObject({ title: "Site review", description: "Review the site", scope });
    return { status: 200, json: { id: id(76), code: "OB-76", title: "Site review", description: "Review the site",
      scope, severity: "MEDIUM", status: "DRAFT", obligation_type: "LEGAL", metadata: {},
      created_by: id(1), updated_by: id(1), created_at: AT, updated_at: AT } satisfies S["ComplianceObligation"] };
  });
  await page.goto("/compliance/new");
  await page.getByRole("textbox", { name: t("compliance.site") }).fill(site);
  await page.getByRole("textbox", { name: t("compliance.name") }).fill("Site review");
  await page.getByRole("textbox", { name: t("compliance.detail") }).fill("Review the site");
  await page.getByRole("button", { name: t("compliance.save"), exact: true }).click();
  await expect(page.getByText(t("compliance.saved", { action: t("compliance.action.obligation") }), { exact: true })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});

test("a manager can link a known obligation and regulation independently of list permission", async ({ page }) => {
  const screen = await mount(page, "ko", [manage]);
  const obligation = id(81), regulation = id(82);
  await mockRoute(page, "post", "/api/v1/compliance/obligation-regulation-links", req => {
    expect(req.postDataJSON()).toMatchObject({ obligation_id: obligation, regulation_impact_id: regulation, relationship: "AMENDED_BY" });
    return { status: 200, json: { id: id(83), obligation_id: obligation, regulation_impact_id: regulation,
      relationship: "AMENDED_BY", created_by: id(1), created_at: AT } satisfies S["ObligationRegulationLink"] };
  });
  await page.goto("/compliance/new");
  await page.getByRole("combobox", { name: t("compliance.action") }).selectOption("regulationLink");
  await page.getByRole("textbox", { name: t("compliance.ref.obligation") }).fill(obligation);
  await page.getByRole("textbox", { name: t("compliance.ref.regulation") }).fill(regulation);
  await page.getByRole("combobox", { name: t("compliance.relationship") }).selectOption("AMENDED_BY");
  await page.getByRole("button", { name: t("compliance.save"), exact: true }).click();
  await expect(page.getByText(t("compliance.saved", { action: t("compliance.action.regulationLink") }), { exact: true })).toBeVisible();
  expect(screen.unexpected).toEqual([]);
});
