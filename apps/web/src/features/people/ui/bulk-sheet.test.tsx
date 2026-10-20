import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { BulkSheet } from "./bulk-sheet";
import { rosterPageQuery } from "../api";
import { unitsQuery } from "../../../reference/org/api";

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => (
    <div data-sheet="bulk">{children}{actions}</div>
  ),
}));

beforeAll(() => loadCatalog("ko"));

test.each([0, 1])("primary commit is disabled (filled style, with DisabledReason) with %i targets and required fields empty", async (count) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await Promise.all([
    qc.prefetchQuery({ ...rosterPageQuery(0), queryFn: async () => ({
      items: [{ id: "test-person", name: "가상직원", employee_number: "TEST-1", status: "ACTIVE" }], total: 1,
    }) }),
    qc.prefetchQuery({ ...unitsQuery, queryFn: async () => ({ items: [] }) }),
  ]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <BulkSheet source={count === 0 ? { paste: "" } : { picked: new Map([["test-person", "가상직원"]]) }} onClose={() => {}} onDone={() => {}} />
    </QueryClientProvider>,
  );
  const m = html.match(new RegExp(`<button[^>]*>${count}명 발령</button>`));
  expect(m).not.toBeNull();
  const btn = m![0];
  expect(btn).toContain('aria-disabled="true"');
  expect(btn).toContain("btn--primary");
  const id = btn.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  expect(html).toContain(`id="${id}"`);
});
