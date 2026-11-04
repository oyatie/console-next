import type { koUiSetupRail } from "../ko/ui-setup-rail";

export const enUiSetupRail: Record<keyof typeof koUiSetupRail, string> = {
  "uiSetupRail.progress": "{done, number} of {total, number} done",
  "uiSetupRail.state.todo": "Required",
  "uiSetupRail.state.done": "Done",
  "uiSetupRail.state.attention": "Check",
  "uiSetupRail.state.blocked": "Blocked",
};
