// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { PatternSheet } from "./pattern-sheet";

vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ children }: { children: ReactNode }) => <>{children}</> }));
beforeAll(() => loadCatalog("ko"));

function renderSheet(open = true) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PatternSheet open={open} onClose={() => {}} onAdded={() => {}} /></QueryClientProvider>);
  client.clear();
  return html;
}

test("only served work regimes can be chosen", () => {
  const html = renderSheet();
  for (const kind of ["FLEXIBLE", "SELECTIVE", "DEEMED", "DISCRETIONARY"] as const) {
    expect(html).not.toContain(t(`attendancePatterns.kind.${kind}`));
  }
  for (const kind of ["WEEKLY", "STAGGERED", "ROTATION"] as const) {
    expect(html).toContain(t(`attendancePatterns.kind.${kind}`));
  }
  expect(html).not.toContain("파일럿 이후");
});

test("the closed pattern sheet offers no controls", () => {
  expect(renderSheet(false)).toBe("");
});
