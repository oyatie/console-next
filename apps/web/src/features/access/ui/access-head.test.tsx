// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { AccessHead } from "./access-head";

const state = vi.hoisted(() => ({ failed: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [1, 2, 3], account_id: "ops" }, error: state.failed ? new Error("outage") : null }) }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/access/roles",
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
beforeAll(() => loadCatalog("ko"));
test.each([false, true])("header hides writes and counts after a failed read (%s)", failed => {
  state.failed = failed;
  const html = renderToStaticMarkup(<AccessHead actions="write" />);
  expect(html.includes("write")).toBe(!failed);
  expect(html.includes(">3<")).toBe(!failed);
});
test("navigation names the served review and emergency account screens", () => {
  state.failed = false;
  const html = renderToStaticMarkup(<AccessHead />);
  for (const label of ["역할", "부여 현황", "권한 검토", "비상 관리자 계정"]) expect(html).toContain(label);
  expect(html).not.toContain("운영 시작 준비");
});
