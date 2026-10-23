// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SupportQueue } from "./support-queue";

vi.mock("@console/i18n", async (original) => ({ ...await original<object>(), t: (key: string, params?: Record<string, unknown>) => params?.at ? `${key} ${params.at}` : key }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, search }: { children: ReactNode; to: string; search: { review: string } }) => <span data-to={to} data-review={search.review}>{children}</span> }));

test("the Home queue names the pending request and expiry and deep-links to that request", () => {
  const request = { id: "session-a", ticket_ref: "HELP-123", operator_label: "운영자 · 공급사", reason: "조회 오류 조사", request_expires_at: "2026-10-23T12:00:00Z" };
  const html = renderToStaticMarkup(<SupportQueue requests={[request]} />);
  for (const text of [request.ticket_ref, request.operator_label, request.reason, "supportAccess.requestDeadline", "KST", "/audit/support-access", 'data-review="session-a"']) expect(html).toContain(text);
});
