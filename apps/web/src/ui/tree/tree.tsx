import type { ReactNode } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { ChevronRight } from "lucide-react";
import s from "./tree.module.css";

/**
 * A single-select tree (React Aria treegrid): ↑↓ move, ←→ collapse and expand, Enter or a click selects,
 * Esc clears the selection. Expansion is the caller's state. `textValue` is each row's accessible name
 * (put everything the row shows in it: name, kind, count, marker), and type-ahead matches it. `disabled` rows stay
 * visible but cannot be chosen (say why in the row).
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
  const node = (item: T): ReactNode => (
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
      {childrenOf(item).map(node)}
    </TreeItem>
  );
  return (
    <Tree
      id={id}
      aria-label={label}
      className={`tree ${s.tree}`}
      data-density={density}
      aria-busy={loading || undefined}
      data-state={error ? "error" : undefined}
      renderEmptyState={() => error ? <div className={s.error} role="alert">{error}</div> : loading ? <div className={s.loading} role="status" aria-busy="true"><div className={s.skeleton} /></div> : empty != null && <div className={s.empty}>{empty}</div>}
      selectionMode="single"
      keyboardNavigationBehavior={keyboardNavigationBehavior}
      selectedKeys={selected ? [selected] : []}
      onSelectionChange={(keys) => onSelect(keys instanceof Set ? ([...keys][0] as string | undefined) : undefined)}
      expandedKeys={expanded}
      disabledKeys={disabled}
      onExpandedChange={(keys) => onExpandedChange(new Set([...keys].map(String)))}
    >
      {(loading || error ? [] : roots).map(node)}
    </Tree>
  );
}
