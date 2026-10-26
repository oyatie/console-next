import type { ReactNode } from "react";
import s from "./key-value.module.css";

/** One fact: its label, its value, and at most one verb on it (fix, correct, change). */
export type KeyValueItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  action?: ReactNode;
  readOnly?: boolean;
};

/**
 * Facts as label and value pairs (kit .kvx): a `dl`, labels in a fixed column so values line up down a panel, the
 * one verb per fact in a fitted column at the end. An empty value is the caller's dash with its reason, never blank.
 */
export function KeyValue({
  items,
  label,
  loading,
  empty,
  error,
  readOnly,
  density,
}: {
  items: readonly KeyValueItem[];
  label?: string;
  loading?: boolean;
  empty?: ReactNode;
  error?: ReactNode;
  readOnly?: boolean;
  density?: "dense" | "default";
}) {
  const acts = items.some((i) => i.action != null);
  return (
    <dl className={s.kv} data-acts={acts || undefined} data-density={density} aria-label={label} data-readonly={readOnly || undefined} aria-busy={loading || undefined}>
      {loading || error || (items.length === 0 && empty != null) ? (
        <div><dt className="sr-only">{label}</dt><dd className={error ? s.error : loading ? s.loading : s.empty} role={error ? "alert" : loading ? "status" : undefined} data-state={error ? "error" : undefined}>
          {error || (loading ? <div className={s.skeleton} /> : empty)}
        </dd></div>
      ) : items.map((i) => (
        <div
          key={i.key}
          className={s.row}
          data-readonly={i.readOnly || readOnly || undefined}
        >
          <dt className={s.label}>{i.label}</dt>
          <dd className={s.value}>{i.value}</dd>
          {acts && <dd className={s.act}>{!readOnly && !i.readOnly && i.action}</dd>}
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
