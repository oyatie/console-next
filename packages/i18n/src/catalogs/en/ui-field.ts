import type { koUiField } from "../ko/ui-field";

export const enUiField: Record<keyof typeof koUiField, string> = {
  "uiField.required": "Required",
  "uiField.optional": "Optional",
  "uiField.valueMissing": "This field is required.",
  "uiField.typeMismatch": "Enter a value in the correct format.",
  "uiField.patternMismatch": "Enter a value matching the required pattern.",
  "uiField.tooShort": "The value is too short.",
  "uiField.tooLong": "The value is too long.",
  "uiField.rangeUnderflow": "Enter a value at or above the minimum.",
  "uiField.rangeOverflow": "Enter a value at or below the maximum.",
  "uiField.stepMismatch": "Enter a value matching the allowed step.",
  "uiField.badInput": "Enter a valid value.",
  "uiField.example": "e.g. {example}",
  "uiField.derived": "Auto",
  "uiField.overridden": "Edited",
  "uiField.override": "Edit",
  "uiField.override.label": "Edit {label}",
  "uiField.revert": "Recalculate automatically",
  "uiField.copyUrlFailed": "Couldn’t copy the address. Select it and copy it yourself.",
  "uiField.copyUrl": "Copy address",
  "uiField.copiedUrl": "Address copied",
};
