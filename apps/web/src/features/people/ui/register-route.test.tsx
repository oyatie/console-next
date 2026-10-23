// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import type { Composer } from "../../../ui/composer/composer";
import { RegisterRoute } from "./register-route";

const state = vi.hoisted(() => ({ pending: false, failed: false, allowed: false }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  isPending: state.pending, isSuccess: !state.pending && !state.failed,
  data: state.pending || state.failed ? undefined : { capabilities: state.allowed ? [{ feature: "employee_directory_manage", permission: "allow", org_wide: true }] : [] },
}) }));
vi.mock("../../../lib/react/denied", () => ({ Denied: () => <section aria-label="Access refused" /> }));
vi.mock("../../../ui/composer/composer", () => ({ Composer: (p: ComponentProps<typeof Composer>) => <div role="dialog" aria-label={p.title}>{p.loading ? <p role="status" /> : p.children}{p.recovery ?? <Button type="submit">{p.title}</Button>}</div> }));
vi.mock("./register-sheet", () => ({ RegisterSheet: () => <section aria-label="Registration form" /> }));
beforeAll(() => loadCatalog("ko"));

test("a registration refusal stays in the action dialog above the roster", () => {
  const html = renderToStaticMarkup(<RegisterRoute />);
  expect(html).toMatch(/role="dialog"[^>]*><section aria-label="Access refused"/);
  expect(html).not.toContain('aria-label="Registration form"');
  expect(html).not.toContain('type="submit"');
});

test("registration waits for authorization before presenting the form", () => {
  state.pending = true;
  try {
    const html = renderToStaticMarkup(<RegisterRoute />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-label="Registration form"');
    expect(html).not.toContain('aria-label="Access refused"');
    expect(html).not.toContain('type="submit"');
  } finally { state.pending = false; }
});

test.each(["granted", "unavailable"])("registration keeps the server-authorized form when the projection is %s", mode => {
  state.allowed = mode === "granted";
  state.failed = mode === "unavailable";
  try {
    expect(renderToStaticMarkup(<RegisterRoute />)).toContain('aria-label="Registration form"');
  } finally { state.allowed = false; state.failed = false; }
});
