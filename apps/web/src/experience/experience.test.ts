// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { DEFAULT_EXPERIENCE_ID, experiences, offeredExperiences, resolveExperience } from "./table";
import { loadPack } from "./pack";

vi.mock("../shell/baseline/shell", () => ({ default: () => null }));
vi.mock("../shell/console/shell", () => ({ ConsoleShell: () => null }));

test("the experience entry is data, and absent or unknown ids resolve to the Console default", () => {
  expect(JSON.parse(JSON.stringify(experiences))).toEqual(experiences);
  expect(DEFAULT_EXPERIENCE_ID).toBe("console");
  for (const id of [undefined, "", "missing", "constructor", "__proto__", "baseline ", "control-room"]) {
    expect(resolveExperience(id).id).toBe("console");
  }
  for (const experience of experiences) expect(resolveExperience(experience.id)).toBe(experience);
});

test("the pack loader uses the boot attribute, reads none as Classic as the stylesheets do, and an unknown one as Console", async () => {
  const baseline = await import("../shell/baseline/shell");
  const { ConsoleShell } = await import("../shell/console/shell");
  for (const id of [undefined, "baseline"]) {
    vi.stubGlobal("document", { documentElement: { dataset: { experience: id } } });
    expect(await loadPack(), id).toBe(baseline);
  }
  for (const id of ["console", "missing", "constructor"]) {
    vi.stubGlobal("document", { documentElement: { dataset: { experience: id } } });
    expect((await loadPack()).default, id).toBe(ConsoleShell);
  }
  vi.unstubAllGlobals();
});

test("the server's styles and its default are the bundle's", () => {
  const keys = (file: string) => readFileSync(new URL(`../../../../backend/crates/settings/domain/src/keys/${file}`, import.meta.url), "utf8");
  const codes = keys("mod.rs").match(/pub const EXPERIENCES: &\[&str\] = &\[([^\]]*)\];/)?.[1];
  expect(codes?.match(/"[^"]*"/g)?.map(code => JSON.parse(code))).toEqual(experiences.map(experience => experience.id));
  expect(keys("display.rs").match(/"display\.experience" = D::code\(EXPERIENCES, "([^"]*)"/)?.[1]).toBe(DEFAULT_EXPERIENCE_ID);
});

test("the chooser offers the built style and the listed styles, and keeps an unlisted style only for a person already on it", () => {
  expect(experiences.map(experience => [experience.id, experience.listing])).toEqual([["baseline", "listed"], ["console", "listed"], ["warm-clear", "unlisted"]]);
  expect(offeredExperiences("baseline").map(experience => experience.id)).toEqual(["baseline", "console"]);
  expect(offeredExperiences("console").map(experience => experience.id)).toEqual(["baseline", "console"]);
  // Leaving it must stay possible, and the select must show what is in force.
  expect(offeredExperiences("warm-clear").map(experience => experience.id)).toEqual(["baseline", "console", "warm-clear"]);
});
