// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(join(root, file), "utf8");
const run = (bin, args) => spawnSync(bin, args, { cwd: root, encoding: "utf8" });
const oxlint = join(root, "node_modules/.bin/oxlint");
const config = run(oxlint, ["-c", "oxlint.json", "--print-config"]);
assert.equal(config.status, 0, config.stderr);
const effective = JSON.parse(config.stdout);
assert.ok(Object.keys(effective.rules).length > 0, "empty effective rules are not evidence");
const version = run(oxlint, ["--version"]).stdout.trim();
assert.ok(version.includes(JSON.parse(read("package-lock.json")).packages["node_modules/oxlint"].version), "installed oxlint differs from the lock pin");
const directory = mkdtempSync(join(tmpdir(), "linter-evidence-"));
const probes = {};
try {
  for (const [name, source] of Object.entries({
    "floating-promise.ts": "async function save() { return 1; }\nsave();\n",
    "playwright-wait.ts": "declare const page: { waitForTimeout(ms: number): Promise<void> };\npage.waitForTimeout(100);\n",
    "conditional-hook.tsx": "import { useState } from 'react';\nexport function Probe({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }\n",
  })) {
    const file = join(directory, name);
    writeFileSync(file, source);
    const result = run(oxlint, ["-c", join(root, "oxlint.json"), file]);
    assert.ok([0, 1].includes(result.status), result.stderr || "oxlint failed to execute");
    probes[name] = { source, status: result.status, diagnostics: (result.stdout + result.stderr).replaceAll(directory, "<fixture>") };
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
const evidence = {
  generatedBy: "node scripts/quality/linter-evidence.mjs --write",
  version, lintCommand: JSON.parse(read("package.json")).scripts.lint,
  configSha256: createHash("sha256").update(read("oxlint.json")).digest("hex"),
  effective, probes,
};
const target = "docs/quality/linter-evidence.json";
if (process.argv.includes("--refresh")) {
  const candidates = [];
  for (const name of ["eslint", "typescript-eslint", "eslint-plugin-react-hooks", "eslint-plugin-jsx-a11y", "eslint-plugin-playwright", "eslint-plugin-react", "eslint-plugin-import", "eslint-plugin-react-refresh", "eslint-plugin-oxlint", "oxlint-tsgolint", "@biomejs/biome", "prettier"]) {
    const source = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, `${source}: ${response.status}`);
    const data = await response.json(), latest = data["dist-tags"].latest;
    const adoptionSource = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`;
    const adoption = await fetch(adoptionSource, { signal: AbortSignal.timeout(20000) });
    assert.ok(adoption.ok, `${adoptionSource}: ${adoption.status}`);
    candidates.push({ name, source, latest, lastRelease: data.time[latest], license: data.versions[latest].license, maintainers: data.maintainers.map((m) => m.name), repository: data.repository, adoptionSource, adoption: await adoption.json(), approval: null });
  }
  writeFileSync(join(root, "docs/quality/linter-candidates.json"), JSON.stringify({ generatedBy: "node scripts/quality/linter-evidence.mjs --refresh", candidates }, null, 2) + "\n");
}
if (process.argv.includes("--write")) {
  const measurements = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now(), result = run("npm", ["run", "lint"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    measurements.push((performance.now() - start) / 1000);
  }
  evidence.timing = { command: "npm run lint", node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model, seconds: measurements };
  writeFileSync(join(root, target), JSON.stringify(evidence, null, 2) + "\n");
} else {
  const recorded = JSON.parse(read(target));
  delete recorded.timing;
  assert.deepEqual(evidence, recorded, "linter evidence drift; regenerate with --write");
}
console.log(`linter evidence: ${Object.keys(effective.rules).length} effective rules, ${effective.overrides.length} overrides, ${Object.keys(probes).length} probes`);
