// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { fmtDate } from "@console/i18n/format";
import { experiences, offeredExperiences, resolveExperience } from "./table";
import { loadPack } from "./pack";

vi.mock("../shell/baseline/shell", () => ({ default: () => null }));
vi.mock("../shell/console/shell", () => ({ ConsoleShell: () => null }));
// A failed assertion must not leave the page stand-in for the tests after it.
afterEach(() => vi.unstubAllGlobals());

test("the experience entry is data, and absent or unknown ids resolve to console while keeping baseline selectable", () => {
  expect(JSON.parse(JSON.stringify(experiences))).toEqual(experiences);
  for (const id of [undefined, "", "missing", "constructor", "__proto__", "baseline "]) {
    expect(resolveExperience(id).id).toBe("console");
  }
  expect(resolveExperience("baseline").id).toBe("baseline");
  for (const experience of experiences) expect(resolveExperience(experience.id)).toBe(experience);
});

test("the pack loader uses the boot attribute, defaults to console, and loads baseline when selected", async () => {
  const baseline = await import("../shell/baseline/shell");
  const consoleMod = await import("../shell/console/shell");
  for (const id of [undefined, "console", "missing", "constructor"]) {
    vi.stubGlobal("document", { documentElement: { dataset: { experience: id } } });
    expect((await loadPack()).default).toBe(consoleMod.ConsoleShell);
  }
  vi.stubGlobal("document", { documentElement: { dataset: { experience: "baseline" } } });
  expect(await loadPack()).toBe(baseline);
});

test("the chooser offers the built style and the listed styles, and keeps an unlisted style only for a person already on it", () => {
  expect(experiences.map(experience => [experience.id, experience.listing])).toEqual([["baseline", "listed"], ["console", "listed"], ["warm-clear", "unlisted"]]);
  expect(offeredExperiences("baseline").map(experience => experience.id)).toEqual(["baseline", "console"]);
  expect(offeredExperiences("console").map(experience => experience.id)).toEqual(["baseline", "console"]);
  // Leaving it must stay possible, and the select must show what is in force.
  expect(offeredExperiences("warm-clear").map(experience => experience.id)).toEqual(["baseline", "console", "warm-clear"]);
});

test("the Console style draws business dates as ISO days by default, and Classic or warm-clear keep the locale form", async () => {
  await import("./dom");
  for (const [document, day] of [
    [{ documentElement: { dataset: { experience: "console" } } }, "2026-11-06"],
    [{ documentElement: { dataset: { experience: "baseline" } } }, "2026. 11. 06."],
    [{ documentElement: { dataset: { experience: "warm-clear" } } }, "2026. 11. 06."],
    // A bare test document without data-experience matches CSS (:root = baseline); index.html and prefs.js stamp console.
    [{}, "2026. 11. 06."],
  ] as const) {
    vi.stubGlobal("document", document);
    expect(fmtDate("2026-11-06"), JSON.stringify(document)).toBe(day);
  }
});
