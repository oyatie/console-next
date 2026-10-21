import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { CONTRACT_KIND, PAY_UNIT, label } from "../../../lib/labels";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { ContractRefusal } from "./contract-refusal";
import { useDirtyEscape } from "../../../lib/react/dirty-escape";
import { todayKst } from "../../../lib/pure/today";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { CONTRACT_KINDS, LABOUR, PAY_UNITS, contractIssues, draftOf, hasEnd, weeklyMinutes, type Contract, type ContractDraft, type ContractKind, type PayUnit } from "../domain/facts";
import { recordContract } from "../api";

const EMPTY: ContractDraft = { kind: null, start: "", end: "", wage: "", unit: null, hours: "" };

/**
 * Records a contract (G1), or a correction of `of`: rows are never edited, a correction is a new row that names the
 * one it replaces and starts from its terms. Required terms follow the kind (LSA art. 17(1): a labour contract states
 * its wage and weekly hours; a fixed-term one its end). Nothing is preselected; errors show on press.
 */
export function ContractForm({ employeeId, name, of, onClose, onCorrect }: { employeeId: string; name: string; of?: Contract; onClose: () => void; onCorrect: (id: string) => void }) {
  const today = todayKst();
  const [d, setD] = useState<ContractDraft>(() => (of ? draftOf(of) : EMPTY));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof ContractDraft>(k: K) => (v: ContractDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const issues = contractIssues(d);
  const error = (k: keyof ContractDraft) => (tried && issues[k] ? t(`facts.contract.error.${issues[k]}`) : undefined);
  const labour = d.kind !== null && LABOUR.includes(d.kind);
  const record = useCommand({
    run: (_: void, key: string) =>
      recordContract(
        employeeId,
        {
          kind: d.kind!,
          start_date: d.start,
          end_date: hasEnd(d.kind) && d.end ? d.end : null,
          wage_won: Number(d.wage),
          pay_unit: d.unit!,
          weekly_minutes: weeklyMinutes(d.hours),
          supersedes_id: of?.id ?? null,
        },
        key,
      ),
    invalidates: ["/api/v1/employees"],
    onSuccess: onClose,
    announce: () => t(of ? "facts.contract.corrected" : "facts.contract.recorded", { name }),
  });
  const press = () => {
    setTried(true);
    const count = Object.keys(issues).length;
    if (count) return announce(t("facts.errors", { count }));
    record.mutate(undefined);
  };
  const dirty = JSON.stringify(d) !== JSON.stringify(of ? draftOf(of) : EMPTY);
  const { ref, armed } = useDirtyEscape<HTMLDivElement>(dirty, onClose);
  const title = of ? t("facts.contracts.correct.title", { start: fmtDate(of.start_date) }) : t("facts.contracts.record");
  return (
    <div ref={ref}>
      <Form className="form" aria-label={title} noValidate onSubmit={press}>
        <h3 className="panel__title">{title}</h3>
        {of && <p className="muted">{t("facts.contracts.correct.note")}</p>}
        <ChoiceField
          label={t("facts.contract.kind")}
          required
          options={CONTRACT_KINDS.map((k) => ({ value: k, label: label(CONTRACT_KIND, k) }))}
          value={d.kind}
          onChange={(k) => setD((x) => ({ ...x, kind: k as ContractKind, end: hasEnd(k as ContractKind) ? x.end : "" }))}
          error={error("kind")}
        />
        <DateField label={t("facts.contract.start")} required value={d.start} onChange={set("start")} today={today} error={error("start")} />
        {hasEnd(d.kind) && (
          <DateField
            label={t("facts.contract.end")}
            required={d.kind === "FIXED_TERM"}
            value={d.end}
            onChange={set("end")}
            today={today}
            min={d.start || undefined}

            error={error("end")}
          />
        )}
        <Field label={t("facts.contract.wage")} required unit={t("facts.won")} error={error("wage")}>
          {(p) => <TextInput {...p} inputMode="numeric" className="num" value={d.wage === "" ? "" : fmtNumber(Number(d.wage))} onChange={(e) => set("wage")(e.target.value.replace(/[^\d]/g, ""))} />}
        </Field>
        <ChoiceField label={t("facts.contract.unit")} required options={PAY_UNITS.map((u) => ({ value: u, label: label(PAY_UNIT, u) }))} value={d.unit} onChange={(u) => set("unit")(u as PayUnit)} error={error("unit")} />
        <Field label={t("facts.contract.hours")} required={labour} unit={t("facts.contract.hours.unit")}  error={error("hours")}>
          {(p) => <TextInput {...p} inputMode="decimal" className="num" value={d.hours} onChange={(e) => set("hours")(e.target.value.replace(/[^\d.]/g, ""))} />}
        </Field>
        {armed && <p className="muted" role="status">{t("facts.escConfirm")}</p>}
        <p id="contract-consequence" className="muted">{t("facts.contract.consequence")}</p>
        <ContractRefusal error={record.error} onCorrect={onCorrect} />
        <div className="row">
          <Button disabled={record.isPending} onClick={onClose}>{t("common.back")}</Button>
          <Button type="submit" variant="primary" disabled={record.isPending} aria-describedby="contract-consequence">{t(of ? "facts.contract.saveCorrection" : "facts.contract.save")}</Button>
        </div>
      </Form>
    </div>
  );
}
