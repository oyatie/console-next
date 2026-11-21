// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Button, Check, IconButton } from "../button/button";
import s from "./filter-rail.module.css";

export type FilterRailTreeNode = {
  id: string;
  label: ReactNode;
  checked: boolean;
  count?: number | string;
  expanded?: boolean;
  expandLabel?: string;
  onToggleExpand?: () => void;
  onChange: (checked: boolean) => void;
  children?: readonly FilterRailTreeNode[];
};

type FilterRailGroup = {
  id: string;
  title: ReactNode;
  items: readonly {
    id: string;
    label: ReactNode;
    checked: boolean;
    count?: number | string;
    onChange: (checked: boolean) => void;
  }[];
};

type FilterRailProps = {
  label: string;
  toggleLabel: string;
  activeCount?: number;
  phoneTools?: ReactNode;
  org?: {
    title: ReactNode;
    all?: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void };
    nodes: readonly FilterRailTreeNode[];
  };
  groups?: readonly FilterRailGroup[];
  reset?: { label: string; disabled?: boolean; onReset: () => void };
};

/** Left-hand facet and hierarchy filter rail that collapses into a compact phone disclosure under 768px. */
export function FilterRail({ label, toggleLabel, activeCount = 0, phoneTools, org, groups = [], reset }: FilterRailProps) {
  const [phoneOpen, setPhoneOpen] = useState(false);

  return (
    <nav className={s.rail} aria-label={label} data-open={phoneOpen || undefined}>
      <div className={s.phoneBar}>
        <div className={s.phoneBarStart}>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={phoneOpen}
            onClick={() => setPhoneOpen(open => !open)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            <bdi>{toggleLabel}</bdi>
            {activeCount > 0 ? <bdi className={s.badge}>{activeCount}</bdi> : null}
          </Button>
          {reset && activeCount > 0 ? (
            <Button variant="ghost" size="sm" disabled={reset.disabled} onClick={reset.onReset}>
              {reset.label}
            </Button>
          ) : null}
        </div>
        {phoneTools ? <div className={s.phoneTools}>{phoneTools}</div> : null}
      </div>

      <div className={s.body}>
        {org ? (
          <section className={s.section} aria-label={typeof org.title === "string" ? org.title : undefined}>
            <div className={s.heading}>{org.title}</div>
            {org.all ? (
              <div className={s.allRow}>
                <Check checked={org.all.checked} onChange={org.all.onChange}>
                  {org.all.label}
                </Check>
              </div>
            ) : null}
            <ul className={s.tree}>
              {org.nodes.map(node => (
                <li key={node.id} className={s.node}>
                  <div className={s.nodeRow}>
                    {node.children && node.children.length > 0 && node.onToggleExpand ? (
                      <IconButton
                        size="sm"
                        className={s.chevBtn}
                        label={node.expandLabel ?? String(node.label)}
                        aria-expanded={Boolean(node.expanded)}
                        onClick={node.onToggleExpand}
                      >
                        {node.expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                      </IconButton>
                    ) : (
                      <bdi className={s.chevSpacer} aria-hidden="true" />
                    )}
                    <div className={s.checkWrap}>
                      <Check checked={node.checked} onChange={node.onChange} count={node.count}>
                        {node.label}
                      </Check>
                    </div>
                  </div>
                  {node.expanded && node.children && node.children.length > 0 ? (
                    <ul className={s.children}>
                      {node.children.map(child => (
                        <li key={child.id} className={s.childRow}>
                          <Check checked={child.checked} onChange={child.onChange} count={child.count}>
                            {child.label}
                          </Check>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map(group => (
          <section key={group.id} className={s.section}>
            <div className={s.heading}>{group.title}</div>
            <ul className={s.groupList}>
              {group.items.map(item => (
                <li key={item.id} className={s.groupItem}>
                  <Check checked={item.checked} onChange={item.onChange} count={item.count}>
                    {item.label}
                  </Check>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {reset ? (
        <div className={s.foot}>
          <Button variant="secondary" size="sm" className={s.resetBtn} disabled={reset.disabled} onClick={reset.onReset}>
            {reset.label}
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
