import { expect, type Page } from "@playwright/test";

/**
 * Layout stability: a control must not move while the screen loads, or a click already pressed on it releases
 * on whatever slid under the pointer (pointerup elsewhere, click on the common ancestor) and does nothing.
 *
 * Recorded from the first script on (context.addInitScript), each shift with the elements that moved:
 * 1. A shift with no user input in the 500 ms before it (the browser's hadRecentInput, plus typing it misses): an
 *    unattended load.
 * 2. A shift inside that window, after a response landed since the input and later than the frame that painted
 *    the input's own result (Event Timing): a read after a click (a page, a panel's detail) is a load too. Against
 *    the local backend it lands in ~50 ms, inside the window: without this rule the unit card's since line
 *    (4262ca4, 53-71 ms after the click) went unseen.
 * 3. Not a command's result: from the press that sent a write until a second after its answer, the page shows
 *    what it made or why it refused, what the user is waiting on, not a screen they take as ready and aim at.
 * 4. A shift that moves a control 8 px or more off where it was (growing over its old place keeps the press), or
 *    a block carrying one that moved whole, fails at any score. A block that also resized (grew upward over the
 *    controls at its foot) is left to the score. The rects are clipped to the viewport, so a block partly off
 *    screen reads as resized: a known ceiling.
 * 5. Not shifts: an element that was not in view before (it appeared), one inside a scroller that scrolled in the
 *    last 500 ms (a virtual list recycling its rows), and what a test's own viewport resize moved (forgetResize).
 * Chromium only: Firefox and WebKit have no layout-shift entries, so there the check is a no-op.
 */

/**
 * The score (impact × distance, CLS's unit) allowed per check for shifts that move no control. At 1280×720 a
 * full-width card moving one text line (24 px) scores ~0.011, the Home rail jumping 85 px 0.044. Over the suite
 * the unattended shifts that moved no control were either two lines or more (0.0924, 0.0594, 0.0232: fixed) or one
 * (an empty card nudged 76 px, 0.0153): 0.02 lets a line of text reflow and fails a block that visibly jumps. A
 * shift that moves a control fails at any score: a chip sliding a few pixels scores ~0.0002 and still loses the click.
 */
export const SHIFT_BUDGET = 0.02;

declare global {
  interface Window {
    __shifts?: { value: number; control: boolean; at: string; nodes: string[] }[];
    __shiftGeneration?: number;
  }
}

