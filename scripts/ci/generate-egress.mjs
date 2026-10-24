// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { requiredEndpoints } from "./egress.mjs";

// Keep each action's inputs literal: these are consumed during runner pre-steps, before checkout.
export function generateEgress(source) {
  const workflow = load(source);
  const pins = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    .map((step) => step.uses).filter((uses) => uses?.startsWith("step-security/harden-runner@"));
  if (!pins.length) return source;
  if (new Set(pins).size !== 1) throw new Error("inconsistent harden-runner pins");
  const generated = new Set();
  const output = source.replace(/^      - uses: (?:&harden-runner )?(?:step-security\/harden-runner@[^\n]+|\*harden-runner)\n(?: {8,}[^\n]*\n)*/gm, (step, offset) => {
    const name = [...source.slice(0, offset).matchAll(/^  ([\w-]+):/gm)].at(-1)?.[1];
    const job = workflow.jobs[name];
    if (!job || job.steps[0].with?.["egress-policy"] !== "block") throw new Error(`${name}: expected block-mode hardening first`);
    const endpoints = [...requiredEndpoints(job)].sort();
    if (!endpoints.length) throw new Error(`${name}: empty block allow-list`);
    generated.add(name);
    const input = `          allowed-endpoints: ${JSON.stringify(endpoints.join(" "))}\n`;
    const literal = step.replace(/^      - uses:[^\n]*\n/, `      - uses: ${pins[0]}\n`);
    return /^          allowed-endpoints:/m.test(literal)
      ? literal.replace(/^          allowed-endpoints:[^\n]*\n(?: {12,}[^\n]*\n)*/gm, input)
      : literal.replace(/^(          egress-policy: block\n)/m, `$1${input}`);
  });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.steps?.some((step) => step.with?.["egress-policy"] === "block") && !generated.has(name)) throw new Error(`${name}: hardening must be an explicit per-job step`);
  }
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
    const path = `.github/workflows/${file}`, source = readFileSync(path, "utf8"), generated = generateEgress(source);
    if (process.argv.includes("--check")) {
      if (generated !== source) throw new Error(`${file}: stale egress inputs; run node scripts/ci/generate-egress.mjs`);
    } else if (generated !== source) writeFileSync(path, generated);
  }
}
