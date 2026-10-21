import type { koUiBlocker } from "../ko/ui-blocker";

export const enUiBlocker: Record<keyof typeof koUiBlocker, string> = {
  "uiBlocker.code": "Refusal code {code}",
  "uiBlocker.who": "Who can unblock this",
  "uiBlocker.who.ability": "Who can unblock this · {ability}",
  "uiBlocker.remedies": "What you can do",
};
