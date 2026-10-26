// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { i18n, loadCatalog } from "@console/i18n";
import { app, frame, root, screen } from "./app";
import { authzQuery } from "../reference/authz/api";
import { tenantsQuery } from "../features/platform/api";

vi.mock("../lib/react/session", () => ({ ensureSession: () => {}, ensureEnrolling: () => {}, leaveSignInWhenSignedIn: () => {} }));
vi.mock("../shell/shell", () => ({ Shell: () => null }));
beforeAll(() => loadCatalog(i18n.locale));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("routes leave cold-session reads to the shell and screen observers", async () => {
  const qc = new QueryClient();
  const authz = vi.spyOn(authzQuery, "queryFn").mockImplementation(() => new Promise<never>(() => {}));
  const tenants = vi.spyOn(tenantsQuery, "queryFn").mockImplementation(() => new Promise<never>(() => {}));
  const router = createRouter({ routeTree: root.addChildren([app.addChildren(frame.screens)]), context: { queryClient: qc }, history: createMemoryHistory({ initialEntries: ["/platform"] }) });
  await router.load();
  expect.soft(authz).not.toHaveBeenCalled();
  expect.soft(tenants).not.toHaveBeenCalled();
  expect.soft(qc.getQueryCache().getAll()).toHaveLength(0);
  qc.clear();
});

test("the production screen import paints without advancing the former 1,500 ms font timeout", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { fonts: { load: vi.fn(() => new Promise(() => {})) } });
  let painted = false;
  const module = { Screen: () => null };
  const loading = screen(async () => module)().then(value => { painted = true; return value; });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(painted).toBe(true);
  expect(await loading).toBe(module);
});
