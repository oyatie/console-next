// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolveExperience, type experiences } from "./table";

const packs = {
  baseline: () => import("../shell/baseline/shell"),
} satisfies Record<(typeof experiences)[number]["id"], () => Promise<unknown>>;

export function loadPack() {
  return packs[resolveExperience(document.documentElement.dataset.experience).id]();
}
