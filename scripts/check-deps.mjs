#!/usr/bin/env node
// Dependency gate (EN-5): every external package named in a workspace package.json must be on
// scripts/dependency-allowlist.json, so adding one is a visible allowlist edit in review. Workspace
// packages (@console/*) are in-repo and always allowed. Stale allowlist entries also fail, so the
// list shrinks when a dependency is dropped.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// manifests: [{ file, json }]; returns the problem lines (empty = pass).
export function checkDeps(manifests, allowlist) {
  const internal = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const allowed = new Set(allowlist);
  const used = new Set();
  const problems = [];
  for (const { file, json } of manifests) {
    for (const field of FIELDS) {
      for (const name of Object.keys(json[field] ?? {})) {
        if (internal.has(name)) continue;
        used.add(name);
        if (!allowed.has(name)) problems.push(`${file}: ${field} "${name}" is not on the allowlist`);
      }
    }
  }
  for (const name of allowed) if (!used.has(name)) problems.push(`allowlist: "${name}" is not used by any package.json`);
  return problems;
}

// Root manifest plus every workspace manifest; workspace globs are "dir/*" only.
export function readManifests(root) {
  const read = (file) => ({ file, json: JSON.parse(readFileSync(path.join(root, file), "utf8")) });
  const top = read("package.json");
  const out = [top];
  for (const glob of top.json.workspaces ?? []) {
    if (!glob.endsWith("/*") || glob.slice(0, -2).includes("*")) throw new Error(`unsupported workspace glob: ${glob}`);
    const dir = glob.slice(0, -2);
    if (!existsSync(path.join(root, dir))) continue;
    for (const name of readdirSync(path.join(root, dir)).sort()) {
      const file = path.join(dir, name, "package.json");
      if (existsSync(path.join(root, file))) out.push(read(file));
    }
  }
  return out;
}

// Added/changed requirements need version-specific registry/provenance evidence, not just an allowlist edit.
export function checkDependencyNotes(manifests, previous, notes, lock, readNote) {
  const internal = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const problems = [];
  for (const { file, json } of manifests) {
    for (const field of FIELDS) {
      for (const [name, requirement] of Object.entries(json[field] ?? {})) {
        const priorFile = previous && typeof previous === "object" && Object.hasOwn(previous, file)
          ? previous[file]
          : null;
        const priorField = priorFile && typeof priorFile === "object" && Object.hasOwn(priorFile, field)
          ? priorFile[field]
          : null;
        const priorRequirement = priorField && typeof priorField === "object" && Object.hasOwn(priorField, name)
          ? priorField[name]
          : undefined;
        if (internal.has(name) || priorRequirement === requirement) continue;
        const key = `${file}:${field}:${name}`;
        const note = notes[key];
        const pin = lock.packages?.[`${path.dirname(file) === "." ? "" : path.dirname(file) + "/"}node_modules/${name}`]
          ?? lock.packages?.[`node_modules/${name}`];
        if (!note || note.requirement !== requirement || !pin?.version || note.version !== pin.version ||
          !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(note.version) || !pin.integrity ||
          note.registry !== `https://registry.npmjs.org/${encodeURIComponent(name)}/${note.version}` ||
          !/^\d{4}-\d{2}-\d{2}$/.test(note.checked ?? "") ||
          !/^docs\/quality\/dependencies\/[a-z0-9-]+\.md$/.test(note.note ?? "")) {
          problems.push(`${key}: added/changed dependency needs a verification note matching its requirement and lock pin`);
          continue;
        }
        const text = readNote(note.note);
        if (!["Reason", "Provenance", "License", "Security"].every((heading) => new RegExp(`^${heading}:\\s*\\S.+`, "m").test(text)))
          problems.push(`${key}: verification note must explain Reason, Provenance, License and Security`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { allow } = JSON.parse(readFileSync(path.join(root, "scripts/dependency-allowlist.json"), "utf8"));
  const problems = checkDeps(readManifests(root), allow);
  if (problems.length) {
    console.error(`deps: ${problems.length} problem(s); edit scripts/dependency-allowlist.json with owner approval:\n${problems.join("\n")}`);
    process.exit(1);
  }
}
