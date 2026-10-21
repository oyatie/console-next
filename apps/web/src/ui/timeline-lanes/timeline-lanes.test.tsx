import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { TimelineLanes } from "./timeline-lanes";

beforeAll(() => loadCatalog("ko"));

test("the existing ribbon keeps dates, headings, state, detail, actor, actions and focus targets", () => {
  const ribbon = html(<TimelineLanes labels={{ upcoming: "upcoming", today: "today", past: "past" }}
    upcoming={[{ key: "future", date: "2026-11-01", title: "future", state: "scheduled" }]}
    past={[{ key: "old", id: "event-1", date: "2026-10-01", title: "change", detail: "reason", meta: "actor", verbs: "correct", struck: true, highlight: true }]} />);
  for (const value of ["upcoming", "today", "past", "2026-11-01", "scheduled", "change", "reason", "actor", "correct"]) expect(ribbon).toContain(value);
  expect(ribbon).toContain('id="event-1" tabindex="-1"');
  expect(ribbon).toContain('data-struck="true"');
  expect(ribbon).toContain('data-highlight="true"');
  expect(ribbon).toContain('role="separator" aria-label="today"');
});
