// SPDX-License-Identifier: LicenseRef-Proprietary
// What the grid's browser test reads off the page about a column's place between the sticky side columns. Each runs in the page.
import type { Locator } from "@playwright/test";

/** Whether the active cell, with the editor when one is open in it, shows whole: nothing covers either of its edges. */
export const activeShows = (grid: Locator) => grid.evaluate(table => {
  const cell = document.getElementById(table.getAttribute("aria-activedescendant") ?? "");
  if (!cell) return "no active cell";
  const b = cell.getBoundingClientRect(), y = (b.top + b.bottom) / 2;
  // Whatever is on top at an edge: a sticky column over the cell, or what lies past the box's edge.
  const tops = [b.left + 1, b.right - 1].map(x => document.elementFromPoint(x, y));
  const covers = tops.filter(top => !cell.contains(top)).map(top => top ? `${top.tagName} ${top.className} at ${Math.round(top.getBoundingClientRect().left)}` : "nothing");
  return covers.length ? `out of view: ${Math.round(b.left)}-${Math.round(b.right)}, covered by ${covers.join(" and ")}` : "in view";
});

/** The first day of a body row whose start shows and whose end does not, counted from 0 (-1 for none). */
export const cutDay = (row: Locator) => row.evaluate(tr => [...tr.querySelectorAll("td")].findIndex(cell => {
  const b = cell.getBoundingClientRect(), y = (b.top + b.bottom) / 2;
  return cell.contains(document.elementFromPoint(b.left + 6, y)) && !cell.contains(document.elementFromPoint(b.right - 1, y));
}));
