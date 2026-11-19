// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { EXPERIENCE_KEY } from "../lib/prefs";
import {
  EXPERIENCE_SOURCE_KEY,
  mergeWorkspaceExperience,
  readStoredExperience,
  resolveEffectiveExperience,
  writeStoredExperience,
} from "./store";

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
    workspaceLayout: { experience: "control-room" },
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "baseline", source: "personal" },
  })).toEqual({ id: "control-room", choice: "control-room", tenantId: "baseline", source: "personal" });

  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "baseline" },
    settingsItems: [{ key: "display.experience", value: "control-room" }],
    storedDevice: { id: "control-room", source: "tenant" },
  })).toEqual({ id: "baseline", choice: "baseline", tenantId: "control-room", source: "personal" });
});

test("explicit follow-organization-default uses the tenant setting even when the device had an older personal choice", () => {
  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "tenant" },
    settingsItems: [{ key: "display.experience", value: "control-room" }],
    storedDevice: { id: "baseline", source: "personal" },
  })).toEqual({ id: "control-room", choice: "tenant", tenantId: "control-room", source: "tenant" });

  expect(resolveEffectiveExperience({
    workspaceLayout: { experience: "tenant" },
    settingsItems: [],
    storedDevice: { id: "control-room", source: "personal" },
  })).toEqual({ id: "baseline", choice: "tenant", tenantId: "baseline", source: "tenant" });
});

test("an unset server workspace follows the tenant default on a fresh device, and preserves an explicit device seed", () => {
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "control-room" }],
    storedDevice: { id: null, source: null },
  })).toEqual({ id: "control-room", choice: "tenant", tenantId: "control-room", source: "tenant" });

  // Tenant cached on an earlier visit updates when the organization switches back to baseline.
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "control-room", source: "tenant" },
  })).toEqual({ id: "baseline", choice: "tenant", tenantId: "baseline", source: "tenant" });

  // Explicit device seed (such as E2E_EXPERIENCE or a pre-existing device choice) stays in force until changed.
  expect(resolveEffectiveExperience({
    workspaceLayout: {},
    settingsItems: [{ key: "display.experience", value: "baseline" }],
    storedDevice: { id: "control-room", source: null },
  })).toEqual({ id: "control-room", choice: "control-room", tenantId: "baseline", source: "personal" });
});

test("unknown workspace or setting codes fall back safely without prototype pollution", () => {
  for (const invalid of ["unknown", "constructor", "__proto__", ""]) {
    expect(resolveEffectiveExperience({
      workspaceLayout: { experience: invalid },
      settingsItems: [{ key: "display.experience", value: invalid }],
      storedDevice: { id: null, source: null },
    })).toEqual({ id: "baseline", choice: "tenant", tenantId: "baseline", source: "tenant" });
  }
});

test("merging the experience choice preserves unrelated workspace layout keys", () => {
  const existing = { tabs: ["/people", "/attendance"], splitWidth: 440 };
  expect(mergeWorkspaceExperience(existing, "control-room")).toEqual({
    tabs: ["/people", "/attendance"],
    splitWidth: 440,
    experience: "control-room",
  });
  expect(mergeWorkspaceExperience(existing, "tenant")).toEqual({
    tabs: ["/people", "/attendance"],
    splitWidth: 440,
    experience: "tenant",
  });
});

test("device storage keeps fresh baseline clean, caches non-baseline tenant defaults, and clears stale tenant cache", () => {
  const store = memoryStorage();
  expect(readStoredExperience(store)).toEqual({ id: null, source: null });

  expect(writeStoredExperience("baseline", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({});

  expect(writeStoredExperience("control-room", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({ [EXPERIENCE_KEY]: "control-room", [EXPERIENCE_SOURCE_KEY]: "tenant" });
  expect(readStoredExperience(store)).toEqual({ id: "control-room", source: "tenant" });

  expect(writeStoredExperience("baseline", "tenant", store)).toBe(true);
  expect(store.snapshot()).toEqual({});

  expect(writeStoredExperience("baseline", "personal", store)).toBe(true);
  expect(store.snapshot()).toEqual({ [EXPERIENCE_KEY]: "baseline", [EXPERIENCE_SOURCE_KEY]: "personal" });
});
