// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbContract, postgresImage } from "./db-contract.mjs";

const privacyGates = ["personal-data-classification", "pii-no-logs", "tenant-isolation", "rls-arming", "audit-coverage"];

export function rustBuild(crates, packages) {
  const selected = packages.filter((pkg) => crates.includes(pkg.name));
  const db = [...dbCrates(packages)].filter((name) => crates.includes(name)).sort();
  const unitFilter = `kind(lib)${db.length ? ` & not (${db.map((name) => `package(=${name})`).join(" + ")})` : ""}`;
  return {
    crates: [...crates].sort(),
    features: selected.flatMap((pkg) => ["full", "test-postgres"].filter((f) => Object.hasOwn(pkg.features ?? {}, f)).map((f) => `${pkg.name}/${f}`)).join(","),
    unitFilter, dbFilter: `not (${unitFilter})`,
  };
}

export function planBudget(plan, config, shards) {
  const queue = JSON.parse(readFileSync(new URL("../../.github/rulesets/dev.json", import.meta.url), "utf8")).rules.find((rule) => rule.type === "merge_queue");
  if (config.maxTotalMinutes >= queue.parameters.check_response_timeout_minutes) throw new Error("CI minute budget must be below the merge-queue timeout");
  const estimates = config.jobMinutes;
  const jobs = [estimates.plan, estimates.hygiene, estimates.gate];
  if (plan.web || plan.e2e) jobs.push(estimates.web);
  if (plan.backend || plan.e2e) jobs.push(estimates.build);
  if (plan.backend) {
    jobs.push(...Array(privacyGates.length).fill(estimates.privacyGate));
    for (const mode of ["unit", "db"]) if (plan[mode]) jobs.push(...Array(config.nextestPartitions[mode]).fill(estimates[mode]));
  }
  if (plan.e2e) {
    jobs.push(estimates.e2ePlan);
    jobs.push(...(shards ?? Array(config.e2eMaxShards).fill({ est: config.e2eTargetSeconds })).map((job) => estimates.e2eSetup + job.est / 60));
  }
  const minutes = Math.ceil(jobs.reduce((a, b) => a + b, 0));
  if (jobs.length > config.maxJobs) throw new Error("CI plan exceeds job budget");
  if (!Number.isFinite(minutes) || minutes > config.maxTotalMinutes) throw new Error("CI plan exceeds summed minute budget");
  return { jobs: jobs.length, minutes };
}

export function dbCrates(packages) {
  const selected = new Set(packages.filter((p) => p.dependencies.some((d) => d.name === "sqlx")).map((p) => p.name));
  return new Set(dependents(selected, packages, (p) => p.dependencies.map((d) => d.name)));
}

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
    "backend-test": plan.unit ?? plan.backend,
    "backend-db": plan.db ?? plan.backend,
    "e2e-plan": plan.e2e,
    e2e: plan.e2e,
    ...Object.fromEntries(privacyGates.map((name) => [name, plan.backend])),
    hygiene: true,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
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
  const app = cargo.find((pkg) => path.relative(root, path.dirname(pkg.manifest_path)) === "backend/app")?.name;
  const build = { ...rustBuild(plan.backend ? plan.crates : plan.e2e ? [app] : [], cargo), full: plan.full };
  const db = dbCrates(cargo);
  const targets = cargo.filter((p) => plan.crates.includes(p.name)).flatMap((p) => (p.targets ?? []).filter((t) => t.test).map((t) => t.kind.includes("lib") && !db.has(p.name) ? "unit" : "db"));
  plan.unit = plan.backend && targets.includes("unit");
  plan.db = plan.backend && targets.includes("db");
  const matrix = (mode) => ({ include: plan[mode] ? Array.from({ length: config.nextestPartitions[mode] }, (_, i) => ({ partition: i + 1 })) : [] });
  const budget = planBudget(plan, config);
  const browserVersion = JSON.parse(readFileSync("package-lock.json", "utf8")).packages["node_modules/@playwright/test"].version;
  const outputs = { ...plan, base: base ?? "", build: build, budget, unitMatrix: matrix("unit"), dbMatrix: matrix("db"), required: requiredJobs(plan), postgres: pin, retention: config.retentionDays, browserVersion, testAdmin: dbContract().admin, database: config.database };
  for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === "object" ? JSON.stringify(value) : value}\n`);
}
