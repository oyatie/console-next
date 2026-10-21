#!/usr/bin/env node
// Client contract gate: packages/api/src/schema.d.ts must be exactly what openapi-typescript
// generates from the backend's committed contract (backend/openapi/openapi.yaml) at the backend
// sha this client ships with. `npm run gen:api` writes it (--write); `npm run check` fails on any
// difference, so the types can never lag the server unnoticed.
//
// The pair: CONSOLE_REPO (the backend tree E2E and the lander already use; default this repository
// when it carries backend/ (the public monorepo), else the backend-mvp checkout beside the main
// console-react checkout) at CONSOLE_BACKEND_REF (default HEAD). The contract is read from git, never the working tree, so the check names one sha.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "backend/openapi/openapi.yaml";
const GEN = path.join(ROOT, "node_modules/.bin/openapi-typescript");

const git = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

export function defaultRepo() {
  if (process.env.CONSOLE_REPO) return path.resolve(process.env.CONSOLE_REPO);
  if (existsSync(path.join(ROOT, SPEC))) return ROOT;
  // A worktree's main checkout is the parent of git's common dir.
  const common = git(ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
  return path.resolve(path.dirname(common || path.join(ROOT, ".git")), "../frontend/backend-mvp");
}

// Returns { ok, message }. Every unknown (no repo, no ref, no spec, generator failure) is a failure.
export function checkApiSchema({ repo, ref = "HEAD", out, write = false }) {
  const fix = `regenerate: CONSOLE_REPO=<backend tree> CONSOLE_BACKEND_REF=<sha> npm run gen:api`;
  if (!existsSync(repo)) return { ok: false, message: `backend repo not found at ${repo} (set CONSOLE_REPO)` };
  const sha = git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
  if (sha.status !== 0) return { ok: false, message: `backend ref ${ref} does not resolve in ${repo}: ${sha.stderr.trim()}` };
  const at = sha.stdout.trim();
  const spec = git(repo, "show", `${at}:${SPEC}`);
  if (spec.status !== 0) return { ok: false, message: `${SPEC} is missing at backend ${at}: ${spec.stderr.trim()}` };
  const tmp = mkdtempSync(path.join(tmpdir(), "api-schema-"));
  try {
    writeFileSync(path.join(tmp, "openapi.yaml"), spec.stdout);
    const gen = spawnSync(GEN, [path.join(tmp, "openapi.yaml"), "-o", path.join(tmp, "schema.d.ts")], { encoding: "utf8" });
    if (gen.status !== 0) return { ok: false, message: `openapi-typescript failed on backend ${at}:\n${gen.stdout}${gen.stderr}` };
    const want = readFileSync(path.join(tmp, "schema.d.ts"), "utf8");
    const label = `${path.relative(ROOT, out) || out} vs backend ${at.slice(0, 12)} (${SPEC})`;
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
  const r = checkApiSchema({
    repo: defaultRepo(),
    ref: process.env.CONSOLE_BACKEND_REF || "HEAD",
    out: path.join(ROOT, "packages/api/src/schema.d.ts"),
    write: process.argv.includes("--write"),
  });
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}
