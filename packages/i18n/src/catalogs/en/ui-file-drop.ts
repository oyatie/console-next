import type { koUiFileDrop } from "../ko/ui-file-drop";

export const enUiFileDrop: Record<keyof typeof koUiFileDrop, string> = {
  "uiFileDrop.hint": "Drop a file here or choose one · {types} · up to {mb} MB",
  "uiFileDrop.pick": "Choose file",
  "uiFileDrop.pickMany": "Choose files",
  "uiFileDrop.wrongType": "{name}: this format isn’t accepted. Upload a {types} file.",
  "uiFileDrop.tooLarge": "{name}: larger than {mb} MB. Lower the scan resolution or save it as PDF, then upload again.",
};
