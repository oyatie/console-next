// Korean copy for `uiSetupRail.` ids (apps/web/src/ui/setup-rail). Rules: the header of ../ko.ts and packages/i18n/GUIDE.md.
import type { enUiSetupRail } from "../en/ui-setup-rail";
export const koUiSetupRail: Record<keyof typeof enUiSetupRail, string> = {
  "uiSetupRail.progress": "{done, number}/{total, number} 완료",
  "uiSetupRail.state.todo": "필요",
  "uiSetupRail.state.done": "완료",
  "uiSetupRail.state.attention": "확인",
  "uiSetupRail.state.blocked": "차단",
};