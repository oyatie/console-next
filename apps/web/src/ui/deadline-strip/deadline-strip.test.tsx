// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { DeadlineStrip } from "./deadline-strip";

beforeAll(() => loadCatalog("ko"));

test("DeadlineStrip renders overdue, today, upcoming, and undated headers and statutory vs operational rows", () => {
  const html = renderToStaticMarkup(
    <DeadlineStrip
      monthLabel="11"
      days={[
        { date: "2026-11-08", dayLabel: "08", bucket: "over" },
        { date: "2026-11-10", dayLabel: "10", bucket: "today" },
        { date: "2026-11-14", dayLabel: "14", bucket: "upcoming" },
      ]}
      entries={[
        { id: "s1", shortLabel: "S1", fullLabel: "Statutory item", lane: "statutory", date: "2026-11-14" },
        { id: "o1", shortLabel: "O1", fullLabel: "Operational item", lane: "operational", date: null, tone: "undated" },
      ]}
      selectedId="s1"
      onSelect={() => undefined}
    />,
  );
  expect(html).toContain(t("uiWorklist.schedule"));
  expect(html).toContain(t("uiWorklist.statutoryLane"));
  expect(html).toContain(t("uiWorklist.operationalLane"));
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="S1 · Statutory item"');
});
