// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { CardPrint } from "./card-print";
import type { Card } from "./use-card";
vi.mock("./print-paper", () => ({ PrintPaper: () => null }));
beforeAll(() => loadCatalog("ko"));
test("masked print has no reveal mode or purpose gate", () => {
  const html = renderToStaticMarkup(<CardPrint c={{ e: { name: "한기록" } } as Card} onClose={() => {}} />);
  expect(html).not.toContain("print-why");
  expect(html).not.toContain("print-mode");
  expect(html).not.toContain("aria-disabled");
});
