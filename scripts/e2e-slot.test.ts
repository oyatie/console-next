import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("the local runner passes its shared timing cache or explicit override to every child", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slot-timings-"));
  try {
    const receipt = path.join(dir, "receipt");
    const lock = path.join(dir, process.platform === "darwin" ? "lockf" : "flock");
    writeFileSync(lock, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TIMINGS_RECEIPT,process.env.E2E_TIMINGS_FILE??'missing');\n`, { mode: 0o700 });
    for (const override of [undefined, path.join(dir, "custom.json")]) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, E2E_SLOTS: "1", E2E_MAX_LOAD_PER_CORE: "0", TIMINGS_RECEIPT: receipt };
      delete env.E2E_TIMINGS_FILE;
      if (override !== undefined) env.E2E_TIMINGS_FILE = override;
      const result = spawnSync(process.execPath, ["scripts/e2e-slot.mjs", "--list"], { env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(receipt, "utf8")).toBe(override ?? path.join(dir, ".cache/console-e2e/timings.json"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The colima VM (Linux, 32768–60999) and macOS (49152–65535) hand out ephemeral ports from here up (e2e/slot.ts).
const EPHEMERAL = 32768;
/** One slot's ports as an E2E run sees them (e2e/slot.ts PORTS, read the way playwright.config.ts reads them). */
function portsOf(slot: number, env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", "const m = await import('./e2e/slot.ts'); console.log(JSON.stringify(m.PORTS))"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, E2E_SLOT: String(slot), E2E_AGENT: "test", ...env },
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return Object.values(JSON.parse(run.stdout) as Record<string, number>);
}

// Regression (e2e-load-stall-dev): slot 2's Postgres on 55452 lay in the ephemeral range, where a pgtest container's
// random host port had taken it ("address already in use"); the mail UI's 8025 + 10 × slot met slot 5's backend at 8095.
test("every slot's ports, and the demo stack's, lie below the ephemeral range and never overlap", () => {
  const slots = Array.from({ length: 10 }, (_, slot) => portsOf(slot)).flat();
  const demo = [...JSON.parse(readFileSync("package.json", "utf8")).scripts.demo.matchAll(/_PORT=(\d+)/g)].map((m) => Number(m[1]));
  expect(demo).toHaveLength(6);
  for (const p of [...slots, ...demo]) expect(p, `port ${p}`).toBeLessThan(EPHEMERAL);
  expect(new Set([...slots, ...demo]).size).toBe(slots.length + demo.length);
});

test("an environment variable still overrides its port (the demo stack sets them all)", () => {
  expect(portsOf(0, { CONSOLE_DEV_PG_PORT: "25532" })).toContain(25532);
});

test("a slot whose default port would reach the ephemeral range is refused at load", () => {
  expect(() => portsOf(1000)).toThrow(/slot 1000's pg 35432, s3 38333, otel 34317 must stay below 32768/);
});
