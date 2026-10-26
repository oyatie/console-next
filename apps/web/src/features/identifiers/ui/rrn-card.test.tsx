// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { RrnCard } from "./rrn-card";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { recorded: false }, isPending: false, isError: false }),
}));
beforeAll(() => loadCatalog("ko"));

test("identifiers reports no recorded number without offering the unserved record command", () => {
  const html = renderToStaticMarkup(<RrnCard employeeId="person" who="한기록" />);
  expect(html).toContain(t("empCard.rrn.none"));
  expect(html).not.toContain(">기록</button>");
});
