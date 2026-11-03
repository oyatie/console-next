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
  const samples = Number(labels?.["samples-per-cache"]);
  const run_ms = Number(labels?.["run-timeout-seconds"]) * 1000;
  assert(Object.values(shape).every(n => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(samples) && samples >= 20, "invalid lab fixture or sample count");
  assert(Number.isSafeInteger(run_ms) && run_ms > 0, "invalid lab deadline");
  return { ms: objective.value * 1000, target: objective.target, samples, run_ms, shape };
}

export const budget = readBudget(readYaml(new URL("../../backend/app/slos/page-load.openslo.yaml", import.meta.url)));
