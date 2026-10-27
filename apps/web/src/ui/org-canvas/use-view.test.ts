import { expect, test } from "vitest";
import { barInsets, firstView, fitView, revealView, unzoomOf } from "./use-view";

test("zooming out preserves a control's readable text and 24 px target", () => {
  for (const zoom of [0.4, 0.57, 0.8, 0.86, 1, 1.5]) {
    expect(12 * zoom * unzoomOf(zoom)).toBeGreaterThanOrEqual(12);
    expect(24 * zoom * unzoomOf(zoom)).toBeGreaterThanOrEqual(24);
  }
  expect(unzoomOf(1.5)).toBe(1);
});

test("a chart narrower than the canvas opens at 100%, centred along the top", () => {
  expect(firstView(1000, { w: 600, h: 2000 }, 56)).toEqual({ zoom: 1, x: 200, y: 56 });
});

test("a chart a little wider fits its width; its height never shrinks it (it pans down)", () => {
  expect(firstView(1000, { w: 1250, h: 4000 }, 56)).toEqual({ zoom: 0.8, x: 0, y: 56 });
});

// Regression: a chart far wider than the canvas (a side panel open beside it) opened fitted at 57%, unreadable.
test("a chart too wide to fit readably opens at 100% from its start", () => {
  expect(firstView(600, { w: 1060, h: 700 }, 56)).toEqual({ zoom: 1, x: 0, y: 56 });
});

test("a phone canvas opens at the start of a wide chart without clipping its leading labels", () => {
  expect(firstView(340, { w: 432, h: 900 }, 56)).toEqual({ zoom: 1, x: 0, y: 56 });
});

test("a box partly under the bottom bar is centred between the bars", () => {
  const v = { zoom: 1, x: 0, y: 0 };
  expect(revealView(v, { x: 100, y: 500, w: 200, h: 80 }, { w: 1000, h: 600 }, { top: 60, bottom: 70 })).toEqual({ zoom: 1, x: 300, y: -245 });
});

test("a box in the clear area leaves the view as it is", () => {
  const v = { zoom: 1, x: 0, y: 0 };
  expect(revealView(v, { x: 100, y: 100, w: 200, h: 80 }, { w: 1000, h: 600 }, { top: 60, bottom: 70 })).toBe(v);
});

test("fit pads only the measured bars, ignoring the overview's corner height", () => {
  const i = barInsets({ top: 100, bottom: 700 }, { bottom: 152, height: 52 }, { top: 638, height: 46 });
  expect(i).toEqual({ top: 60, bottom: 70 });
  const corner = { x: 700, y: 320, w: 280, h: 264 };
  expect(fitView({ w: 1000, h: 600 }, { w: 800, h: 940 }, { ...i, corner })).toEqual({ zoom: 0.5, x: 300, y: 60 });
  expect(barInsets({ top: 100, bottom: 700 }, { bottom: 0, height: 0 })).toEqual({ top: 0, bottom: 0 });
});

test("the space alongside the overview is usable; only an intersecting box is revealed", () => {
  const v = { zoom: 1, x: 0, y: 0 }, vp = { w: 1000, h: 600 };
  const i = { top: 60, bottom: 70, corner: { x: 700, y: 300, w: 280, h: 284 } };
  expect(revealView(v, { x: 100, y: 400, w: 200, h: 80 }, vp, i)).toBe(v);
  expect(revealView(v, { x: 720, y: 400, w: 200, h: 80 }, vp, i)).toEqual({ zoom: 1, x: -320, y: -145 });
});

test("reveal avoids the overview when the usual centre overlaps it, at the current zoom", () => {
  const i = { top: 60, bottom: 70, corner: { x: 700, y: 260, w: 280, h: 324 } };
  const next = revealView({ zoom: 0.8, x: 0, y: 0 }, { x: 1000, y: 500, w: 750, h: 100 }, { w: 1000, h: 600 }, i);
  expect(next.x + 1000 * next.zoom + 750 * next.zoom).toBeLessThan(i.corner.x);
  const wide = revealView({ zoom: 1, x: 0, y: 0 }, { x: 0, y: 700, w: 800, h: 80 }, { w: 1000, h: 600 }, i);
  expect(wide.y + 700 + 80).toBeLessThan(i.corner.y);
});
