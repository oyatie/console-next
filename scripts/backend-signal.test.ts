// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { reapOrphanListener, stopBackend } from "./backend-process.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

test.each(["exited", "zombie"])("an %s group leader tolerates macOS EPERM", state => {
  vi.mocked(spawnSync).mockReturnValue({
    status: state === "exited" ? 1 : 0, stdout: state === "exited" ? "" : "1 Z console-app", stderr: "",
  } as never);
  const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw error; });
  expect(() => stopBackend({ pid: 123 }, "SIGKILL")).not.toThrow();
  expect(kill).toHaveBeenCalledWith(-123, "SIGKILL");
});

test.each(["EPERM", "EINVAL"])("a live group still reports %s", code => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "1 S console-app", stderr: "" } as never);
  const error = Object.assign(new Error(`kill ${code}`), { code });
  vi.spyOn(process, "kill").mockImplementation(() => { throw error; });
  expect(() => stopBackend({ pid: 123 }, "SIGKILL")).toThrow(error);
});

test("an already absent group tolerates ESRCH", () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); });
  expect(() => stopBackend({ pid: 123 })).not.toThrow();
});

test("a single listener still reports EPERM", async () => {
  vi.mocked(spawnSync).mockImplementation((command, args) => ({
    status: command === "ps" && args?.[1] === "456" ? 1 : 0,
    stdout: command === "lsof" ? "p123\n" : args?.[1] === "456" ? "" : "1 S console-app",
    stderr: "",
  }) as never);
  const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw error; });
  const dir = mkdtempSync(path.join(os.tmpdir(), "backend-signal-"));
  const file = path.join(dir, "backend.json");
  try {
    writeFileSync(file, JSON.stringify({ pid: 456, apiPid: 123 }));
    await expect(reapOrphanListener(8190, file)).rejects.toThrow(error);
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
