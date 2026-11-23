// SPDX-License-Identifier: LicenseRef-Proprietary
import { Info } from "lucide-react";
import s from "./disabled-reason.module.css";

export function DisabledReason({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null;
  return (
    <span className={s.reason}>
      <Info size={12} aria-hidden="true" />
      <span>{reason}</span>
    </span>
  );
}
