import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const directory = "scripts/standing-text.d";
const base = "scripts/standing-text-baseline.json";
const screens = "scripts/standing-text-new-screens.json";

export function mergeRegistry(baseline, newScreens, contributions) {
  const seen = new Set();
  baseline = { ...baseline }; newScreens = { ...newScreens };
  for (const [lane, entry] of contributions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !["baseline", "newScreens"].includes(key))) throw new Error(`${lane}: invalid registry`);
    for (const [kind, target] of [["baseline", baseline], ["newScreens", newScreens]]) {
      const values = entry[kind] ?? {};
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`${lane}: invalid ${kind}`);
      for (const [key, value] of Object.entries(values)) {
        const ownership = `${kind}:${key}`;
        if (seen.has(ownership)) throw new Error(`${lane}: overlapping registry entry ${ownership}`);
        if (kind === "baseline" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${lane}: invalid baseline pin ${key}`);
        seen.add(ownership); target[key] = value;
      }
    }
  }
  return { baseline, newScreens };
}

export function readRegistry(ref) {
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`cannot read registry at ${ref}: ${result.stderr}`);
    return result.stdout;
  };
  const read = (file) => JSON.parse(ref ? git("show", `${ref}:${file}`) : readFileSync(file, "utf8"));
  const files = ref ? git("ls-tree", "-r", "--name-only", ref, directory).trim().split("\n").filter((file) => file.endsWith(".json"))
    : existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => `${directory}/${file}`) : [];
  return mergeRegistry(read(base), read(screens), files.sort().map((file) => [file, read(file)]));
}

// INTEG folds a landed batch so the next lane can reduce the same screen in its own file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const merged = readRegistry();
  if (process.argv[2] === "--fold") {
    writeFileSync(base, `${JSON.stringify(merged.baseline, null, 2)}\n`);
    writeFileSync(screens, `${JSON.stringify(merged.newScreens, null, 2)}\n`);
    if (existsSync(directory)) for (const file of readdirSync(directory).filter((file) => file.endsWith(".json"))) rmSync(`${directory}/${file}`);
  } else console.log(JSON.stringify(merged, null, 2));
}
