import type { koUiConflict } from "../ko/ui-conflict";

export const enUiConflict: Record<keyof typeof koUiConflict, string> = {
  "uiConflict.field_conflict": "{count, plural, one {# field} other {# fields}} changed while you were saving. Your entries are kept. Select a value for each field to save.",
  "uiConflict.stale_facts": "{count, plural, one {# fact} other {# facts}} changed after you checked, so nothing was applied. Review the new values, select one for each, then run it again.",
  "uiConflict.left": "{count, plural, one {# field} other {# fields}} left to select",
  "uiConflict.done": "Every field has a choice",
  "uiConflict.mine": "Your value",
  "uiConflict.current": "Current value",
  "uiConflict.base": "Value when loaded",
  "uiConflict.changedBy": "Changed by {actor} at {at}",
  "uiConflict.changedBy.hidden": "Changed at {at}",
  "uiConflict.choice": "Value to use for {label}",
  "uiConflict.useTheirs": "Use that value",
  "uiConflict.keepMine": "Keep my value",
  "uiConflict.empty": "No value",
};
