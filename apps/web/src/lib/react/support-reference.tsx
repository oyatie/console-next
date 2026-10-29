// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../ui/button/button";
import { announce } from "./announce";
import css from "../../ui/receipt/receipt.module.css";

/** A request id has no embedded timestamp. Only display the server's recorded time. */
export function SupportReference({ reference, at, compact = true }: { reference?: string | null; at?: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!reference) return null;
  const date = at ? new Date(at) : undefined;
  const stamp = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  const short = expanded || !compact ? reference : reference.slice(0, 8);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`ref ${reference}`);
      announce(t("common.supportReference.copied"));
    } catch {
      setExpanded(true);
      announce(t("common.supportReference.copyFailed"));
    }
  };
  return (
    <div className={css.meta} data-support-reference={reference}>
      <data value={reference}>{t("common.supportReference")} <code title={reference}>{short}</code></data>
      <Button variant="ghost" size="sm" onClick={() => void copy()}>{t("common.supportReference.copy")}</Button>
      {stamp && <time dateTime={stamp}>{fmtDateTime(stamp)}</time>}
    </div>
  );
}
