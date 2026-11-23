// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- The router mock preserves route links for this navigation contract.
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { AuditTabs } from "./audit-tabs";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

beforeAll(() => loadCatalog("ko"));

test("audit navigation exposes audit log, access log review, and support-access views", () => {
  const html = renderToStaticMarkup(<AuditTabs />);
  expect(html).toContain('href="/audit"');
  expect(html).toContain(t("audit.nav.log"));
  expect(html).toContain('href="/audit/access-log"');
  expect(html).toContain("접속기록 점검");
  expect(html).toContain('href="/audit/support-access"');
  expect(html).toContain("지원 접근");
});
