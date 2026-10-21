// English for `uiRecordActions.` ids (apps/web/src/ui/record-actions).
import type { koUiRecordActions } from "../ko/ui-record-actions";

export const enUiRecordActions: Partial<Record<keyof typeof koUiRecordActions, string>> = {
  "uiRecordActions.edit": "Edit",
  "uiRecordActions.add": "Add",
  "uiRecordActions.of": "{verb} {field}",
  "uiRecordActions.addOf": "Add {object}",
  "uiRecordActions.more": "More for {field}",
  "uiRecordActions.history": "History",
  "uiRecordActions.end.delete": "Delete",
  "uiRecordActions.end.void": "Void",
  "uiRecordActions.end.clear": "Clear",
  "uiRecordActions.path.setup": "Applies now (setup phase) · kept in the audit log",
  "uiRecordActions.path.revision": "Applies now · kept as a dated revision",
  "uiRecordActions.path.correction": "Applies now · kept as a correction record",
  "uiRecordActions.path.approval": "Applies after approval · kept in the history",
  "uiRecordActions.path.second": "Applies once a second person confirms · kept as a correction record",
  "uiRecordActions.path.stepUp": "Applies after your passkey · kept as a correction record",
};
