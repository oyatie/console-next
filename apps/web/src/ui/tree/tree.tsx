import type { ReactNode } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { ChevronRight } from "lucide-react";

/**
 * A single-select tree (React Aria treegrid): ↑↓ move, ←→ collapse and expand, Enter or a click selects,
 * Esc clears the selection. Expansion is the caller's state. `textValue` is each row's accessible name
 * (put everything the row shows in it: name, kind, count, marker), and type-ahead matches it. `disabled` rows stay
 * visible but cannot be chosen (say why in the row).
 */
export function TreeView<T extends { id: string }>({ id, label, roots, childrenOf, textValue, row, selected, onSelect, expanded, onExpandedChange, disabled }: {
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
      className="tree"
      selectionMode="single"
      selectedKeys={selected ? [selected] : []}
      onSelectionChange={(keys) => onSelect(keys instanceof Set ? ([...keys][0] as string | undefined) : undefined)}
      expandedKeys={expanded}
      disabledKeys={disabled}
      onExpandedChange={(keys) => onExpandedChange(new Set([...keys].map(String)))}
    >
      {roots.map(node)}
    </Tree>
  );
}
