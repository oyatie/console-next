import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";
import { Field, TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import type { Kind } from "../domain/bulk";
import { DEMOTION_REASON } from "../domain/titles";
import s from "./bulk-page.module.css";

const ARROW = "→";
export type HeadRow = { id: string; name: string; before?: number; after?: number; note?: ReactNode };

/**
 * The right pane (spec E6-move): when (chips, no default), why (reason chips) and a memo every record keeps; then
 * the headcount of each unit the batch touches before and after, and the workplace line.
 */
export function BulkWhen({ kind, demotion = false, today, date, onDate, code, onCode, memo, onMemo, shown, tried, heads, echo }: {
  kind: Kind | null;
  demotion?: boolean;
  today: string;
  date: string;
  onDate: (d: string) => void;
  code: string | null;
  onCode: (c: string) => void;
  memo: string;
  onMemo: (m: string) => void;
  shown: { date?: string; code?: string; memo?: string };
  tried: boolean;
  heads: readonly HeadRow[];
  echo?: string;
}) {
  return (
    <div className={s.side}>
      <Card titleId="bulk-when" title={t("bulk.page.when")}>
        <DateField label={t("bulk.page.date")} required today={today} presets={datePresets(today, ["today", "nextMonday", "nextMonthFirst"])} value={date} onChange={onDate} echo={echo} error={shown.date} showErrors={tried} />
        {kind && (
          <ReasonCodeField key={kind} look="chips" domain={kind === "TRANSFER" ? "lifecycle_transfer" : "lifecycle_promote"} label={t("bulk.page.reason")} value={code} onChange={onCode} only={demotion ? [DEMOTION_REASON] : undefined} hint={demotion ? t("lifecycle.promote.demotion") : undefined} error={shown.code} />
        )}
        <Field label={t("bulk.page.memo")} required error={shown.memo}>
          {(p) => <TextInput {...p} value={memo} maxLength={1000} onChange={(e) => onMemo(e.target.value)} />}
        </Field>
      </Card>
      {heads.length > 0 && (
        <Card titleId="bulk-after" title={t("bulk.page.after")}>
          <div className={s.after}>
          <Table
            label={t("bulk.page.after")}
            rows={[...heads]}
            rowId={(h) => h.id}
            columns={[
              { header: <span className="sr-only">{t("bulk.page.col.now")}</span>, cell: (h) => h.name, fit: true },
              { header: <span className="sr-only">{t("bulk.page.after")}</span>, cell: (h) => (h.before === undefined ? null : <span className="num">{[h.before, ARROW, ""].join(" ")}<b>{h.after}</b></span>) },
              { header: <span className="sr-only">{t("bulk.page.col.check")}</span>, cell: (h) => h.note ?? null },
            ]}
          />
          </div>
        </Card>
      )}
    </div>
  );
}
