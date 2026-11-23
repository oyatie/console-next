// SPDX-License-Identifier: LicenseRef-Proprietary

type Attributes = { getAttribute?: (name: string) => string | null };

/**
 * Whether the element holding the focus has a popup open, which takes Escape before anything around it: an expanded
 * trigger that declares a popup (a select, a menu), or an expanded combobox. A disclosure button or an
 * unfolded tree row is expanded too, but opens nothing that Escape closes.
 */
export function popupOpen(el: Attributes): boolean {
  if (el.getAttribute?.("aria-expanded") !== "true") return false;
  const popup = el.getAttribute("aria-haspopup");
  return (popup !== null && popup !== "false") || el.getAttribute("role") === "combobox";
}
