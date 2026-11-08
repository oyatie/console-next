// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { chunk, crashed } from "../chunk-guard";
import { sessionStream } from "./session-stream";

vi.mock("../chunk-guard", () => ({ chunk: vi.fn(), crashed: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function setup() {
  const openLive = vi.fn();
  const closeLive = vi.fn();
  const ready = Promise.withResolvers<typeof import("./live")>();
  vi.mocked(chunk).mockReturnValue(ready.promise);
  const qc = new QueryClient();
  return { setActive: sessionStream(qc), ready, openLive, closeLive, qc,
    loaded: async () => { ready.resolve({ openLive, closeLive } as unknown as typeof import("./live")); await ready.promise; } };
}

test("signed-out sessions do not load the event client", () => {
  const { setActive } = setup();
  setActive(false);
  expect(chunk).not.toHaveBeenCalled();
});

test("an active session opens once loaded and closes synchronously on sign-out", async () => {
  const { setActive, loaded, openLive, closeLive, qc } = setup();
  setActive(true);
  expect(openLive).not.toHaveBeenCalled();
  await loaded();
  expect(openLive).toHaveBeenCalledExactlyOnceWith(qc);
  setActive(false);
  expect(closeLive).toHaveBeenCalledOnce();
  setActive(true);
  expect(openLive).toHaveBeenCalledTimes(2);
});

test("sign-out while loading never opens a stale stream", async () => {
  const { setActive, loaded, openLive } = setup();
  setActive(true);
  setActive(false);
  await loaded();
  expect(openLive).not.toHaveBeenCalled();
});

test("a replacement session opens only the latest pending stream", async () => {
  const { setActive, loaded, openLive, qc } = setup();
  setActive(true);
  setActive(false);
  setActive(true);
  await loaded();
  expect(openLive).toHaveBeenCalledExactlyOnceWith(qc);
});

test("an unrecoverable event chunk failure reaches the static crash screen", async () => {
  const { setActive, ready } = setup();
  setActive(true);
  const error = new Error("load failed");
  ready.reject(error);
  await ready.promise.catch(() => {});
  expect(crashed).toHaveBeenCalledExactlyOnceWith(error);
});
