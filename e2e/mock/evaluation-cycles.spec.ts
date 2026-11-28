// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { experienceState } from "../experience";
import { test } from "../locale-fixture";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type Schema = components["schemas"];
const endpoint = "/api/v1/evaluation/cycles";
function cycle(n: number): Schema["EvaluationCycleSummary"] {
  return { id: id(n), name: "Review " + n, period_label: "2030 Q2", kind: "REGULAR", stage: "OPEN",
    due_date: "2030-06-30", created_at: AT, subjects_total: 5, self_submitted: 3, manager_submitted: 2, finalized: 0, calibrated: 0 };
}
async function mount(page: Page, access: { read?: boolean; create?: boolean }, locale: string) {
  const fixture = await mockScreen(page, screens[0], "empty");
  await page.addInitScript(lang => localStorage.setItem("console.locale",lang), locale);
  const features = [...(access.read ? ["served_evaluation_cycles"] : []), ...(access.create ? ["served_evaluation_cycle_create"] : [])];
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
    capabilities: features.map(feature => ({ feature, org_wide: true, scoped: false, permission: "allow" as const, branch_scope: { kind: "all" as const } })) } });
  return fixture;
}

for (const experience of ["baseline","console"] as const) for (const lang of ["ko","en"] as const) test.describe(`${experience} ${lang}`, () => {
  test.use({ storageState: experienceState(experience), locale: lang === "en" ? "en-US" : "ko-KR" });
  test("register navigation, pagination, record facts and archived selection follow read permission", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const screen = await mount(page, { read: true }, lang);
    const active = Array.from({length:21}, (_, i) => cycle(101+i));
    await mockRoute(page, "get", endpoint, req => {
      const q = new URL(req.url()).searchParams;
      const start = Number(q.get("offset") ?? 0);
      const rows = q.get("stage") === "ARCHIVED" ? [{ ...cycle(300), stage: "ARCHIVED" as const }] : active;
      return { status: 200, json: { items: rows.slice(start, start + Number(q.get("limit"))), total: rows.length } };
    });
    try {
      await page.goto("/");
      await page.getByRole("link", { name: t("evaluation.title"), exact: true }).first().click();
      await expect(page.getByRole("heading", { name: t("evaluation.title"), exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: t("evaluation.create"), exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: t("common.page.next"), exact: true }).click();
      await expect(page).toHaveURL(/page=1/);
      await page.getByRole("row").filter({ hasText: "Review 121" }).click();
      await expect(page.locator("dl").filter({ hasText: t("evaluation.subjects") })).toContainText("5");
      await page.getByRole("combobox", {name: t("evaluation.stage")}).selectOption("ARCHIVED");
      await expect(page.getByRole("row").filter({hasText:"Review 300"})).toBeVisible();
      await expect(page).not.toHaveURL(/page=1/);
      await expectAxe(page,"Evaluation cycle register"); await fits(page,"Evaluation cycle register");
      await page.goto("/evaluation/new");
      await expect(page.getByRole("textbox", { name: t("evaluation.name") })).toHaveCount(0);
      expect(screen.unexpected).toEqual([]);
    } finally { screen.release(); }
  });

  test("creation uses its own permission and command key without a register read", async ({ page }) => {
    await page.setViewportSize({width:1440,height:900});
    const screen = await mount(page, {create:true}, lang);
    const loseResponse = experience === "console" && lang === "en";
    const submissions: {key:string|undefined; body:Schema["CreateEvaluationCycleRequest"]}[] = [];
    await mockRoute(page,"post",endpoint,req => {
      const body = req.postDataJSON() as Schema["CreateEvaluationCycleRequest"];
      submissions.push({key:req.headers()["idempotency-key"],body});
      if (loseResponse) return submissions.length === 1
        ? { status: 503, json: failure("unavailable") }
        : { status: 409, json: failure("command_applied") };
      return {status:201, json:{...cycle(400), ...body, stage:"DRAFT" as const, subjects:[], progress_by_unit:[], created_by:id(33), opened_at:null, calibration_started_at:null, finalized_at:null, archived_at:null }};
    });
    if (loseResponse) await mockRoute(page,"get","/api/v1/requests/{key}", req => {
      const key = new URL(req.url()).pathname.split("/").pop()!;
      expect(key).toBe(submissions[0]?.key);
      return {status:200, json:{id:id(405), idempotency_key:key, command:"evaluation.cycle.created",
        state:"APPLIED" as const, deadline:null, inputs_masked:{}, result:null, touched:[], refusal_code:null, created_at:AT, settled_at:AT, masked:false}};
    });
    try {
      await page.goto("/");
      await page.getByRole("link", {name:t("evaluation.create"),exact:true}).first().click();
      await page.getByRole("textbox", {name:t("evaluation.name")}).fill("Spring check-in");
      await page.getByRole("combobox", {name:t("evaluation.kind")}).selectOption("PROBATION");
      await page.getByRole("textbox", {name:t("evaluation.period")}).fill("2030 Q2");
      const due = page.getByRole("textbox",{name:t("me.evaluation.due")});
      await due.fill("2030-06-30");
      await due.press("Tab");
      await page.getByRole("button",{name:t("evaluation.save"),exact:true}).click();
      if (loseResponse) await page.getByRole("button",{name:t("requestOutcome.check"),exact:true}).click();
      await expect(page.getByText(t("evaluation.created",{name:"Spring check-in"}),{exact:true})).toBeVisible();
      expect(submissions).toHaveLength(loseResponse ? 2 : 1);
      if (loseResponse) expect(submissions[1]).toEqual(submissions[0]);
      expect(submissions[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(submissions[0]?.body).toEqual({name:"Spring check-in",kind:"PROBATION",period_label:"2030 Q2",due_date:"2030-06-30"});
      await expect(page.getByRole("link",{name:t("evaluation.title"),exact:true})).toHaveCount(0);
      expect(screen.unexpected).toEqual([]);
    } finally { screen.release(); }
  });
});

test("unavailable builds conceal both destinations and both private operations", async ({page}) => {
  const f = await mount(page,{}, "ko");
  try {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true }).first()).toBeVisible();
    for (const name of [t("evaluation.title"), t("evaluation.create")]) await expect(page.getByRole("link", {name, exact:true})).toHaveCount(0);
    for (const path of ["/evaluation","/evaluation/new"]) {
      await page.goto(path);
      await expect(page.getByRole("main").getByText(t(path === "/evaluation" ? "denied.capability.served_evaluation_cycles" : "denied.capability.served_evaluation_cycle_create"), {exact:true})).toBeVisible();
      await expect(page.getByRole("combobox")).toHaveCount(0);
    }
    expect(f.unexpected).toEqual([]);
  } finally {f.release();}
});

test("register keeps failure and empty distinct and allows a retry", async({page}) => {
  const f=await mount(page,{read:true}, "ko");
  await installFaultClock(page, req => new URL(req.url()).pathname === endpoint);
  const held=Promise.withResolvers<void>();
  let failed=true;
  await mockRoute(page,"get",endpoint,async () => {
    await held.promise;
    return failed ? {status:503,json:failure("unavailable")} : {status:200,json:{items:[],total:0}};
  });
  try {
    await page.goto("/evaluation");
    await expect(page.getByRole("status",{name:t("common.loading"),exact:true}).first()).toBeVisible();
    held.resolve();
    const retry=page.getByRole("button",{name:t("common.retry"),exact:true}).first();
    await expect(retry).toBeVisible();
    await expect(page.getByText(t("evaluation.empty"))).toHaveCount(0);
    failed=false; await retry.click();
    await expect(page.getByText(t("evaluation.empty"))).toBeVisible();
    expect(f.unexpected).toEqual([]);
  } finally {held.resolve(); f.release();}
});
