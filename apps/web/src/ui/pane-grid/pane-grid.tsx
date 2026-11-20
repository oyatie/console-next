// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { isImeKey } from "../../lib/pure/ime";
import { editable, FOCUS_SETTLE_MS, ROW_SELECTOR } from "../long-table/row-keys";
import { PaneSplitter, SidePane, type SidePaneSpec } from "./pane-grid-side";
import s from "./pane-grid.module.css";

const rowElOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>(ROW_SELECTOR) : null);
const rowKeyOf = (el: Element | null) => el?.getAttribute("data-row-id") ?? el?.getAttribute("data-id") ?? null;

/** Filled operational pane title bar (`--surface-2`, `1px` `--border` bottom rule) with title, meta, and actions. */
export function PaneHead({
  title,
  meta,
  actions,
  level = 2,
  titleRef,
}: {
  /** Heading label of the pane. */
  title: ReactNode;
  /** Secondary contextual fact shown inline after `title` (for example period or item reference). */
  meta?: ReactNode;
  /** Trailing action controls aligned to the inline end of the bar. */
  actions?: ReactNode;
  /** Heading level (`2` for top-level panes, `3` inside nested sections). */
  level?: 2 | 3;
  /** Optional ref attached to the heading element for programmatic focus. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <header className={s.paneHead}>
      <div className={s.paneTitleGroup}>
        <Heading ref={titleRef} tabIndex={titleRef ? -1 : undefined} className={s.paneTitle}>
          {title}
        </Heading>
        {meta != null ? <bdi className={s.paneMeta}>{meta}</bdi> : null}
      </div>
      {actions != null ? <div className={s.paneActions}>{actions}</div> : null}
    </header>
  );
}

/**
 * Rule-divided multi-pane workspace grid (`start` rail, `main` region, optional `bottom` strip/bands, and resizable
 * `record` / `related` side panes with keyboard resize, Escape dismissal, and single-pane phone navigation).
 */
export function PaneGrid({
  start,
  main,
  bottom,
  record,
  related,
  full,
  onFull,
  onSelect,
  onOpen,
}: {
  /** Optional inline-start pane (filter rail, document metadata, or settings view list). */
  start?: ReactNode;
  /** Primary center region (table, grid, or document body). */
  main: ReactNode;
  /** Optional lower pane directly beneath `main` inside the center column. */
  bottom?: ReactNode;
  /** Optional primary detail or decision pane on the inline end. */
  record?: SidePaneSpec | false | "" | null;
  /** Optional secondary related-record pane beside `record`. */
  related?: SidePaneSpec | false | "" | null;
  /** Whether the active side pane expands across the workspace on tablet/desk widths. */
  full?: boolean;
  /** Toggle handler for full-pane mode. */
  onFull?: (on: boolean) => void;
  /** Row selection callback invoked when row focus settles while `record` is open. */
  onSelect?: (id: string) => void;
  /** Row activation callback invoked on `Enter` when `record` already shows the focused row. */
  onOpen?: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const recordRef = useRef<HTMLElement>(null);
  const relatedRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRecord = record || undefined;
  const openRelated = openRecord && related ? related : undefined;
  const depth = openRelated ? 2 : openRecord ? 1 : 0;
  const liveRef = useRef({ openRecord, openRelated, full, onFull, onSelect, onOpen });
  useLayoutEffect(() => {
    liveRef.current = { openRecord, openRelated, full, onFull, onSelect, onOpen };
  });

  const closePane = useCallback((pane: SidePaneSpec) => {
    clearTimeout(settleRef.current);
    restoreRef.current = pane.returnFocus ?? null;
    pane.onClose();
  }, []);

  useEffect(() => {
    const center = centerRef.current;
    if (!center) return;
    const onFocusIn = (e: FocusEvent) => {
      const row = rowElOf(e.target);
      if (row?.closest('[role="tree"]')) return;
      const id = rowKeyOf(row);
      if (!id) return;
      clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => {
        const openId = liveRef.current.openRecord?.id;
        if (openId && id !== openId) liveRef.current.onSelect?.(id);
      }, FOCUS_SETTLE_MS);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || e.altKey || e.ctrlKey || e.metaKey || editable(e.target)) return;
      const row = rowElOf(e.target);
      const id = rowKeyOf(row);
      if (!row || !id || row.closest('[role="grid"], [role="tree"]')) return;
      if (e.key === "Enter" && e.target === row) {
        const { openRecord: rec, onSelect: pick, onOpen: expand } = liveRef.current;
        if (rec?.id === id && expand) {
          e.preventDefault();
          expand(id);
        } else if (pick) {
          e.preventDefault();
          pick(id);
        }
      }
    };
    center.addEventListener("focusin", onFocusIn);
    center.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(settleRef.current);
      center.removeEventListener("focusin", onFocusIn);
      center.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || e.altKey || e.ctrlKey || e.metaKey) return;
      const { openRecord: rec, openRelated: rel, full: isFull, onFull: setFull } = liveRef.current;
      if (e.key !== "Escape" || (!rel && !rec) || editable(e.target)) return;
      if (
        e.target instanceof Element &&
        e.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sheet-layer], [data-escape-scope], [aria-expanded="true"]')
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (isFull && setFull && !window.matchMedia("(max-width: 767px)").matches) setFull(false);
      else closePane((rel ?? rec)!);
    };
    root.addEventListener("keydown", onKeyDown, true);
    return () => root.removeEventListener("keydown", onKeyDown, true);
  }, [closePane]);

  useEffect(() => {
    const fn = restoreRef.current;
    if (!fn || depth < 0) return;
    restoreRef.current = null;
    const frame = requestAnimationFrame(() => fn()?.focus());
    return () => cancelAnimationFrame(frame);
  }, [depth]);

  return (
    <div
      ref={rootRef}
      className={s.grid}
      data-pane-grid=""
      data-depth={depth}
      data-full={(full && depth > 0) || undefined}
    >
      {start != null ? <div className={s.start}>{start}</div> : null}
      <div ref={centerRef} className={s.center}>
        <div className={s.main}>{main}</div>
        {bottom != null ? <div className={s.bottom}>{bottom}</div> : null}
      </div>
      {openRecord ? (
        <>
          <PaneSplitter kind="record" container={rootRef} pane={recordRef} />
          <SidePane
            kind="record"
            pane={openRecord}
            paneRef={recordRef}
            centerRef={centerRef}
            full={full}
            onFull={!openRelated ? onFull : undefined}
            onCloseRequest={closePane}
          />
        </>
      ) : null}
      {openRelated ? (
        <>
          <PaneSplitter kind="related" container={rootRef} pane={relatedRef} />
          <SidePane
            kind="related"
            pane={openRelated}
            paneRef={relatedRef}
            centerRef={centerRef}
            full={full}
            onFull={onFull}
            onCloseRequest={closePane}
          />
        </>
      ) : null}
    </div>
  );
}
