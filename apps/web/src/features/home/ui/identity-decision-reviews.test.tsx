// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { IdentityDecisionReviews } from "./identity-decision-reviews";

test("HR sees the account basis, the review remedy, named accounts and paging", async () => {
  await loadCatalog("ko");
  const account = { id: "account-id", display_name: "김검토" } as components["schemas"]["UserSummary"];
  const root = createRootRoute({ component: () => <IdentityDecisionReviews page={{ items: [account], total: 2, limit: 1, offset: 0 }} onPage={() => {}} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain("계정 기준 결재 확인 2명");
  expect(html).toContain("실제로 다른 사람이 결정했는지 확인");
  expect(html).toContain("감사 기록");
  expect(html).toContain("김검토 계정 연결 검토");
  expect(html).toContain("view=accounts");
  expect(html).toContain("sel=account-id");
  expect(html).toContain('aria-label="페이지 이동"');
});
