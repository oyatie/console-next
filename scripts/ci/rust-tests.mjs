// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

// Any library with a transitive SQLx dependency runs with the DB; integration binaries
// also run there. Mixed unit/DB binaries therefore never lose their database tests.
const metadata = JSON.parse(readFileSync("../.cache/ci/metadata.json", "utf8"));
const db = new Set(metadata.packages.filter((p) => p.name === "sqlx").map((p) => p.id));
for (let size = -1; size !== db.size;) {
  size = db.size;
  for (const node of metadata.resolve.nodes) if (node.dependencies.some((id) => db.has(id))) db.add(node.id);
}
const packages = metadata.packages.filter((p) => metadata.workspace_members.includes(p.id));
const plain = packages.filter((p) => !db.has(p.id)).map((p) => `package(=${p.name})`).join(" + ");
const unit = `kind(lib) & (${plain || "none()"})`;
const affected = JSON.parse(process.env.AFFECTED_CRATES);
const selected = affected.map((name) => `package(=${name})`).join(" + ") || "none()";
const config = JSON.parse(readFileSync("../scripts/ci/config.json", "utf8"));
const [mode, partition] = process.argv.slice(2);
if (!["unit", "db"].includes(mode) || !Number.isInteger(Number(partition)) || Number(partition) < 1 || Number(partition) > config.nextestPartitions) throw new Error("invalid Rust test partition");
mkdirSync("../.cache/ci/extracted", { recursive: true });
const result = spawnSync("cargo", ["nextest", "run", "--config-file", "../.config/nextest.toml", "--profile", "ci", "--archive-file", "../.cache/ci/workspace.tar.zst", "--workspace-remap", ".", "--extract-to", "../.cache/ci/extracted", "--partition", `slice:${partition}/${config.nextestPartitions}`, "--no-tests=pass", "--no-fail-fast", "--failure-output", "never", "--success-output", "never", "-E", `(${selected}) & (${mode === "db" ? `not (${unit})` : unit})`], { stdio: "inherit" });
process.exit(result.status ?? 1);
