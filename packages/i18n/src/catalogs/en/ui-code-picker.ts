import type { koUiCodePicker } from "../ko/ui-code-picker";

export const enUiCodePicker: Record<keyof typeof koUiCodePicker, string> = {
  "uiCodePicker.notLoaded": "The {list} list isn’t loaded yet. Save it as printed; you’ll be asked to assign the code once the list is ready.",
  "uiCodePicker.notLoadedEmpty": "The {list} list isn’t loaded yet. You can leave it empty and save, and select once the list is ready.",
  "uiCodePicker.loading": "Searching…",
  "uiCodePicker.none": "No matching code. Try other words.",
  "uiCodePicker.version": "{list} · {version}",
};
