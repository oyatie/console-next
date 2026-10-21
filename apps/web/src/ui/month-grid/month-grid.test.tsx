import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthGrid } from "./month-grid";

const weeks = [["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]];
const render = (selected?: string) =>
  renderToStaticMarkup(
    <MonthGrid label="m" weeks={weeks} weekdays={["S", "M", "T", "W", "T", "F", "S"]} inMonth={(d) => d >= "2026-10-01"} cell={(d) => (d === "2026-10-03" ? "H" : null)} tone={(d) => (d === "2026-10-03" ? "holiday" : undefined)} selected={selected} onSelect={() => undefined} />,
  );

test("one tab stop: the selected day, else the month's first day; the lead days are muted", () => {
  const html = render();
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  expect(html).toMatch(/data-date="2026-10-01"[^>]*tabindex="0"/);
  expect(html).toMatch(/data-date="2026-09-27"[^>]*data-out="true"/);
  expect(render("2026-10-02")).toMatch(/data-date="2026-10-02"[^>]*tabindex="0"[^>]*aria-selected="true"/);
});

test("a holiday carries its tone and its words, not colour alone", () => {
  expect(render()).toMatch(/data-date="2026-10-03"[^>]*data-tone="holiday"[^>]*>.*H<\/td>/);
});
