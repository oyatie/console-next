// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { alive, bin, eventually, launchBackend, listener, plant, responds } from "./backend-process-fixture";

test.each([
  { stubborn: false, adopted: false }, { stubborn: true, adopted: false },
  { stubborn: false, adopted: true }, { stubborn: true, adopted: true },
])("a console-app orphan is reaped and the next backend binds its port: %j", async ({ stubborn, adopted }) => {
  const orphan = await plant({ orphan: true, stubborn });
  const run = launchBackend(orphan.port, {
    E2E_CACHE_DIR: orphan.cache,
    ...(adopted ? { ADOPTED_LISTENER_PID: String(orphan.pid), ADOPTER_PID: String(process.pid) } : {}),
  });
  await eventually(() => existsSync(run.file) || run.child.exitCode !== null, Boolean);
  expect(run.child.exitCode, run.output()).toBeNull();
  const next = await listener(run.file);
  expect(JSON.parse(readFileSync(path.join(orphan.cache, "backend.json"), "utf8"))).toMatchObject({ pid: run.child.pid, apiPid: next.pid });
  expect(next.pid).not.toBe(orphan.pid);
  expect(await responds(orphan.port)).toEqual({ pid: next.pid });
  expect(alive(orphan.pid)).toBe(false);
  expect(alive(orphan.child)).toBe(true);
  await eventually(run.output, (output) => output.includes("[backend] ready"));
}, 30_000);

test.each([{ orphan: false, other: false }, { orphan: true, other: true }])("an unsafe listener is refused without killing it: %j", async (options) => {
  const occupied = await plant(options);
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("refusing to stop");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test.each(["missing", "malformed", "wrong listener", "invalid launcher"])("an orphan without valid slot ownership is refused: %s", async (record) => {
  const occupied = await plant({ orphan: true });
  const file = path.join(occupied.cache, "backend.json");
  if (record === "missing") rmSync(file);
  else writeFileSync(file, record === "malformed" ? "{" : JSON.stringify({
    pid: record === "invalid launcher" ? -1 : occupied.launcher,
    apiPid: record === "wrong listener" ? occupied.child : occupied.pid,
  }));
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("refusing to stop");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test("a legacy orphan record names the listener and the exact manual cleanup step", async () => {
  const occupied = await plant({ orphan: true });
  writeFileSync(path.join(occupied.cache, "backend.json"), JSON.stringify({ pid: occupied.launcher, bin }));
  const run = launchBackend(occupied.port, {
    E2E_CACHE_DIR: occupied.cache,
    ADOPTED_LISTENER_PID: String(occupied.pid), ADOPTER_PID: "1",
  });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).toContain(`port ${occupied.port} is held by pid ${occupied.pid}`);
  expect(run.output()).toContain("legacy slot record has no apiPid");
  expect(run.output()).toContain(`run \`kill -TERM ${occupied.pid}\` and retry`);
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});

test.each([{ orphan: false, other: false }, { orphan: true, other: true }])("a legacy record never suggests killing a live or foreign listener: %j", async (options) => {
  const occupied = await plant(options);
  writeFileSync(path.join(occupied.cache, "backend.json"), JSON.stringify({ pid: occupied.launcher }));
  const run = launchBackend(occupied.port, { E2E_CACHE_DIR: occupied.cache });
  expect(await run.exited, run.output()).not.toBe(0);
  expect(run.output()).not.toContain("kill -TERM");
  expect(await responds(occupied.port)).toEqual({ pid: occupied.pid });
});
