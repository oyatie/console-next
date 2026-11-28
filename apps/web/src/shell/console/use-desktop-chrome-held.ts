// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { session } from "@console/api";

/** Withhold the initial desktop layout while the tenant name is loading. A pending route can expose navigation
 * before that request starts. Keep those mounted controls and their focus when the route then settles first. */
export function useDesktopChromeHeld(restoring: boolean, awaitingProfile: boolean) {
  const principal = session.principal;
  const [shownFor, setShownFor] = useState<string | null>(null);
  const holding = restoring || (awaitingProfile && (!principal || shownFor !== principal));
  const visibleFor = holding ? null : principal;
  if (shownFor !== visibleFor) setShownFor(visibleFor);
  return holding;
}
