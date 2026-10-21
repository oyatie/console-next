// English for `uiRecord.` ids (apps/web/src/ui/record).
import type { koUiRecord } from "../ko/ui-record";

export const enUiRecord: Partial<Record<keyof typeof koUiRecord, string>> = {
  "uiRecord.registerItem": "Employee register item {no}",
  "uiRecord.sections": "Record sections",
  "uiRecord.markOf": "{mark} {field}",
  "uiRecord.edit": "Edit",
  "uiRecord.mark.rc": "Edit",
  "uiRecord.mark.cor": "Correct only",
  "uiRecord.mark.corTwo": "Correct only · two people",
  "uiRecord.mark.first": "First entry",
  "uiRecord.mark.inline": "Quick edit",
  "uiRecord.mark.verb": "By action",
  "uiRecord.mark.lock": "Only via actions",
};
