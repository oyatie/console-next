// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { AttendanceHead } from "./attendance-head";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search, ...props }: { children: ReactNode; search: { tab: string } | ((previous: object) => { tab: string }) }) => <span {...props} data-href={`?tab=${(typeof search === "function" ? search({}) : search).tab}`}>{children}</span>,
}));
beforeAll(() => loadCatalog("ko"));

const tabs = ["day", "month", "week", "overtime", "schedule", "issues", "close"] as const;
test.each(tabs)("T6 order and current URL view: %s", tab => {
  const html = renderToStaticMarkup(<AttendanceHead tab={tab} />);
  const links = [...html.matchAll(/<span\b([^>]*data-href="[^"]+"[^>]*)>(.*?)<\/span>/g)];
  expect(links.map(link => link[2])).toEqual(["오늘", "근태 기록", "주간", "연장근로", "근무 일정", "확인 필요", "월 마감"]);
  expect(links.map(link => link[1]!.match(/data-href="([^"]+)"/)![1])).toEqual(tabs.map(id => `?tab=${id}`));
  expect(links.filter(link => link[1]!.includes('aria-current="page"')).map(link => link[2])).toEqual([links[tabs.indexOf(tab)]![2]]);
  expect(html).not.toContain(">휴가<");
});
