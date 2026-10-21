import { identityProblems } from "../../../reference/entity/domain/names";
import { entityNameText } from "../../../reference/entity/present";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, label } from "../../../lib/labels";
import { entitiesRef } from "../../../reference/entity/api";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { excludeReasonsQuery, EXCLUDE_REASONS, NOTE_MAX, NUMBER_MAX, OTHER } from "../api";
import { EMPLOYMENT_TYPES, type ImportRow, type ReviewItem } from "../domain/contract";
import { answerOf, NEW_PERSON, NONE, withChoice, withNumber, withRowAnswer, type Picks } from "../domain/steps";
import { candidateBasisLabel, employmentTypeLabel, reasonLabel, refusalLabel } from "../present";
import s from "./import.module.css";

type Common = { picks: Picks; busy: boolean; onResolve: (c: Picks) => void };

/**
 * Who a row is (namesakes and RRN matches): each person on file it may be, told apart by employee number, legal entity and department and a masked
 * birth date (names are never suffixed), or a new person, or the row left out this time. One click each.
 */
export function Identity({ item, row, picks, busy, onResolve }: Common & { item: ReviewItem; row: ImportRow }) {
  const res = item.resolution!;
  const [excluding, setExcluding] = useState(res.key in picks.exclusions);
  const held = answerOf(picks, "identity", res.key);
  const pick = (choice: string) => onResolve(withChoice(picks, "identity", res.key, choice));
  if (excluding) return <ExcludeRow item={item} row={row} picks={picks} busy={busy} onResolve={onResolve} onBack={() => setExcluding(false)} />;
  return (
    <ul className={s.people}>
      {res.choices.filter((c) => c !== NEW_PERSON).map((id) => {
        const c = row.candidates?.find((x) => x.employee_id === id);
        return (
          <li key={id} className={s.person}>
            <div>
              <strong>{row.name}</strong> <span className="code">{c?.employee_number ?? t("import.number.none")}</span> · {c ? label(EMPLOYEE_STATUS, c.status as never) : ""}
              <div className="muted">{[c?.company, c?.org_unit].filter(Boolean).join(" · ") || t("importReview.identity.noPlace")}</div>
              <div className="muted">{c?.birth_date_masked ? t("importReview.identity.birth", { masked: c.birth_date_masked }) : t("importReview.identity.noBirth")}</div>
              {c && <div className="muted">{t(`import.decide.basis.${c.basis}`)}</div>}
            </div>
            <Button variant={held === id ? "primary" : "secondary"} aria-pressed={held === id} disabled={busy} onClick={() => pick(id)}>
              {t("importReview.identity.same", { number: c?.employee_number ?? t("import.number.none") })}
            </Button>
          </li>
        );
      })}
      {res.choices.includes(NEW_PERSON) && (
        <li className={s.person}>
          <div>{t("importReview.identity.newWhy", { name: row.name })}</div>
          <Button variant={held === NEW_PERSON ? "primary" : "secondary"} aria-pressed={held === NEW_PERSON} disabled={busy} onClick={() => pick(NEW_PERSON)}>{t("import.decide.new")}</Button>
        </li>
      )}
      <li className={s.person}>
        <div className="muted">{t("importReview.identity.excludeWhy")}</div>
        <Button onClick={() => setExcluding(true)}>{t("import.decide.exclude")}</Button>
      </li>
    </ul>
  );
}

/** A refused row: what to fix in the file, or leave it out this time with a reason (BW-07). */
export function ExcludeRow({ item, row, picks, busy, onResolve, onBack }: Common & { item: ReviewItem; row: ImportRow; onBack?: () => void }) {
  const reasons = useQuery(excludeReasonsQuery);
  const held = picks.exclusions[row.source_key];
  const [reason, setReason] = useState<Reason>({ code: held?.reason_code || null, memo: held?.note ?? "" });
  const [tried, setTried] = useState(false);
  const codes = (reasons.data?.items ?? []).filter((x) => x.active).map((x) => ({ code: x.code, label: reasonLabel(EXCLUDE_REASONS, x) }));
  const problem = reasonProblem(reason, OTHER);
  const next = () => withRowAnswer(picks, row.source_key, { exclude: { reason_code: reason.code!, ...(reason.memo ? { note: reason.memo } : {}) } });
  const go = t("importReview.exclude.run");
  return (
    <div className="form">
      {item.reason !== "unresolved_identity" && <p>{t("importReview.exclude.fix", { why: refusalLabel(item.reason) })}</p>}
      <ReasonField label={t("import.decide.reason", { sheet: row.sheet, row: row.row })} codes={codes} other={OTHER} value={reason} onChange={setReason} memoMax={NOTE_MAX} showErrors={tried} />
      <div className="form__actions">
        {onBack && <Button onClick={onBack}>{t("importReview.exclude.back")}</Button>}
        {held && <Button disabled={busy} onClick={() => onResolve(withRowAnswer(picks, row.source_key, null))}>{t("importReview.exclude.undo")}</Button>}
        {problem ? (
          <DisabledReason control={(p) => <Button {...p} variant="primary" onClick={() => setTried(true)}>{go}</Button>} reason={t("importReview.exclude.needReason")} />
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => onResolve(next())}>{go}</Button>
        )}
      </div>
    </div>
  );
}

