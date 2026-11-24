// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { hasUnsavedInput, installDirtyTracker } from "./dirty-guard";
import { DEFAULT_EXPERIENCE_ID, experiences, resolveExperience } from "./table";

export { hasUnsavedInput, installDirtyTracker };
export type ExperienceId = (typeof experiences)[number]["id"];
export type ExperienceSource = "personal" | "tenant";

export const EXPERIENCE_SOURCE_KEY = "console.experience.source";
export type ExperienceChoice = ExperienceId | "tenant";

type MinimalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const EXPERIENCE_EVENT = "console:experience";
const EXPERIENCE_KEY = "console.experience";

function normalizeExperienceId(value: unknown): unknown {
  return value === "control-room" ? "console" : value;
}

function isKnownExperienceId(value: unknown): value is ExperienceId {
  return typeof value === "string" && experiences.some(experience => experience.id === value);
}

function defaultStorage(): MinimalStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStoredExperience(storage: MinimalStorage | null = defaultStorage()): {
  id: ExperienceId | null;
  source: ExperienceSource | null;
} {
  if (!storage) return { id: null, source: null };
  try {
    const rawId = normalizeExperienceId(storage.getItem(EXPERIENCE_KEY));
    const rawSource = storage.getItem(EXPERIENCE_SOURCE_KEY);
    return {
      id: isKnownExperienceId(rawId) ? rawId : null,
      source: rawSource === "personal" || rawSource === "tenant" ? rawSource : null,
    };
  } catch {
    return { id: null, source: null };
  }
}

export function writeStoredExperience(
  id: ExperienceId,
  source: ExperienceSource,
  storage: MinimalStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    // public/prefs.js paints the default with nothing stored; any other organization default is kept for the next load.
    if (source === "tenant" && id === DEFAULT_EXPERIENCE_ID) {
      storage.removeItem(EXPERIENCE_KEY);
      storage.removeItem(EXPERIENCE_SOURCE_KEY);
    } else {
      storage.setItem(EXPERIENCE_KEY, id);
      storage.setItem(EXPERIENCE_SOURCE_KEY, source);
    }
    return true;
  } catch {
    return false;
  }
}

export function mergeWorkspaceExperience(
  layout: Record<string, unknown> | undefined,
  choice: ExperienceChoice,
): Record<string, unknown> {
  const base = layout && typeof layout === "object" && !Array.isArray(layout) ? layout : {};
  return { ...base, experience: choice };
}

export function resolveEffectiveExperience({
  workspaceLayout,
  settingsItems,
  storedDevice,
}: {
  workspaceLayout: Record<string, unknown> | undefined;
  settingsItems: readonly { key: string; value: unknown }[] | undefined;
  storedDevice: { id: ExperienceId | null; source: ExperienceSource | null };
}): {
  id: ExperienceId;
  choice: ExperienceChoice;
  tenantId: ExperienceId;
  source: ExperienceSource;
} {
  const settingRow = settingsItems?.find(item => item.key === "display.experience");
  const normalizedSetting = settingRow ? normalizeExperienceId(settingRow.value) : undefined;
  const tenantId: ExperienceId = isKnownExperienceId(normalizedSetting) ? normalizedSetting : DEFAULT_EXPERIENCE_ID;
  const rawChoice = workspaceLayout && Object.hasOwn(workspaceLayout, "experience")
    ? normalizeExperienceId(workspaceLayout.experience)
    : undefined;

  if (isKnownExperienceId(rawChoice)) {
    return { id: rawChoice, choice: rawChoice, tenantId, source: "personal" };
  }
  if (rawChoice === "tenant") {
    return { id: tenantId, choice: "tenant", tenantId, source: "tenant" };
  }
  if (storedDevice.id !== null && storedDevice.source !== "tenant") {
    return { id: storedDevice.id, choice: storedDevice.id, tenantId, source: "personal" };
  }
  const id: ExperienceId = settingsItems !== undefined ? tenantId : (storedDevice.id ?? DEFAULT_EXPERIENCE_ID);
  return { id, choice: "tenant", tenantId, source: "tenant" };
}

export function readDomExperienceId(): ExperienceId {
  // With no attribute the stylesheets draw Classic, so the scripts read Classic too, whatever the default.
  return resolveExperience((typeof document === "undefined" ? undefined : document.documentElement.dataset.experience) ?? "baseline").id;
}

export function applyDomExperience(id: ExperienceId): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Classic is written too, as public/prefs.js does, so the attribute always names the style in force.
  if (root.dataset.experience === id) return;
  root.dataset.experience = id;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EXPERIENCE_EVENT));
}

function subscribeDomExperience(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  installDirtyTracker(document);
  window.addEventListener(EXPERIENCE_EVENT, onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-experience"] });
  return () => {
    window.removeEventListener(EXPERIENCE_EVENT, onChange);
    observer.disconnect();
  };
}

export function useActiveExperienceId(): ExperienceId {
  // Static markup takes this: print documents render through it and look the same in every style.
  return useSyncExternalStore(subscribeDomExperience, readDomExperienceId, () => "baseline");
}
