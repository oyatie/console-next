// SPDX-License-Identifier: LicenseRef-Proprietary
type ColumnSearch = { sel?: unknown; sel2?: unknown };
type NavigateFn<S extends ColumnSearch> = (opts: { search: (prev: S) => S & { sel?: string; sel2?: string }; replace?: boolean; resetScroll?: boolean }) => unknown;

const clean = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** URL-backed 2- and 3-column selection (`?sel=` and `?sel2=`) for FlexibleColumns surfaces. */
export function columnSelection<S extends ColumnSearch>(search: S, navigate: NavigateFn<S>) {
  const sel = clean(search.sel);
  const sel2 = sel ? clean(search.sel2) : undefined;
  const go = (fn: (prev: S) => S & { sel?: string; sel2?: string }) => void navigate({ search: fn, replace: true, resetScroll: false });
  return {
    sel,
    sel2,
    select: (id: string | undefined) => go(prev => ({ ...prev, sel: id, sel2: id && id === clean(prev.sel) ? clean(prev.sel2) : undefined })),
    selectRelated: (id: string | undefined) => go(prev => ({ ...prev, sel: clean(prev.sel), sel2: clean(prev.sel) ? id : undefined })),
    closeRightmost: () => go(prev => (clean(prev.sel) && clean(prev.sel2) ? { ...prev, sel: clean(prev.sel), sel2: undefined } : { ...prev, sel: undefined, sel2: undefined })),
  };
}
