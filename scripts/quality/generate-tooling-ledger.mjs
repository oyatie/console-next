// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, render, renderArchitecture, renderOwnerSummary, reviewRows } from "./tooling-inventory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const tools = [
  ["Rust", "rust-toolchain.toml", JSON.parse(read("rust-toolchain.toml").match(/^channel\s*=\s*("[^"]+")/m)[1]), "build/tooling"],
  ["Node.js", "package.json", JSON.parse(read("package.json")).engines.node, "build/tooling"],
  ["npm", ".github/workflows/ci.yml", "runner bundled; not pinned", "CI/supply chain"],
  ["Chromium", ".github/workflows/ci.yml", "Playwright lock pin", "test"],
].map(([name, file, pin, layer]) => ({ kind: "ci-tool", name, direct: true, uses: [{ file, user: file, pin, layer }], callsites: [], evidence: [] }));
// Refresh an existing dependency/tool/image pin without reclassifying it or requiring Cargo metadata.
const pins = process.argv.find((arg) => arg.startsWith("--pins="))?.slice("--pins=".length);
if (pins) {
  const register = JSON.parse(read("docs/quality/dependency-register.json"));
  const current = [...inventory(files, read), ...tools];
  const selected = register.rows.filter((r) => ["container", "ci-tool", "npm"].includes(r.kind) && `${r.kind}:${r.name}` === pins);
  if (selected.length !== 1) throw new Error(`unregistered tool/image: ${pins}; run full review`);
  for (const row of selected) {
    const observed = current.find((r) => r.kind === row.kind && r.name === row.name);
    for (const use of row.uses) {
      const matches = observed?.uses.filter((u) => u.file === use.file && u.user === use.user && u.layer === use.layer && u.override === use.override);
      if (matches?.length !== 1) throw new Error(`tool/image use changed: ${row.name} in ${use.file}; run full review`);
      const field = row.kind === "npm" ? "requirement" : "pin";
      use[field] = matches[0][field];
    }
    if (row.kind === "npm") row.pins = observed.pins;
  }
  for (const [file, body] of [
    ["docs/quality/dependency-register.json", JSON.stringify(register, null, 2) + "\n"],
    ["docs/quality/dependency-register.md", render(register.rows)],
  ]) {
    if (process.argv.includes("--write")) writeFileSync(resolve(root, file), body);
    else if (read(file) !== body) throw new Error(`${file}: stale pins; regenerate with --pins=${pins} --write`);
  }
  console.log(`tooling ledger: ${pins} pins refreshed`);
  process.exit(0);
}
const graphs = files.filter((f) => f.endsWith("Cargo.lock")).map(dirname).map((dir) => {
  // The fuzz lock is already stale on the base; declarations remain enumerable without resolving it.
  const args = ["metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", `${dir}/Cargo.toml`, ...(dir.endsWith("fuzz") ? ["--no-deps"] : [])];
  const graph = JSON.parse(execFileSync("cargo", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  for (const pkg of graph.packages) pkg.manifest_path = relative(root, pkg.manifest_path);
  return graph;
});
const rows = inventory(files, read, graphs);
rows.push(...tools);
const reviews = JSON.parse(read("scripts/quality/tooling-reviews.json"));
const sourcesPath = "scripts/quality/tooling-sources.json";
const fetchJSON = async (url) => {
  const response = await fetch(url, { headers: { "User-Agent": "console-tooling-register" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};
if (process.argv.includes("--refresh")) {
  const snapshot = JSON.parse(read(sourcesPath)).entries;
  for (const row of rows.filter((r) => r.direct && ["npm", "cargo"].includes(r.kind))) {
    const key = `${row.kind}:${row.name}`;
    const url = row.kind === "npm" ? `https://registry.npmjs.org/${encodeURIComponent(row.name)}` : `https://crates.io/api/v1/crates/${row.name}`;
    try {
      const data = await fetchJSON(url);
      if (row.kind === "npm") {
        const version = data["dist-tags"].latest;
        const downloads = await fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(row.name)}`);
        snapshot[key] = { source: url, latest: version, lastRelease: data.time[version], license: data.versions[version].license, maintainers: data.maintainers.map((m) => m.name), repository: data.repository, unpackedBytes: data.versions[version].dist.unpackedSize, downloads };
      } else snapshot[key] = { source: url, latest: data.crate.max_version, lastRelease: data.versions[0].created_at, license: data.versions[0].license, maintainers: "registry owners not yet independently reviewed", repository: data.crate.repository, downloads: data.crate.recent_downloads };
    } catch (error) { snapshot[key] = { ...snapshot[key], source: url, unavailable: error.message }; }
  }
  const upstreams = new Map();
  for (const row of rows.filter((r) => r.direct && ["action", "container", "ci-tool", "ci-source"].includes(r.kind))) {
    const repo = reviews[`${row.kind}:${row.name}`]?.evidence.find((s) => s.startsWith("https://github.com/"))?.split("/").slice(3, 5).join("/");
    if (!repo) continue;
    const url = `https://api.github.com/repos/${repo}`;
    try {
      if (!upstreams.has(repo)) upstreams.set(repo, await Promise.all([fetchJSON(url), fetchJSON(`${url}/releases/latest`)]));
      const [project, release] = upstreams.get(repo);
      snapshot[`${row.kind}:${row.name}`] = { source: url, latest: release.tag_name, lastRelease: release.published_at, license: project.license?.spdx_id, maintainers: project.owner.login, archived: project.archived, repository: project.html_url };
    } catch (error) { snapshot[`${row.kind}:${row.name}`] = { ...snapshot[`${row.kind}:${row.name}`], source: url, unavailable: error.message }; }
  }
  writeFileSync(resolve(root, sourcesPath), JSON.stringify({ generatedBy: "generate-tooling-ledger.mjs --refresh", checked: "2026-10-26", entries: snapshot }, null, 2) + "\n");
}
const sources = JSON.parse(read(sourcesPath));
const closure = (id, edges, seen = new Set()) => {
  if (seen.has(id)) return seen;
  seen.add(id);
  for (const next of edges.get(id) ?? []) closure(next, edges, seen);
  return seen;
};
const cargoCounts = new Map();
for (const graph of graphs.filter((g) => g.resolve)) {
  const edges = new Map(graph.resolve.nodes.map((n) => [n.id, n.dependencies]));
  for (const pkg of graph.packages) {
    const pins = cargoCounts.get(pkg.name) ?? [];
    pins.push({ version: pkg.version, transitiveCount: closure(pkg.id, edges).size - 1 });
    cargoCounts.set(pkg.name, pins);
  }
}
const npmEdges = new Map();
for (const [location, pin] of Object.entries(JSON.parse(read("package-lock.json")).packages)) {
  if (!location.includes("node_modules/")) continue;
  const name = location.split("node_modules/").at(-1);
  npmEdges.set(name, [...new Set([...(npmEdges.get(name) ?? []), ...Object.keys({ ...pin.dependencies, ...pin.optionalDependencies })])]);
}
for (const row of rows.filter((r) => r.direct)) {
  const review = reviews[`${row.kind}:${row.name}`];
  if (!review) throw new Error(`missing review: ${row.kind}:${row.name}`);
  const source = sources.entries[`${row.kind}:${row.name}`];
  if (source) {
    row.evidence.push(source.source);
    row.lastRelease = source.lastRelease ?? `unavailable: ${source.unavailable}`;
    row.license = [...new Set((row.pins ?? []).map((p) => p.license).filter(Boolean))].join(" / ") || `unverified at pinned version; latest upstream: ${source.license ?? "unknown"}`;
    row.maintainers = Array.isArray(source.maintainers) ? source.maintainers.join(", ") : source.maintainers;
    row.adoption = source.downloads;
    row.footprint = source.unpackedBytes ? `${source.unpackedBytes} unpacked bytes (latest registry release); bundle delta unmeasured` : "compile/bundle delta unmeasured";
    row.sourceSnapshot = source;
  }
  row.allowedUsers = [...new Set(row.uses.map((u) => u.user))].sort();
  row.resolvedFootprint = row.kind === "npm" ? { uniqueTransitiveNamesAcrossAllLockVersions: closure(row.name, npmEdges).size - 1 } : cargoCounts.get(row.name) ?? null;
  row.observedLayers = [...new Set(row.uses.map((u) => u.layer))].sort();
  row.layerFindings = row.uses.flatMap((u) => {
    if (!review.allowedLayers.includes(u.layer)) return [`${u.user}: ${u.layer} outside ${review.approval ? "approved" : "proposed"} ${review.allowedLayers.join(", ")}`];
    if (review.approvedUses && !review.approvedUses.some((approved) => approved.user === u.user && approved.layer === u.layer)) return [`${u.user}: ${u.layer} use is not in the exact approved users`];
    return [];
  });
  row.evidence = [...new Set([...row.evidence, ...review.evidence])];
}
const reviewed = reviewRows(rows, reviews).sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
const direct = reviewed.filter((r) => r.direct);
const output = { generatedBy: "node scripts/quality/generate-tooling-ledger.mjs --write", reviewedOn: sources.checked, limitations: ["Fuzz lock is stale on base: declarations and committed pins included; stale dependency edges are not inferred.", "Calls are textual candidates, not proof of dead code.", "No dependency approved by inventory presence; no new gate enforcement until slice 4."], rows: direct };
const transitive = { generatedBy: output.generatedBy, reviewedOn: sources.checked, note: "Resolved implementation inventory only; no independent classifications, recommendations or approval rulings.", rows: reviewed.filter((r) => !r.direct) };
const outputs = [
  ["docs/quality/dependency-register.json", JSON.stringify(output, null, 2) + "\n"],
  ["docs/quality/dependency-register.md", render(direct)],
  ["docs/quality/dependency-transitive-inventory.json", JSON.stringify(transitive, null, 2) + "\n"],
  ["docs/quality/dependency-owner-summary.md", renderOwnerSummary(direct, JSON.parse(read("scripts/quality/tooling-owner-groups.json")))],
  ...["backend", "frontend"].map((name) => {
    const file = `docs/architecture/${name}-module-map.md`;
    return [file, renderArchitecture(direct, file, name === "backend" ? "Backend" : "Frontend")];
  }),
];
for (const [file, body] of outputs) {
  if (process.argv.includes("--write")) writeFileSync(resolve(root, file), body);
  else if (read(file) !== body) throw new Error(`${file}: stale; regenerate with --write`);
}
console.log(`tooling ledger: ${reviewed.filter((r) => r.direct).length} direct/tool/gate rows; ${reviewed.length} total names`);
