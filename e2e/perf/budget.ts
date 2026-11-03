// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
export const readYaml = (file: URL) => yaml.load(readFileSync(file, "utf8"));

export function readBudget(value: unknown) {
  const slo = value as { metadata?: { labels?: Record<string, string> }; spec?: { objectives?: { op: string; value: number; target: number }[] } };
  const objective = slo.spec?.objectives?.[0], labels = slo.metadata?.labels;
  assert(objective?.op === "lte" && Number.isFinite(objective.value) && objective.value > 0, "invalid LCP objective");
  assert(Number.isFinite(objective.target) && objective.target > 0 && objective.target <= 1, "invalid LCP target");
  const shape = Object.fromEntries(["employees", "entities", "workplaces", "departments"].map(key => [key, Number(labels?.[key])])) as Record<"employees" | "entities" | "workplaces" | "departments", number>;
  assert(Object.values(shape).every(n => Number.isSafeInteger(n) && n > 0), "invalid lab fixture");
  return { ms: objective.value * 1000, target: objective.target, shape };
}

export function readHarness(value: unknown) {
  const run = value as { samples_per_cache?: unknown; run_timeout_seconds?: unknown };
  const samples = Number(run.samples_per_cache), run_ms = Number(run.run_timeout_seconds) * 1000;
  assert(Number.isSafeInteger(samples) && samples >= 20, "invalid lab sample count");
  assert(Number.isSafeInteger(run_ms) && run_ms > 0, "invalid lab deadline");
  return { samples, run_ms };
}

export const budget = {
  ...readBudget(readYaml(new URL("../../backend/app/slos/page-load.openslo.yaml", import.meta.url))),
  ...readHarness(readYaml(new URL("./lab.yaml", import.meta.url))),
};
