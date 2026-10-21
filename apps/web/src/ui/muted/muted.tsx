import type { ReactNode } from "react";

/**
 * A value said quietly beside or instead of a fact: none recorded, not set, a unit, a since-line. The one muted
 * inline element, in place of hand-written muted spans (one component per job).
 */
export function Muted({ children }: { children: ReactNode }) {
  return <span className="muted">{children}</span>;
}
