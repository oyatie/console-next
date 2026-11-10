// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button, IconButton } from "../button/button";
import { editable, ROW_SELECTOR } from "../long-table/row-keys";
import { SidePanelReadContext } from "../side-panel/read-context";
import s from "./flexible-columns.module.css";

type Kind = "record" | "related";
type FlexibleColumnPane = {
  id: string; label: string; title?: ReactNode; crumb?: ReactNode; expand?: ReactNode;
  closeLabel?: string; onClose: () => void; returnFocus?: () => HTMLElement | null | undefined; children: ReactNode;
};

const FOCUS_SETTLE_MS = 150;
const rowElOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>(ROW_SELECTOR) : null);
const rowKeyOf = (el: Element | null) => el?.getAttribute("data-row-id") ?? el?.getAttribute("data-id") ?? null;
const setColumnWidth = (el: HTMLElement, kind: Kind, width?: number) => {
  const prop = kind === "related" ? "--col-related-w" : "--col-record-w";
  if (width === undefined) el.style.removeProperty(prop);
  else el.style.setProperty(prop, `${width}px`);
};

function Splitter({ kind, container, pane }: { kind: Kind; container: RefObject<HTMLDivElement | null>; pane: RefObject<HTMLElement | null> }) {
  const [pct, setPct] = useState(50);
  const apply = (raw: number) => {
    const root = container.current;
    if (!root) return;
    const total = root.getBoundingClientRect().width || 1200;
    const clamped = Math.max(260, Math.min(Math.max(320, Math.floor(total * 0.6)), Math.round(raw)));
    setColumnWidth(root, kind, clamped);
    setPct(Math.max(20, Math.min(80, Math.round((clamped / total) * 100))));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !pane.current) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.current.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => apply(startW + (startX - ev.clientX));
    const onUp = () => (window.removeEventListener("pointermove", onMove), window.removeEventListener("pointerup", onUp), window.removeEventListener("pointercancel", onUp));
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home" && container.current) return void (e.preventDefault(), setColumnWidth(container.current, kind, undefined), setPct(50));
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && pane.current) {
      e.preventDefault();
      apply(pane.current.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 24 : -24));
    }
  };
  return <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("common.resizeColumn")}
    aria-valuemin={20} aria-valuemax={80} aria-valuenow={pct} className={s.splitter} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}

