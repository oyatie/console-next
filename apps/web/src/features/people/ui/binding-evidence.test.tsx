// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { BindingEvidence, BindingReviewChip } from "./binding-evidence";
const state = vi.hoisted(() => ({ q: { data: undefined as unknown, error: null as unknown, isPending: false, refetch: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.q }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, params, children }: { to: string; params: { id: string }; children: ReactNode }) => <span data-to={to} data-record={params.id}>{children}</span> }));
vi.mock("../../../lib/react/denied", () => ({ Denied: () => <div data-denied /> }));
let forbidden: unknown;
beforeAll(async () => {
  await loadCatalog("ko");
  const { ApiError } = await vi.importActual<typeof import("@console/api")>("@console/api");
  forbidden = new ApiError(403, "forbidden", "Forbidden");
});
beforeEach(() => { state.q = { data: { items: [], total: 0 }, error: null, isPending: false, refetch: vi.fn() }; });
const candidate = (id: string) => ({ employee_id: id, name: `Person ${id}`, employee_number: `E-${id}`, birth_date: "1990-03-04" });
const review = (kind: string) => ({ subject_kind: kind, evidence: { candidates: [candidate("self"),candidate("other")] } });
test.each(["EMPLOYEE", "ACCOUNT"])("%s evidence names and links only the other record, without duplicate candidates", (kind) => {
  state.q.data = { items: [review(kind),review(kind)], total: 2 };
  const html = renderToStaticMarkup(<BindingEvidence subjectId="subject" employeeId="self" />);
  expect(html).toContain('data-record="other"');
  expect(html).toContain("Person other"); expect(html).toContain("E-other");
  expect(html).toContain('dateTime="1990-03-04"');
  expect(html).not.toContain('data-record="self"');
  expect(html.match(/data-record=/g)).toHaveLength(1);
});
test("account evidence links employee candidates; empty evidence draws no heading", () => {
  expect(renderToStaticMarkup(<BindingEvidence subjectId="account" />)).toBe("");
  state.q.data = { items: [review("ACCOUNT")], total: 1 };
  expect(renderToStaticMarkup(<BindingEvidence subjectId="account" />)).toContain('data-record="self"');
});
test("pending, failed and forbidden evidence use the shared state component", () => {
  state.q.data = undefined; state.q.isPending = true;
  expect(renderToStaticMarkup(<BindingEvidence subjectId="subject" />)).toContain(t("common.loading"));
  state.q.isPending = false; state.q.error = new Error("offline");
  expect(renderToStaticMarkup(<BindingEvidence subjectId="subject" />)).toContain(t("common.loadFailed.title"));
  state.q.error = forbidden;
  expect(renderToStaticMarkup(<BindingEvidence subjectId="subject" />)).toContain("data-denied");
});
test("an open review surfaces the action even when the legacy identity flag is false", () => {
  expect(renderToStaticMarkup(<BindingReviewChip subjectId="subject" onOpen={vi.fn()} />)).toBe("");
  state.q.data = { items: [review("EMPLOYEE")], total: 1 };
  const html = renderToStaticMarkup(<BindingReviewChip subjectId="subject" required={false} onOpen={vi.fn()} />);
  expect(html).toContain(t("people.identityReview")); expect(html).toContain(t("person.identity"));
  state.q.data = { items: [], total: 0 };
  expect(renderToStaticMarkup(<BindingReviewChip subjectId="subject" required onOpen={vi.fn()} />)).toContain(t("person.identity"));
});
