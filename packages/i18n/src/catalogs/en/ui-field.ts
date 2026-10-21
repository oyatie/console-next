import type { koUiField } from "../ko/ui-field";

export const enUiField: Record<keyof typeof koUiField, string> = {
  "uiField.required": "Required",
  "uiField.optional": "Optional",
  "uiField.example": "e.g. {example}",
  "uiField.derived": "Auto",
  "uiField.overridden": "Edited",
  "uiField.override": "Edit",
  "uiField.override.label": "Edit {label}",
  "uiField.revert": "Recalculate automatically",
};
