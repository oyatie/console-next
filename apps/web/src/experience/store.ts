// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { session } from "@console/api";
import { get } from "../lib/query";
import { settingsQuery } from "../reference/settings/api";
import {
  applyDomExperience,
  EXPERIENCE_SOURCE_KEY,
  hasUnsavedInput,
  installDirtyTracker,
  mergeWorkspaceExperience,
  readDomExperienceId,
  readStoredExperience,
  resolveEffectiveExperience,
  writeStoredExperience,
  type ExperienceChoice,
  type ExperienceId,
  type ExperienceSource,
} from "./dom";

export {
  EXPERIENCE_SOURCE_KEY,
  mergeWorkspaceExperience,
  readStoredExperience,
  resolveEffectiveExperience,
  writeStoredExperience,
  type ExperienceChoice,
  type ExperienceId,
  type ExperienceSource,
};

export const workspaceQuery = { ...get("/api/v1/me/workspace"), staleTime: 5 * 60_000, retry: false };

/** Cache an enforced rollback for this tab's pre-authentication first paint without overwriting its preference. */
const ROLLBACK_KEY = "console.experience.rollback";
let inMemoryRollback: string | null = null;
function rememberedRollback(): string | null {
  try { return sessionStorage.getItem(ROLLBACK_KEY); }
  catch { return inMemoryRollback; }
}
function rememberRollback(active: boolean): boolean {
  inMemoryRollback = active ? session.principal : null;
  try {
    if (inMemoryRollback) sessionStorage.setItem(ROLLBACK_KEY, inMemoryRollback);
    else sessionStorage.removeItem(ROLLBACK_KEY);
    return true;
  } catch { return false; }
}

export function useExperienceSync(enabled: boolean): void {
  useEffect(() => {
    installDirtyTracker();
    const unsubscribe = session.subscribe(() => { if (!session.principal) rememberRollback(false); });
    return () => { unsubscribe(); };
  }, []);
  const workspace = useQuery({ ...workspaceQuery, enabled });
  const settings = useQuery({ ...settingsQuery, enabled });
  const forced = workspace.data?.legacy_kill_switch_enabled;
  useEffect(() => {
    if (!enabled) return;
    if (forced !== undefined) rememberRollback(forced);
    if (forced === undefined && !workspace.isSuccess && session.principal && rememberedRollback() === session.principal) return;
    if (!forced && !workspace.isSuccess && !settings.isSuccess) return;
    const layout = workspace.data?.layout && typeof workspace.data.layout === "object" && !Array.isArray(workspace.data.layout)
      ? workspace.data.layout
      : undefined;
    const items = Array.isArray(settings.data?.items) ? settings.data.items : undefined;
    const resolved = resolveEffectiveExperience({ workspaceLayout: layout, settingsItems: items, storedDevice: readStoredExperience() });
    const target = forced ? "baseline" : resolved.id;
    const apply = () => {
      if (target !== readDomExperienceId() && hasUnsavedInput()) return false;
      if (!forced) writeStoredExperience(resolved.id, resolved.source);
      applyDomExperience(target, resolved.source);
      return true;
    };
    if (apply()) return;
    // Retry after an edit, submit or unmount commits. A new server choice cancels the old listener.
    const listeners = new AbortController();
    let pending = 0;
    const stop = () => { listeners.abort(); observer.disconnect(); window.cancelAnimationFrame(pending); };
    const schedule = () => {
      window.cancelAnimationFrame(pending);
      pending = window.requestAnimationFrame(() => { if (apply()) stop(); });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-form-value", "open"] });
    for (const type of ["input", "change", "reset", "submit", "visibilitychange"]) document.addEventListener(type, schedule, { signal: listeners.signal });
    return stop;
  }, [enabled, forced, workspace.isSuccess, workspace.data, settings.isSuccess, settings.data]);
}
