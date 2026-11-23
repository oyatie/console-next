// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useActiveExperienceId } from "../../experience/dom";

/** Branches a route or feature screen on the active experience without pulling `PatternShell` into wizard chunks. */
export function ExperienceSwitch({ baseline, children }: { baseline: () => ReactNode; children: () => ReactNode }) {
  const experience = useActiveExperienceId();
  return <>{experience === "baseline" ? baseline() : children()}</>;
}
