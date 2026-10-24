#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project, sourceFiles } from "./quality/project.mjs";
import { clones } from "./quality/clones.mjs";
import { patterns } from "./quality/patterns.mjs";
import { deadCode } from "./quality/dead-code.mjs";
import { atBase, baselineGrowth, ratchet } from "./quality/ratchet.mjs";
import { dependencyProblems } from "./quality/dependencies.mjs";
import { resolveBase } from "./git-base.mjs";

const BASELINE = "scripts/quality/baseline.json";

export function findings(root) {
  const files = sourceFiles(root, ["apps/web/src", "packages/api/src", "packages/i18n/src", "e2e"]);
  files.push(...readdirSync(root).filter((f) => /\.config\.ts$/.test(f)));
  if (existsSync(path.join(root, "apps/web/vite.config.ts"))) files.push("apps/web/vite.config.ts");
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const { sources, checker } = project(root, files);
  return {
    ...clones(sources.filter((s) => relative(s.fileName).startsWith("apps/web/src/")).map((s) => ({ file: relative(s.fileName), text: s.text }))),
    ...patterns(sources, checker, relative),
    ...deadCode(sources, checker, relative),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--report") continue;
      if (!["--root", "--base"].includes(args[i]) || !args[++i] || args[i].startsWith("--")) throw new Error("usage: check-ai-quality.mjs [--root path] [--base ref] [--report]");
    }
    const option = (name, fallback) => args.includes(name) ? args[args.lastIndexOf(name) + 1] : fallback;
    const root = path.resolve(option("--root", path.resolve(import.meta.dirname, "..")));
    const found = findings(root);
    if (args.includes("--report")) {
      process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
    } else {
      const base = resolveBase(root, { base: option("--base", undefined) });
      const baseline = JSON.parse(readFileSync(path.join(root, BASELINE), "utf8"));
      const previous = atBase(root, base, BASELINE);
      const problems = [...ratchet(found, baseline), ...(previous === undefined ? [] : baselineGrowth(baseline, JSON.parse(previous))), ...dependencyProblems(root, base)];
      if (problems.length) {
        console.error(`ai-quality: ${problems.length} problem(s):\n${problems.join("\n")}`);
        process.exitCode = 1;
      } else {
        const counts = {};
        for (const [key, count] of Object.entries(found)) counts[key.split(":")[0]] = (counts[key.split(":")[0]] ?? 0) + count;
        console.log(`ai-quality: pass; inherited findings ${JSON.stringify(counts)}`);
      }
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
