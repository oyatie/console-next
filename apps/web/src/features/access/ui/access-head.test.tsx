// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- Preserve tab links and their current marker in the router mock.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { AccessHead } from "./access-head";
import { opsQuery } from "../api";

const state = vi.hoisted(() => ({ failed: false, path: "/access/roles", ops: "loaded" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (query: unknown) => {
  if (query === opsQuery) return {
    data: state.ops === "loading" ? undefined : { account_id: "ops" },
    error: ["failed", "refused"].includes(state.ops) ? new Error(state.ops) : null,
  };
  return { data: { items: [1, 2, 3] }, error: state.failed ? new Error("outage") : null };
} }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => state.path,
  Link: ({ children, to, "aria-current": current }: { children: ReactNode; to: string; "aria-current"?: "page" }) => <a href={to} aria-current={current}>{children}</a>,
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.failed = false; state.path = "/access/roles"; state.ops = "loaded"; });
test.each([false, true])("header hides writes and counts after a failed read (%s)", failed => {
  state.failed = failed;
  const html = renderToStaticMarkup(<AccessHead actions="write" />);
  expect(html.includes("write")).toBe(!failed);
  expect(html.includes(">3<")).toBe(!failed);
});
test("navigation distinguishes go-live checks from the planned access review", () => {
  state.failed = false;
  const html = renderToStaticMarkup(<AccessHead />);
  for (const label of ["역할", "부여 현황", "운영 시작 준비", "비상 관리자 계정"]) expect(html).toContain(label);
  expect(html).not.toContain("권한 검토");
});

test.each(["loading", "failed", "refused"])("ops tab is absent when its read is %s, including stale data", status => {
  state.ops = status;
  expect(renderToStaticMarkup(<AccessHead />)).not.toContain("비상 관리자 계정");
});

test.each(["loading", "loaded"])("grants tab does not claim the ops path while ops is %s", status => {
  state.path = "/access/people/ops";
  state.ops = status;
  expect(renderToStaticMarkup(<AccessHead />)).not.toMatch(/href="\/access\/grants" aria-current="page"/);
});

test("grants tab marks an ordinary person's access as current", () => {
  state.path = "/access/people/person";
  expect(renderToStaticMarkup(<AccessHead />)).toMatch(/href="\/access\/grants" aria-current="page"/);
});
