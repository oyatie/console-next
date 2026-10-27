#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// The owner register is the npm allowlist. Existing pending declarations stay visible;
// inventory does not approve a new package, consumer, requirement or override.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "./quality/tooling-inventory.mjs";

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// manifests: [{ file, json }]; returns the problem lines (empty = pass).
export function checkDeps(manifests, register) {
  const sources = new Map(manifests.map(({ file, json }) => [file, JSON.stringify(json)]));
  const registered = new Map(register.rows.filter((r) => r.kind === "npm" && r.direct).map((r) => [r.name, r]));
  const problems = [];
  for (const row of inventory([...sources.keys()], (file) => sources.get(file))) {
    const entry = registered.get(row.name);
    for (const use of row.uses) {
      if (!entry) problems.push(`${use.file}: "${row.name}" is not in the owner dependency register`);
      else if (!entry.uses.some((prior) => ["file", "user", "requirement", "layer", "override"].every((key) => prior[key] === use[key])))
        problems.push(`${use.file}: "${row.name}" use is not recorded in the owner dependency register`);
    }
  }
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
  const register = JSON.parse(readFileSync(path.join(root, "docs/quality/dependency-register.json"), "utf8"));
  const problems = checkDeps(readManifests(root), register);
  if (problems.length) {
    console.error(`deps: ${problems.length} problem(s); update the owner dependency register only with owner approval:\n${problems.join("\n")}`);
    process.exit(1);
  }
}
