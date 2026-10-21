import type { ReactNode } from "react";
import s from "./key-value.module.css";

/** One fact: its label, its value, and at most one verb on it (fix, correct, change). */
export type KeyValueItem = { key: string; label: ReactNode; value: ReactNode; action?: ReactNode };

/**
 * Facts as label and value pairs (kit .kvx): a `dl`, labels in a fixed column so values line up down a panel, the
 * one verb per fact in a fitted column at the end. An empty value is the caller's dash with its reason, never blank.
 */
export function KeyValue({ items, label }: { items: readonly KeyValueItem[]; label?: string }) {
  const acts = items.some((i) => i.action != null);
  return (
    <dl className={s.kv} data-acts={acts || undefined} aria-label={label}>
      {items.map((i) => (
        <div key={i.key} className={s.row}>
          <dt className={s.label}>{i.label}</dt>
          <dd className={s.value}>{i.value}</dd>
          {acts && <dd className={s.act}>{i.action}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Counts side by side in one bordered row (kit .statrow): the label over the number. Never a vanity KPI: each is a count the view acts on. */
export function StatRow({ items, label }: { items: readonly { key: string; label: ReactNode; value: ReactNode }[]; label?: string }) {
  return (
    <dl className={s.stats} aria-label={label}>
      {items.map((i) => (
        <div key={i.key} className={s.stat}>
          <dt className={s.statLabel}>{i.label}</dt>
          <dd className={s.statValue}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
