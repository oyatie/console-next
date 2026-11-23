// SPDX-License-Identifier: LicenseRef-Proprietary
import s from "./badge.module.css";

export type BadgeTone = "ok" | "warn" | "danger" | "info" | "outline" | "neutral" | "unknown";

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: string;
}) {
  return (
    <span className={`${s.badge} ${s[tone]}`} title={title}>
      {children}
    </span>
  );
}
