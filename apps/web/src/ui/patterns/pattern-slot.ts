// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment, isValidElement, type ReactNode } from "react";
import { shown } from "../shown";

/** Whether an optional pattern slot carries visible content, ignoring empty arrays and empty Fragments. */
export function shownSlot(node: ReactNode): boolean {
  if (!shown(node) || node === true) return false;
  if (Array.isArray(node)) return node.some(shownSlot);
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return shownSlot(node.props.children);
  return true;
}
