import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandError } from "./command-error";
import { useCommand } from "./command";

beforeAll(() => loadCatalog("ko"));

test.each(["org_change_sod_violation", "leave_decide_requester_forbidden", "sod_violation", "second_person_required"])("%s explains identity refusal and who can decide", async (code) => {
  const banner = await html(new ApiError(403, code, "internal diagnostic", [], undefined, true));
  expect(banner).toContain("다른 사람");
  expect(banner).toContain("같은 사람");
  expect(banner).not.toContain("internal diagnostic");
  expect(banner).toContain('role="alert"');
});

test.each(["org_change", "leave", "payroll", "period_unlock", "account_link", "governance"])("%s unbound identity refusal names the personnel-record fix", async (domain) => {
  const banner = await html(new ApiError(403, `${domain}.refuse.identity_unbound`, "diagnostic", [], undefined, true));
  expect(banner).toContain("인사카드");
  expect(banner).toContain("계정 관리 권한");
  expect(banner).not.toContain("diagnostic");
  expect(banner).toContain('role="alert"');
});

test("unavailable solo unlock names the second-person remedy", async () => {
  const banner = await html(new ApiError(409, "period_unlock_sole_holder_refused", "diagnostic", [], undefined, true));
  expect(banner).toContain("다른 마감 권한자");
  expect(banner).toContain("다시 신청");
  expect(banner).not.toContain("diagnostic");
});

