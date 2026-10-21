import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("timed commands preserve failure and report its stage without command arguments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proof-timing-"));
  try {
    const result = spawnSync("node", ["scripts/proof-timing.mjs", "check", "--", "node", "-e", "process.exit(7)"],
      { env: { ...process.env, CONSOLE_SLOT_ROOT: root, CONSOLE_LANE: "timing-test" } });
    expect(result.status).toBe(7);
    const record = JSON.parse(readFileSync(path.join(root, "proof-timings.jsonl"), "utf8"));
    expect(record).toMatchObject({ stage: "check", lane: "timing-test", wait_seconds: 0, rc: 7 });
    expect(record.run_seconds).toBeGreaterThanOrEqual(0);
    expect(record).not.toHaveProperty("command");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
