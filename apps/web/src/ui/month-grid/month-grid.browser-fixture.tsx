// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { addDays } from "../date/days";
import { MonthGrid } from "./month-grid";
import "../../app.css";

// The weeks the attendance calendar's month helper gives for October 2026: Sunday 27 September to Saturday 31 October.
const WEEKS = [0, 1, 2, 3, 4].map(w => Array.from({ length: 7 }, (_, d) => addDays("2026-09-27", w * 7 + d)));
const HOLIDAY: Record<string, string> = { "2026-10-03": "National Foundation Day", "2026-10-09": "Hangul Day" };
const sunday = (d: string) => WEEKS.some(w => w[0] === d);
const choose = new URLSearchParams(location.search).has("choose");

/**
 * October 2026 with the props the attendance calendar passes: Sunday-first weeks of seven, the neighbouring months'
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
        inMonth={d => d.startsWith("2026-10")}
        tone={d => (HOLIDAY[d] ? "holiday" : sunday(d) ? "rest" : undefined)}
        cell={d => HOLIDAY[d] ?? (sunday(d) ? "Weekly rest day" : null)}
        {...(choose ? { selected: day, onSelect: setDay } : {})}
      />
      <button type="button">After</button>
      <output id="key">{key}</output>
      <output id="chosen">{day}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
