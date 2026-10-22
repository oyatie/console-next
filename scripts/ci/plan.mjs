// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbContract, postgresImage } from "./db-contract.mjs";

function dependents(selected, packages, depends) {
  for (let size = -1; size !== selected.size;) {
    size = selected.size;
    for (const pkg of packages) if (depends(pkg).some((name) => selected.has(name))) selected.add(pkg.name);
  }
  return [...selected].sort();
}

export function affected(files, cargo, npm, root, force = false) {
  const relative = (pkg) => path.relative(root, path.dirname(pkg.manifest_path));
  const within = (file, dir) => file === dir || file.startsWith(`${dir}/`);
  const shared = /(^|\/)(Cargo\.(toml|lock)|rust-toolchain(\.toml)?|package(-lock)?\.json|migrations|openapi)(\/|$)|^(\.github|\.config|scripts|ops|third-party|registry)\//;
  const docs = (file) => /^(docs\/|.*\.md$)/.test(file);
  const full = force || files.some((file) => shared.test(file) || (!docs(file) && ![...cargo.map(relative), ...npm.map((p) => p.dir), "e2e", "apps", "packages"].some((dir) => within(file, dir))));
  const crates = full ? cargo.map((p) => p.name).sort() : dependents(new Set(cargo.filter((p) => files.some((f) => within(f, relative(p)))).map((p) => p.name)), cargo,
    (pkg) => pkg.dependencies.map((dep) => cargo.find((p) => dep.path === path.dirname(p.manifest_path))?.name).filter(Boolean));
  const workspaces = full ? npm.map((p) => p.name).sort() : dependents(new Set(npm.filter((p) => files.some((f) => within(f, p.dir))).map((p) => p.name)), npm,
    (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  const backend = full || crates.length > 0;
  const web = full || workspaces.length > 0 || files.some((f) => /^(apps|packages)\//.test(f));
  const app = cargo.find((pkg) => relative(pkg) === "backend/app");
  return { full, crates, workspaces, backend, web, e2e: full || (app !== undefined && crates.includes(app.name)) || web || files.some((f) => /^(e2e\/|playwright.*\.ts$)/.test(f)) };
}

export function requiredJobs(plan) {
  return {
    web: plan.web || plan.e2e,
    "rust-build": plan.backend || plan.e2e,
    "backend-test": plan.backend,
    "backend-db": plan.backend,
    "e2e-plan": plan.e2e,
    e2e: plan.e2e,
    ...Object.fromEntries(["personal-data-classification", "pii-no-logs", "tenant-isolation", "rls-arming", "audit-coverage"].map((name) => [name, plan.backend])),
    hygiene: true,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base.sha ?? event.before;
  const force = process.env.GITHUB_EVENT_NAME === "merge_group" || !base || /^0+$/.test(base);
  const files = force ? [] : execFileSync("git", ["diff", "--name-only", "-z", base, "HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const cargo = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", "backend/Cargo.toml", "--format-version", "1", "--no-deps", "--locked"], { encoding: "utf8" })).packages;
  const npm = JSON.parse(readFileSync("package.json", "utf8")).workspaces.flatMap((glob) => {
    const parent = glob.replace(/\/\*$/, "");
    return readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      try { return [{ ...JSON.parse(readFileSync(`${parent}/${d.name}/package.json`, "utf8")), dir: `${parent}/${d.name}` }]; }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    });
  });
  const plan = affected(files, cargo, npm, root, force);
  // The existing census harness owns the image pin; service jobs consume this output.
  const pin = postgresImage();
  const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
  const browserVersion = JSON.parse(readFileSync("package-lock.json", "utf8")).packages["node_modules/@playwright/test"].version;
  const outputs = { ...plan, required: requiredJobs(plan), postgres: pin, retention: config.retentionDays, partitions: Array.from({ length: config.nextestPartitions }, (_, i) => i + 1), browserVersion, testAdmin: dbContract().admin, database: config.database };
  for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === "object" ? JSON.stringify(value) : value}\n`);
}