async function html(error: unknown, props: { children?: ReactNode; historyHref?: string; fieldLabel?: (field: string) => string | null | undefined; own?: (code: string) => string | undefined; live?: "polite" | "assertive"; recover?: boolean; read?: boolean; onFocusField?: (field: string) => void; formId?: string; formFields?: string[] } = {}) {
  const root = createRootRoute({ component: () => <CommandError error={error} {...props} /> });
  const outcome = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const router = createRouter({ routeTree: root.addChildren([outcome]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const callerGuidance = "caller guidance";
const callerRemedy = "caller remedy";
const key = "actual-transport-intent-key";
const operation = "original-operation-id";

test.each([
  new ApiError(503, "walk_outage", "walk: simulated outage", [], operation, true, [], { supportRef: "read-support-reference" }),
  new ApiError(502, "http_502", "Bad Gateway", [], operation, false),
  new TypeError("walk: simulated outage"),
])("an unkeyed request failure is safe read copy, never command uncertainty: %s", async error => {
  const banner = await html(error);
  expect(banner).not.toContain(t("requestOutcome.checking"));
  expect(banner).not.toContain(t("requestOutcome.remedy"));
  expect(banner).not.toContain("walk: simulated outage");
  expect(banner).not.toContain("Bad Gateway");
  expect(banner).not.toContain("/requests/");
  expect(banner).toContain('role="alert"');
  if (error instanceof ApiError && error.supportRef) expect(banner).toContain(error.supportRef);
});

test("an explicitly marked read uses safe copy even when its error carries a key", async () => {
  const banner = await html(new ApiError(503, "walk_outage", "walk: simulated outage", [], operation, true, [], { requestKey: key }), { read: true });
  expect(banner).toContain(t("common.read.failedReason"));
  expect(banner).not.toContain("walk: simulated outage");
  expect(banner).not.toContain(t("requestOutcome.checking"));
  expect(banner).not.toContain("/requests/");
});

test("an unanswered gateway failure is announced as an alert while preserving the lookup remedy", async () => {
  const banner = await html(new ApiError(502, "http_502", "Bad Gateway", [], undefined, false, [], { requestKey: key }), { live: "assertive" });
  expect(banner).toContain('role="alert"');
  expect(banner).toContain(t("requestOutcome.remedy"));
  expect(banner).toContain(`href="/requests/${key}"`);
});

test.each([0, 503])("HTTP %s uncertainty names checking, its remedy and the actual transport link", async (status) => {
  const error = new ApiError(status, status === 0 ? "command_unknown" : "service_unavailable", "unavailable", [], undefined, true, [], { requestKey: key });
  const banner = await html(error, { children: <span>{callerGuidance}</span> });
  expect(banner).toContain(t("requestOutcome.checking"));
  expect(banner).toContain(t("requestOutcome.remedy"));
  expect(banner).toContain(`href="/requests/${key}"`);
  expect(banner).toContain(t("requestOutcome.open"));
  expect(banner).toContain("caller guidance");
  expect(banner).toContain('role="status"');
});

test.each(["command_processing", "command_applied"])("%s remains checking and uses operation ID before key", async (code) => {
  const banner = await html(new ApiError(409, code, "outcome", [], operation, true, [], { requestKey: key }));
  expect(banner).toContain(t("requestOutcome.checking"));
  expect(banner).toContain(t("requestOutcome.remedy"));
  expect(banner).toContain(`href="/requests/${operation}"`);
  expect(banner).not.toContain(`href="/requests/${key}"`);
  expect(banner).toContain(t("common.supportReference"));
  expect(banner).toContain(operation);
});

const recordedAt = "2026-10-09T05:06:00Z";
const latest = { actor_name: "latest actor", actor_kind: "OPS_ACCOUNT" as const, recorded_at: recordedAt, fields: ["unit", "parent"], audit_id: "audit-line-id", redacted: false };

test.each(["exit_protected_period", "exit_case_required", "invalid_transition"])("%s omits generic 409 last-change copy", async (code) => {
  const banner = await html(new ApiError(409, code, "refused", [], operation, true, [], { lastChange: { ...latest, redacted: true } }));
  expect(banner).not.toContain(t("requestOutcome.other"));
  expect(banner).not.toContain(t("requestOutcome.history"));
  expect(banner).toContain(operation);
});

test("409 preserves refusal and children, then names actor/time/fields/badge and history", async () => {
  const error = new ApiError(409, "stale_revision", "record changed", [], operation, true, [], { lastChange: latest });
  const banner = await html(error, { children: <span>{callerRemedy}</span>, historyHref: "/structure/history#audit-line-id", fieldLabel: field => ({ unit: "organization unit", parent: "parent organization" })[field as "unit" | "parent"] });
  expect(banner).toContain(t("common.failed.code.stale_revision"));
  expect(banner).toContain("caller remedy");
  expect(banner).toContain(t("requestOutcome.changed", { actor: latest.actor_name, at: fmtDateTime(recordedAt) }));
  expect(banner).toContain(t("requestOutcome.fields", { fields: "organization unit, parent organization" }));
  expect(banner).toContain(t("timeline.state.emergency"));
  expect(banner).toContain('href="/structure/history#audit-line-id"');
  expect(banner).toContain(t("requestOutcome.history"));
  expect(banner).toContain('role="alert"');
});

test("redaction hides hostile supplied name/time/fields/history and shows other-user copy", async () => {
  const error = new ApiError(409, "stale_revision", "record changed", [], undefined, true, [], {
    lastChange: { ...latest, actor_name: "secret actor", recorded_at: "2001-01-02T01:23:00Z", fields: ["secret field"], redacted: true },
  });
  const banner = await html(error, { historyHref: "/structure/secret-history" });
  expect(banner).toContain(t("requestOutcome.other"));
  expect(banner).not.toContain("secret");
  expect(banner).not.toContain(fmtDateTime("2001-01-02T01:23:00Z"));
  expect(banner).not.toContain(t("requestOutcome.history"));
  expect(banner).not.toContain(t("timeline.state.emergency"));
});

test.each([
  [422, "invalid_request_key", "requestOutcome.invalid"],
  [404, "request_not_found", "requestOutcome.notFound"],
  [409, "idempotency_key_reused", "requestOutcome.terminal"],
  [409, "command_settled", "requestOutcome.terminal"],
  [409, "command_expired", "requestOutcome.terminal"],
] as const)("%s %s keeps the caller's localized refusal and remedy without another submission", async (status, code, message) => {
  const error = new ApiError(status, code, "server fallback", [], operation);
  const banner = await html(error, { own: (refusal) => refusal === code ? t(message) : undefined, children: <span>{t("requestOutcome.remedy")}</span> });
  expect(banner).toContain(t(message));
  expect(banner).toContain(t("requestOutcome.remedy"));
  expect(banner).not.toContain("server fallback");
  expect(banner).not.toContain(t("requestOutcome.checking"));
  expect(banner).toContain(`href="/requests/${operation}"`);
  expect(banner.match(/<button/g)).toHaveLength(1);
  expect(banner).toContain(t("common.supportReference.copy"));
});


test("receipt_used links the original successful operation instead of the refused attempt", async () => {
  const banner = await html(new ApiError(409, "receipt_used", "already applied", [], "refused-attempt", true, [], { originalOperationId: "original-success" }));
  expect(banner).toContain('href="/requests/original-success"');
  expect(banner).not.toContain('href="/requests/refused-attempt"');
});


test("409 uses the record's field labels and never exposes untranslated API identifiers", async () => {
  const error = new ApiError(409, "stale_revision", "record changed", [], undefined, true, [], {
    lastChange: { ...latest, fields: ["main_phone", "internal_untranslated_field"] },
  });
  const label = (field: string) => field === "main_phone" ? t("entity.history.field.main_phone") : undefined;
  const banner = await html(error, { fieldLabel: label });
  expect(banner).toContain(t("entity.history.field.main_phone"));
  expect(banner).not.toContain("main_phone");
  expect(banner).not.toContain("internal_untranslated_field");
  expect(banner).toContain(t("requestOutcome.fieldsOther", { count: 1 }));
});

// Regression (CL-dev-reds, chaos-setup): a screen with no check of its own left an uncertain save behind a disabled
// button. The shared refusal offers the command's recovery in place, unless the screen offers it itself.
test("an uncertain command failure offers its recovery in place; a refusal and an opted-out screen do not", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let command!: ReturnType<typeof useCommand<string, string>>;
  function Probe({ collect }: { collect: (value: ReturnType<typeof useCommand<string, string>>) => void }) {
    collect(useCommand<string, string>({ run: () => Promise.reject(new TypeError("Failed to fetch")) }));
    return null;
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe collect={(value) => { command = value; }} /></QueryClientProvider>);
  const failure: unknown = await command.mutateAsync("original").catch((e: unknown) => e);
  expect(await html(failure)).toContain(t("requestOutcome.check"));
  expect(await html(failure, { recover: false })).not.toContain(t("requestOutcome.check"));
  expect(await html(new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: key }))).not.toContain(t("requestOutcome.check"));
  expect(await html(new ApiError(422, "validation", "bad"))).not.toContain(t("requestOutcome.check"));
  client.clear();
});

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



test("a non-stale 409 never displays supplied last-change facts", async () => {
  const error = new ApiError(409, "idempotency_key_reused", "already used", [], operation, true, [], { lastChange: latest });
  const markup = await html(error);
  expect(markup).not.toContain(latest.actor_name);
  expect(markup).not.toContain(t("requestOutcome.changed", { actor: latest.actor_name, at: fmtDateTime(recordedAt) }));
});

// A refusal has one quotable identifier; the outcome link remains an action.
test.each([false, true])("one support identifier (server reference: %s)", async supported => {
  const reference = "abcdef0123456789";
  const error = new ApiError(409, "invalid_transition", "diagnostic", [], operation, true, [], {
    requestKey: key, ...(supported ? { supportRef: reference, supportRefAt: "2026-10-22T04:50:18.769Z" } : {}),
  });
  const markup = await html(error);
  expect(markup.match(/<data /g)).toHaveLength(1);
  expect(markup).toContain(`data-support-reference="${supported ? reference : operation}"`);
  expect(markup).not.toContain("문의 번호");
  expect(markup).toContain(`href="/requests/${operation}"`);
  if (!supported) expect(markup).toContain(`>${operation}</code>`);
  if (supported) {
    expect(markup).toContain("KST</time>");
    expect(markup.match(/<time[^>]*>([^<]+)<\/time>/)?.[1]).not.toMatch(/UTC|\dT\d/);
    expect(markup).not.toContain(`>${operation}<`);
  }
});

test("field validation uses the same single support identifier", async () => {
  const markup = await html(new ApiError(422, "validation", "diagnostic", [], operation, true, [], {
    supportRef: "validation-support", errors: [{ field: "name", code: "required" }],
  }));
  expect(markup).toContain('data-support-reference="validation-support"');
  expect(markup).not.toContain(`>${operation}<`);
});

test("failed passkey verification cannot offer a command outcome", async () => {
  const markup = await html(new ApiError(401, "passkey_step_up_failed", "diagnostic", [], operation, true, [], { requestKey: key }), {
    own: code => code === "passkey_step_up_failed" ? t("empCard.reveal.error.passkey_step_up_failed") : undefined,
  });
  expect(markup).toContain("본인 확인에 실패해 표시하지 않았습니다.");
  expect(markup).not.toContain(t("requestOutcome.open"));
  expect(markup).not.toContain("/requests/");
});
