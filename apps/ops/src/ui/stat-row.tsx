// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./stat-row.module.css";

export type StatItem = {
  id: string;
  label: string;
  value: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "primary";
};

export function StatRow({ items }: { items: readonly StatItem[] }) {
  return (
    <dl className={s.stats}>
      {items.map((item) => (
        <div
          key={item.id}
          className={s.stat}
          data-tone={item.tone && item.tone !== "default" ? item.tone : undefined}
        >
          <dt className={s.label}>{item.label}</dt>
          <dd className={s.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
