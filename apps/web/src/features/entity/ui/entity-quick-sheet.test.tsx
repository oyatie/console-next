import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { EntityQuickSheet } from "./entity-quick-sheet";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span>,
}));

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => (
    <aside data-quick-sheet>{children}{actions}</aside>
  ),
}));

beforeAll(() => loadCatalog("ko"));

test("법인 등록 quick sheet primary commit is disabled (filled style, with DisabledReason) when required fields empty", () => {
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <EntityQuickSheet open={true} onClose={() => {}} onSaved={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("법인 등록");
  expect(html).toContain("사업자 구분, 이름, 대표자를 정하면 저장할 수 있습니다.");
  const button = html.match(/<button[^>]*>[^<]*법인 등록<\/button>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain("btn--primary");
  const reasonId = button.match(/aria-describedby="([^"]+)"/)![1];
  expect(html).toContain(`id="${reasonId}"`);
});
