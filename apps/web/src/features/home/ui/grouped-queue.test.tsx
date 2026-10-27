// SPDX-License-Identifier: LicenseRef-Proprietary

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { GroupedQueue } from "./grouped-queue";

beforeAll(() => loadCatalog("ko"));
type Item = components["schemas"]["ActionInboxItem"];
const item = (id: string, extra: Partial<Item> & { fold_key?: string } = {}): Item => ({ id, kind: "register_review", lane: "turn", title: id, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "employee", id }], ...extra });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const html = (items: Item[]) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterContextProvider router={router}><GroupedQueue items={items} /></RouterContextProvider></QueryClientProvider>);

test("deadline groups put the D-day exit before undated reviews in the server item set", () => {
  const items = [
    item("undated review"),
    item("later", { due: "2026-11-01T00:00:00Z", days_remaining: 9 }),
    item("D-day exit", { kind: "hr_exit_confirm", due: "2026-10-23T00:00:00Z", days_remaining: 0, dueTone: "danger", links: [{ kind: "exit_case", id: "exit" }] }),
    item("overdue", { due: "2026-10-22T00:00:00Z", days_remaining: -1 }),
  ];
  const markup = html(items);
  for (const [before, after] of [["overdue", "D-day exit"], ["D-day exit", "later"], ["later", "undated review"]])
    expect(markup.indexOf(before!)).toBeLessThan(markup.indexOf(after!));
  for (const heading of ["기한 지남", "기한 임박", "그 뒤", "기한 없음"])
    expect(markup).toContain(`>${heading}</h3>`);
  expect(markup.match(/<table\b/g)).toHaveLength(4);
  for (const heading of ["할 일", "대상", "기한", "출처", "담당"])
    expect(markup).toContain(`>${heading}</th>`);
});

test("one subject node per item, and only registered record actions get a menu", () => {
  const markup = html([
    item("한 번만 표시"), item("링크 없음", { links: [] }),
    item("미지원 링크", { links: [{ kind: "approval_run", id: "unregistered" }] }),
    item("잘못된 등록 링크", { links: [{ kind: "registration_check", id: "missing-registration-id" }] }),
  ]);
  expect(markup.match(/>한 번만 표시</g)).toHaveLength(1);
  for (const title of ["링크 없음", "미지원 링크", "잘못된 등록 링크"])
    expect(markup).not.toContain(`aria-label="${title} 작업"`);
});

test("each deadline group ranks source dates before server insertion order", () => {
  const markup = html([
    item("undated first"),
    item("due in three days", { due: "2026-10-29T00:00:00Z", days_remaining: 3, dueTone: "warn" }),
    item("later overdue", { due: "2026-10-25T00:00:00Z", days_remaining: -1, dueTone: "danger" }),
    item("D-day exit", { kind: "hr_exit_confirm", due: "2026-10-26T09:00:00+09:00", days_remaining: 0, dueTone: "danger" }),
    item("earlier overdue", { due: "2026-10-24T00:00:00Z", days_remaining: -2, dueTone: "danger" }),
    item("earlier today", { due: "2026-10-25T23:00:00Z", days_remaining: 0, dueTone: "danger" }),
  ]);
  const ordered = ["earlier overdue", "later overdue", "earlier today", "D-day exit", "due in three days", "undated first"];
  const positions = ordered.map(id => markup.indexOf(`data-id="${id}"`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("every record action is quiet rather than a primary row action", () => {
  const items = [
    item("register"),
    item("exit", { kind: "hr_exit_confirm", links: [{ kind: "exit_case", id: "exit" }] }),
    item("draft", { kind: "org_change_draft", links: [{ kind: "org_change", id: "draft" }] }),
    item("grant", { kind: "grant_notice", links: [{ kind: "access", id: "grant" }] }),
  ];
  expect(html(items)).not.toContain("btn--primary");
  expect(html(items)).not.toContain("담당 정보 없음");
});

test("only server fold identities combine rows, keeping deadline and kind boundaries", () => {
  const items = [
    item("first filing", { kind: "insurance_filing", fold_key: "insurance:person:case" }),
    item("second filing", { kind: "insurance_filing", fold_key: "insurance:person:case" }),
    item("person-a", { title: "같은 이름", fold_key: "person:a" }), item("person-b", { title: "같은 이름", fold_key: "person:b" }),
    item("another deadline", { kind: "insurance_filing", fold_key: "insurance:person:case", due: "2026-10-26T00:00:00Z", days_remaining: 0 }),
  ];
  const markup = html(items);
  expect(markup.match(/<tr data-id=/g)).toHaveLength(4);
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("4대보험 신고 · 2건");
  expect(markup).not.toContain("second filing");
});
