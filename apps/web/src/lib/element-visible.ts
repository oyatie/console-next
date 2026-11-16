// SPDX-License-Identifier: LicenseRef-Proprietary
/** checkVisibility is newer than the oldest supported browsers. */
export function elementVisible(element: Element): boolean {
  return (element.checkVisibility?.() ?? element.getClientRects().length > 0)
    && getComputedStyle(element).visibility === "visible";
}
