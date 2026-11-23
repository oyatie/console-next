// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./meter-legend.module.css";

export type MeterLegendItem = {
  key: string;
  swatch: "used" | "pending" | "rest";
  label: ReactNode;
  strong?: boolean;
};

/** Full-width summary band container around a segmented `Meter` and its `MeterLegend`. */
export function MeterBand({ children }: { children: ReactNode }) {
  return <div className={s.band}>{children}</div>;
}

/** Swatch legend paired beneath a segmented `Meter` (`■` / `□`). */
export function MeterLegend({ items }: { items: readonly MeterLegendItem[] }) {
  return (
    <ul className={s.legend}>
      {items.map((item) => (
        <li key={item.key} className={s.item} data-strong={item.strong || undefined}>
          <i className={s.swatch} data-swatch={item.swatch} aria-hidden="true" />
          <bdi>{item.label}</bdi>
        </li>
      ))}
    </ul>
  );
}
