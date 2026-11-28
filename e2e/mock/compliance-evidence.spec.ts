// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { experienceState } from "../experience";
import { test } from "../locale-fixture";
import { screens } from "../states/registry";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

type S = components["schemas"];
const path = "/api/v1/compliance/evidence-bindings";
const read = "served_compliance_evidence", link = "served_compliance_evidence_link", accept = "served_compliance_evidence_accept";
const provenance = { created_by: id(3), updated_by: id(3), created_at: AT, updated_at: AT };
const binding: S["EvidenceBinding"] = { ...provenance, id: id(777), control_id: id(702), evidence_target_type: "external_document",
  evidence_target_id: "Synthetic training register", status: "PROPOSED", confidence: "HIGH", metadata: {}, valid_from: "2026-01-01",
  hash_sha256: "ab".repeat(32) };
async function mount(page: Page, locale: string, features: string[]) {
  const screen = await mockScreen(page, screens[0], "empty");
  await page.addInitScript(lang => localStorage.setItem("console.locale", lang), locale);
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities:
    features.map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false })) } });
  return screen;
}
for (const style of ["baseline", "console"] as const) for (const locale of ["ko", "en"] as const) test.describe(`${style} ${locale}`, () => {
  test.use({ storageState: experienceState(style), locale: locale === "ko" ? "ko-KR" : "en-US" });
  test("an evidence reviewer can inspect immutable provenance and accept once", async ({ page }) => {
    const screen = await mount(page, locale, [read, accept]);
    let current = binding;
    let decisions = 0;
    await mockRoute(page, "get", path, () => ({ status: 200, json: { items: [current], offset: 0, limit: 25, total: 1 } }));
    await mockRoute(page, "post", "/api/v1/compliance/evidence-bindings/{id}/accept", req => {
      expect(new URL(req.url()).pathname).toBe(path + "/" + binding.id + "/accept");
      expect(req.headers()["idempotency-key"]).toBeTruthy();
      decisions++; current = { ...binding, status: "ACCEPTED" };
      return { status: 200, json: current };
    });
    await page.goto("/compliance/evidence");
    await page.getByText(binding.evidence_target_id, { exact: true }).first().click();
    await expect(page.getByText(binding.hash_sha256!, { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: t("compliance.propose") })).toHaveCount(0);
    await page.getByRole("button", { name: t("compliance.accept"), exact: true }).click();
    await page.getByRole("button", { name: t("compliance.confirmAccept") }).click();
    await expect(page.getByText(t("compliance.accepted"), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("compliance.accept"), exact: true })).toHaveCount(0);
    expect(decisions).toBe(1); expect(screen.unexpected).toEqual([]);
  });
  test("a proposer selects a real control and sends its immutable evidence reference", async ({ page }) => {
    const screen = await mount(page, locale, [read, link]);
    await mockRoute(page, "get", "/api/v1/compliance/frameworks", { status: 200, json: { items: [
      { ...provenance, id: id(701), name: "Training", code: "FW", version_label: "1", framework_kind: "INTERNAL_CONTROL", status: "ACTIVE", metadata: {} },
    ], limit: 25, offset: 0, total: 1 } });
    await mockRoute(page, "get", "/api/v1/compliance/framework-controls", req => {
      expect(new URL(req.url()).searchParams.get("framework_id")).toBe(id(701));
      return { status: 200, json: { items: [{ ...provenance, id: id(702), framework_id: id(701), title: "Training review",
        objective: "Review training", control_key: "TRAINING", control_type: "DETECTIVE", status: "ACTIVE", evidence_requirements: [] } satisfies S["ComplianceControl"]],
        limit: 25, offset: 0, total: 1 } };
    });
    await mockRoute(page, "get", "/api/v1/compliance/obligations", { status: 200, json: { items: [], limit: 25, offset: 0, total: 0 } });
    await mockRoute(page, "post", path, req => {
      expect(req.postDataJSON()).toMatchObject({ control_id: id(702), evidence_target_type: "external_document",
        evidence_target_id: binding.evidence_target_id, obligation_id: null });
      expect(req.headers()["idempotency-key"]).toBeTruthy();
      return { status: 200, json: binding };
    });
    await page.goto("/compliance/evidence/new");
    await page.getByRole("combobox", { name: t("compliance.ref.framework") }).selectOption(id(701));
    await page.getByRole("combobox", { name: t("compliance.ref.control") }).selectOption(id(702));
    await page.getByRole("textbox", { name: t("compliance.targetId") }).fill(binding.evidence_target_id);
    await page.getByRole("button", { name: t("compliance.propose"), exact: true }).click();
    await expect(page.getByText(t("compliance.proposed"), { exact: true })).toBeVisible();
    expect(screen.unexpected).toEqual([]);
  });
});

test("evidence readers see empty answers and cannot act, while a refused read retains its reason", async ({ page }) => {
  await mount(page, "ko", [read]);
  await mockRoute(page, "get", path, { status: 200, json: { items: [], limit: 25, offset: 0, total: 0 } });
  await page.goto("/compliance/evidence");
  await expect(page.getByText(t("compliance.evidenceEmpty"), { exact: true })).toBeVisible();
  await page.goto("/compliance/evidence/new");
  await expect(page.getByRole("main").getByText(t("denied.capability.served_compliance_evidence_link"))).toBeVisible();
  await mockRoute(page, "get", path, { status: 403, json: failure("forbidden") });
  await page.goto("/compliance/evidence");
  await expect(page.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
});

test("held, failed and recovered evidence reads keep the worklist filter and its page", async ({ page }) => {
  await mount(page, "ko", [read]);
  const held = Promise.withResolvers<void>();
  let stage: "held" | "ready" = "held";
  await mockRoute(page, "get", path, async req => {
    const query = new URL(req.url()).searchParams;
    if (stage === "held") {
      await held.promise;
      return { status: 422, json: failure("validation") };
    }
    const offset = Number(query.get("offset"));
    return { status: 200, json: { items: [{ ...binding, evidence_target_id: offset ? "Second page" : binding.evidence_target_id }],
      limit: 25, total: 26, offset } };
  });
  const sent = page.waitForRequest(req => new URL(req.url()).pathname === path);
  try {
    await page.goto("/compliance/evidence");
    await sent;
    await expect(page.getByRole("main").locator('[aria-busy="true"]').first()).toBeVisible();
    held.resolve();
    const retry = page.getByRole("main").getByRole("button", { name: t("common.retry") }).first();
    await expect(retry).toBeVisible();
    stage = "ready"; await retry.click();
    await page.getByRole("button", { name: t("common.page.next"), exact: true }).click();
    await expect(page.getByText("Second page", { exact: true }).first()).toBeVisible();
    const filtered = page.waitForRequest(req => {
      const url = new URL(req.url());
      return url.pathname === path && url.searchParams.get("status") === "ACCEPTED" && url.searchParams.get("offset") === "0";
    });
    await page.getByRole("combobox", { name: t("compliance.status") }).selectOption("ACCEPTED");
    await filtered;
  } finally { held.resolve(); }
});
