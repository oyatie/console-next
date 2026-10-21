import type { koUiReceipt } from "../ko/ui-receipt";

export const enUiReceipt: Record<keyof typeof koUiReceipt, string> = {
  "uiReceipt.draft": "Draft",
  "uiReceipt.undoApplied": "Undo",
  "uiReceipt.dismiss": "Dismiss",
  "uiReceipt.undo": "Undo",
  "uiReceipt.sending": "Waiting for the server to record it · closing the window continues with the same request key",
  "uiReceipt.recorded": "Recorded",
  "uiReceipt.checking.title": "No response received",
  "uiReceipt.checking": "The earlier request may already have been processed. Looking up its recorded state with the same request key. Do not run it again.",
};
