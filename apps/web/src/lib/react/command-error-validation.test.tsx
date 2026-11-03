// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { CommandError } from "./command-error";

beforeAll(() => loadCatalog("ko"));

async function html(error: unknown, props: { children?: ReactNode; historyHref?: string; fieldLabel?: (field: string) => string | null | undefined; own?: (code: string) => string | undefined; live?: "polite" | "assertive"; recover?: boolean; read?: boolean; onFocusField?: (field: string) => void; formId?: string; formFields?: string[] } = {}) {
  const root = createRootRoute({ component: () => <CommandError error={error} {...props} /> });
  const outcome = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const router = createRouter({ routeTree: root.addChildren([outcome]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const callerRemedy = "caller remedy";
const operation = "original-operation-id";
const recordedAt = "2026-10-09T05:06:00Z";
const latest = { actor_name: "latest actor", actor_kind: "OPS_ACCOUNT" as const, recorded_at: recordedAt, fields: ["unit", "parent"], audit_id: "audit-line-id", redacted: false };

test("boundary validation refusal lists every named field and keeps the support reference", async () => {
  const error = new ApiError(422, "validation", "validation failed", [], operation, true, [], {
    errors: [
      { field: "workplace", code: "workplace_required" },
      { field: "manager_name", code: "name_too_long" },
    ],
  });
  const markup = await html(error, {
    fieldLabel: (f) => (f === "workplace" ? "사업장" : f === "manager_name" ? "담당자 이름" : undefined),
    formFields: ["workplace", "manager_name"],
    children: <span>{callerRemedy}</span>,
  });
  expect(markup).toContain('data-component="error-summary"');
  expect(markup).toContain('href="#workplace"');
  expect(markup).toContain("사업장");
  expect(markup).toContain('href="#manager_name"');
  expect(markup).toContain("담당자 이름");
  expect(markup).toContain(t("common.supportReference"));
  expect(markup).toContain(operation);
  expect(markup).toContain(`href="/requests/${operation}"`);
  expect(markup).toContain(callerRemedy);
});

test("an untrusted plain object cannot opt into the validation summary", async () => {
  const error = { code: "birth_date_invalid", field: "birth_date" };
  const markup = await html(error, {
    fieldLabel: (f) => (f === "birth_date" ? "생년월일" : undefined),
    formFields: ["birth_date"],
  });
  expect(markup).not.toContain('data-component="error-summary"');
  expect(markup).toContain(t("common.networkError"));
});

test.each(["org_change.refuse.not_drafter", "org_change.refuse.identity_unbound"] as const)("field refusal %s uses its canonical catalog reason", async (code) => {
  const error = new ApiError(422, "validation", "internal diagnostic", [], undefined, true, [], {
    errors: [{ field: "change", code }],
  });
  const markup = await html(error, { formFields: ["change"] });
  expect(markup).toContain(t(code));
  expect(markup).not.toContain(t("common.failed.code.validation"));
  expect(markup).not.toContain("internal diagnostic");
});

test("adversarial: validation refusal on server-only field shows in summary without a dead focus target", async () => {
  const error = new ApiError(422, "validation", "validation failed", [], undefined, true, [], {
    errors: [
      { field: "server_nonce", code: "nonce_expired" },
    ],
  });
  const markup = await html(error, {
    formFields: ["client_field_a", "client_field_b"],
  });
  expect(markup).toContain('data-component="error-summary"');
  expect(markup).not.toContain('href="#server_nonce"');
  expect(markup).not.toContain("nonce_expired");
  expect(markup).toContain(t("common.failed.code.validation"));
});

test("409 field details remain a Banner with change facts and support reference", async () => {
  const error = new ApiError(409, "stale_revision", "record changed", [], operation, true, [], {
    details: { field: "workplace" },
    lastChange: latest,
  });
  const markup = await html(error, { children: <span>{callerRemedy}</span> });
  expect(markup).not.toContain('data-component="error-summary"');
  expect(markup).toContain(t("requestOutcome.changed", { actor: latest.actor_name, at: fmtDateTime(recordedAt) }));
  expect(markup).toContain(t("common.supportReference"));
  expect(markup).toContain(operation);
  expect(markup).toContain(callerRemedy);
});

test("bulk refusals remain a Banner with their support reference", async () => {
  const error = new ApiError(422, "bulk_lifecycle_refused", "bulk refused", [], operation, true, [
    { employee_id: "employee-1", code: "period_locked", message: "locked" },
  ]);
  const markup = await html(error);
  expect(markup).not.toContain('data-component="error-summary"');
  expect(markup).toContain(t("common.supportReference"));
  expect(markup).toContain(operation);
});

test("503 field-shaped details remain a Banner with retry guidance", async () => {
  const error = new ApiError(503, "unavailable", "unavailable", [], operation, true, [], {
    errors: [{ field: "workplace", code: "workplace_unavailable" }],
    retryAfterMs: 2_000,
  });
  const markup = await html(error);
  expect(markup).not.toContain('data-component="error-summary"');
  expect(markup).toContain(t("common.failed.retryAfter", { seconds: "2" }));
  expect(markup).toContain(t("common.supportReference"));
  expect(markup).toContain(operation);
});

test("field validation uses the same single support identifier", async () => {
  const markup = await html(new ApiError(422, "validation", "diagnostic", [], operation, true, [], {
    supportRef: "validation-support", errors: [{ field: "name", code: "required" }],
  }));
  expect(markup).toContain('data-support-reference="validation-support"');
  expect(markup).not.toContain(`>${operation}<`);
});
