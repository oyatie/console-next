// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button, IconButton } from "../button/button";
import { Skeleton } from "../skeleton/skeleton";
import s from "./side-panel.module.css";
import { SidePanelReadContext } from "./read-context";

type SidePanelProps = {
  open: boolean;
  title: string;
  crumb?: ReactNode;
  chips?: ReactNode;
  openLink?: ReactNode;
  size?: "peek" | "lg";
  loading?: boolean;
  onClose: () => void;
  /** Resolve the selected row even after reload or Forward. Key the panel by the selected record. */
  returnFocus?: () => HTMLElement | null;
  /** Read-only content; use QueryState for failed/refused reads and EmptyState for empty content. Edits use Sheet. */
  children: ReactNode;
};

/** A non-modal peek beside a list/canvas; below 1280 it overlays, below 640 it fills the screen. Escape within the panel dismisses it (WCAG 2.4.11). */
export function SidePanel({ open, title, crumb, chips, openLink, size = "peek", loading, onClose, returnFocus, children }: SidePanelProps) {
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const findOrigin = useEffectEvent(() => returnFocus?.() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    if (!open) return;
    const origin = findOrigin();
    const panel = box.current;
    heading.current?.focus({ preventScroll: true });
    return () => {
      // A route or another overlay may already own focus when this peek unmounts.
      if (origin?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body)) origin.focus();
    };
  }, [open]);
  useEffect(() => {
    const panel = box.current;
    if (!open || !panel) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]')) return;
      event.preventDefault();
      onClose();
    };
    panel.addEventListener("keydown", escape);
    return () => panel.removeEventListener("keydown", escape);
  }, [open, onClose]);
  if (!open) return null;
  return <aside ref={box} className={s.panel} data-side-panel data-size={size} aria-labelledby={id}>
    <header className={s.head}>
      <Button variant="ghost" className={s.back} onClick={onClose}><ArrowLeft size={16} aria-hidden />{t("common.back")}</Button>
      {crumb != null && <div className={s.crumb}>{crumb}</div>}
      <div className={s.heading}>
        <h2 ref={heading} id={id} tabIndex={-1} className={s.title}>{title}</h2>
        <IconButton className={s.close} label={t("common.closePanel")} onClick={onClose}><X size={16} aria-hidden /></IconButton>
      </div>
      {(chips != null || openLink != null) && <div className={s.tools}>{chips}{openLink}</div>}
    </header>
    {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable read content must be keyboard reachable (WCAG 2.1.1). */}
    <div className={s.body} tabIndex={0} aria-busy={loading || undefined}>
      <SidePanelReadContext value={true}>{loading ? <Skeleton bones={["title", "row", "row"]} label={t("common.loading")} /> : children}</SidePanelReadContext>
    </div>
  </aside>;
}
