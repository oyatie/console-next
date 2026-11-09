// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { chunk, crashed } from "../chunk-guard";
import { sessionStream, streamReady } from "./session-stream";

vi.mock("../chunk-guard", () => ({ chunk: vi.fn(), crashed: vi.fn() }));
afterEach(() => { sessionStream(new QueryClient())(false); vi.clearAllMocks(); });

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

test("readiness waits until the active stream opens", async () => {
  const { setActive, loaded, openLive } = setup();
  setActive(true);
  const read = vi.fn();
  const loading = streamReady().then(read);
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  await loaded();
  await loading;
  expect(openLive).toHaveBeenCalledBefore(read);
  setActive(true);
  await streamReady();
  expect(openLive).toHaveBeenCalledTimes(2);
});

test("inactive readiness does not wait for a superseded chunk", async () => {
  const { setActive, loaded, openLive } = setup();
  await streamReady();
  setActive(true);
  setActive(false);
  await streamReady();
  await loaded();
  expect(openLive).not.toHaveBeenCalled();
});

test("a waiting loader follows the replacement session's chunk", async () => {
  const first = setup();
  first.setActive(true);
  const read = vi.fn();
  const loading = streamReady().then(read);
  first.setActive(false);
  const second = setup();
  first.setActive(true);
  await first.loaded();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  expect(first.openLive).not.toHaveBeenCalled();
  await second.loaded();
  await loading;
  expect(second.openLive).toHaveBeenCalledBefore(read);
});

test("a failed stream chunk refuses readiness as well as showing recovery", async () => {
  const { setActive, ready } = setup();
  setActive(true);
  const loading = expect(streamReady()).rejects.toThrow("load failed");
  ready.reject(new Error("load failed"));
  await loading;
  expect(crashed).toHaveBeenCalledOnce();
});
