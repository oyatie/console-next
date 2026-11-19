// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { monthOf, monthWeeks, weekday } from "../../features/attendance/domain/month";
import { MonthGrid } from "./month-grid";
import "../../app.css";

const MONTH = "2026-10";
const WEEKS = monthWeeks(MONTH);
const HOLIDAY: Record<string, string> = { "2026-10-03": "National Foundation Day", "2026-10-09": "Hangul Day" };
const choose = new URLSearchParams(location.search).has("choose");

/**
 * October 2026 as the attendance calendar passes it: Sunday-first weeks from the same helper, the neighbouring months'
 * days muted, a tone and its words on rest days and holidays, and nothing to choose. `?choose` adds a selection, as the
 * gallery does. `#key` names the last key that reached the window and says whether its default was cancelled.
 */
export function Fixture() {
  const [day, setDay] = useState<string>();
  const [key, setKey] = useState("");
  useEffect(() => {
    const hear = (e: KeyboardEvent) => setKey(`${e.code} ${e.defaultPrevented ? "taken" : "left"}`);
    window.addEventListener("keydown", hear);
    return () => window.removeEventListener("keydown", hear);
  }, []);
  return (
    <main>
      <button type="button">Before</button>
      <MonthGrid
        label="October 2026"
        weeks={WEEKS}
        weekdays={["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]}
        inMonth={d => monthOf(d) === MONTH}
        tone={d => (HOLIDAY[d] ? "holiday" : weekday(d) === 0 ? "rest" : undefined)}
        cell={d => HOLIDAY[d] ?? (weekday(d) === 0 ? "Weekly rest day" : null)}
        {...(choose ? { selected: day, onSelect: setDay } : {})}
      />
      <button type="button">After</button>
      <output id="key">{key}</output>
      <output id="chosen">{day}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
