// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { app, root } from "./app";
import { streamReady } from "../lib/live/session-stream";

vi.mock("../lib/react/session", () => ({ ensureSession: () => {}, ensureEnrolling: () => {}, leaveSignInWhenSignedIn: () => {} }));
vi.mock("../shell/shell", () => ({ Shell: () => null }));
vi.mock("../lib/live/session-stream", () => ({ streamReady: vi.fn() }));

test("the app waits for its session stream before a child loader reads data", async () => {
  const ready = Promise.withResolvers<void>();
  vi.mocked(streamReady).mockReturnValue(ready.promise);
  const read = vi.fn();
  const child = createRoute({ getParentRoute: () => app, path: "/stream-order", loader: read });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([child])]), history: createMemoryHistory({ initialEntries: ["/stream-order"] }) });
  const loading = router.load();
  try {
    await vi.waitFor(() => expect(streamReady).toHaveBeenCalled());
    expect(read).not.toHaveBeenCalled();
  } finally { ready.resolve(); await loading; }
  expect(read).toHaveBeenCalledOnce();
});
