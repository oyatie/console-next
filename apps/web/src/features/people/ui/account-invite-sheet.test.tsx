// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { InviteSheet } from "./account-invite-sheet";

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: (props: { children: ReactNode; actions: ReactNode }) => (
    <div data-testid="invite-sheet">{props.children}{props.actions}</div>
  ),
}));

beforeAll(() => loadCatalog("ko"));

test("primary commit is disabled (filled style, with DisabledReason) when nobody chosen", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <InviteSheet onClose={() => {}} onIssued={() => {}} onOpenAccount={() => {}} />
    </QueryClientProvider>,
  );
  expect(markup).toContain("패스키로 확인하고 계정 초대");
  expect(markup).toContain("초대할 직원을 선택하십시오");
  const match = markup.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*패스키로 확인하고 계정 초대[\s\S]*?<\/button>/);
  expect(match).not.toBeNull();
  const node = match![0];
  expect(node).toContain('aria-disabled="true"');
  expect(node).toContain("btn--primary");
  const descId = node.match(/aria-describedby="([^"]+)"/)![1];
  expect(markup).toContain(`id="${descId}">초대할 직원을 선택하십시오`);
});
