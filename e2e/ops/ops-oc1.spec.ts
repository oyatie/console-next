// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAxe, fits } from "../a11y";
import { withFullPage } from "../shots";
import { forgetResize } from "../stability";
import { makeMe, mountOpsMock } from "./fixtures";

async function shotOps(page: Page, screen: string) {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  const html = page.locator("html");
  const prevTheme = await html.getAttribute("data-theme");
  const prevViewport = page.viewportSize();
  const capture = (width: number, mode: string) =>
    withFullPage(page, () =>
      page.screenshot({ path: `${dir}/${width}/${screen}-${mode}.png`, fullPage: true }),
    );
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const mode of ["light", "dark"] as const) {
      await html.evaluate((el, t) => {
        el.dataset.theme = t;
      }, mode);
      await capture(1440, mode);
      await atPhoneWidth(page, () => capture(390, mode));
    }
  } finally {
    await html.evaluate((el, t) => {
      if (t === null) delete el.dataset.theme;
      else el.dataset.theme = t;
    }, prevTheme);
    if (prevViewport) await page.setViewportSize(prevViewport);
  }
}

test.describe("Stage-1 OC1 Ops Cockpit", () => {
  test("Obligations list, filters, detail transitions, create, and broken-chain Unknown degradation", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/obligations");

    await expect(page.getByRole("heading", { name: "Obligations" })).toBeVisible();
    await expect(page.getByText("Blocked: 1 open launch gate").first()).toBeVisible();
    await expect(page.getByText("Production PITR drill signoff")).toBeVisible();
    await expectAxe(page, "ops-obligations-1440");
    await shotOps(page, "obligations");

    await page.getByLabel("State").selectOption("open");
    await expect(page).toHaveURL(/state=open/);
    await expect(page.getByText("Statutory wage calculation review")).toHaveCount(0);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page).toHaveURL(/\/obligations\/OBL-0001/);
    await expect(page.getByText("Event history (1)")).toBeVisible();
    await shotOps(page, "obligation-detail");

    // Transition open -> in-review -> done
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page.getByText("Event history (2)")).toBeVisible();

    await page.getByLabel("Lifecycle transitions").selectOption("done");
    await page.getByLabel("Evidence reference").fill("drill-2026-11-21");
    await page.getByLabel("Signer").fill("ops-lead");
    await page.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByText("Obligation is finalized and cannot be modified")).toBeVisible();

    // Create new obligation
    await page.goto("/obligations");
    await page.getByRole("button", { name: "New obligation" }).click();
    await page.getByLabel("Title").fill("Verify backup escrow");
    await page.getByLabel("Due date (YYYY-MM-DD)").fill("2026-11-30");
    await page.getByRole("button", { name: "Open obligation" }).click();
    await expect(page).toHaveURL(/\/obligations\/OBL-0004/);
    await expect(page.getByText("Verify backup escrow").first()).toBeVisible();

    await atPhoneWidth(page, async () => {
      await fits(page, "ops-obligations-390");
    });
    expect(mock.unexpected).toEqual([]);

    // Broken chain degradation
    const brokenMock = await mountOpsMock(page, "paging", { brokenObligationChain: true });
    await page.goto("/obligations");
    await expect(page.getByText(/record chain integrity error/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "New obligation" })).toBeDisabled();
    expect(brokenMock.unexpected).toEqual([]);
  });

  test("Alerting ack/silence, render.jq deep links, Watchdog guard, and 390px Jobs Line 2 + Rerun", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging", {
      extraAlertKeys: ["Watchdog×monitoring"],
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    // render.jq /alerts/$key/ack deep link
    await page.goto(`/alerts/${encodeURIComponent("HighErrorRate×api")}/ack`);
    await expect(page.getByRole("heading", { name: "Acknowledge alert group" })).toBeVisible();
    await page.getByLabel("Acknowledgement note (optional)").fill("N/A");
    await page.locator("form").getByRole("button", { name: "Acknowledge" }).click();
    await expect(page.getByText(/cannot be a placeholder/i)).toBeVisible();
    await page.getByLabel("Acknowledgement note (optional)").fill("Mitigating canary regression");
    await page.locator("form").getByRole("button", { name: "Acknowledge" }).click();
    await expect(page.getByText("Acknowledged in spool")).toBeVisible();

    // Watchdog unsilenceable guard
    await page.goto(`/alerts/${encodeURIComponent("Watchdog×monitoring")}`);
    await expect(page.getByText("Watchdog alert is unsilenceable by policy")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create silence" })).toBeDisabled();

    // render.jq /alerts/silence?matcher=... deep link
    await page.goto('/alerts/silence?matcher=alertname%3D%22HighErrorRate%22&matcher=component%3D%22api%22');
    await expect(page.getByLabel(/Matchers/)).toHaveValue("alertname=HighErrorRate\ncomponent=api");
    await page.getByLabel(/Comment/).fill("Silencing during controlled canary rollback");
    await page.locator("form").getByRole("button", { name: "Create silence" }).click();
    await expect(page.getByText("sil-1")).toBeVisible();
    await page.getByRole("button", { name: "Expire" }).click();
    await expect(page.getByText(/No active silences/)).toBeVisible();

    // 390px Running -> Jobs Line 2 + Rerun receipt
    await page.goto("/running/jobs");
    await page.getByRole("button", { name: "Rerun" }).first().click();
    await expect(page.getByText("ACT-0002 · job-rerun")).toBeVisible();

    await atPhoneWidth(page, async () => {
      await expect(page.getByText(/11-21 21:00Z · exit 0 · Next: 11-21 22:00Z/)).toBeVisible();
      await expect(page.getByText(/11-21 18:00Z · exit 1 · Next: Not scheduled/)).toBeVisible();
      const rowBox = await page.locator("tbody tr").first().boundingBox();
      expect(rowBox?.height ?? 999).toBeLessThanOrEqual(68);
      await fits(page, "ops-jobs-390");
    });
    await shotOps(page, "jobs");
    expect(mock.unexpected).toEqual([]);
  });

  test("O1 Service Health unblended and OPS-ONCALL Page Test command", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/health");

    await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
    await expect(page.getByText("Low sample volume (<50k requests / 30d)")).toBeVisible();
    await expect(page.getByText("Public status feed (unblended)")).toBeVisible();
    await expect(page.getByText("Degraded performance")).toBeVisible();
    await expectAxe(page, "ops-health-1440");
    await shotOps(page, "health");

    await page.goto("/oncall");
    await expect(page.getByText("Single operator on call").first()).toBeVisible();
    await page.getByRole("button", { name: "Trigger page test" }).click();
    await expect(page.getByText("ACT-0002 · page-test")).toBeVisible();
    await expectAxe(page, "ops-oncall-1440");
    await shotOps(page, "oncall");

    await atPhoneWidth(page, async () => {
      await fits(page, "ops-oncall-390");
    });
    expect(mock.unexpected).toEqual([]);
  });

  test("O3 Incidents declare, clocks, 409 conflict recovery, SEV1 postmortem gate, and public draft", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging", { forceConflictOnce: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/incidents");

    await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
    await expect(page.getByText("Elevated 502 responses on api-canary")).toBeVisible();
    await expect(page.getByText(/Intrusion 24h:.*PIPC \/ KISA 72h:/)).toBeVisible();
    await expectAxe(page, "ops-incidents-1440");
    await shotOps(page, "incidents");

    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page).toHaveURL(/\/incidents\/INC-0001/);
    const detail = page.locator("aside");
    await expect(detail.getByText("Intrusion 24h")).toBeVisible();
    await expect(detail.getByText("PIPC / KISA 72h")).toBeVisible();
    await expect(detail.getByText("ST-2026 · API latency and elevated errors")).toBeVisible();
    await shotOps(page, "incident-detail");

    // 409 conflict reload recovery
    await page.getByLabel("Note").fill("Confirmed upstream pool saturation");
    await page.getByRole("button", { name: "Append event" }).click();
    await expect(page.getByText("Incident modified concurrently; reload required")).toBeVisible();
    await page.getByRole("button", { name: "Reload latest sequence" }).click();
    await page.getByRole("button", { name: "Append event" }).click();
    await expect(page.getByText("Timeline (2)")).toBeVisible();

    // SEV1 postmortem gate
    await page.getByLabel("Timeline event").selectOption("resolved");
    await page.getByRole("button", { name: "Append event" }).click();
    await expect(page.getByText("Postmortem link required before resolving SEV1/SEV2")).toBeVisible();

    // Link postmortem & draft public update
    await page.getByLabel("Timeline event").selectOption("postmortem_linked");
    await page.getByLabel("Postmortem reference").fill("docs/postmortems/2026-11-21.md");
    await page.getByRole("button", { name: "Append event" }).click();
    await expect(page.getByText("Timeline (3)")).toBeVisible();

    await page.getByLabel("Public message (English)").fill("Canary weight held while investigating.");
    await page.getByLabel("Public message (Korean)").fill("Canary weight held status update.");
    await page.getByRole("button", { name: "Draft public update" }).click();
    await expect(page.getByText("ACT-0002 · status-publish")).toBeVisible();

    // Declare new incident
    await page.goto("/incidents");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await page.getByLabel("Title").fill("DB backup delay");
    await page.getByRole("button", { name: "Declare" }).click();
    await expect(page).toHaveURL(/\/incidents\/INC-0002/);
    expect(mock.unexpected).toEqual([]);
  });

  test("O4/O5 Changes, Promote signoff/triage/request, and Actions queue", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/changes");

    await expect(page.getByText("DORA-5 delivery metrics")).toBeVisible();
    await expect(page.getByText("Unknown: gate missing").first()).toBeVisible();
    await expect(page.getByText("ci-ok: pass")).toBeVisible();
    await page.getByLabel("Change reason (required)").fill("Holding rollout during investigation");
    await page.getByRole("button", { name: "Freeze deploys" }).click();
    await expect(page.getByText("ACT-0002 · freeze")).toBeVisible();
    await expectAxe(page, "ops-changes-1440");
    await shotOps(page, "changes");

    await page.goto("/promote");
    await expect(page.getByText("Blocked by open P0/P1 feedback or missing release gates")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request promotion" })).toBeDisabled();

    // Triage P1 feedback -> Watching -> Signoff ready -> Ready -> Promote
    await page.getByLabel("Feedback ID").fill("FB-101");
    await page.locator('form:has-text("Save triage")').getByLabel("Note").fill("Verified resolved");
    await page.getByRole("button", { name: "Save triage" }).click();
    await expect(page.getByText("Awaiting a ready staging signoff for this candidate digest")).toBeVisible();

    await page.locator('form:has-text("Record signoff")').getByLabel("Note").fill("Staging smoke green");
    await page.getByRole("button", { name: "Record signoff" }).click();
    await expect(page.getByRole("button", { name: "Request promotion" })).toBeEnabled();
    await page.getByRole("button", { name: "Request promotion" }).click();
    await expect(page.getByText("ACT-0003 · promote")).toBeVisible();
    await shotOps(page, "promote");

    await page.goto("/actions");
    await expect(page.getByText("ACT-0001 · canary-hold")).toBeVisible();
    await expectAxe(page, "ops-actions-1440");
    await shotOps(page, "actions");
    expect(mock.unexpected).toEqual([]);
  });

  test("O6 Recovery denies unknown tenant field and O9 Runbooks blocks XSS with segment-safe paths", async ({ page }) => {
    const drillPayloads: Record<string, unknown>[] = [];
    const mock = await mountOpsMock(page, "paging", {
      onDrillBody: (b) => drillPayloads.push(b),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/recovery");

    await expect(page.getByText("Unknown: Not measured")).toBeVisible();
    await page.getByRole("button", { name: "Request backup" }).click();
    await expect(page.getByText("ACT-0002 · backup-now")).toBeVisible();
    await page.getByLabel("Target (name or UTC Z timestamp)").fill("latest-verified");
    await page.getByRole("button", { name: "Request drill" }).click();
    await expect(page.getByText("ACT-0003 · drill")).toBeVisible();
    expect(drillPayloads[0]).not.toHaveProperty("tenant");
    await expectAxe(page, "ops-recovery-1440");
    await shotOps(page, "recovery");

    // Runbooks + XSS proof
    await page.goto("/runbooks");
    await expect(page.getByText(/Runbook bundle SHA \(8f2a10c\) differs/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operations Runbook" })).toBeVisible();
    await shotOps(page, "runbooks");

    await page.getByRole("button", { name: "XSS Probe" }).click();
    await expect(page.getByRole("heading", { name: "XSS Verification" })).toBeVisible();
    expect(mock.runbookPaths).toContain("/api/ops/v1/runbooks/docs/ops/xss-probe.md");
    expect(mock.runbookPaths.some((p) => p.includes("%2F"))).toBe(false);

    const xssCheck = await page.evaluate(() => ({
      xss: (window as unknown as { __xss?: unknown }).__xss,
      jsLinks: document.querySelectorAll('a[href^="javascript:"]').length,
      extLinks: document.querySelectorAll('a[href^="https://"]').length,
    }));
    expect(xssCheck.xss).toBeUndefined();
    expect(xssCheck.jsLinks).toBe(0);
    expect(xssCheck.extLinks).toBe(0);
    await expectAxe(page, "ops-runbooks-1440");
    await page.getByText("RUNBOOK.md").click();
    await expect(page.getByRole("heading", { name: "Operations Runbook" })).toBeVisible();
    await page.locator("article").getByRole("link", { name: "Alerts" }).click();
    await expect(page).toHaveURL(/\/alerts/);
    expect(mock.runbookPaths).not.toContain("/api/ops/v1/runbooks/alerts");
    expect(mock.unexpected).toEqual([]);
  });

  test("Mobile More sheet, 320px fits, 403 Cedar refusals, and zero Hangul/SCREAMING_SNAKE_CASE", async ({ page }) => {
    const mock = await mountOpsMock(page, "paging");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await page.getByRole("button", { name: "More" }).click();
    const dialog = page.getByRole("dialog", { name: "All cockpit surfaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("link", { name: "Recovery" }).click();
    await expect(page).toHaveURL(/\/recovery/);
    await fits(page, "ops-recovery-390");

    await page.setViewportSize({ width: 320, height: 640 });
    await forgetResize(page);
    await fits(page, "ops-recovery-320");
    expect(mock.unexpected).toEqual([]);

    // 403 refusals on OC1 surfaces when operator lacks obligation.read / recovery.read
    const minMock = await mountOpsMock(page, "paging", {
      meOverride: makeMe(["read.me", "read.home"]),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/obligations");
    await expect(page.getByText("Permission missing")).toBeVisible();
    await expect(page.getByText("ops-action-denied")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    expect(await page.locator("body").innerText()).not.toMatch(/\p{Script=Hangul}/u);

    await page.goto("/recovery");
    await expect(page.getByText("Permission missing")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b[A-Z]{2,}_[A-Z0-9_]+\b/);
    expect(minMock.unexpected).toEqual([]);
  });
});
