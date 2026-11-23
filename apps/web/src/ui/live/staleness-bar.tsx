// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
import { i18n, t } from "@console/i18n";
import { fmtTimeKst } from "@console/i18n/format";
import s from "./degraded.module.css";

export function StalenessBar({ lastEventAt }: { lastEventAt: number | null }) {
  useSyncExternalStore(i18n.subscribe, () => i18n.locale, () => i18n.locale);
  const message =
    lastEventAt !== null
      ? t("live.status.staleAt", { time: fmtTimeKst(lastEventAt) })
      : t("live.status.stale");

  return (
    <div role="status" className={s.stalenessBar}>
      <TriangleAlert className={s.stalenessIcon} size={14} aria-hidden="true" />
      <span className={s.stalenessText}>{message}</span>
    </div>
  );
}
