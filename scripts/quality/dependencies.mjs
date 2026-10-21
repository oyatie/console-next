import { readFileSync } from "node:fs";
import path from "node:path";
import { checkDependencyNotes, readManifests } from "../check-deps.mjs";
import { atBase } from "./ratchet.mjs";

export function dependencyProblems(root, base) {
  const manifests = readManifests(root);
  const previous = Object.fromEntries(manifests.map(({ file }) => [file, JSON.parse(atBase(root, base, file) ?? "{}")]));
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const notes = JSON.parse(read("scripts/quality/dependency-verification.json"));
  const lock = JSON.parse(read("package-lock.json"));
  return checkDependencyNotes(manifests, previous, notes, lock, read);
}
