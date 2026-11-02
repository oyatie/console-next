// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { REVIEWS, VIEWS, reviewTotals, statusTotals } from "../domain/roster";
import { RosterFilters } from "./roster-filters";

vi.mock("./roster-scope", () => ({ RosterScope: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([0, 3, undefined])("an active department review stays visible with server count %s", (count) => {
  const html = renderToStaticMarkup(<RosterFilters soonDays={60} status="current" review={["department"]}
    counts={{ status: { totals: statusTotals([3, 0, 0, 0, 0]), failed: [] },
      review: { totals: { ...reviewTotals([0, 0, 0, 0, 0, 0]), department: count }, failed: REVIEWS.map(() => false) } }}
    onChange={() => undefined} findSlot={() => undefined} density="regular" onDensity={() => undefined} />);
  const chip = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes("부서 없음"));
  expect(chip).toBeDefined();
  expect(chip).toContain('aria-pressed="true"');
});

test.each(REVIEWS)("the active %s filter remains removable even if its count fails", (review) => {
  const html = renderToStaticMarkup(<RosterFilters soonDays={60} status="current" review={review === "identity" ? [review, "department"] : [review, "identity"]}
    counts={{ status: { totals: statusTotals([3, 0, 1, 0, 0]), failed: [] },
      review: { totals: reviewTotals([]), failed: REVIEWS.map(() => true) } }}
    onChange={() => undefined} findSlot={() => undefined} density="regular" onDensity={() => undefined} />);
  const chip = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes(`title="${t(`roster.review.${review}.title`, { days: 60 })}"`));
  expect(chip).toContain('aria-pressed="true"');
  expect(chip).toContain(t("roster.count.failed"));
});

test.each(VIEWS.filter(view => view.review?.length))("the $id view does not repeat its active review chip", (view) => {
  const html = renderToStaticMarkup(<RosterFilters soonDays={60} status={view.status!} review={view.review!}
    counts={{ status: { totals: statusTotals([3, 0, 1, 0, 0]), failed: [] },
      review: { totals: reviewTotals([0, 3, 0, 0, 3, 0, 0]), failed: [] } }}
    onChange={() => undefined} findSlot={() => undefined} density="regular" onDensity={() => undefined} />);
  expect(html).not.toContain(t(`roster.review.${view.review![0]!}.title`, { days: 60 }));
});

test("the current view marks unresolved people as included", () => {
  const html = renderToStaticMarkup(<RosterFilters soonDays={60} status="current" review={[]}
    counts={{ status: { totals: statusTotals([3, 0, 1, 0, 0]), failed: [] },
      review: { totals: reviewTotals([]), failed: [] } }}
    onChange={() => undefined} findSlot={() => undefined} density="regular" onDensity={() => undefined} />);
  const chip = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes(t("roster.status.UNKNOWN")));
  expect(chip).toContain('aria-pressed="true"');
});
