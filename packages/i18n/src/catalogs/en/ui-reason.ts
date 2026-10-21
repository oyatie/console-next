import type { koUiReason } from "../ko/ui-reason";

export const enUiReason: Record<keyof typeof koUiReason, string> = {
  "uiReason.memo": "Note",
  "uiReason.count": "{count, number} / {max, number}",
  "uiReason.pick": "Select one for {label}.",
  "uiReason.memoRequired": "A note is required when you select Other.",
};
