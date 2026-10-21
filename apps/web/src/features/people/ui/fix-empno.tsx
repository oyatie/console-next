import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { focusOnce } from "../../../lib/react/focus-once";
import { reasonCodesQuery, useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { DateField } from "../../../ui/date/date-field";
import { TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Sheet } from "../../../ui/sheet/sheet";
import { byNumbersQuery } from "../api";
import { changeEmployeeNumber } from "../api/record";
import type { Card } from "./use-card";
import { Card as Surface } from "../../../ui/card/card";
import s from "./card.module.css";
import { Who } from "./card-who";

const DOMAIN = "employee_number_change";

/**
 * employee-number change (E4-empno-change, decision #25): a dated change of a number that was right, unlike its
 * correction. The new number is checked against every holder as typed (a taken one names its holder), with a date (today
 * or earlier; the server applies no future change) and a reason, none preselected. The old number stays the person's
 * alias: it still finds them and is never handed to anyone else.
 */
export function FixEmpno({ c, onClose, onCorrect }: { c: Card; onClose: () => void; onCorrect: () => void }) {
  const today = todayKst();
  const [no, setNo] = useState("");
  const [when, setWhen] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useQuery(reasonCodesQuery(DOMAIN));
  const needsNote = useNeedsNote(DOMAIN, why);
  const next = no.trim();
  const holders = useQuery({ ...byNumbersQuery([next]), enabled: next.length > 0 }).data?.items.filter((x) => x.employee_number === next && x.id !== c.e.id) ?? [];
  const taken = holders[0];
  const date = when === "today" ? today : typed;
  const missing = !next || next === c.e.employee_number || taken ? "empno-new" : !when || !date || date > today ? "empno-when" : !why ? "empno-why" : needsNote && !note.trim() ? "empno-note" : null;
  const run = useCommand({
    run: () => changeEmployeeNumber(c.e.id, { new_number: next, effective_date: date, reason_code: why!, ...(note.trim() ? { note: note.trim() } : {}), expected_updated_at: c.e.updated_at }),
    invalidates: ["/api/v1/employees"],
    settle: true,
    announce: (r) => t("empFix.empno.done", { no: r.to_number }),
    onSuccess: onClose,
  });
  const press = () => (missing ? document.getElementById(missing)?.querySelector<HTMLElement>("input, textarea")?.focus() : run.mutate(undefined));
  return (
    <Sheet
      open
      kicker={<Who c={c} />}
      title={t("empFix.empno.title")}
      subtitle={t("empFix.empno.sub", { no: c.e.employee_number ?? "—" })}
      onClose={onClose}
      notice={run.isError && <CommandError error={run.error} />}
      consequence={<span>{missing ? t("empFix.empno.pick") : <b>{t("empFix.empno.cons", { from: c.e.employee_number ?? "—", to: next })}</b>}</span>}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t("empFix.cancel")}</Button>
          <Button onClick={onCorrect}>{t("empFix.empno.toCorrect")}</Button>
          <Button variant="primary" aria-disabled={missing ? true : undefined} onClick={press}>{t("empFix.empno.commit")}</Button>
        </>
      }
    >
      <div id="empno-new" className={s.fieldBlock}>
        <span className={s.fieldLabel}>{t("empFix.empno.new")}</span>
        <TextInput aria-label={t("empFix.empno.new")} aria-invalid={taken ? true : undefined} aria-describedby={taken ? "empno-new-issue" : undefined} className={s.mono} value={no} onChange={(e) => setNo(e.target.value)} ref={focusOnce} />
        <span id="empno-new-issue" className={`${s.err} ${s.empnoStatus}`} aria-hidden={!taken || undefined}>
          {taken && <><TriangleAlert size={12} aria-hidden /> {t("empFix.empno.taken", { name: taken.name, no: taken.employee_number ?? "", where: taken.org_unit ?? "—" })}</>}
        </span>
      </div>
      <div id="empno-when">
        <ChipChoice label={t("empFix.empno.when")} options={[{ value: "today", label: t("empFix.empno.today") }, { value: "typed", label: t("empFix.empno.past") }]} value={when} onChange={setWhen} />
        {when === "typed" && <DateField label={t("empFix.empno.date")} required value={typed} onChange={setTyped} today={today} max={today} />}
      </div>
      <div id="empno-why"><ReasonCodeField domain={DOMAIN} label={t("empFix.empno.why")} value={why} onChange={setWhy} /></div>
      {needsNote && (
        <div id="empno-note" className={s.fieldBlock}>
          <span className={s.fieldLabel}>{t("empFix.empno.note")}</span>
          <TextArea aria-label={t("empFix.empno.note")} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <Surface look="outline">
        {(["alias", "links", "issued"] as const).map((k) => (
          <div key={k} className={s.stackRow}>
            <span className={s.stackHead}><b>{t(`empFix.empno.then.${k}`, { no: c.e.employee_number ?? "—" })}</b><span className={s.s12}>{t(`empFix.empno.then.${k}.state`)}</span></span>
            <span className={s.s12}>{t(`empFix.empno.then.${k}.d`)}</span>
          </div>
        ))}
      </Surface>
    </Sheet>
  );
}
