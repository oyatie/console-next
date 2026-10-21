import { forwardRef, useCallback, type HTMLAttributes, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { place } from "./place";
import s from "./org-node.module.css";

export type NodeLevel = "tenant" | "entity" | "site" | "dept";
/** Box states (spec D6, D15, D16): selection is a fill and ring; keyboard focus is a separate ink outline. */
export type NodeState = "sel" | "multi" | "hit" | "now" | "ok" | "drop" | "dim" | "edit" | "ghost" | "skel" | "scheduled" | "gone";

/**
 * One box of the org chart (spec §2 OrgNode). Level is told by the top edge and a text label, never by a hue;
 * type never shrinks below 12 px (D3). The caller lays it out (x, y, w, h) and fills its lines.
 */
export const OrgNode = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  level: NodeLevel;
  box: { x: number; y: number; w: number; h: number };
  states?: readonly NodeState[];
  tile?: boolean;
}>(function OrgNode({ level, box, states = [], tile, className, ...rest }, ref) {
  const { x, y, w, h } = box;
  const at = useCallback(
    (el: HTMLDivElement | null) => {
      place({ left: x, top: y, width: w, height: h })(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [x, y, w, h, ref],
  );
  return (
    <div
      ref={at}
      {...rest}
      data-box
      data-level={level}
      data-s={states.join(" ") || undefined}
      className={[s.node, tile && s.tile, className].filter(Boolean).join(" ")}
    />
  );
});

export const NodeKicker = ({ icon, children, link }: { icon?: ReactNode; children: ReactNode; link?: ReactNode }) => (
  <div className={s.kicker}>{icon}<em>{children}</em>{link}</div>
);
export const NodeRow = ({ name, count, children, small }: { name: ReactNode; count?: ReactNode; children?: ReactNode; small?: boolean }) => (
  <div className={s.row}><span className={small ? `${s.name} ${s.small}` : s.name}>{name}</span>{children}{count != null && <span className={s.count}>{count}</span>}</div>
);
export const NodeLine = ({ children }: { children: ReactNode }) => <div className={s.line}>{children}</div>;
export const NodeFoot = ({ children }: { children: ReactNode }) => <div className={s.foot}>{children}</div>;
export const NodeChips = ({ children }: { children: ReactNode }) => <div className={s.chips}>{children}</div>;
/** A text tag on the top edge (D16: a change mark carries text; "now" on the current search hit). */
export const NodeTag = ({ tone = "neutral", children }: { tone?: "hit" | "new" | "neutral"; children: ReactNode }) => (
  <span className={s.tag} data-tone={tone}>{children}</span>
);
/** The expander under a box ("11 departments", "3 below"); its own ≥ 24 px target (D13). */
export const NodeMore = ({ open, label, onToggle, ...aria }: { open: boolean; label: ReactNode; onToggle: () => void; "aria-label"?: string }) => (
  <button type="button" className={s.more} aria-expanded={open} tabIndex={-1} onClick={(e) => (e.stopPropagation(), onToggle())} {...aria}>
    {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
    {label}
  </button>
);
/** A count badge on a collapsed container (search hits inside). */
export const NodeBadge = ({ children }: { children: ReactNode }) => <span className={s.badge}>{children}</span>;
