// SPDX-License-Identifier: LicenseRef-Proprietary
// What the grid's browser test reads off the page about the sticky side columns. Each runs in the page.
import type { Locator } from "@playwright/test";

/**
 * The head row and the first person's row at a sideways scroll position: what is wrong with the sticky side columns
 * (one lying on another, a gap or an overlap between neighbours in view), how many totals are in view, how far the
 * last one ends from the box's right edge, and how many whole day columns show between the two sides.
 */
export const sideways = (grid: Locator, scrollLeft: number, leads: number) => grid.locator("..").evaluate((el, [to, lead]) => {
  el.scrollLeft = to;
  const box = el.getBoundingClientRect(), right = box.left + el.clientWidth, faults: string[] = [];
  const shows = (cell: Element) => {
    const b = cell.getBoundingClientRect();
    return cell.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2));
  };
  const seen = { days: 0, totals: 0 };
  for (const row of [el.querySelector("thead tr")!, el.querySelector("tbody tr:not([aria-hidden])")!]) {
    const cells = [...row.children], sides = [...cells.slice(0, lead), ...cells.slice(-4)];
    const bounds = sides.map(c => c.getBoundingClientRect()), inView = bounds.map(b => b.left < right - 1);
    sides.forEach((cell, i) => {
      const b = bounds[i]!, name = `${row.parentElement!.tagName} ${i < lead ? "lead" : "total"} ${i < lead ? i + 1 : i - lead + 1}`;
      if (inView[i] && !shows(cell)) faults.push(`${name} is covered`);
      if (i > 0 && i !== lead && inView[i - 1] && Math.abs(b.left - bounds[i - 1]!.right) > 1) faults.push(`${name} starts at ${Math.round(b.left)}, its neighbour ends at ${Math.round(bounds[i - 1]!.right)}`);
    });
    if (Math.abs(bounds[0]!.left - box.left) > 1) faults.push(`${row.parentElement!.tagName} lead 1 starts at ${Math.round(bounds[0]!.left)}`);
    const from = bounds[lead - 1]!.right, until = Math.min(right, ...bounds.slice(lead).map(b => b.left));
    seen.days = cells.slice(lead, -4).filter(c => c.getBoundingClientRect().left >= from - 1 && c.getBoundingClientRect().right <= until + 1 && shows(c)).length;
    seen.totals = inView.slice(lead).filter(Boolean).length;
  }
  return { faults, ...seen, end: el.scrollWidth - el.clientWidth, totalsEnd: Math.abs(Math.round(right - el.querySelector("thead tr")!.lastElementChild!.getBoundingClientRect().right)) };
}, [scrollLeft, leads] as const);

/** Whether the active cell, with the editor when one is open in it, shows whole between the lead columns and the held totals. */
export const activeShows = (grid: Locator) => grid.evaluate(table => {
  const el = table.parentElement!, cell = document.getElementById(table.getAttribute("aria-activedescendant") ?? "");
  if (!cell) return "no active cell";
  const head = [...el.querySelector("thead tr")!.children].map(c => c.getBoundingClientRect());
  const from = head[cell.parentElement!.querySelectorAll("th").length - 1]!.right;
  const until = Math.min(el.getBoundingClientRect().left + el.clientWidth, ...head.slice(-4).map(b => b.left));
  const b = cell.getBoundingClientRect();
  return b.left >= from - 1 && b.right <= until + 1 && cell.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2))
    ? "in view" : `out of view: ${Math.round(b.left)}-${Math.round(b.right)} in ${Math.round(from)}-${Math.round(until)}`;
});
