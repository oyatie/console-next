// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// oxlint-disable-next-line no-restricted-imports -- Pattern contract tests mount TanStack Router in memory.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
// oxlint-disable-next-line no-restricted-imports -- Refusal tests isolate QueryState without live queries.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// oxlint-disable-next-line no-restricted-imports -- Exercise PageReadGate with a 403/404/503 ApiError.
import { ApiError } from "@console/api";
import { expect } from "vitest";
import type { ReadState } from "../../lib/react/query-view";
import { PageMain } from "../page/page-main";
import { PagePhoneHeader } from "../page/page-scope";
import type { PatternHead } from "./pattern-shell";

export const readyRead: ReadState = { isPending: false, error: null, data: true, refetch() {} };

export const notFoundRead = (ref: string): ReadState => ({
  ...readyRead,
  error: new ApiError(404, "not_found", "", [], ref),
});

export const failedRead = (ref: string): ReadState => ({
  ...readyRead,
  data: undefined,
  error: new ApiError(503, "service_unavailable", "", [], ref),
});

export const mark = (name: string) => <bdi data-contract-region={name}>{name}</bdi>;

const actionLinkLabel = "Action link";

export const makeTabs = () => (
  <nav aria-label="Views">
    <a href="/review" aria-current="page">
      {mark("tabs")}
    </a>
  </nav>
);

export const makeHead = (titleId: string, extra?: { filters?: ReactNode; tools?: ReactNode }): PatternHead => ({
  title: mark("head"),
  titleId,
  asOf: mark("asOf"),
  actions: <a href="/review">{actionLinkLabel}</a>,
  primary: { id: "new", label: "New item", onAction() {} },
  commands: { label: "Commands", items: [{ id: "columns", label: "Columns", onAction() {} }] },
  ...extra,
});

export async function renderPatternMarkup(node: ReactNode) {
  const testRouter = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await testRouter.load();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

export async function assertPatternLifecycle({
  pattern,
  optionalRegions,
  render,
  placed,
  stripped,
  withheld,
  phoneHeadAware = false,
}: {
  pattern: string;
  optionalRegions: readonly string[];
  render: (q?: ReadState) => ReactNode;
  placed: readonly string[];
  stripped: readonly string[];
  withheld: readonly string[];
  phoneHeadAware?: boolean;
}) {
  expect(optionalRegions).toEqual(["facts"]);

  for (const shell of [false, true]) {
    const html = await renderPatternMarkup(shell ? <PageMain>{render()}</PageMain> : render());
    for (const name of placed) {
      expect(html.split(`data-contract-region="${name}"`), `${pattern} shell=${shell} region=${name}`).toHaveLength(2);
    }
    expect(html).not.toContain('data-contract-region="facts"');
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(`data-pattern="${pattern}"`);
  }

  if (phoneHeadAware) {
    const phoneHtml = await renderPatternMarkup(
      <PagePhoneHeader value={{ shellOwnsH1: true }}>
        <PageMain>{render()}</PageMain>
      </PagePhoneHeader>,
    );
    expect(phoneHtml.match(/<h1\b/g)).toBeNull();
    expect(phoneHtml.match(/<h2\b/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  }

  const refusedHtml = await renderPatternMarkup(
    render({ ...readyRead, error: new ApiError(403, "access_denied", "", [], `${pattern}-refused`) }),
  );
  expect(refusedHtml).toContain('data-contract-region="head"');
  expect(refusedHtml).toContain('data-contract-region="tabs"');
  expect(refusedHtml).toContain(`${pattern}-refused`);
  expect(refusedHtml).not.toContain("data-detail");
  for (const name of stripped) expect(refusedHtml).not.toContain(`data-contract-region="${name}"`);
  for (const label of ["New item", "Columns", "Action link"]) expect(refusedHtml).not.toContain(label);
  expect(refusedHtml.match(/<h1\b/g)).toHaveLength(1);

  for (const state of ["loading", "failed"] as const) {
    const html = await renderPatternMarkup(
      render(state === "failed" ? failedRead(`${pattern}-fail`) : { ...readyRead, isPending: true, data: undefined }),
    );
    expect(html).toContain('data-contract-region="tabs"');
    expect(html).toContain('data-contract-region="overlays"');
    expect(html).toContain(">New item</button>");
    for (const name of withheld) expect(html).not.toContain(`data-contract-region="${name}"`);
    if (state === "failed") expect(html).toContain(`${pattern}-fail`);
  }
}
