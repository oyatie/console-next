import { useState, type ReactNode } from "react";
import { t } from "@console/i18n";
import { RowInput, Saving } from "../../../ui/record/inline";
import { FieldMark, FieldRow } from "../../../ui/record/field-row";
import { Kbd } from "../../../ui/record/record-section";
import { focusOnce } from "../../../lib/react/focus-once";
import { InlineConflict, type FieldConflict } from "./inline-conflict";
import s from "./card.module.css";

/**
 * A quick edit field (Class I): F2 or the mark opens the editor in place; Enter saves, Esc puts the value back.
 * While the save is out the typed value shows with a quiet tick (no layout shift); `sending` is that value.
 */
export function InlineField({ label, children, raw, sub, sending, onSave, placeholder, wide, manage, conflict }: {
  label: string;
  children: ReactNode;
  raw: string;
  sub?: ReactNode;
  sending?: string;
  onSave: (next: string) => void;
  placeholder?: string;
  wide?: boolean;
  manage: boolean;
  /** This field's save met someone else's: the choice opens under it. */
  conflict?: FieldConflict;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const done = () => setDraft(null);
  const value = editing ? (
    <RowInput
      ref={focusOnce}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done();
        } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          const next = draft.trim();
          done();
          if (next !== raw) onSave(next);
        }
      }}
      onBlur={done}
    />
  ) : sending !== undefined ? (
    <Saving label={t("empCard.quick.tick")}>{sending || "—"}</Saving>
  ) : (
    children
  );
  return (
    <>
    <FieldRow
      label={label}
      edit={editing}
      wide={wide}
      sub={editing ? <span className={s.keys}><Kbd k="Enter" /> {t("empCard.inline.save")} <Kbd k="Esc" /> {t("empCard.inline.cancel")}</span> : sub}
      mark={manage && !editing && <FieldMark kind="inline" field={label} onPress={() => setDraft(raw)} />}
    >
      {value}
    </FieldRow>
    {/* Under the row, across the section: the choice this field's lost race needs (E12-conflict). */}
    {conflict && <InlineConflict field={label} now={raw} c={conflict} />}
    </>
  );
}
