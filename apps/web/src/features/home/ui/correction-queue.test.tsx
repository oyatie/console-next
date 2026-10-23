// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { IdentifierCorrectionCase } from "../../../reference/entity/api";
import { CorrectionQueue } from "./correction-queue";

beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });

test.each(["ko", "en"] as const)("%s Home links each kind of correction work to its case, with the review deadline", async (locale) => {
  i18n.set(locale);
  const rows: IdentifierCorrectionCase[] = (["PENDING", "APPROVED", "RECORDED"] as const).map((status) => ({
    id: status, entity_id: "entity", entity_name: "검토할 법인", subject_id: "entity", subject_type: "LEGAL_ENTITY", requested_by: "requester", status,
    proposal: null, reviewed_at: null, consumed_at: null,
    can_decide: status === "PENDING", can_apply: status === "APPROVED", can_review: status === "RECORDED",
    payload_hash: "a".repeat(64), created_at: "2026-10-23T00:00:00Z", expires_at: "2026-11-01T00:00:00Z",
    review_due_at: status === "RECORDED" ? "2026-10-25T16:00:00Z" : null,
  }));
  const root = createRootRoute({ component: () => <CorrectionQueue items={rows} more today="2026-10-23" /> });
  const entities = createRoute({ getParentRoute: () => root, path: "/org/entities" });
  const router = createRouter({ routeTree: root.addChildren([entities]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  for (const status of ["PENDING", "APPROVED", "RECORDED"]) expect(html).toContain(`/org/entities?correction=${status}#identifier-corrections`);
  expect(html).toContain('dateTime="2026-10-25T16:00:00Z"');
  expect(html).toContain("D-3");
  for (const text of locale === "ko" ? ["정정 요청 검토", "승인된 정정 적용", "사후 검토 기록", "모든 정정 요청 보기"] : ["Review correction request", "Apply approved correction", "Record post-review", "All correction requests"]) expect(html).toContain(text);
});
