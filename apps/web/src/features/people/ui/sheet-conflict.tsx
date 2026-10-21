import { useState } from "react";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { RecordRows } from "../../../ui/record/rows";
import { errorCode } from "../api/record";
import { Banner } from "../../../ui/banner/banner";
import s from "./card.module.css";

/**
 * A 409 inside a sheet (E12-conflict-sheet): someone saved this person after the sheet opened. Nothing was written and
 * the typed value is kept; the three values sit side by side (as opened · now · mine) and the way on is chosen, with
 * no default: send mine against the new state, or drop it. The code and the person's request id stay in the details line.
 */
export function SheetConflict({ field, opened, now, mine, error, onChoose }: { field: string; opened: string; now: string; mine: string; error: unknown; onChoose: (keep: boolean | null) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const rows = [
    { id: "opened", label: t("empFix.conflict.opened"), value: opened },
    { id: "now", label: t("empFix.conflict.now"), value: now },
    { id: "mine", label: t("empFix.conflict.mine"), value: mine },
  ];
  return (
    <div className={s.scrollBox} role="alert">
      <Banner tone="danger" title={t("empFix.conflict.title", { field })}>
      <p className={s.note}>{t("empFix.conflict.kept")}</p>
      <RecordRows label={t("empFix.conflict.table")} rows={rows} rowId={(r) => r.id} columns={[{ header: "", cell: (r) => r.label }, { header: t("empFix.conflict.value"), cell: (r) => (r.id === "opened" ? r.value : <b>{r.value}</b>) }]} />
      <ChoiceField
        label={t("empFix.conflict.how")}
        required
        value={pick}
        onChange={(v) => {
          setPick(v);
          onChoose(v === "keep");
        }}
        options={[{ value: "keep", label: t("empFix.conflict.keep"), description: t("empFix.conflict.keep.d") }, { value: "drop", label: t("empFix.conflict.drop"), description: t("empFix.conflict.drop.d") }]}
      />
      <details className={s.note}><summary>{t("empFix.conflict.details")}</summary>{errorCode(error) ?? "conflict"}</details>
      </Banner>
    </div>
  );
}
