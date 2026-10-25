// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { PeopleRoute } from "./people-route";

const state = vi.hoisted(() => ({ pending: false, failed: false, allowed: false, sheet: true }));
vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useChildMatches: () => state.sheet ? [{}] : [],
  Outlet: () => state.sheet ? <section aria-label="Registration form" /> : null,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  isPending: state.pending, isSuccess: !state.pending && !state.failed, isError: state.failed,
  error: state.failed ? new TypeError("offline") : null, refetch: vi.fn(),
  data: state.pending || state.failed ? undefined : { is_ops: false, entries: state.allowed ? [{ domain: "hr_basic", level: "edit", enforcement: "ENFORCED", scope: { kind: "TENANT" } }] : [] },
}) }));
vi.mock("../../../lib/react/denied", () => ({ Denied: () => <section aria-label="Access refused" /> }));
vi.mock("../People", () => ({ People: () => <section aria-label="Roster" /> }));
vi.mock("./register-toast", () => ({ RegisterToast: () => null }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.pending = false; state.failed = false; state.allowed = false; state.sheet = true; });

test("a registration refusal replaces both the sheet and the roster", () => {
  const html = renderToStaticMarkup(<PeopleRoute />);
  expect(html).toContain('aria-label="Access refused"');
  expect(html).not.toContain('aria-label="Registration form"');
  expect(html).not.toContain('aria-label="Roster"');
});

test("registration waits for authorization before presenting the form", () => {
  state.pending = true;
  const html = renderToStaticMarkup(<PeopleRoute />);
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('aria-label="Registration form"');
  expect(html).not.toContain('aria-label="Access refused"');
});

test("an unavailable grant read offers retry before presenting the form", () => {
  state.failed = true;
  const html = renderToStaticMarkup(<PeopleRoute />);
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain('aria-label="Registration form"');
});

test("a tenant edit grant permits both the roster and registration", () => {
  state.allowed = true;
  const html = renderToStaticMarkup(<PeopleRoute />);
  expect(html).toContain('aria-label="Registration form"');
  expect(html).toContain('aria-label="Roster"');
});

test("the roster alone does not require a registration grant", () => {
  state.sheet = false;
  expect(renderToStaticMarkup(<PeopleRoute />)).toContain('aria-label="Roster"');
});
