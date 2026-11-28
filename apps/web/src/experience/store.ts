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
function rememberRollback(active: boolean): void {
  try {
    if (active && session.principal) sessionStorage.setItem(ROLLBACK_KEY, session.principal);
    else sessionStorage.removeItem(ROLLBACK_KEY);
  } catch { /* Device storage is optional. */ }
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
    if (forced === undefined && !workspace.isSuccess) {
      try {
        if (session.principal && sessionStorage.getItem(ROLLBACK_KEY) === session.principal) return;
      } catch { /* The server can still resolve the choice. */ }
    }
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
    // A saved or discarded draft need not trigger another server query.
    const pending = window.setInterval(() => { if (apply()) window.clearInterval(pending); }, 500);
    return () => window.clearInterval(pending);
  }, [enabled, forced, workspace.isSuccess, workspace.data, settings.isSuccess, settings.data]);
}
