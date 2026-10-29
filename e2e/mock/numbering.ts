// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { NumberingState } from "../states/numbering";
import { checklist, failure, id } from "./fixtures";
import { mockRoute } from "./route";

/** Numbering-only fixtures layered over the populated shell; unknown phase never inherits its answer. */
export async function numberingReads(page: Page, state: NumberingState) {
  const waiting = Promise.withResolvers<void>();
  let recovered = false;
  let phaseReads = 0;
  const phase: typeof checklist.phase = state === "setup" ? "SETUP" : "OPERATING";
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    phaseReads++;
    if (state === "phase-loading") await waiting.promise;
    return { status: 200, json: { ...checklist, phase, go_live_at: phase === "SETUP" ? null : checklist.go_live_at } };
  });
  // 500 is outside the generated checklist response union.
  if (state === "phase-500") await page.route("**/api/v1/onboarding/checklist", route => {
    if (recovered) return route.fallback();
    phaseReads++;
    return route.fulfill({ status: 500, json: failure("internal") });
  });
  await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/reason-codes", { status: 200, json: { domain: "employee_number_change", items: [
    { code: "NUMBERING_SCHEME_CHANGE", system: true, active: true, requires_note: false, involuntary: false, notice_required: false, label_ko: null, label_en: null },
  ] } });
  const writes: string[] = [];
  await mockRoute(page, "post", "/api/v1/employees/renumber/preview", req => {
    writes.push(req.url());
    return { status: 200, json: { preview_digest: "numbering-preview", conflicts: 0, lines: [{ employee_id: id(100), from: "OLD-1", to: "HG-0001" }] } };
  });
  await mockRoute(page, "post", "/api/v1/employees/renumber/apply", req => {
    writes.push(req.url());
    return { status: 200, json: { batch_id: id(200), changed: 1 } };
  });
  await mockRoute(page, "post", "/api/v1/employees/renumber/{batch_id}/undo", req => {
    writes.push(req.url());
    return { status: 200, json: { batch_id: id(200), changed: 1 } };
  });
  return { writes, phaseReads: () => phaseReads, recover: () => { recovered = true; }, releasePhase: () => waiting.resolve() };
}
