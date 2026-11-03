// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- The router mock preserves route links for this navigation contract.
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { AuditTabs } from "./audit-tabs";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

beforeAll(() => loadCatalog("ko"));

test("audit navigation exposes only the served support-access view", () => {
  const html = renderToStaticMarkup(<AuditTabs />);
  expect(html).not.toContain('href="/audit/access-log"');
  expect(html).not.toContain("접속기록 점검");
  expect(html).toContain('href="/audit/support-access"');
  expect(html).toContain("지원 접근");
});
