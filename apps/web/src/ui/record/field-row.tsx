import { useId, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { ChevronRight, Lock, Pencil } from "lucide-react";
import { t } from "@console/i18n";
import s from "./record.module.css";

/**
 * One fact of a record: its employee register item number (when the register lists it), label, value, a sub line (since
 * when, why it is locked, who confirms) and the one mark its server field class gives it (`mark`).
 * `edit` tints the row while its editor or sheet is open; `wide` spans both columns.
 */
export function FieldRow({ label, no, children, sub, mark, edit, wide, id }: { label: ReactNode; no?: string; children: ReactNode; sub?: ReactNode; mark?: ReactNode; edit?: boolean; wide?: boolean; id?: string }) {
  return (
    <div className={s.row} data-edit={edit || undefined} data-wide={wide || undefined} id={id}>
      <span className={s.label}>
        {no && <span className={s.lno} title={t("uiRecord.registerItem", { no })}>{no}</span>}
        {label}
      </span>
      <span className={s.value}>
        {children}
        {sub && <span className={s.sub}>{sub}</span>}
      </span>
      <span className={s.act}>{mark}</span>
    </div>
  );
}

/**
 * The field-class mark (spec §1.1): rc "edit" (change or correct), cor "correction only" (COR-L), corTwo "correction only, two people"
 * (COR-H), first "first entry" (COR-H, empty), inline "quick edit" (Class I), verb "by transfer ›" (a personnel action), lock (derived).
 * Every row's verb reads edit and is named "{field} edit" (docs/design/record-actions.md §3: one verb, found from the value's own row);
 * the class says, beside it, which way the edit is recorded. `text`/`name` replace both for a verb of its own (the employee-number change).
 */
export type MarkKind = "rc" | "cor" | "corTwo" | "first" | "inline" | "verb" | "lock";

export function FieldMark({ kind, field, text, onPress, name }: { kind: MarkKind; field: string; text?: string; onPress?: () => void; name?: string }) {
  const id = useId();
  const cls = t(`uiRecord.mark.${kind}`);
  if (kind === "lock")
    return (
      <span className={s.mark} data-k="lock">
        <Lock size={12} aria-hidden /> {text ?? cls}
      </span>
    );
  const verb = text ?? t("uiRecord.edit");
  // The class line names the path; a quick edit (rc, inline) needs none beyond the verb.
  const hint = text === undefined && kind !== "rc" && kind !== "inline" ? cls : null;
  return (
    <span className={s.markRow}>
      {hint && <span id={id} className={s.markHint}>{hint}</span>}
      <Button className={s.mark} data-k={kind === "corTwo" ? "cor" : kind} aria-label={name ?? t("uiRecord.markOf", { field, mark: verb })} aria-describedby={hint ? id : undefined} onPress={onPress}>
        <Pencil size={12} aria-hidden />
        {verb}
        {kind === "verb" && <ChevronRight size={12} aria-hidden />}
      </Button>
    </span>
  );
}
