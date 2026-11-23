// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./key-value.module.css";

export type KeyValueItem = {
  id: string;
  label: string;
  value: ReactNode;
};

export function KeyValue({ items }: { items: readonly KeyValueItem[] }) {
  return (
    <dl className={s.kv}>
      {items.map((item) => (
        <div key={item.id} className={s.row}>
          <dt className={s.label}>{item.label}</dt>
          <dd className={s.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
