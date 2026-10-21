import type { koUiSetupRail } from "../ko/ui-setup-rail";

export const enUiSetupRail: Record<keyof typeof koUiSetupRail, string> = {
  "uiSetupRail.progress": "{done, number} of {total, number} done",
  "uiSetupRail.state.todo": "To do",
  "uiSetupRail.state.done": "Done",
  "uiSetupRail.state.attention": "Done, with something to check",
  "uiSetupRail.state.blocked": "Waiting on an earlier step",
};
