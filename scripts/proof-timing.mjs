import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function proofTiming(stage, started, acquired, rc) {
  const root = process.env.CONSOLE_SLOT_ROOT ?? path.join(os.homedir(), ".cache/console-target");
  mkdirSync(root, { recursive: true });
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entry = { at: Date.now() / 1000, lane: process.env.E2E_AGENT ?? process.env.CONSOLE_LANE ?? path.basename(process.cwd()),
    revision, stage, wait_seconds: (acquired - started) / 1000, run_seconds: (Date.now() - acquired) / 1000, rc };
  appendFileSync(path.join(root, "proof-timings.jsonl"), `${JSON.stringify(entry)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [stage, separator, ...command] = process.argv.slice(2);
  if (!stage || separator !== "--" || !command.length) throw new Error("usage: proof-timing.mjs <stage> -- <command> [args]");
  const start = Date.now();
  const run = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  proofTiming(stage, start, start, run.status ?? 1);
  process.exit(run.status ?? 1);
}
