// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- Preserve tab links and their current marker in the router mock.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { AccessHead } from "./access-head";
import { opsQuery } from "../api";

const state = vi.hoisted(() => ({ failed: false, path: "/access/roles", ops: "loaded", phase: "SETUP" as "SETUP" | "OPERATING" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (query: unknown) => {
  if (query === opsQuery) return {
    isPending: ["loading", "retrying"].includes(state.ops),
    failureCount: state.ops === "loading" || state.ops === "loaded" ? 0 : 1,
    data: ["loading", "retrying", "first-failed", "first-refused"].includes(state.ops) ? undefined : { account_id: "ops" },
    error: ["failed", "refused", "first-failed", "first-refused"].includes(state.ops) ? new Error(state.ops) : null,
  };
  return { data: { phase: state.phase, items: [1, 2, 3] }, error: state.failed ? new Error("outage") : null };
} }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => state.path,
  Link: ({ children, to, "aria-current": current }: { children: ReactNode; to: string; "aria-current"?: "page" }) => <a href={to} aria-current={current}>{children}</a>,
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.failed = false; state.path = "/access/roles"; state.ops = "loaded"; state.phase = "SETUP"; });
test.each([false, true])("header hides writes, phase and counts after a failed read (%s)", failed => {
  state.failed = failed;
  const html = renderToStaticMarkup(<AccessHead actions="write" />);
  expect(html.includes("write")).toBe(!failed);
  expect(html.includes(">3<")).toBe(!failed);
  expect(html.includes(t("access.phase.setup"))).toBe(!failed);
});

test("header hides writes and counts when the owning page reports a failed read", () => {
  const html = renderToStaticMarkup(<AccessHead actions="write" {...({ failed: true } as object)} />);
  expect(html).not.toContain("write");
  expect(html).not.toContain(">3<");
});
test("navigation distinguishes go-live checks in SETUP from access review in OPERATING", () => {
  state.failed = false;
  state.phase = "SETUP";
  const setupHtml = renderToStaticMarkup(<AccessHead />);
  for (const label of [t("access.nav.roles"), t("access.nav.grants"), t("access.nav.ready"), t("access.nav.ops")]) expect(setupHtml).toContain(label);
  expect(setupHtml).not.toContain(t("access.nav.review"));
  expect(setupHtml).toContain('href="/access/ready"');
  expect(setupHtml).not.toContain('href="/access/review"');

  state.phase = "OPERATING";
  const operatingHtml = renderToStaticMarkup(<AccessHead />);
  expect(operatingHtml).toContain(t("access.nav.review"));
  expect(operatingHtml).not.toContain(t("access.nav.ready"));
  expect(operatingHtml).toContain('href="/access/review"');
  expect(operatingHtml).not.toContain('href="/access/ready"');
});

test.each(["loading", "retrying", "failed", "refused", "first-failed", "first-refused"])("ops tab is absent when its read is %s, including stale data", status => {
  state.ops = status;
  expect(renderToStaticMarkup(<AccessHead />)).not.toContain("비상 관리자 계정");
});

test.each(["loading", "loaded", "failed", "refused"])("grants tab does not claim a known ops path while ops is %s", status => {
  state.path = "/access/people/ops";
  state.ops = status;
  expect(renderToStaticMarkup(<AccessHead />)).not.toMatch(/href="\/access\/grants" aria-current="page"/);
});

test.each(["loaded", "retrying", "failed", "refused", "first-failed", "first-refused"])("grants tab marks an ordinary person's access as current while ops is %s", status => {
  state.path = "/access/people/person";
  state.ops = status;
  expect(renderToStaticMarkup(<AccessHead />)).toMatch(/href="\/access\/grants" aria-current="page"/);
});

test("grants tab waits for the first ops answer on an ordinary person's access", () => {
  state.path = "/access/people/person";
  state.ops = "loading";
  expect(renderToStaticMarkup(<AccessHead />)).not.toMatch(/href="\/access\/grants" aria-current="page"/);
});
