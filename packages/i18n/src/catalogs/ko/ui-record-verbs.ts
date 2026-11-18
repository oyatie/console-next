// Korean copy for `uiRecordVerbs.` ids (the correct verb of record actions). Rules: the header of ../ko.ts and GUIDE.md.
// A wrongly entered value is fixed with 「정정」; an applied record is never 「되돌리기」.
import type { enUiRecordVerbs } from "../en/ui-record-verbs";
export const koUiRecordVerbs: Record<keyof typeof enUiRecordVerbs, string> = {
  "uiRecordVerbs.verb.correct": "정정",
  "uiRecordVerbs.button.correct": "{object} 정정",
};
