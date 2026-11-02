// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { toolsSpot, type Box, type Layout } from "./layout";

test.each([1, 1.4])("compact tools clear the parent at the visible top edge at scale %s", scale => {
  const box: Box = { node: {} as never, lod: "xs", x: 324, y: 384, w: 224, h: 36 };
  const parent = { ...box, x: 300, y: 300, h: 74 };
  const layout: Layout = { boxes: [parent, box], lines: [], w: 1200, h: 1000, lod: "far" };
  const visible = { x: 280, y: box.y, w: 300, h: 300 };
  expect(toolsSpot(layout, box, scale, undefined, undefined, visible).overlap).toBeGreaterThan(0);
  const w = 88 * scale, h = 34 * scale;
  const spot = toolsSpot(layout, box, scale, w, h, visible);
  expect(spot.overlap).toBe(0);
  expect(spot.x).toBeGreaterThanOrEqual(visible.x);
  expect(spot.y).toBeGreaterThanOrEqual(visible.y);
  expect(spot.x + w).toBeLessThanOrEqual(visible.x + visible.w);
  expect(spot.y + h).toBeLessThanOrEqual(visible.y + visible.h);
  for (const other of layout.boxes) {
    expect(spot.x >= other.x + other.w || spot.x + w <= other.x || spot.y >= other.y + other.h || spot.y + h <= other.y).toBe(true);
  }
});

test("a blocked toolbar chooses the least overlap within the visible area", () => {
  const box: Box = { node: {} as never, lod: "m", x: 100, y: 100, w: 100, h: 40 };
  const layout: Layout = { boxes: [box, { ...box, y: 80, h: 20 }], lines: [], w: 500, h: 500, lod: "near" };
  const spot = toolsSpot(layout, box, 1, 80, 30, { x: 90, y: 90, w: 120, h: 60 });
  expect(spot.overlap).toBe(1600);
  expect(spot.side).toBe("below");
  expect(spot.x).toBeGreaterThanOrEqual(90);
  expect(spot.x + 80).toBeLessThanOrEqual(210);
  expect(spot.y).toBeGreaterThanOrEqual(90);
  expect(spot.y + 30).toBeLessThanOrEqual(150);
});
