// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./record.module.css";

/** A masked value as shown by default (never the value itself). */
export function Masked({ children }: { children: ReactNode }) {
  return <span className={s.masked}>{children}</span>;
}
