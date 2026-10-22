// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../ui/button/button";
import { announce } from "./announce";
import css from "../../ui/receipt/receipt.module.css";

/** A request id has no embedded timestamp. Only display the server's recorded time. */
export function SupportReference({ reference, at }: { reference?: string | null; at?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!reference) return null;
  const date = at ? new Date(at) : undefined;
  const stamp = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  const short = `ref ${expanded ? reference : reference.slice(0, 8)}`;
  const displayAt = stamp ? `${stamp.slice(0, 19).replace("T", " ")} UTC` : undefined;
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
      <data value={reference}>{t("common.supportReference")} <code title={`ref ${reference}`}>{short}</code></data>
      <Button variant="ghost" size="sm" onClick={() => void copy()}>{t("common.supportReference.copy")}</Button>
      {stamp && <time dateTime={stamp}>{displayAt}</time>}
    </div>
  );
}
