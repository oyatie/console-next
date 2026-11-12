// Korean copy for `uiChoice.` ids (apps/web/src/ui/choice): the select's empty first entry.
// A choice that changes the outcome is never preselected, so the empty entry names the action.
import type { enUiChoice } from "../en/ui-choice";
export const koUiChoice: Record<keyof typeof enUiChoice, string> = {
  "uiChoice.pathSeparator": " › ",
  "uiChoice.placeholder": "{label} 선택",
  "uiChoice.noMatch": "맞는 곳이 없습니다 · 검색어를 줄이거나 비우십시오",
};