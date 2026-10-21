import { useQueries } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, labeled } from "../../../lib/labels";
import { useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Table } from "../../../ui/table";
import { employeeQuery, type DuplicateCandidate } from "../api";
import type { DupPick } from "../domain/register";
import type { PlaceOption } from "../domain/register-place";
import s from "./register.module.css";

type Row = { k: "name" | "phone" | "birth" | "place" | "hire" | "number"; a: string; b: string; same: boolean | null };

/**
 * May be the same person (spec E3-register-dup, decision #25 §11.3): the search the server ran, the people it found
 * side by side with what is being typed (masked where the server matched a private value), and three answers with no
 * default — open the record on file, register a namesake (a recorded exception with its reason), or rehire one who left.
 */
export function RegisterDup({ mine, candidates, places, pick, onPick, tried }: {
  mine: { name: string; birth: string; place: string; hire: string; status: string; number: string | null };
  candidates: readonly DuplicateCandidate[];
  /** The places the sheet offers, to name the candidate's place the same way as the one being typed. */
  places: readonly PlaceOption[];
  pick: DupPick;
  onPick: (p: DupPick) => void;
  tried: boolean;
}) {
  const reads = useQueries({ queries: candidates.map((c) => employeeQuery(c.employee_id)) });
  const needsNote = useNeedsNote("exception", pick.code);
  const first = candidates[0]!;
  const them = reads[0]?.data?.employee;
  const rehire = candidates.some((c) => c.remedy === "rehire");
  const cell = (same: boolean | null) => (same === null ? <span className={s.steel}>—</span> : <Chip tone={same ? "ok" : "neutral"}>{t(same ? "register.dup.same" : "register.dup.differ")}</Chip>);
  const at = places.find((p) => p.unit.id === them?.org_unit_id);
  const theirPlace = at ? (at.unit.kind === "SITE" ? at.unit.name : `${at.site} › ${at.unit.name}`) : (them?.org_unit ?? "—");
  // The server matched on a private value it does not show: both sides read the same masked form.
  const masked = first.basis === "name_phone" ? "010-●●●●-●●●●" : `${mine.birth.slice(0, 8)}●●`;
  const status = them ? labeled(EMPLOYEE_STATUS, them.status ?? "").label : "";
  return (
    <section className={s.dup} role="status" aria-labelledby="register-dup-title">
      <div className={s.dupHead}>
        <AlertTriangle size={16} aria-hidden />
        <b id="register-dup-title">{t("register.dup.title", { n: candidates.length })}</b>
      </div>
      <div className={s.cmp}>
        <Table
          label={t("register.dup.choice")}
          rowId={(r) => r.k}
          rows={[
            { k: "name", a: mine.name, b: them?.name ?? "", same: them ? them.name.replace(/\s/g, "") === mine.name.replace(/\s/g, "") : null },
            { k: first.basis === "name_phone" ? "phone" : "birth", a: masked, b: masked, same: true },
            { k: "place", a: mine.place, b: theirPlace, same: them ? theirPlace === mine.place : null },
            { k: "hire", a: `${mine.hire} · ${mine.status}`, b: them ? `${them.hire_date ?? "—"} · ${status}` : "", same: them ? them.hire_date === mine.hire : null },
            { k: "number", a: mine.number ?? t("register.dup.mineNumber"), b: first.employee_number ?? "—", same: false },
          ] satisfies Row[]}
          columns={[
            { header: t("register.dup.col.field"), cell: (r) => <span className={s.steel}>{t(`register.dup.row.${r.k}`)}</span>, fit: true },
            { header: t("register.dup.col.mine"), cell: (r) => r.a },
            { header: t("register.dup.col.theirs", { name: them?.name ?? mine.name, number: first.employee_number ?? "—" }), cell: (r) => r.b },
            { header: <span className="sr-only">{t("register.dup.choice")}</span>, cell: (r) => cell(r.same), fit: true },
          ]}
        />
      </div>
      <ChoiceField
        label={t("register.dup.choice")}
        required
        options={[
          { value: "same", label: t("register.dup.sameLabel", { number: first.employee_number ?? "—" }), description: t("register.dup.sameDesc") },
          { value: "other", label: t("register.dup.otherLabel"), description: t("register.dup.otherDesc", { name: mine.name }) },
          ...(rehire ? [{ value: "rehire", label: t("register.dup.rehireLabel"), description: t("register.dup.rehireDesc") }] : []),
        ]}
        value={pick.verdict}
        onChange={(v) => onPick({ ...pick, verdict: v as DupPick["verdict"] })}
        error={tried && !pick.verdict ? t("register.dup.choice") : undefined}
      />
      {pick.verdict === "other" && (
        <>
          <ReasonCodeField domain="exception" look="chips" label={t("register.dup.reason")} value={pick.code} onChange={(code) => onPick({ ...pick, code })} error={tried && !pick.code ? t("reason.field.missing") : undefined} />
          {needsNote && (
            <Field label={t("people.duplicate.note")} required error={tried && !pick.note.trim() ? t("people.duplicate.noteMissing") : undefined}>
              {(p) => <TextArea {...p} rows={2} maxLength={1000} value={pick.note} onChange={(e) => onPick({ ...pick, note: e.target.value })} />}
            </Field>
          )}
        </>
      )}
    </section>
  );
}
