// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { ImportDryRun } from "../domain/contract";
import { initialPicks, withGroupAnswer } from "../domain/steps";
import { ReviewGroups } from "./review-groups";

beforeAll(() => loadCatalog("ko"));

const dry = (groups: unknown[]) => ({ review: { groups } }) as ImportDryRun;
const render = (d: ImportDryRun, picks = initialPicks()) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ReviewGroups dry={d} picks={picks} busy={false} onResolve={() => undefined} /></QueryClientProvider>);

// regression: a file whose dates carry two-digit years could only have its rows left out.
test("a file of two-digit years offers one answer that says how the dates will read", () => {
  const html = render(dry([{ key: "two_digit_year:hire_date", reason: "two_digit_year", field: "hire_date", rows: 16, blocking: true }]));
  expect(html).toContain("연도가 두 자리입니다");
  expect(html).toContain("연.월.일 순서로 읽기 · 24.03.04는 2024년 3월 4일 (16행)");
});

test("the answer given stays on screen with the way to take it back", () => {
  const html = render(dry([]), withGroupAnswer(initialPicks(), "two_digit_year", "recent"));
  expect(html).toContain("연도가 두 자리인 날짜: 연.월.일 순서로 읽음");
  expect(html).toContain("이 답 되돌리기");
});
