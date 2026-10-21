import { useRef, useState, type KeyboardEvent } from "react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Kbd } from "../../../ui/record/record-section";
import { missing, type RowDraft, type RowField } from "../domain/record-spec";
import { tx } from "../present";
import { EditRow } from "../../../ui/record/inline";
import { PathNote, type ChangePath } from "../../../ui/record-actions/record-actions";
import { FIX_REASONS } from "../domain/fix";
import s from "./card.module.css";

/** The read that draws a section's rows: the register facts (careers) or the personnel-card entries. */
type SectionRead = "/api/v1/employees/{id}/register-facts" | "/api/v1/employees/{id}/records";

/**
 * A row typed in place (E2-records): one control per column, Enter saves and opens the next empty row, Esc
 * closes (a typed row is kept until saved or cleared). A required column left empty is focused and said, never red
 * before the first try. With `initial` it edits one existing row (edit): it opens on that row's values, asks why (the
 * correction keeps the earlier version in the row's history), says the path, and closes once saved. `why` reaches `onSave`
 * as its code (domain/fix FIX_REASONS).
 */
export function RowEditor({ section, spec, reads, onSave, onClose, initial, path }: { section: string; spec: readonly RowField[]; reads: SectionRead; onSave: (d: RowDraft, key: string, why?: string) => Promise<unknown>; onClose: () => void; initial?: RowDraft; path?: ChangePath }) {
  const editing = initial !== undefined;
  const [d, setD] = useState<RowDraft>(initial ?? {});
  const [why, setWhy] = useState("");
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const run = useCommand({
    run: (x: RowDraft, key: string) => onSave(x, key, why || undefined),
    // Closes (or clears for the next row) once the rows' own read is in: the saved row and the editor land in one frame,
    // never the old value shown after a save nor the editor jumping under the next keystroke; the rest re-reads after.
    invalidates: [reads, "/api/v1/employees"],
    awaitFirstRead: true,
    onSuccess: () => {
      if (editing) return onClose();
      setD({});
      setTried(false);
      setSaved((n) => n + 1);
      requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("input, select")?.focus());
    },
  });
  const lacks = [...missing(spec, d), ...(editing && !why ? ["why"] : [])];
  const save = () => {
    setTried(true);
    if (lacks.length) return void box.current?.querySelector<HTMLElement>(`[data-k="${lacks[0]}"]`)?.focus();
    run.mutate(d);
  };
  // Enter saves the row and opens the next; Esc closes (IME composition keeps its own Enter).
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  };
  const name = (k: string) => tx(`empRec.${section}.${k}`);
  return (
    <EditRow
      ref={box}
      role="group"
      aria-label={t(editing ? "empRec.editRow" : "empRec.newRow", { section: tx(`empRec.${section}`) })}
    >
      <div className={s.rowInputs}>
        {spec.map((f) =>
          f.kind === "choice" ? (
            <SelectInput key={f.key} data-k={f.key} onKeyDown={keys} aria-label={name(f.key)} aria-invalid={tried && lacks.includes(f.key) ? true : undefined} value={d[f.key] ?? ""} onChange={(e) => setD({ ...d, [f.key]: e.target.value })}>
              <option value="" disabled>{name(f.key)}</option>
              {f.options!.map((o) => <option key={o} value={o}>{tx(`empRec.${section}.${f.key}.${o}`)}</option>)}
            </SelectInput>
          ) : (
            <TextInput
              key={f.key}
              data-k={f.key}
              onKeyDown={keys}
              type={f.kind === "date" ? "date" : f.kind === "month" ? "month" : "text"}
              aria-label={name(f.key)}
              placeholder={name(f.key)}
              aria-invalid={tried && lacks.includes(f.key) ? true : undefined}
              value={d[f.key] ?? ""}
              onChange={(e) => setD({ ...d, [f.key]: e.target.value })}
            />
          ),
        )}
        {editing && (
          <SelectInput data-k="why" onKeyDown={keys} aria-label={t("empFix.why")} aria-invalid={tried && !why ? true : undefined} value={why} onChange={(e) => setWhy(e.target.value)}>
            <option value="" disabled>{t("empFix.why")}</option>
            {FIX_REASONS.map((r) => <option key={r} value={r}>{t(`empFix.reason.${r}`)}</option>)}
          </SelectInput>
        )}
      </div>
      <div className={s.rowFoot}>
        <span className={s.keys}><Kbd k="Enter" /> {t("empRec.enter")} <Kbd k="Esc" /> {t("empRec.esc")}</span>
        {tried && lacks.length > 0 && <span className={s.warn} role="status">{t("empRec.lacks", { fields: lacks.map((k) => (k === "why" ? t("empFix.why") : name(k))).join(" · ") })}</span>}
        {saved > 0 && !tried && <span className={s.s12} role="status">{t("empRec.saved", { count: saved })}</span>}
        {path && <PathNote path={path} />}
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>{t("empRec.close")}</Button>
        <Button variant="primary" onClick={save} disabled={run.isPending}>{t(editing ? "empRec.saveEdit" : "empRec.save")}</Button>
      </div>
      {run.isError && <CommandError error={run.error} />}
    </EditRow>
  );
}
