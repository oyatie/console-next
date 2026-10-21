import { expect, test } from "vitest";
import { clock, duration, endOf, nextDay, nightMinutes, parseClock, workMinutes } from "./minutes";

test("clock entry: the forms people type, nothing past 24:00", () => {
  expect(["9", "09", "9:30", "0930", "18:00", "24:00", "0:00"].map(parseClock)).toEqual([540, 540, 570, 570, 1080, 1440, 0]);
  expect(["", "25", "9:60", "24:01", "6:5O", "9-18"].map(parseClock)).toEqual([null, null, null, null, null, null]);
});

test("an end at or before the start is the next day's", () => {
  expect(endOf(1260, 360)).toBe(1800);
  expect(endOf(480, 1020)).toBe(1020);
  expect([clock(1800), nextDay(1800), clock(1020), nextDay(1020)]).toEqual(["06:00", true, "17:00", false]);
});

test("durations are h:mm, never decimals", () => {
  expect([duration(480), duration(2240), duration(30), duration(0)]).toEqual(["8:00", "37:20", "0:30", "0:00"]);
});

test("work and night minutes leave the breaks out", () => {
  const day = { start: 480, end: 1020, breaks: [{ start: 720, end: 780 }] };
  expect([workMinutes(day), nightMinutes(day)]).toEqual([480, 0]);
  // 21:00–06:00 (+1) with 02:00–03:00 off: 8:00 of work, 7:00 of it at night.
  const night = { start: 1260, end: 1800, breaks: [{ start: 1560, end: 1620 }] };
  expect([workMinutes(night), nightMinutes(night)]).toEqual([480, 420]);
});
