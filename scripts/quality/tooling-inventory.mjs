// SPDX-License-Identifier: LicenseRef-Proprietary
import path from "node:path";

const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const dependencyKinds = new Set(["npm", "cargo", "action", "container", "ci-tool"]);
const textFile = /\.(?:[cm]?[jt]sx?|rs|ya?ml|toml|json|sh|md)$/;
const toolBins = { oxlint: "oxlint", stylelint: "stylelint", typescript: "tsc", vitest: "vitest", "@playwright/test": "playwright", "@stryker-mutator/core": "stryker", "openapi-typescript": "openapi-typescript" };

// Cargo-generated lock records only, not a general TOML parser; metadata supplies resolved edges.
export function cargoPins(source) {
  return source.split(/^\[\[package\]\]\s*$/m).slice(1).map((block) => {
    const get = (key) => block.match(new RegExp(`^${key} = "([^"\\n]+)"$`, "m"))?.[1];
    const name = get("name"), version = get("version");
    if (!name || !version) throw new Error("invalid Cargo lock package record");
    return { name, version, source: get("source") ?? null, checksum: get("checksum") ?? null };
  });
}

export function layer(file, kind = "normal", name = "") {
  if (kind === "devDependencies" && (name === "typescript" || name.startsWith("@types/"))) return "build/tooling";
  if (kind !== "normal" && kind !== null) return kind === "dev" || kind === "devDependencies" ? "test" : "build/tooling";
  if (file.includes("/ci/") || file.startsWith(".github/")) return "CI/supply chain";
  if (file.includes("/fuzz/")) return "test";
  if (file.includes("/domain/") || file.includes("/kernel/") || file.includes("/canonical-domain/")) return "domain/entities";
  if (file.includes("/application/") || file.includes("/runtime/")) return "use cases";
  if (/\/(rest|adapter-[^/]+)\//.test(file)) return "interface adapters";
  if (file.startsWith("packages/api/")) return "web: data";
  if (file.startsWith("packages/i18n/")) return "web: UI";
  if (file.startsWith("apps/web/")) return "web: UI";
  return "frameworks & drivers/platform";
}

export function inventory(files, readInput, metadata = []) {
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) cache.set(file, readInput(file));
    return cache.get(file);
  };
  const rows = new Map();
  const add = (kind, name, use, extra = {}) => {
    const key = `${kind}:${name}`;
    const row = rows.get(key) ?? { kind, name, direct: false, uses: [], callsites: [], evidence: [] };
    if (use) { row.uses.push(use); row.direct = true; }
    Object.assign(row, extra);
    rows.set(key, row);
    return row;
  };
  const manifests = files.filter((f) => /(^|\/)package.json$/.test(f) && !f.startsWith("third-party/"));
  const platformFile = "deploy/versions.json";
  const platform = files.includes(platformFile) ? JSON.parse(read(platformFile)) : {};
  for (const [name, pin] of Object.entries(platform.tools ?? {})) add("ci-tool", name, { file: platformFile, user: "deploy/ci/tools.py", pin, layer: "CI/supply chain" });
  for (const pin of Object.values({ ...platform.images, ...platform.platformImages })) add("container", pin.split(/[:@]/)[0], { file: platformFile, user: "deploy", pin, layer: "CI/supply chain" });
  for (const [name, pin] of Object.entries(platform.sources ?? {})) add("ci-source", name, { file: platformFile, user: "deploy/ci/vendor.mjs", pin, layer: "CI/supply chain" });
  const internal = new Set(manifests.map((f) => JSON.parse(read(f)).name));
  for (const file of manifests) {
    const json = JSON.parse(read(file));
    for (const field of fields) for (const [name, requirement] of Object.entries(json[field] ?? {})) {
      if (!internal.has(name)) add("npm", name, { file, user: json.name, requirement, layer: layer(file, field === "dependencies" ? "normal" : field, name) });
    }
    const overrides = (value, chain = []) => {
      for (const [name, entry] of Object.entries(value)) {
        if (typeof entry === "object") overrides(entry, [...chain, name]);
        else add("npm", name, { file, user: json.name, requirement: entry, layer: "build/tooling", override: [...chain, name].join(" > ") });
      }
    };
    overrides(json.overrides ?? {});
  }
  if (files.includes("package-lock.json")) for (const [location, pin] of Object.entries(JSON.parse(read("package-lock.json")).packages ?? {})) {
    if (!location.includes("node_modules/") || pin.link) continue;
    const name = location.split("node_modules/").at(-1);
    const row = add("npm", name);
    row.pins ??= [];
    row.pins.push({ location, version: pin.version, license: pin.license ?? null, integrity: pin.integrity ?? null, source: pin.resolved ?? null });
    row.evidence = ["package-lock.json", `https://registry.npmjs.org/${encodeURIComponent(name)}`];
  }
  if (files.includes("package-lock.json")) for (const [location, pin] of Object.entries(JSON.parse(read("package-lock.json")).packages ?? {})) {
    for (const name of Object.keys({ ...pin.dependencies, ...pin.optionalDependencies })) {
      const row = rows.get(`npm:${name}`);
      if (row) row.resolvedParents = [...new Set([...(row.resolvedParents ?? []), location || "root manifest"])];
    }
  }
  for (const graph of metadata) {
    const members = new Set(graph.workspace_members);
    for (const pkg of graph.packages) {
      if (!members.has(pkg.id)) {
        const row = add("cargo", pkg.name);
        row.pins ??= [];
        row.pins.push({ version: pkg.version, license: pkg.license, source: pkg.source, repository: pkg.repository });
        row.job = pkg.description;
        row.evidence = [`https://docs.rs/${pkg.name}`, `https://crates.io/api/v1/crates/${pkg.name}`];
        continue;
      }
      for (const dep of pkg.dependencies) {
        if (dep.path && !dep.path.includes("third-party/")) continue;
        add("cargo", dep.name, { file: pkg.manifest_path, user: pkg.name, requirement: dep.req, alias: dep.rename ?? dep.name.replaceAll("-", "_"), layer: layer(pkg.manifest_path, dep.kind), kind: dep.kind ?? "normal", target: dep.target, features: dep.features, defaultFeatures: dep.uses_default_features });
      }
    }
  }
  for (const file of files.filter((f) => f.endsWith("Cargo.lock"))) for (const pin of cargoPins(read(file))) {
    if (pin.name.startsWith("console-")) continue;
    const row = add("cargo", pin.name);
    row.pins ??= [];
    row.pins.push({ ...pin, lockfile: file });
    row.evidence.push(file, `https://crates.io/api/v1/crates/${pin.name}`);
  }
  for (const file of files) {
    if (/^scripts\/check-.*\.mjs$/.test(file) && !file.endsWith(".test.mjs") || /^backend\/ci\/gates\/[^/]+\/Cargo.toml$/.test(file)) {
      const name = file.endsWith("Cargo.toml") ? path.dirname(file) : file;
      add("gate", name, { file, user: name, layer: "build/tooling" });
    }
    if (/^\.github\/workflows\/.*\.ya?ml$/.test(file)) {
      const source = read(file);
      for (const match of source.matchAll(/\buses:\s*["']?([\w.-]+\/[\w./-]+)@([^\s"'#]+)/g)) add("action", match[1], { file, user: file, pin: match[2], layer: "CI/supply chain" });
      for (const match of source.matchAll(/(?:docker:\/\/|\s)((?:[\w.-]+\/)*[\w.-]+)(:[\w.-]+)?(@sha256:[a-f\d]+)?(?=\s|$)/gm)) {
        if (!match[3] && !match[0].startsWith("docker://")) continue;
        add("container", match[1], { file, user: file, pin: `${match[2] ?? ""}${match[3] ?? ""}`, layer: "CI/supply chain" });
      }
      for (const match of source.matchAll(/https:\/\/github.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//g)) add("ci-tool", match[1].split("/")[1], { file, user: file, pin: match[2], layer: "CI/supply chain" }, { evidence: [`https://github.com/${match[1]}`] });
    }
    if (/(^|\/)(?:Dockerfile(?:\..*)?|[^/]+\.Dockerfile)$/.test(file)) {
      const stages = new Set();
      for (const match of read(file).matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
        const variable = match[1].match(/^\$\{(\w+)_IMAGE\}$/)?.[1];
        const pin = variable ? platform.images?.[variable.toLowerCase()] : match[1];
        if (!pin) throw new Error(`unresolved Dockerfile image argument: ${file}: ${match[1]}`);
        if (pin !== "scratch" && !stages.has(pin)) add("container", pin.split(/[:@]/)[0], { file, user: file, pin, layer: "CI/supply chain" });
        if (match[2]) stages.add(match[2]);
      }
    }
  }
  for (const row of rows.values()) {
    if (!row.direct || !["npm", "cargo"].includes(row.kind)) continue;
    const names = row.kind === "cargo" ? [...new Set(row.uses.map((u) => u.alias))] : [row.name, toolBins[row.name]].filter(Boolean);
    const owners = row.uses.map((u) => path.dirname(u.file));
    for (const file of files) {
      if (!textFile.test(file) || /(?:lock\.json|Cargo\.lock)$/.test(file) || file.startsWith("docs/") || file.startsWith("third-party/") || file.startsWith("scripts/quality/")) continue;
      if (row.kind === "npm" && /\.(rs|toml)$/.test(file)) continue;
      if (row.kind === "cargo" && !owners.some((o) => file.startsWith(`${o}/`))) continue;
      const lines = read(file).split("\n");
      const index = lines.findIndex((line) => names.some((n) => line.includes(n)));
      if (index >= 0) row.callsites.push(`${file}:${index + 1}`);
    }
  }
  return [...rows.values()].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

export function reviewRows(rows, reviews) {
  return rows.map((row) => {
    if (!row.direct) return { ...row, job: row.job ?? `Resolved implementation dependency of ${(row.resolvedParents ?? []).join(", ") || "the committed lock graph"}` };
    const review = reviews[`${row.kind}:${row.name}`];
    if (!review) throw new Error(`missing review: ${row.kind}:${row.name}`);
    if (review.class === "STANDARD" && (!review.approval || !review.architectureRecord ||
      !["a", "b", "c", "d", "e"].every((key) => review.standardTest?.[key]?.result === "pass" && review.standardTest[key].source)))
      throw new Error(`unproven STANDARD: ${row.kind}:${row.name}`);
    return { ...row, ...review, evidence: [...new Set([...(row.evidence ?? []), ...(review.evidence ?? [])])] };
  });
}

export function render(rows) {
  const direct = rows.filter((r) => r.direct);
  const dependencies = direct.filter((r) => dependencyKinds.has(r.kind));
  const approved = dependencies.filter((r) => r.class === "STANDARD").length;
  const pending = dependencies.filter((r) => r.class === "NEEDS-OWNER").length;
  const cell = (v) => String(v ?? "unmeasured").replaceAll("|", "&#124;").replaceAll("\n", " ");
  const out = [
    "<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->",
    "<!-- Generated by scripts/quality/generate-tooling-ledger.mjs; edit tooling-reviews.json and tooling-sources.json. -->",
    "# Dependency approval register and gate ledger", "",
    `Snapshot: 2026-10-26. ${direct.length} direct dependency/tool/gate rows. Resolved-only names are inventoried separately.`, "",
    `The [2026-10-26 ruling](dependency-ruling-2026-10-26.md) records ${approved} STANDARD approvals (including the three owner-approved bases); ${pending} direct dependencies remain NEEDS-OWNER. The four OpenTelemetry trace rows are NEEDS-OWNER because the Rust traces SDK is Beta. Inventory, allowlists and provenance alone confer no approval. No dependency was added, removed or swapped.`, "",
    `Owner decisions: [${pending} unresolved rows, grouped with one recommendation per group](dependency-owner-summary.md). Resolved-only names are technical inventory in [dependency-transitive-inventory.json](dependency-transitive-inventory.json), without classifications or rulings. Gates and vendored CI sources below are separate from the ${dependencies.length} direct dependency decisions.`, "",
    "Regenerate offline: node scripts/quality/generate-tooling-ledger.mjs --write. Verify: omit --write. Sources are dated snapshots, not live CI requests. JSON includes usages, targets, features, pins and textual call-site candidates. Candidates include manifests/configuration and require review before removal.", "",
    "Architecture: [frontend](../architecture/frontend-module-map.md), [backend](../architecture/backend-module-map.md). Proposed users confer no permission. Cross-ring uses are flagged, not grandfathered. Licence policies: [backend](../../backend/deny.toml), [desktop](../../apps/desktop/src-tauri/deny.toml).", "",
    "Footprint: npm unpacked bytes are not browser bundle KB; Rust transitive counts include target/build/dev edges, not compile time. Unmeasured bundle/compile deltas and unverified security processes are explicit. Review owner: Jason Lee; review date: 2026-10-26.", "",
  ];
  for (const group of [...new Set(direct.map((r) => r.group))].sort()) {
    out.push(`## ${group}`, "", "| Item / class / verdict | Job and failure without it | Alternatives / own code | Evidence / gaps | Layer, users, exit |", "| --- | --- | --- | --- | --- |");
    for (const r of direct.filter((r) => r.group === group)) {
      const sites = r.callsites.slice(0, 3).join(", ") || r.uses.map((u) => u.file).join(", ");
      const sources = r.evidence.map((s) => `[source](${s.startsWith("https://") ? s : `../../${s}`})`).join(" ");
      const criteria = Object.entries(r.standardTest ?? {}).map(([key, value]) => `${key}: ${cell(value.reason)} ([source](${value.source.startsWith("https://") ? value.source : `../../${value.source}`}))`).join("; ");
      out.push(`| ${cell(r.kind)}: **${cell(r.name)}** — ${cell(r.class)}; ${cell(r.verdict)}${r.recommendation ? `; recommendation: ${cell(r.recommendation)}` : ""} | ${cell(r.job)}; ${cell(sites)} | ${cell(r.alternatives)} | ${sources}; ${cell(r.reason)}; ${criteria}; licence: ${cell(r.license)}; release (latest upstream): ${cell(r.lastRelease)}; maintainers: ${cell(r.maintainers)}; security: ${cell(r.securityProcess)}; footprint: ${cell(r.footprint)} | ${cell(r.layer)}; ${r.approval ? "approved" : "proposed"} users: ${cell((r.approvedUsers ?? r.allowedUsers)?.join(", "))}; **layer findings: ${cell(r.layerFindings?.join("; ") || "none")}**; exit: ${cell(r.exitPlan)} |`);
    }
    out.push("");
  }
  out.push("## Rule preservation", "");
  for (const r of direct.filter((r) => r.kind === "gate")) out.push(`- ${r.name}: ${r.ruleMapping}`);
  out.push("", "No gate is deleted. Replacement is conditional on owner approval, an architecture record, planted-case parity and PR-tier timing. Slice 3 applies one verdict at a time; slice 4 enforces approvals, layers and ledger coverage in npm run check.", "");
  return out.join("\n");
}

export function renderOwnerSummary(rows, groups) {
  const pending = rows.filter((r) => r.direct && dependencyKinds.has(r.kind) && r.class === "NEEDS-OWNER");
  const out = ["<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->", "<!-- Generated by scripts/quality/generate-tooling-ledger.mjs; edit tooling-owner-groups.json. -->", "# Dependency decisions for the owner", "", ...(groups._status ? [groups._status, ""] : []), `${pending.length} unresolved direct dependency rows. Recommendations are proposals, not approvals or instructions to change packages. [Evidence and individual reasons](dependency-register.md); [ruling](dependency-ruling-2026-10-26.md).`, "", "| Group (rows) | Dependencies needing a ruling | One recommendation for the group |", "| --- | --- | --- |"];
  for (const group of [...new Set(pending.map((r) => r.group))].sort()) {
    if (!groups[group]) throw new Error(`missing owner group recommendation: ${group}`);
    const members = pending.filter((r) => r.group === group);
    out.push(`| ${group} (${members.length}) | ${members.map((r) => `\`${r.kind}:${r.name}\``).join(", ")} | ${groups[group]} |`);
  }
  return out.join("\n") + "\n";
}

export function renderArchitecture(rows, file, title) {
  const approved = rows.filter((r) => r.class === "STANDARD" && r.architectureRecord === file);
  const out = ["<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->", "<!-- Generated by scripts/quality/generate-tooling-ledger.mjs from tooling-reviews.json. -->", `# ${title} dependencies by layer`, "", "Approved under the [2026-10-26 ruling](../quality/dependency-ruling-2026-10-26.md). Each dependency has one home layer; explicitly listed outer-ring and test uses below are limited to that dependency's job and exact users. Existing out-of-scope declarations remain findings in the [register](../quality/dependency-register.md), not new exceptions. Domain/entities and use cases remain independent of framework types. Existing layer-boundary gates stay in force; approval enforcement is a later slice.", "", "| Dependency | Home layer | Allowed users and use layers | Approving ruling | Exit plan |", "| --- | --- | --- | --- | --- |"];
  for (const row of approved) {
    const users = row.allowedLayers.map((layer) => {
      const names = [...new Set(row.approvedUses.filter((u) => u.layer === layer).map((u) => u.user))].sort();
      return names.length ? `${layer}: ${names.map((name) => `\`${name}\``).join(", ")}` : "";
    }).filter(Boolean).join("; ");
    out.push(`| \`${row.kind}:${row.name}\` | ${row.layer} | ${users} | [${row.approval.ruling}](../quality/dependency-ruling-2026-10-26.md) | ${row.exitPlan} |`);
  }
  out.push("", "No other dependency is approved by this map. Proposed choices and the unresolved owner queue remain in the register; a manifest, lock, licence allowlist or historical comment is not a ruling.", "");
  return out.join("\n");
}
