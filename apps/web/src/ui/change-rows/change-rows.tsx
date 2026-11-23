// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { t } from "@console/i18n";
import s from "./change-rows.module.css";

/**
 * Compact before-to-after diff rows for record panes and approval documents: aligns subject, prior value, arrow, and
 * proposed value on a dense hairline grid.
 */
export function ChangeRows({
  items,
  label,
}: {
  /** Diff entries showing each subject's `before` and `after` states. */
  items: readonly {
    id: string;
    subject: ReactNode;
    before: ReactNode;
    after: ReactNode;
  }[];
  /** Accessible name of the change list; defaults to `uiWorklist.changes`. */
  label?: string;
}) {
  return (
    <dl className={s.list} aria-label={label ?? t("uiWorklist.changes")} data-change-rows="">
      {items.map(item => (
        <div key={item.id} className={s.row}>
          <dt className={s.subject}>{item.subject}</dt>
          <dd className={s.before}>{item.before}</dd>
          <dd className={s.arrow} aria-hidden="true">
            <ArrowRight size={12} />
          </dd>
          <dd className={s.after}>{item.after}</dd>
        </div>
      ))}
    </dl>
  );
}
