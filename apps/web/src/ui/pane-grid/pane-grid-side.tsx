// SPDX-License-Identifier: LicenseRef-Proprietary
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { t } from "@console/i18n";
import { isImeKey } from "../../lib/pure/ime";
import { Button, IconButton } from "../button/button";
import { useMountFocus } from "../page/use-mount-focus";
import { SidePanelReadContext } from "../side-panel/read-context";
import { openWorkspaceTab, type OpenTabPayload } from "../workspace-tabs/open-tab";
import s from "./pane-grid.module.css";

type SideKind = "record" | "related";

export type SidePaneSpec = {
  id: string;
  label: string;
  title?: ReactNode;
  meta?: ReactNode;
  openInTab?: OpenTabPayload;
  actions?: ReactNode;
  closeLabel?: string;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
  footer?: ReactNode;
  children: ReactNode;
};

function setSideWidth(el: HTMLElement, kind: SideKind, width?: number) {
  const prop = kind === "related" ? "--pane-related-w" : "--pane-record-w";
  if (width === undefined) el.style.removeProperty(prop);
  else el.style.setProperty(prop, `${width}px`);
}

export function PaneSplitter({
  kind,
  container,
  pane,
}: {
  kind: SideKind;
  container: RefObject<HTMLDivElement | null>;
  pane: RefObject<HTMLElement | null>;
}) {
  const maxPct = kind === "related" ? 50 : 55;
  const minW = kind === "related" ? 260 : 280;
  const [pct, setPct] = useState(50);
  const apply = (raw: number) => {
    const root = container.current;
    if (!root) return;
    const total = root.getBoundingClientRect().width || 1200;
    const maxW = Math.max(minW, Math.floor((total * maxPct) / 100));
    const clamped = Math.max(minW, Math.min(maxW, Math.round(raw)));
    setSideWidth(root, kind, clamped);
    setPct(Math.max(20, Math.min(maxPct, Math.round((clamped / total) * 100))));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !pane.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.current.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => apply(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeKey(e)) return;
    if (e.key === "Home" && container.current) {
      e.preventDefault();
      setSideWidth(container.current, kind, undefined);
      setPct(50);
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && pane.current) {
      e.preventDefault();
      apply(pane.current.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 24 : -24));
    }
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("common.resizeColumn")}
      aria-valuemin={20}
      aria-valuemax={maxPct}
      aria-valuenow={pct}
      className={s.splitter}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

export function SidePane({
  kind,
  pane,
  paneRef,
  centerRef,
  full,
  onFull,
  onCloseRequest,
}: {
  kind: SideKind;
  pane: SidePaneSpec;
  paneRef: RefObject<HTMLElement | null>;
  centerRef: RefObject<HTMLDivElement | null>;
  full?: boolean;
  onFull?: (on: boolean) => void;
  onCloseRequest: (pane: SidePaneSpec) => void;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeLabel = pane.closeLabel ?? t(kind === "related" ? "common.closeRelated" : "common.closePanel");

  useMountFocus(pane.id, () => {
    const singleCol = centerRef.current && getComputedStyle(centerRef.current).display === "none";
    if (!singleCol && kind !== "related") return null;
    return backRef.current && getComputedStyle(backRef.current).display !== "none"
      ? backRef.current
      : titleRef.current ?? closeRef.current;
  });

  return (
    <aside ref={paneRef} className={s[kind]} aria-label={pane.label} data-pane={kind}>
      <header className={s.paneHead}>
        <Button ref={backRef} variant="ghost" size="sm" className={s.back} onClick={() => onCloseRequest(pane)}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t("common.back")}
        </Button>
        <div className={s.paneTitleGroup}>
          <h2 ref={titleRef} tabIndex={-1} className={s.paneTitle}>
            {pane.title ?? pane.label}
          </h2>
          {pane.meta != null ? <bdi className={s.paneMeta}>{pane.meta}</bdi> : null}
        </div>
        <div className={s.paneActions}>
          {pane.openInTab ? (
            <Button size="sm" onClick={() => openWorkspaceTab(pane.openInTab!)}>
              <ExternalLink size={12} aria-hidden="true" />
              {t("uiFlexibleColumns.openInTab")}
            </Button>
          ) : null}
          {pane.actions}
          {onFull ? (
            <IconButton
              size="sm"
              className={s.fullBtn}
              label={t("uiFlexibleColumns.full")}
              aria-pressed={Boolean(full)}
              onClick={() => onFull(!full)}
            >
              {full ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            </IconButton>
          ) : null}
          <IconButton ref={closeRef} size="sm" className={s.closeBtn} label={closeLabel} onClick={() => onCloseRequest(pane)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <SidePanelReadContext value={true}>
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable read content must be keyboard reachable (WCAG 2.1.1). */}
        <div className={s.paneBody} tabIndex={0}>
          {pane.children}
        </div>
      </SidePanelReadContext>
      {pane.footer != null ? <div className={s.paneFooter}>{pane.footer}</div> : null}
    </aside>
  );
}
