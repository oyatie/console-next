import type { ReactNode } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { ChevronRight } from "lucide-react";
import s from "./tree.module.css";

/**
 * A single-select tree (React Aria treegrid): ↑↓ move, → expands, ← collapses or moves to the parent, Enter or a click
 * selects, Esc clears the selection unless `required`. Expansion is the caller's state. `textValue` is each row's
 * accessible name (put everything the row shows in it: name, kind, count, marker), and type-ahead matches it.
 * `disabled` rows stay visible but cannot be chosen (say why in the row).
 */
export function TreeView<T extends { id: string }>({
  id,
  label,
  roots,
  childrenOf,
  textValue,
  row,
  selected,
  onSelect,
  required,
  expanded,
  onExpandedChange,
  disabled,
  keyboardNavigationBehavior,
  loading,
  empty,
  error,
  density,
}: {
  id?: string;
  label: string;
  roots: T[];
  childrenOf: (item: T) => T[];
  textValue: (item: T) => string;
  /** The row's content after the chevron. */
  row: (item: T) => ReactNode;
  selected?: string;
  onSelect: (id: string | undefined) => void;
  /** For a caller that drops an empty selection: a chosen row cannot be cleared, so Esc is left to what holds the tree (a dialog or a sheet closes). */
  required?: boolean;
  expanded: Set<string>;
  onExpandedChange: (keys: Set<string>) => void;
  disabled?: ReadonlySet<string>;
  loading?: boolean;
  empty?: ReactNode;
  error?: ReactNode;
  density?: "dense" | "default";
  /** Let Tab reach interactive content within a row. */
  keyboardNavigationBehavior?: "arrow" | "tab";
}) {
  // React Aria moves ArrowLeft to the parent only from a row it does not hold as expanded; a row it holds as expanded
  // does nothing there when it has no children. So a row with children is passed on as the caller lists it, and a row
  // with none is passed on only under a disabled parent, which cannot take the focus (the move would land on the tree).
  // A folded row with children under a disabled parent cannot be passed on that way, so its ArrowLeft is stopped instead.
  const open = new Set<string>();
  const stays = new Set<string>();
  const node = (item: T, stay = false): ReactNode => {
    const kids = childrenOf(item);
    if (kids.length ? expanded.has(item.id) : stay) open.add(item.id);
    else if (stay) stays.add(item.id);
    return (
      <TreeItem key={item.id} id={item.id} textValue={textValue(item)} data-id={item.id}>
        <TreeItemContent>
          {({ hasChildItems }) => (
            <div className="tree__row">
              {hasChildItems ? (
                <Button slot="chevron" className="tree__chevron"><ChevronRight size={14} aria-hidden /></Button>
              ) : (
                <span className="tree__chevron" />
              )}
              {row(item)}
            </div>
          )}
        </TreeItemContent>
        {kids.map((kid) => node(kid, disabled?.has(item.id)))}
      </TreeItem>
    );
  };
  const rows = (loading || error ? [] : roots).map((root) => node(root));
  return (
    <Tree
      id={id}
      aria-label={label}
      className={`tree ${s.tree}`}
      render={(props) => (
        <div
          {...props}
          onKeyDownCapture={(e) => {
            // The tree hears the key before the row does, and the row's own handler is what moves the focus. The handler
            // passed on below is the tree's type-ahead.
            const at = e.target as HTMLElement;
            if (e.key === "ArrowLeft" && at.getAttribute("role") === "row" && stays.has(at.dataset.id ?? "")) e.stopPropagation();
            props.onKeyDownCapture?.(e);
          }}
        />
      )}
      data-density={density}
      aria-busy={loading || undefined}
      data-state={error ? "error" : undefined}
      renderEmptyState={() => error ? <div className={s.error} role="alert">{error}</div> : loading ? <div className={s.loading} role="status" aria-busy="true"><div className={s.skeleton} /></div> : empty != null && <div className={s.empty}>{empty}</div>}
      selectionMode="single"
      disallowEmptySelection={required}
      escapeKeyBehavior={required ? "none" : undefined}
      keyboardNavigationBehavior={keyboardNavigationBehavior}
      selectedKeys={selected ? [selected] : []}
      onSelectionChange={(keys) => onSelect(keys instanceof Set ? ([...keys][0] as string | undefined) : undefined)}
      expandedKeys={open}
      disabledKeys={disabled}
      onExpandedChange={(keys) => {
        // Only the row that was folded or unfolded changes in the caller's set.
        const next = new Set(expanded);
        for (const key of keys) if (!open.has(String(key))) next.add(String(key));
        for (const key of open) if (!keys.has(key)) next.delete(key);
        onExpandedChange(next);
      }}
    >
      {rows}
    </Tree>
  );
}
