// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { experiences, resolveExperience } from "./table";
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
