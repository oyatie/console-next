import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { BulkSheet } from "./bulk-sheet";

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => (
    <div data-sheet="bulk">{children}{actions}</div>
  ),
}));

beforeAll(() => loadCatalog("ko"));

test("primary commit is disabled (filled style, with DisabledReason) when 0 targets: 0명 발령", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <BulkSheet source={{ paste: "" }} onClose={() => {}} onDone={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("0명 발령");
  const m = html.match(/<button[^>]*>[^<]*0명 발령[^<]*<\/button>/);
  expect(m).not.toBeNull();
  const btn = m![0];
  expect(btn).toContain('aria-disabled="true"');
  expect(btn).toContain("btn--primary");
  const id = btn.match(/aria-describedby="([^"]+)"/)![1];
  expect(html).toContain(`id="${id}"`);
});