/**
 * A unit, workplace or employment type text in the file that names nothing: pick what it means, or "none of these" (the people
 * come in unplaced, at a customer site, or with the field empty). One answer covers every row with that text.
 */
export function ValuePick({ kind, text, picks, busy, onResolve, item }: Common & { kind: "company" | "unit" | "workplace" | "type"; text: string; item?: ReviewItem }) {
  const units = useQuery({ ...unitsQuery, enabled: kind === "unit" });
  const entities = useQuery({ ...entitiesRef, enabled: kind === "workplace" || kind === "company" });
  const decision = kind === "company" ? "company_map" : kind === "unit" ? "unit_map" : kind === "workplace" ? "workplace_map" : "employment_type_map";
  const all = units.data?.items ?? [];
  const targets =
    kind === "unit"
      ? all.filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY").map((u) => ({ value: u.id, label: unitPath(all, u) }))
      : kind === "workplace" || kind === "company"
        ? (entities.data?.items ?? []).filter((e) => !e.closed_on && (kind !== "company" || identityProblems(e).length === 0)).flatMap((e) =>
            e.workplaces.filter((w) => !w.closed_on && (kind !== "company" || w.is_primary)).map((w) => ({ value: w.id, label: kind === "company" ? entityNameText(e) : w.current?.name ?? "", content: kind === "company" ? <EntityName entity={e} /> : undefined, description: kind === "company" ? w.current?.name ?? "" : entityNameText(e) })),
          )
        // The server's order: its likely code first (BE-MIG W02), then the rest.
        : [...(item?.resolution?.choices ?? []).filter((c) => EMPLOYMENT_TYPES.includes(c as never)), ...EMPLOYMENT_TYPES].filter((c, i, list) => list.indexOf(c) === i).map((c) => ({ value: c, label: employmentTypeLabel(c) }));
  const sourceText = item?.value ?? text;
  const near = item?.candidates ?? [];
  return (
    <fieldset className={`form form__group ${s.plain}`} disabled={busy}>
      {/* Near names the server found (BE-MIG W03): offered, never bound until picked; one click answers every row. */}
      {near.length > 0 && (
        <div className={s.choices} role="group" aria-label={t("importValues.near", { value: sourceText })}>
          {near.map((c) => (
            <Button key={c.id} variant={answerOf(picks, decision, text) === c.id ? "primary" : "secondary"} aria-pressed={answerOf(picks, decision, text) === c.id} onClick={() => onResolve(withChoice(picks, decision, text, c.id))}>
              {kind === "company" ? <EntityName name={c.name} alias={c.alias} /> : c.name} <span className="muted">{candidateBasisLabel(c.basis)}</span>
            </Button>
          ))}
        </div>
      )}
      <PickOne
        label={t(`importReview.value.choose.${kind}`, { value: sourceText })}
        required={false}
        options={[{ value: NONE, label: t(`importReview.value.none.${kind}`) }, ...targets]}
        value={answerOf(picks, decision, text)}
        onChange={(v) => onResolve(withChoice(picks, decision, text, v))}
        group={t(`importReview.value.kind.${kind}`)}
        empty={t("importReview.value.noOptions")}
      />
    </fieldset>
  );
}

/** no employee number: type the employee number this new person gets, or leave it and give one later with number change. */
export function NumberAnswer({ sourceKey, name, picks, busy, onResolve }: Common & { sourceKey: string; name: string }) {
  const [v, setV] = useState(picks.employee_numbers[sourceKey] ?? "");
  const go = t("importReview.number.run");
  return (
    <div className="form">
      <Field label={t("importReview.number.label", { name })} required >
        {(p) => <TextInput {...p} className="field__input" value={v} maxLength={NUMBER_MAX} onChange={(e) => setV(e.target.value)} />}
      </Field>
      <div className="form__actions">
        {v.trim() ? (
          <Button variant="primary" disabled={busy} onClick={() => onResolve(withNumber(picks, sourceKey, v))}>{go}</Button>
        ) : (
          <DisabledReason control={(p) => <Button {...p} variant="primary">{go}</Button>} reason={t("importReview.number.needOne")} />
        )}
      </div>
    </div>
  );
}
