#!/usr/bin/env node
// Client contract gate: packages/api/src/schema.d.ts must be exactly what openapi-typescript
// generates from the backend's committed contract (backend/openapi/openapi.yaml) at the backend
// sha this client ships with. `npm run gen:api` writes it (--write); `npm run check` fails on any
// difference, so the types can never lag the server unnoticed.
//
// The contract comes from this repository's HEAD, never a sibling checkout or local backend overrides.
// Reading from git rather than the working tree binds the generated types to one committed contract.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "backend/openapi/openapi.yaml";
const OPS_SPEC = "backend/openapi/ops.yaml";
const GEN = path.join(ROOT, "node_modules/.bin/openapi-typescript");

const git = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

// Returns { ok, message }. Every unknown (no repo, no ref, no spec, generator failure) is a failure.
export function checkApiSchema({ repo, ref = "HEAD", out, write = false, specPath = SPEC }) {
  const fix = "regenerate: npm run gen:api";
  if (!existsSync(repo)) return { ok: false, message: `backend repo not found at ${repo}` };
  const sha = git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
  if (sha.status !== 0) return { ok: false, message: `backend ref ${ref} does not resolve in ${repo}: ${sha.stderr.trim()}` };
  const at = sha.stdout.trim();
  const spec = git(repo, "show", `${at}:${specPath}`);
  if (spec.status !== 0) return { ok: false, message: `${specPath} is missing at backend ${at}: ${spec.stderr.trim()}` };
  const tmp = mkdtempSync(path.join(tmpdir(), "api-schema-"));
  try {
    writeFileSync(path.join(tmp, "openapi.yaml"), spec.stdout);
    const gen = spawnSync(GEN, [path.join(tmp, "openapi.yaml"), "-o", path.join(tmp, "schema.d.ts")], { encoding: "utf8" });
    if (gen.status !== 0) return { ok: false, message: `openapi-typescript failed on backend ${at}:\n${gen.stdout}${gen.stderr}` };
    const want = (specPath === OPS_SPEC ? "// SPDX-License-Identifier: LicenseRef-Proprietary\n" : "") + readFileSync(path.join(tmp, "schema.d.ts"), "utf8");
    const label = `${path.relative(ROOT, out) || out} vs backend ${at.slice(0, 12)} (${specPath})`;
    if (write) {
      writeFileSync(out, want);
      return { ok: true, message: `wrote ${label}` };
    }
    const have = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (have === want) return { ok: true, message: `api schema matches ${label}` };
    if (have === null) return { ok: false, message: `${out} is missing; ${fix}` };
    const a = have.split("\n");
    const b = want.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return {
      ok: false,
      message: `api schema drift: ${label}\nfirst difference at line ${i + 1}:\n- ${a[i] ?? "<end>"}\n+ ${b[i] ?? "<end>"}\n${fix}`,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let ok = true;
  if (!process.argv.includes("--write")) {
    const composed = spawnSync("cargo", ["run", "--quiet", "--locked", "--manifest-path", path.join(ROOT, "backend/Cargo.toml"), "-p", "console-contracts", "--bin", "console-openapi-gen", "--", "--check-ops"], { cwd: ROOT, encoding: "utf8" });
    if (composed.status !== 0) {
      console.error(`ops contract composition check failed:\n${composed.stdout ?? ""}${composed.stderr ?? ""}${composed.error ?? ""}`);
      ok = false;
    }
  }
  for (const [specPath, output] of [[SPEC, "schema.d.ts"], [OPS_SPEC, "ops-schema.d.ts"]]) {
    const r = checkApiSchema({ repo: ROOT, specPath, out: path.join(ROOT, "packages/api/src", output), write: process.argv.includes("--write") });
    (r.ok ? console.log : console.error)(r.message);
    ok = r.ok && ok;
  }
  process.exit(ok ? 0 : 1);
}
