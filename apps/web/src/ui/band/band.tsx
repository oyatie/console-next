import type { HTMLAttributes, ReactNode } from "react";
import s from "./band.module.css";

/**
 * A full-bleed strip of a full-width screen (design-language §4.4): a record's head, a filter row, a section bar, a key
 * strip at the foot. It owns the surface and the rule that separates it (`edge`); the caller's class lays out what is in
 * it. `tone="canvas"` sits a strip on the page colour (a stat row under a filter band). A page head is PageHead.
 */
export function Band({ as: El = "div", edge = "bottom", tone = "surface", className, children, ...rest }: HTMLAttributes<HTMLElement> & {
  as?: "div" | "header" | "footer" | "section" | "nav";
  edge?: "bottom" | "top" | "none";
  tone?: "surface" | "canvas";
  children?: ReactNode;
}) {
  return <El {...rest} className={className ? `${s.band} ${className}` : s.band} data-edge={edge} data-tone={tone}>{children}</El>;
}
