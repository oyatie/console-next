// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AttentionInboxItem } from "../domain/inbox-filter";

type RowTarget = { id: string; index: number };
type PendingDecision = { id: string; fallbackIndex: number; dataUpdatedAt: number };

/** Restores keyboard focus to the decided row or the row occupying its slot when an inbox item leaves the queue. */
export function useWorklistDecisionFocus({
  surfaceRef,
  visibleRows,
  selectedItem,
  sel,
  select,
  removed,
  dataUpdatedAt,
  isFetching,
  titleId,
}: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  visibleRows: readonly AttentionInboxItem[];
  selectedItem: AttentionInboxItem | undefined;
  sel: string | undefined;
  select: (id: string | undefined) => void;
  removed: boolean;
  dataUpdatedAt: number;
  isFetching: boolean;
  titleId: string;
}) {
  const domIndexByIdRef = useRef<Map<string, number>>(new Map());
  const lastSelectedRef = useRef<RowTarget | null>(null);
  const restoreListRef = useRef<RowTarget | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);

  const focusWorklistRow = useCallback((target: RowTarget | null) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (target) {
      const exact = surface.querySelector<HTMLElement>(`tbody tr[data-id="${CSS.escape(target.id)}"]`);
      if (exact) {
        exact.focus();
        return;
      }
      const rows = [...surface.querySelectorAll<HTMLElement>("tbody tr[data-id]")];
      if (rows.length > 0) {
        rows[Math.min(Math.max(0, target.index), rows.length - 1)]?.focus();
        return;
      }
    }
    const fallback = surface.querySelector<HTMLElement>("[data-id], a[href], button") ?? document.getElementById(titleId);
    fallback?.focus();
  }, [surfaceRef, titleId]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rows = [...surface.querySelectorAll<HTMLElement>("tbody tr[data-id]")];
    const nextMap = new Map<string, number>();
    rows.forEach((row, idx) => {
      if (row.dataset.id) nextMap.set(row.dataset.id, idx);
    });
    if (nextMap.size > 0) domIndexByIdRef.current = nextMap;
    if (selectedItem) {
      const fallbackIdx = visibleRows.findIndex(row => row.id === selectedItem.id);
      lastSelectedRef.current = {
        id: selectedItem.id,
        index: nextMap.get(selectedItem.id) ?? Math.max(0, fallbackIdx),
      };
    }
  });

  useEffect(() => {
    if (removed && sel) {
      restoreListRef.current = lastSelectedRef.current?.id === sel
        ? lastSelectedRef.current
        : { id: sel, index: 0 };
      select(undefined);
    } else if (!sel && restoreListRef.current) {
      const target = restoreListRef.current;
      let nextFrame = 0;
      const frame = requestAnimationFrame(() => {
        nextFrame = requestAnimationFrame(() => {
          restoreListRef.current = null;
          focusWorklistRow(target);
        });
      });
      return () => {
        cancelAnimationFrame(frame);
        cancelAnimationFrame(nextFrame);
      };
    }
  }, [focusWorklistRow, removed, sel, select]);

  useEffect(() => {
    if (!pendingDecision || sel) return;
    const index = domIndexByIdRef.current.get(pendingDecision.id) ?? Math.max(0, pendingDecision.fallbackIndex);
    const settled = dataUpdatedAt !== pendingDecision.dataUpdatedAt && !isFetching;
    const frame = requestAnimationFrame(() => {
      focusWorklistRow({ id: pendingDecision.id, index });
      if (settled) setPendingDecision(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [dataUpdatedAt, focusWorklistRow, isFetching, pendingDecision, sel]);

  const onItemDecided = (decidedId: string) => {
    const fallbackIndex = visibleRows.findIndex(row => row.id === decidedId);
    setPendingDecision({ id: decidedId, fallbackIndex, dataUpdatedAt });
    if (sel === decidedId) select(undefined);
  };

  return { onItemDecided };
}
