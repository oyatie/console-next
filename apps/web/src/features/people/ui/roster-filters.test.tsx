// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { REVIEWS, reviewTotals, statusTotals } from "../domain/roster";
import { RosterFilters } from "./roster-filters";

vi.mock("./roster-scope", () => ({ RosterScope: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([0, 3, undefined])("an active department review stays visible with server count %s", (count) => {
  const html = renderToStaticMarkup(<RosterFilters status="current" review={["department"]}
    counts={{ status: { totals: statusTotals([3, 0, 0, 0, 0]), failed: [] },
      review: { totals: { ...reviewTotals([0, 0, 0, 0, 0, 0]), department: count }, failed: REVIEWS.map(() => false) } }}
    onChange={() => undefined} findSlot={() => undefined} density="regular" onDensity={() => undefined} />);
  const chip = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes("부서 없음"));
  expect(chip).toBeDefined();
  expect(chip).toContain('aria-pressed="true"');
});
