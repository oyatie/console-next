// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, rmSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { expect, test, vi } from "vitest";
import { startProxy } from "./proxy";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
vi.mock("node:http2", async importOriginal => {
  const http2 = await importOriginal<typeof import("node:http2")>();
  return { ...http2, createSecureServer: vi.fn((...args: Parameters<typeof http2.createSecureServer>) => {
    const server = http2.createSecureServer(...args);
    vi.spyOn(server, "listen");
    return server;
  }) };
});

test("TLS credentials are removed and the proxy binds only IPv4 loopback", async () => {
  const proxy = await startProxy("http://127.0.0.1:1");
  try {
    const server = vi.mocked(createSecureServer).mock.results.at(-1)!.value;
    expect(server.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    const [dir, options] = vi.mocked(rmSync).mock.calls.at(-1)!;
    expect(options).toEqual({ recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  } finally { await proxy.close(); }
});
