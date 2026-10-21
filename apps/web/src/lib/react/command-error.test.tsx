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

async function html(error: unknown, props: { children?: ReactNode; historyHref?: string; fieldLabel?: (field: string) => string | null | undefined; own?: (code: string) => string | undefined; live?: "polite" | "assertive"; recover?: boolean } = {}) {
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
  expect(banner).toContain(t("common.operationId"));
  expect(banner).toContain(operation);
});

const recordedAt = "2026-10-09T05:06:00Z";
const latest = { actor_name: "latest actor", actor_kind: "OPS_ACCOUNT" as const, recorded_at: recordedAt, fields: ["unit", "parent"], audit_id: "audit-line-id", redacted: false };

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
  expect(banner).not.toContain("<button");
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