function ColumnPane({ kind, pane, paneRef, listRef, onCloseRequest, full, onFull }: {
  full?: boolean; onFull?: (on: boolean) => void;
  kind: Kind; pane: FlexibleColumnPane; paneRef: RefObject<HTMLElement | null>; listRef: RefObject<HTMLDivElement | null>; onCloseRequest: (pane: FlexibleColumnPane) => void;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titled = pane.title != null || pane.crumb != null || pane.expand != null;
  const closeLabel = pane.closeLabel ?? t(kind === "related" ? "common.closeRelated" : "common.closePanel");
  useEffect(() => {
    const singleCol = Boolean(listRef.current && getComputedStyle(listRef.current).display === "none");
    if (!pane.id || (!singleCol && kind !== "related")) return;
    const frame = requestAnimationFrame(() => (backRef.current && getComputedStyle(backRef.current).display !== "none" ? backRef.current : titleRef.current ?? closeRef.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [kind, listRef, pane.id]);
  return (
    <aside ref={paneRef} className={s[kind]} aria-label={pane.label}>
      <div className={s.head} data-titled={titled || undefined}>
        <Button ref={backRef} variant="ghost" className={s.back} onClick={() => onCloseRequest(pane)}><ArrowLeft size={16} aria-hidden />{t("common.back")}</Button>
        {pane.crumb != null && <div className={s.crumb}>{pane.crumb}</div>}
        <div className={s.headRow}>
          {pane.title != null && <h2 ref={titleRef} tabIndex={-1} className={s.title}>{pane.title}</h2>}
          <div className={s.actions}>
            {onFull && <IconButton className={s.full} label={t("uiFlexibleColumns.full")} aria-pressed={Boolean(full)} onClick={() => onFull(!full)}>{full ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}</IconButton>}
            {pane.expand}<IconButton ref={closeRef} className={s.close} label={closeLabel} onClick={() => onCloseRequest(pane)}><X size={16} aria-hidden /></IconButton>
          </div>
        </div>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable read content must be keyboard reachable (WCAG 2.1.1). */}
      <SidePanelReadContext value={true}><div className={s.body} tabIndex={0}>{pane.children}</div></SidePanelReadContext>
    </aside>
  );
}

/** Shared list + record + optional related-record columns with URL-driven depth, J/K list-follow, splitter resize, and phone Back. */
export function FlexibleColumns({ list, record, related, onSelect, onOpen, onFind, full, onFull }: {
  full?: boolean; onFull?: (on: boolean) => void;
  list: ReactNode; record?: FlexibleColumnPane | false | "" | null; related?: FlexibleColumnPane | false | "" | null;
  onSelect?: (id: string) => void; onOpen?: (id: string) => void; onFind?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recordRef = useRef<HTMLElement>(null);
  const relatedRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRecord = record || undefined;
  const openRelated = openRecord && related ? related : undefined;
  const depth = openRelated ? 2 : openRecord ? 1 : 0;
  const liveRef = useRef({ openId: openRecord?.id, onSelect, onOpen });
  useEffect(() => { liveRef.current = { openId: openRecord?.id, onSelect, onOpen }; });
  const closePane = useCallback((pane: FlexibleColumnPane) => { clearTimeout(settleRef.current); restoreRef.current = pane.returnFocus ?? null; pane.onClose(); }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onFocusIn = (e: FocusEvent) => {
      const row = rowElOf(e.target);
      if (row?.closest('[role="tree"]')) return;
      const id = rowKeyOf(row);
      if (!id) return;
      clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => { if (liveRef.current.openId && id !== liveRef.current.openId) liveRef.current.onSelect?.(id); }, FOCUS_SETTLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return;
      const currentRow = rowElOf(e.target);
      const currentId = rowKeyOf(currentRow);
      if (!currentRow || !currentId || currentRow.closest('[role="grid"], [role="tree"]')) return;
      const { openId, onSelect: pick, onOpen: expand } = liveRef.current;
      if (e.key === "Enter" && e.target === currentRow && (pick || expand)) {
        if (currentRow.tagName === "BUTTON" && (!openId || openId !== currentId)) return;
        e.preventDefault();
        return void (openId === currentId && expand ? expand(currentId) : pick?.(currentId));
      }
      if (e.shiftKey) return;
      const step = e.code === "KeyJ" || e.key === "ArrowDown" ? 1 : e.code === "KeyK" || e.key === "ArrowUp" ? -1 : 0;
      const rows = step ? [...el.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(r => r.getClientRects().length > 0) : [];
      const next = step ? rows[rows.indexOf(currentRow) + step] : undefined;
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("keydown", onKey);
    return () => { clearTimeout(settleRef.current); el.removeEventListener("focusin", onFocusIn); el.removeEventListener("keydown", onKey); };
  }, []);

  useEffect(() => {
    const fn = restoreRef.current;
    if (!fn || depth < 0) return;
    restoreRef.current = null;
    const frame = requestAnimationFrame(() => fn()?.focus());
    return () => cancelAnimationFrame(frame);
  }, [depth]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current;
      const target = e.target;
      if (!root || !(target instanceof Node) || !root.contains(target) || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "/" && onFind && !editable(target)) return void (e.preventDefault(), e.stopPropagation(), onFind());
      if (e.key !== "Escape" || (!openRelated && !openRecord) || editable(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sheet-layer], [aria-expanded="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (full && onFull && !window.matchMedia("(max-width: 639px)").matches) onFull(false);
      else closePane((openRelated ?? openRecord)!);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closePane, onFind, openRecord, openRelated, full, onFull]);

  return (
    <div ref={rootRef} className={s.columns} data-flexible-columns data-depth={depth} data-full={full && depth > 0 || undefined}>
      <div ref={listRef} className={s.list}>{list}</div>
      {openRecord && <><Splitter kind="record" container={rootRef} pane={recordRef} /><ColumnPane kind="record" full={full} onFull={!openRelated ? onFull : undefined} pane={openRecord} paneRef={recordRef} listRef={listRef} onCloseRequest={closePane} /></>}
      {openRelated && <><Splitter kind="related" container={rootRef} pane={relatedRef} /><ColumnPane kind="related" full={full} onFull={onFull} pane={openRelated} paneRef={relatedRef} listRef={listRef} onCloseRequest={closePane} /></>}
    </div>
  );
}