/** In the page: starts recording. Self-contained (it is serialized into the page). */
export function recordShifts() {
  if (window.__shifts || !PerformanceObserver.supportedEntryTypes.includes("layout-shift")) return;
  const shifts: NonNullable<Window["__shifts"]> = (window.__shifts = []);
  // A control nudged less than this keeps a press aimed at it: a font subset swapping in (Pretendard's dynamic
  // subsets, font-display: swap) moves the top bar's controls 2-5 px on a cold cache.
  const NEAR = 8;
  const CONTROL = "button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=tab], [tabindex]:not([tabindex='-1'])";
  // Typing counts as input even without a key press (a paste, Playwright's fill): the browser's hadRecentInput
  // misses it, so this window is kept here too.
  let lastInput = -Infinity;
  let lastTyped = -Infinity;
  for (const type of ["pointerdown", "mousedown", "keydown"]) addEventListener(type, () => (lastInput = performance.now()), true);
  addEventListener("input", () => (lastInput = lastTyped = performance.now()), true);
  // Each interaction until its own response was painted (Event Timing): a shift in that frame is what the input
  // rendered at once, whatever else landed meanwhile.
  const painted: { from: number; to: number }[] = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { interactionId?: number })[])
      if (e.interactionId) painted.push({ from: e.startTime, to: e.startTime + e.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  // When responses landed (not when they were asked: hovering prefetches before a click), and when the last
  // command (a write) was sent and answered.
  let landed: number[] = [];
  let lastCommand = -Infinity;
  let commandLanded = -Infinity;
  const fetch0 = window.fetch;
  window.fetch = (...args) => {
    const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET");
    // Background POSTs (session restore, consent status) are reads, not a result the user asked to move.
    const command = !/^(GET|HEAD)$/i.test(method) && performance.now() - lastInput < 500;
    if (command) lastCommand = performance.now();
    return fetch0(...args).finally(() => {
      landed = [...landed.slice(-20), performance.now()];
      if (command) commandLanded = performance.now();
    });
  };
  // Scrollers by when they last scrolled: what moves inside one that is scrolling is the scroll (a virtual list
  // recycles its rows), not a shift.
  const scrolled = new Map<EventTarget, number>();
  addEventListener("scroll", (e) => void (e.target && scrolled.set(e.target, performance.now())), true);
  const elementOf = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));
  const describe = (el: Element | null) => {
    if (!el) return "(gone)";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const name = el.getAttribute("aria-label") ?? el.textContent?.replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls}${name ? ` 「${name}」` : ""}`;
  };
  const rect = (r: DOMRectReadOnly) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`;
  type Shift = PerformanceEntry & {
    value: number;
    hadRecentInput: boolean;
    sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Shift[]) {
      // A command's own result (the record it made, its refusal) is what the user pressed for and is waiting on:
      // from the press that sent it until a second after its answer (a slow machine renders it past 500 ms).
      if (lastCommand > lastInput && (commandLanded < lastCommand || e.startTime - commandLanded < 1000)) continue;
      const attended = e.hadRecentInput || e.startTime - lastInput < 500;
      if (attended && !landed.some((t) => t > lastInput && t <= e.startTime)) continue;
      // An element that was not in view before (a recycled virtual row, a block scrolled in) appeared; it did not move.
      const scrolling = [...scrolled].filter(([, t]) => e.startTime - t < 500).map(([el]) => el);
      const moved = e.sources.filter(
        (s) => s.previousRect.width * s.previousRect.height > 0 && !scrolling.some((el) => el instanceof Node && el.contains(s.node)),
      );
      if (!moved.length) continue;
      const els = moved.map((s) => elementOf(s.node));
      const record = {
        value: e.value,
        at: `${location.pathname}${attended ? `, ${Math.round(e.startTime - lastInput)} ms after input` : ""}`,
        // A control that moved, or a block carrying one that moved whole (a block that also resized, e.g. grew
        // upward over the controls at its foot, is left to the score).
        control: moved.some(({ previousRect: a, currentRect: b }, i) => {
          const el = els[i];
          const whole = Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
          const far = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= NEAR;
          // A control that grew over where it was (a count landing in a right-aligned link) is still under the press.
          const kept = b.x <= a.x && b.y <= a.y && b.x + b.width >= a.x + a.width && b.y + b.height >= a.y + a.height;
          return !!el && far && !kept && (el.matches(CONTROL) || (whole && !!el.querySelector(CONTROL)));
        }),
        nodes: moved.map((s, i) => `${describe(els[i]!)} (${rect(s.previousRect)} → ${rect(s.currentRect)})`),
      };
      if (!attended) shifts.push(record);
      else {
        // The interaction's own timing is delivered some time after its frame: decide once it has (expectStable
        // waits 500 ms). Typing has no interaction timing: what it redraws lands within a few frames.
        const input = lastInput;
        const typed = lastTyped;
        const generation = window.__shiftGeneration ?? 0;
        setTimeout(() => {
          const own = e.startTime - input < 24 || e.startTime - typed < 50 || painted.some((p) => p.from <= e.startTime && e.startTime <= p.to + 8);
          if (!own && generation === (window.__shiftGeneration ?? 0)) shifts.push(record);
        }, 300);
      }
    }
  }).observe({ type: "layout-shift", buffered: true });
}

/** Drops what a viewport resize moved (atPhoneWidth): the test resized the page, not the app. */
export async function forgetResize(page: Page) {
  // Two frames for the relayout, then time for the observer to deliver it (and for a deferred input-adjacent one).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));
  await page.evaluate(clearShifts);
}

/** Clears the current screen and prevents delayed input checks from leaking into the next audit. */
export function clearShifts() {
  window.__shiftGeneration = (window.__shiftGeneration ?? 0) + 1;
  window.__shifts?.splice(0);
}

/**
 * Fails (soft) when, since the previous check, a shift moved a control or the shifts add up to more than
 * SHIFT_BUDGET, naming the elements that moved. Call it once the screen has settled; expectAccessible does, so
 * every audited screen is checked. A page opened without the init script starts recording here.
 */
export async function expectStable(page: Page, context: string) {
  await page.evaluate(recordShifts);
  const shifts = await page.evaluate(async () => {
    if (!window.__shifts) return []; // no layout-shift entries in this engine
    // Late content (a count, a detail) lands just after the screen looks ready: let it.
    await new Promise((r) => setTimeout(r, 500));
    return window.__shifts.splice(0);
  });
  const total = shifts.reduce((s, x) => s + x.value, 0);
  const failed = shifts.some((s) => s.control) || total > SHIFT_BUDGET;
  const moved = shifts.map((s) => `${s.value.toFixed(4)}${s.control ? " control" : ""} on ${s.at}: ${s.nodes.join(" | ")}`);
  expect.soft(failed ? moved : [], `layout shift on ${context} (score ${total.toFixed(4)}, budget ${SHIFT_BUDGET})`).toEqual([]);
}
