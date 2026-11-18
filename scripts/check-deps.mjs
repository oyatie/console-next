#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// The owner register is the npm allowlist. Existing pending declarations stay visible;
// inventory does not approve a new package, consumer, layer or override target.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inventory, registerDecision } from "./quality/tooling-inventory.mjs";

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function registryTarball(name, source) {
  const url = URL.canParse(source ?? "") && new URL(source);
  return url && url.origin === "https://registry.npmjs.org" && url.pathname.startsWith(`/${name}/-/`) && url.href === source;
}

const integrityHash = (value) => typeof value === "string" && /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value);

function installedPin(lock, file, name) {
  let dir = path.dirname(file);
  while (true) {
    const pin = lock?.packages?.[`${dir === "." ? "" : dir + "/"}node_modules/${name}`];
    if (pin) return pin;
    if (dir === ".") return undefined;
    dir = path.dirname(dir);
  }
}

function compatibleVersions(previous, current) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const old = stable.exec(previous ?? ""), next = stable.exec(current ?? "");
  return old && next && old[1] === next[1] && (old[1] !== "0" || old[2] === next[2]);
}

// manifests: [{ file, json }]; returns the problem lines (empty = pass).
export function checkDeps(manifests, register, lock) {
  const sources = new Map(manifests.map(({ file, json }) => [file, JSON.stringify(json)]));
  sources.set("package-lock.json", JSON.stringify(lock));
  const registered = new Map(register.rows.filter((r) => r.kind === "npm" && r.direct).map((r) => [r.name, r]));
  const problems = [];
  for (const row of inventory([...sources.keys()], (file) => sources.get(file))) {
    if (!row.direct) continue;
    const entry = registered.get(row.name);
    for (const use of row.uses) {
      if (!entry) problems.push(`${use.file}: "${row.name}" is not in the owner dependency register`);
      else if (!entry.uses.some((prior) => ["file", "user", "layer", "override"].every((key) => prior[key] === use[key])))
        problems.push(`${use.file}: "${row.name}" use is not recorded in the owner dependency register`);
    }
    if (entry && (!row.pins?.length || row.pins.some((pin) => !pin.version)))
      problems.push(`"${row.name}": resolved version is missing from package-lock.json`);
    if (entry && row.pins?.some((pin) => {
      if (pin.inBundle && pin.source === null) return false;
      return !registryTarball(row.name, pin.source);
    }))
      problems.push(`"${row.name}": resolved source must be its npm registry tarball in package-lock.json`);
    if (entry && row.pins?.some((pin) => !pin.inBundle && registryTarball(row.name, pin.source) && !integrityHash(pin.integrity)))
      problems.push(`"${row.name}": resolved pin must have an integrity hash in package-lock.json`);
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

// Routine updates use merge-base evidence; new uses and incompatible changes still need review.
export function checkDependencyNotes(manifests, previous, notes, lock, readNote, evidence = {}) {
  const internal = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const rows = (register) => new Map((register?.rows ?? []).filter((r) => r.kind === "npm" && r.direct).map((r) => [r.name, r]));
  const registered = rows(evidence.register), previousRegistered = rows(evidence.previousRegister);
  const declarationsRegistered = evidence.register && checkDeps(manifests, evidence.register, lock).length === 0;
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
        if (internal.has(name)) continue;
        const pin = installedPin(lock, file, name);
        const priorPin = installedPin(evidence.previousLock, file, name);
        if (priorRequirement === requirement && priorFile.name === json.name &&
          (!evidence.previousLock || isDeepStrictEqual(pin, priorPin))) continue;
        const entry = registered.get(name);
        if (priorRequirement !== undefined && entry &&
          isDeepStrictEqual(registerDecision(entry), registerDecision(previousRegistered.get(name))) &&
          declarationsRegistered &&
          compatibleVersions(priorPin?.version, pin?.version) &&
          typeof pin.license === "string" && pin.license.length > 0 && pin.license === priorPin.license &&
          registryTarball(name, pin.resolved) && integrityHash(pin.integrity)) continue;
        const key = `${file}:${field}:${name}`;
        const note = notes[key];
        if (!note || note.requirement !== requirement || !pin?.version || note.version !== pin.version ||
          !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(note.version) || !pin.integrity ||
          note.registry !== `https://registry.npmjs.org/${encodeURIComponent(name)}/${note.version}` ||
          !/^\d{4}-\d{2}-\d{2}$/.test(note.checked ?? "") ||
          !/^docs\/quality\/dependencies\/[a-z0-9-]+\.md$/.test(note.note ?? "")) {
          problems.push(`${key}: added/changed dependency needs a verification note matching its requirement and lock pin`);
          continue;
        }
        let text;
        try {
          text = readNote(note.note);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          problems.push(`${key}: verification note file is missing: ${note.note}`);
          continue;
        }
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
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const problems = checkDeps(readManifests(root), register, lock);
  if (problems.length) {
    console.error(`deps: ${problems.length} problem(s); update the owner dependency register only with owner approval:\n${problems.join("\n")}`);
    process.exit(1);
  }
}
