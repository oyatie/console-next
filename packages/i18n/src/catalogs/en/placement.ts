import type { koPlacement } from "../ko/placement";

export const enPlacement: Record<keyof typeof koPlacement, string> = {
  "placement.entity": "Legal entity",
  "placement.workplace": "Workplace",
  "placement.primary": "Main workplace",
  "placement.noMatch": "Nothing matches that name",
  "placement.noEntity": "There is no legal entity to employ them.",
  "placement.noEntity.action": "Register entity",
  "placement.noWorkplace": "There is no workplace to place them in.",
  "placement.noWorkplace.action": "Register workplace",
};
