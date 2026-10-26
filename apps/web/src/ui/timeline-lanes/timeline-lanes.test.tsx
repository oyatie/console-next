// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { TimelineLanes, type LaneItem } from "./timeline-lanes";

beforeAll(() => loadCatalog("ko"));

test("the existing ribbon keeps dates, headings, state, detail, actor, actions and focus targets", () => {
  const ribbon = html(
    <TimelineLanes
      labels={{ upcoming: "upcoming", today: "today", past: "past" }}
      upcoming={[{ key: "future", date: "2026-11-01", title: "future", state: "scheduled" }]}
      past={[
        {
          key: "old",
          id: "event-1",
          date: "2026-10-01",
          title: "change",
          detail: "reason",
          meta: "actor",
          verbs: "correct",
          struck: true,
          highlight: true,
        },
      ]}
    />
  );
  for (const value of ["upcoming", "today", "past", "2026-11-01", "scheduled", "change", "reason", "actor", "correct"]) {
    expect(ribbon).toContain(value);
  }
  expect(ribbon).toContain('id="event-1" tabindex="-1"');
  expect(ribbon).toContain('data-struck="true"');
  expect(ribbon).toContain('data-highlight="true"');
  expect(ribbon).toContain('role="separator" aria-label="today"');
});

test("single-lane mode renders items directly without today divider", () => {
  const rendered = html(
    <TimelineLanes
      items={[
        { key: "1", id: "ev-1", date: "2026-10-15", title: "first revision", detail: "field diff" },
        { key: "2", id: "ev-2", date: "2026-10-10", title: "initial record" },
      ]}
    />
  );
  expect(rendered).toContain("first revision");
  expect(rendered).toContain("initial record");
  expect(rendered).toContain('id="ev-1"');
  expect(rendered).not.toContain('role="separator"');
});

test("adversarial: 2,000 events in single-lane mode are paged to limit DOM rows", () => {
  const bigList: LaneItem[] = Array.from({ length: 2000 }, (_, i) => ({
    key: `event-${i}`,
    id: `ev-${i}`,
    date: "2026-10-01",
    title: `Event ${i}`,
  }));

  const rendered = html(<TimelineLanes items={bigList} />);
  // Count rendered <li> elements
  const liMatches = rendered.match(/<li\b/g);
  expect(liMatches).not.toBeNull();
  expect(liMatches!.length).toBe(50);
  expect(liMatches!.length).toBeLessThan(2000);
  expect(rendered).toContain('aria-label="페이지 이동"');
});

test("loading, empty, and error states render correctly", () => {
  const loading = html(<TimelineLanes items={[]} loading />);
  expect(loading).toContain('aria-busy="true"');

  const empty = html(<TimelineLanes items={[]} empty="기록 없음" />);
  expect(empty).toContain("기록 없음");

  const error = html(<TimelineLanes items={[]} error="조회 실패" />);
  expect(error).toContain('data-state="error"');
  expect(error).toContain("조회 실패");
});


test("two lanes page every event with a shared range control, including more than 50 scheduled events", () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ key: `event-${i}`, date: "2026-10-01", title: `Event ${i}` }));
  const rendered = html(<TimelineLanes upcoming={items} past={items} labels={{ upcoming: "Upcoming", today: "Today", past: "Past" }} />);
  expect(rendered.match(/<li\b/g)).toHaveLength(100);
  expect(rendered.match(/class="pager"/g)).toHaveLength(2);
  expect(rendered).toContain("2,000");
});

test("an empty ribbon adds no domain prose unless the caller provides it", () => {
  expect(html(<TimelineLanes items={[]} />)).not.toContain("조직도");
  expect(html(<TimelineLanes upcoming={[]} past={[]} labels={{ upcoming: "Upcoming", today: "Today", past: "Past" }} />)).not.toContain("조직도");
});

test("title and detail accept block content without invalid paragraph or span nesting", () => {
  const title = "Revision", field = "Name", value = "New name";
  const rendered = html(<TimelineLanes items={[{ key: "revision", date: "2026-10-01", title: <div>{title}</div>, detail: <dl><dt>{field}</dt><dd>{value}</dd></dl> }]} />);
  expect(rendered).not.toMatch(/<(?:p|span)\b[^>]*>\s*<(?:div|dl)\b/);
});
