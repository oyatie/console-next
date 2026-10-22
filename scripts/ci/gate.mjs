// SPDX-License-Identifier: LicenseRef-Proprietary
import { fileURLToPath } from "node:url";

export function gate(required, results) {
  return Object.keys(results).every((name) => Object.hasOwn(required, name)) && Object.entries(required).every(([name, needed]) => results[name] === "success" || (!needed && results[name] === "skipped"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const needs = JSON.parse(process.env.NEEDS);
  if (needs.plan?.result !== "success" || !gate(JSON.parse(needs.plan.outputs.required), Object.fromEntries(Object.entries(needs).filter(([name]) => name !== "plan").map(([name, job]) => [name, job.result])))) {
    process.stderr.write(("ci-ok: required proof failed, was cancelled, or did not run") + "\n");
    process.exit(1);
  }
  process.stdout.write(("ci-ok: every required proof passed") + "\n");
}
