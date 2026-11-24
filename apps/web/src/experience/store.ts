// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** Sync the signed-in tenant user's resolved screen style without reloading or clobbering dirty forms. */
export function useExperienceSync(enabled: boolean): void {
  useEffect(() => {
    installDirtyTracker();
  }, []);
  const workspace = useQuery({ ...workspaceQuery, enabled });
  const settings = useQuery({ ...settingsQuery, enabled });
  useEffect(() => {
    if (!enabled || (!workspace.isSuccess && !settings.isSuccess)) return;
    const layout = workspace.data?.layout && typeof workspace.data.layout === "object" && !Array.isArray(workspace.data.layout)
      ? workspace.data.layout
      : undefined;
    const items = Array.isArray(settings.data?.items) ? settings.data.items : undefined;
    const resolved = resolveEffectiveExperience({
      workspaceLayout: layout,
      settingsItems: items,
      storedDevice: readStoredExperience(),
    });
    // Stored even while unsaved input holds the swap back, so the next load paints it first.
    writeStoredExperience(resolved.id, resolved.source);
    if (resolved.id !== readDomExperienceId() && hasUnsavedInput()) return;
    applyDomExperience(resolved.id);
  }, [enabled, workspace.isSuccess, workspace.data, settings.isSuccess, settings.data]);
}
