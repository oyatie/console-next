// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import s from "./list-record-parts.module.css";

/** Compact bottom summary footer beneath a Console `ListRecord` table. */
export function ListSummaryFooter({ label, start, end }: { label?: string; start: ReactNode; end?: ReactNode }) {
  return (
    <footer className={s.footBar} role={label ? "note" : undefined} aria-label={label}>
      <div className={s.footStart}>{start}</div>
      {end != null ? <div className={s.footEnd}>{end}</div> : null}
    </footer>
  );
}

/** Subtle highlighted row band inside a record section (e.g., scheduled appointment notice). */
export function RecordHighlightBand({ tag, children }: { tag: ReactNode; children: ReactNode }) {
  return (
    <div className={s.highlightBand}>
      <bdi className={s.highlightTag}>{tag}</bdi>
      <bdi className={s.highlightBody}>{children}</bdi>
    </div>
  );
}

/** Compact section header inside a Console side record pane (title + optional trailing action/link). */
export function RecordPaneSection({
  title,
  trailing,
  padded = true,
  foot,
  children,
}: {
  title: ReactNode;
  trailing?: ReactNode;
  padded?: boolean;
  foot?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={s.paneSection} aria-labelledby={id}>
      <header className={s.paneSectionHead}>
        <h3 id={id} className={s.paneSectionTitle}>{title}</h3>
        {trailing != null ? <div className={s.paneSectionTrail}>{trailing}</div> : null}
      </header>
      <div className={padded ? s.paneSectionBody : undefined}>{children}</div>
      {foot}
    </section>
  );
}

/**
 * Record sections kept together in one box (one read fills them): it carries the rule its last section would end on.
 * While `held` (its read is out), it keeps the tallest height it has drawn as its minimum, so a shorter answer leaves the
 * sections below it where they were. A new `shape` (what the sections are drawn for, such as a status) lets that go.
 */
export function RecordPaneGroup({ className, held, shape, children }: { className?: string; held?: boolean; shape?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const drawnFor = useRef(shape);
  useLayoutEffect(() => {
    const group = box.current;
    if (!group) return;
    if (drawnFor.current !== shape) {
      drawnFor.current = shape;
      group.style.minBlockSize = "";
    }
    if (!held) return;
    const height = group.getBoundingClientRect().height;
    if (height > (parseFloat(group.style.minBlockSize) || 0)) group.style.minBlockSize = `${height}px`;
  });
  return <div ref={box} className={className ? `${s.paneGroup} ${className}` : s.paneGroup}>{children}</div>;
}

/** A record pane read's loading or failure, inset like its sections; it takes no room while the read shows nothing. */
export function RecordPaneState({ children }: { children: ReactNode }) {
  return <div className={s.paneState}>{children}</div>;
}

/** Rule-separated subject identity header at the top of a Console side record pane. */
export function RecordIdentityBar({
  name,
  nameLevel,
  number,
  badges,
  roleLine,
  path,
  actions,
}: {
  name: ReactNode;
  /** A heading level for the name, when the pane's own title (level 2) is not the name itself. */
  nameLevel?: 3;
  number?: ReactNode;
  badges?: ReactNode;
  roleLine?: ReactNode;
  path?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.identityBar}>
      <div className={s.identityTop}>
        {nameLevel ? <h3 className={s.identityName}>{name}</h3> : <strong className={s.identityName}>{name}</strong>}
        {number != null ? <bdi className={s.identityNumber}>{number}</bdi> : null}
        {badges}
        {roleLine != null ? <bdi className={s.identitySub}>{roleLine}</bdi> : null}
      </div>
      {path != null ? <div className={s.identityPath}>{path}</div> : null}
      {actions != null ? <div className={s.identityActions}>{actions}</div> : null}
    </div>
  );
}

/** Compact summary link rows (label + metric summary). */
export function RecordSummaryList({
  items,
}: {
  items: readonly { key: string; label: ReactNode; value: ReactNode }[];
}) {
  return (
    <dl className={s.summaryList}>
      {items.map(item => (
        <div key={item.key} className={s.summaryRow}>
          <dt className={s.summaryLabel}>{item.label}</dt>
          <dd className={s.summaryValue}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Container-responsive 2-column split bands inside a `ListRecord` main pane (stacks cleanly below 960px or when side record pane opens). */
export function ListSplitBands({ children }: { children: ReactNode }) {
  return (
    <div className={s.splitBandsWrap}>
      <div className={s.splitBands}>{children}</div>
    </div>
  );
}
