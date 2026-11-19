// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolveExperience, type experiences } from "./table";

const baselineShell = () => import("../shell/baseline/shell");
const packs = {
  baseline: baselineShell,
  "control-room": baselineShell,
  "warm-clear": baselineShell,
} satisfies Record<(typeof experiences)[number]["id"], () => Promise<unknown>>;

export function loadPack() {
  return packs[resolveExperience(document.documentElement.dataset.experience).id]();
}
