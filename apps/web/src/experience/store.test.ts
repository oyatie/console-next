// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { ApiError } from "@console/api";
import { afterEach, expect, test, vi } from "vitest";
import { EXPERIENCE_KEY } from "../lib/prefs";
import { queryDefaults } from "../lib/react/query-defaults";
import { settingsQuery } from "../reference/settings/api";
import {
  EXPERIENCE_SOURCE_KEY,
  mergeWorkspaceExperience,
  readStoredExperience,
  resolveEffectiveExperience,
  useExperienceSync,
  workspaceQuery,
  writeStoredExperience,
} from "./store";

afterEach(() => vi.restoreAllMocks());

function SyncProbe({ enabled }: { enabled: boolean }) {
  useExperienceSync(enabled);
  return null;
}

function renderSync(client: QueryClient, enabled: boolean) {
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SyncProbe, { enabled })));
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    snapshot: () => Object.fromEntries(data),
  };
}

test("personal override beats tenant default and device storage", () => {
  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "console" },
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "baseline", source: "personal" },
  })).toEqual({ id: "console", choice: "console", tenantId: "baseline", source: "personal" });

  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "baseline" },
    settingsItems: [{ key: "display.experience", value: "console" }],
    storedDevice: { id: "console", source: "tenant" },
  })).toEqual({ id: "baseline", choice: "baseline", tenantId: "console", source: "personal" });
});

test("explicit follow-organization-default uses the tenant setting even when the device had an older personal choice", () => {
  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "tenant" },
    settingsItems: [{ key: "display.experience", value: "console" }],
    storedDevice: { id: "baseline", source: "personal" },
  })).toEqual({ id: "console", choice: "tenant", tenantId: "console", source: "tenant" });

  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "tenant" },
    settingsItems: [],
    storedDevice: { id: "baseline", source: "personal" },
  })).toEqual({ id: "console", choice: "tenant", tenantId: "console", source: "tenant" });
});

test("an unset server workspace follows the tenant default on a fresh device, and preserves an explicit device seed", () => {
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "console" }],
    storedDevice: { id: null, source: null },
  })).toEqual({ id: "console", choice: "tenant", tenantId: "console", source: "tenant" });

  // Tenant cached on an earlier visit updates when the organization switches back to baseline.
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "console", source: "tenant" },
  })).toEqual({ id: "baseline", choice: "tenant", tenantId: "baseline", source: "tenant" });

  // Explicit device seed (such as E2E_EXPERIENCE or a pre-existing device choice) stays in force until changed.
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "console", source: null },
  })).toEqual({ id: "console", choice: "console", tenantId: "baseline", source: "personal" });
});

test("unknown workspace or setting codes fall back safely without prototype pollution", () => {
  for (const invalid of ["unknown", "constructor", "__proto__", ""]) {
    expect(resolveEffectiveExperience({
      workspaceLayout: { experience: invalid },
      settingsItems: [{ key: "display.experience", value: invalid }],
      storedDevice: { id: null, source: null },
    })).toEqual({ id: "console", choice: "tenant", tenantId: "console", source: "tenant" });
  }
});

test("merging the experience choice preserves unrelated workspace layout keys", () => {
  const existing = { tabs: ["/people", "/attendance"], splitWidth: 440 };
  expect(mergeWorkspaceExperience(existing, "console")).toEqual({
    tabs: ["/people", "/attendance"],
    splitWidth: 440,
    experience: "console",
  });
  expect(mergeWorkspaceExperience(existing, "tenant")).toEqual({
    tabs: ["/people", "/attendance"],
    splitWidth: 440,
    experience: "tenant",
  });
});

test("device storage keeps fresh console default clean, caches explicit baseline tenant defaults, and clears stale tenant cache", () => {
  const store = memoryStorage();
  expect(readStoredExperience(store)).toEqual({ id: null, source: null });

  expect(writeStoredExperience("console", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({});

  expect(writeStoredExperience("baseline", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({ [EXPERIENCE_KEY]: "baseline", [EXPERIENCE_SOURCE_KEY]: "tenant" });
  expect(readStoredExperience(store)).toEqual({ id: "baseline", source: "tenant" });

  expect(writeStoredExperience("console", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({});

  expect(writeStoredExperience("baseline", "personal", store)).toBe(true);
  expect(store.snapshot()).toEqual({ [EXPERIENCE_KEY]: "baseline", [EXPERIENCE_SOURCE_KEY]: "personal" });

  store.setItem(EXPERIENCE_KEY, "control-room");
  expect(readStoredExperience(store)).toEqual({ id: "console", source: "personal" });
  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "control-room" },
    settingsItems: [{ key: "display.experience", value: "control-room" }],
    storedDevice: { id: null, source: null },
  })).toEqual({ id: "console", choice: "console", tenantId: "console", source: "personal" });
});

test("useExperienceSync preserves the shared settings retry policy on 503 faults without restarting exhausted retries", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retryDelay: 0 } } });
  const queryFn = vi.spyOn(settingsQuery, "queryFn").mockRejectedValue(new ApiError(503, "service_unavailable", "busy"));
  const first = new QueryObserver(client, settingsQuery);
  const second = new QueryObserver(client, settingsQuery);
  let stopFirst: (() => void) | undefined;
  let stopSecond: (() => void) | undefined;
  try {
    renderSync(client, false);
    expect(client.getQueryCache().find(settingsQuery)?.options.retry).toBe(queryDefaults.retry);
    expect(client.getQueryCache().find(workspaceQuery)?.options.retry).toBe(false);

    renderSync(client, true);
    expect(client.getQueryCache().find(settingsQuery)?.options.retry).toBe(queryDefaults.retry);

    stopFirst = first.subscribe(() => {});
    renderSync(client, true);
    await vi.waitFor(() => expect(first.getCurrentResult().isError).toBe(true));
    expect(queryFn).toHaveBeenCalledTimes(3);

    stopSecond = second.subscribe(() => {});
    await Promise.resolve();
    expect(second.getCurrentResult().isError).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(3);
  } finally {
    stopFirst?.();
    stopSecond?.();
    client.clear();
  }
});

test.each([
  { status: 401, code: "unauthorized" },
  { status: 403, code: "forbidden" },
])("shared settings reads fail fast in one attempt on $status responses", async ({ status, code }) => {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retryDelay: 0 } } });
  const queryFn = vi.spyOn(settingsQuery, "queryFn").mockRejectedValue(new ApiError(status, code, "refused"));
  const observer = new QueryObserver(client, settingsQuery);
  let stop: (() => void) | undefined;
  try {
    renderSync(client, false);
    renderSync(client, true);
    stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(queryFn).toHaveBeenCalledTimes(1);
  } finally {
    stop?.();
    client.clear();
  }
});
