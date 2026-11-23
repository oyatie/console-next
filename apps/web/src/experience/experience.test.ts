// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { experiences, offeredExperiences, resolveExperience } from "./table";
import { loadPack } from "./pack";

vi.mock("../shell/baseline/shell", () => ({ default: () => null }));

test("the experience entry is data, and absent or unknown ids resolve to baseline", () => {
  expect(JSON.parse(JSON.stringify(experiences))).toEqual(experiences);
  for (const id of [undefined, "", "missing", "constructor", "__proto__", "baseline "]) {
    expect(resolveExperience(id).id).toBe("baseline");
  }
  for (const experience of experiences) expect(resolveExperience(experience.id)).toBe(experience);
});

test("the pack loader uses the boot attribute and falls back to baseline", async () => {
  const baseline = await import("../shell/baseline/shell");
  for (const id of [undefined, "baseline", "missing", "constructor"]) {
    vi.stubGlobal("document", { documentElement: { dataset: { experience: id } } });
    expect(await loadPack()).toBe(baseline);
  }
  vi.unstubAllGlobals();
});

test("the chooser offers the built style and the listed styles, and keeps an unlisted style only for a person already on it", () => {
  expect(experiences.map(experience => [experience.id, experience.listing])).toEqual([["baseline", "listed"], ["console", "listed"], ["warm-clear", "unlisted"]]);
  expect(offeredExperiences("baseline").map(experience => experience.id)).toEqual(["baseline", "console"]);
  expect(offeredExperiences("console").map(experience => experience.id)).toEqual(["baseline", "console"]);
  // Leaving it must stay possible, and the select must show what is in force.
  expect(offeredExperiences("warm-clear").map(experience => experience.id)).toEqual(["baseline", "console", "warm-clear"]);
});
