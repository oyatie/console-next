// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mountDock } from "./dock";

/** All floating status shares one stack, outside the page's layout and scrolling region. */
export function StatusDock({ children }: { children: ReactNode }) {
  const [target] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  useLayoutEffect(() => target ? mountDock(target) : undefined, [target]);
  return target ? createPortal(children, target) : children;
}
