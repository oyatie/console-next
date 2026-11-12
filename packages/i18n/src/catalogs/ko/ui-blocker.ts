// Korean copy for `uiBlocker.` ids (apps/web/src/ui/blocker): the server-refusal panel. Title, body
// and remedies come from the caller (refusal code → catalog); only the fixed frame lives here.
import type { enUiBlocker } from "../en/ui-blocker";
export const koUiBlocker: Record<keyof typeof enUiBlocker, string> = {
  "uiBlocker.reason": "이유 보기",
  "uiBlocker.who": "풀 수 있는 사람",
  "uiBlocker.who.ability": "풀 수 있는 사람 · {ability}",
  "uiBlocker.remedies": "해결 방법",
};