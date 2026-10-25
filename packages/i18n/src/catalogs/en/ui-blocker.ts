import type { koUiBlocker } from "../ko/ui-blocker";

export const enUiBlocker: Record<keyof typeof koUiBlocker, string> = {
  "uiBlocker.reason": "View reason",
  "uiBlocker.who": "Who can unblock this",
  "uiBlocker.who.ability": "Who can unblock this · {ability}",
  "uiBlocker.remedies": "What you can do",
};
