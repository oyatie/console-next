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

test("DeadlineStrip prevents partial-token WCAG 2.5.3 label mismatches and avoids nested identical regions", () => {
  const html = renderToStaticMarkup(
    <DeadlineStrip
      monthLabel="11"
      days={[
        { date: "2026-11-10", dayLabel: "10", bucket: "today" },
        { date: "2026-11-12", dayLabel: "12", bucket: "upcoming" },
      ]}
      entries={[
        { id: "st", shortLabel: "ST", fullLabel: "Statutory Today", lane: "statutory", date: "2026-11-10" },
        { id: "d1", shortLabel: "D1", fullLabel: "D10 item", lane: "operational", date: "2026-11-12", tone: "upcoming" },
        { id: "prefixed", shortLabel: "S1", fullLabel: "S1 · Statutory item", lane: "statutory", date: "2026-11-12" },
      ]}
    />,
  );
  expect(html).toContain('aria-label="ST · Statutory Today"');
  expect(html).toContain('aria-label="D1 · D10 item"');
  expect(html).toContain('aria-label="S1 · Statutory item"');
  expect(html).not.toContain('aria-label="S1 · S1 ·');
  expect(html.match(/role="region"/g)).toHaveLength(1);
  expect(html).toContain('<div class=');
  expect(html).not.toMatch(/<section[^>]*aria-label=/);
});
