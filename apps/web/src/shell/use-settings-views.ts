// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { myAccessQuery } from "../reference/authz/api";
import { settingsViews, type SettingsView } from "./settings-views";

/** Settings sub-routes currently reachable by the signed-in reader, matching `/settings` hub visibility. */
export function useSettingsViews(): readonly SettingsView[] {
  const access = useQuery(myAccessQuery);
  const router = useRouter();
  return settingsViews(Object.values(router.routesByPath ?? {}), access.data);
}
