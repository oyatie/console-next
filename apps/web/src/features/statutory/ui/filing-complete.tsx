import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { freshOnOpen } from "../../../lib/query";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { Dialog } from "../../../ui/dialog";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { SelectField } from "../../../ui/select/select-field";
import { Receipt } from "../../../ui/receipt/receipt";
import { Chip } from "../../../ui/chip";
import { FILING_READS, filingsQuery, recordFiling, type FilingTask, type FilingFacts, type FilingReason } from "../../../reference/statutory/api";
import { FilingFactsFields } from "./filing-facts";
import { FilingWindow } from "./filing-deadline";
import { filingLabel } from "../present";

export function FilingComplete({ task, onClose, onDone }: { task: FilingTask; onClose: () => void; onDone: (r: FilingTask) => void }) {
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState<FilingReason | null>(null);
  const [facts, setFacts] = useState<FilingFacts>(task.applicability_facts);
  const [remuneration, setRemuneration] = useState("");
  const [date, setDate] = useState("");
  const [number, setNumber] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [preview, setPreview] = useState(false);
  const [tried, setTried] = useState(false);
  const latest = freshOnOpen(useQuery({ ...filingsQuery({ event_id: task.event_id, kind: task.kind, insurer: task.insurer }), refetchOnMount: "always" }));
  const current = latest.data?.items[0];
  const changed = latest.isSuccess && (!current || current.version !== task.version);
  const today = todayKst();
  const validDate = isDate(date) && date >= (task.opens_on ?? task.effective_date) && date <= today;
  const loss = task.loss_options.find((o) => o.code === code);
  const needsCode = ["LOSE", "AGE60"].includes(task.kind) && task.loss_options.length > 0;
  const validAmount = !task.basis?.remuneration_required || (remuneration !== "" && Number.isSafeInteger(Number(remuneration)) && Number(remuneration) >= 0);
  const valid = action === "ASSESS" || action === "NOT_APPLICABLE" ? (action === "ASSESS" || (reason !== null && detail.trim() !== "")) : action === "COMPLETE" && validDate && validAmount && (!needsCode || loss) && (!loss?.requires_detail || detail.trim());
  const run = useCommand({
    run: (_: void, key) => recordFiling(task, { expected_version: task.version, action: action as "COMPLETE" | "NOT_APPLICABLE" | "ASSESS", applicability_facts: facts,
      ...(action === "COMPLETE" ? {completed_on: date, receipt_number: number.trim() || undefined, loss_code: code ?? undefined, detail: detail.trim() || undefined,
        total_remuneration_won: remuneration === "" ? undefined : Number(remuneration)} : action === "NOT_APPLICABLE" ? {not_applicable_reason: reason!, detail: detail.trim()} : {}) }, key),
    invalidates: FILING_READS, settle: true, onSuccess: onDone,
  });
  const variables = { name: task.name, insurer: filingLabel(task.insurer), kind: filingLabel(task.kind), date: date ? fmtDate(date) : "" };
  const submit = () => { setTried(true); if (valid) setPreview(true); };
  return <Dialog open read title={t("statutory.completeTitle", variables)} onClose={onClose} dismissable={!run.isPending}>
    <QueryState q={latest}>{() => task.state === "LEGAL_REVIEW" || current?.state === "LEGAL_REVIEW" ? <Chip>{t("lifecycle.trail.unverified")}</Chip> : <Form className="form" noValidate onSubmit={submit}>
      {preview ? <>
        <p>{t(action === "NOT_APPLICABLE" ? "statutory.notApplicableConsequence" : action === "ASSESS" ? "statutory.assessed" : "statutory.consequence", variables)}</p>
        <dl className="facts">{action === "COMPLETE" && <><dt>{t("statutory.completedOn")}</dt><dd>{fmtDate(date)}</dd></>}
          {reason && <><dt>{t("statutory.reason")}</dt><dd>{filingLabel(reason)}</dd></>}
          {remuneration && <><dt>{t("statutory.remuneration")}</dt><dd>{remuneration}</dd></>}
          {number && <><dt>{t("statutory.receiptNumber")}</dt><dd>{number}</dd></>}
          {loss && <><dt>{t("statutory.lossCode")}</dt><dd>{loss.code} · {loss.label}</dd></>}
          {detail && <><dt>{t("statutory.detail")}</dt><dd>{detail}</dd></>}
        </dl>
      </> : <>
        <FilingWindow task={task} />
        <SelectField label={t("statutory.resolution")} placeholder={t("statutory.pickResolution")} value={action} onChange={(v) => { setAction(v); setDetail(""); setDate(""); setNumber(""); setCode(null); setRemuneration(""); setPreview(false); }}
          options={[{id: "COMPLETE", label: t("statutory.complete")}, {id: "NOT_APPLICABLE", label: t("statutory.notApplicable")}, {id: "ASSESS", label: t("statutory.assess")}]}
          error={tried && !action ? t("statutory.requiredResolution") : undefined} />
        {action && <FilingFactsFields task={task} facts={facts} onChange={setFacts} editAll={action !== "COMPLETE"} />}
        {action === "NOT_APPLICABLE" && <>
          <SelectField label={t("statutory.reason")} placeholder={t("statutory.pickReason")} value={reason} onChange={(v) => setReason(v as FilingReason)}
            options={task.not_applicable_options.map((id) => ({id, label: filingLabel(id)}))} error={tried && !reason ? t("statutory.requiredReason") : undefined} />
          <Field label={t("statutory.reasonEvidence")} required error={tried && !detail.trim() ? t("statutory.requiredReason") : undefined}>{(p) => <TextInput {...p} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} />}</Field>
        </>}
        {action === "COMPLETE" && <>
        <DateField label={t("statutory.completedOn")} required value={date} onChange={setDate} today={today} min={task.opens_on ?? task.effective_date} max={today}
          presets={[{ label: t("statutory.today"), date: today }]} error={tried && !validDate ? t("statutory.requiredDate") : undefined} />
        {task.basis?.remuneration_required && <Field label={t("statutory.remuneration")} required error={tried && !validAmount ? t("statutory.requiredRemuneration") : undefined}>{(p) => <TextInput {...p} type="number" min={0} step={1} value={remuneration} onChange={(e) => setRemuneration(e.target.value)} />}</Field>}
        <Field label={t("statutory.receiptNumber")} required={false}>{(p) => <TextInput {...p} value={number} onChange={(e) => setNumber(e.target.value)} maxLength={100} />}</Field>
        {needsCode && <SelectField label={t("statutory.lossCode")} placeholder={t("statutory.pickCode")} value={code} onChange={setCode}
          options={task.loss_options.map((o) => ({ id: o.code, label: [o.code, o.label, o.held ? t("statutory.codeHold") : null].filter(Boolean).join(" · ") }))}
          error={tried && !loss ? t("statutory.requiredCode") : undefined} />}
        {task.kind === "LOSE" && !needsCode && <Chip tone="warn">{t("statutory.codeUnknown")}</Chip>}
        {loss?.requires_detail && <Field label={t("statutory.detail")} required error={tried && !detail.trim() ? t("statutory.requiredDetail") : undefined}>
          {(p) => <TextInput {...p} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} />}
        </Field>}
        </>}
      </>}
      {changed && <div role="alert"><p>{t("statutory.stale")}</p>
        {current?.completed_on && <dl className="facts"><dt>{t("statutory.completedOn")}</dt><dd>{fmtDate(current.completed_on)}</dd>
          {current.receipt_number && <><dt>{t("statutory.receiptNumber")}</dt><dd>{current.receipt_number}</dd></>}
        </dl>}
        <Button onClick={onClose}>{t("statutory.latest")}</Button>
      </div>}
      <CommandError error={run.error} recover={false} />
      {run.isChecking && <Receipt state="checking" />}
      <div className="row">
        <Button onClick={preview ? () => setPreview(false) : onClose} disabled={run.isPending}>{t(preview ? "statutory.edit" : "statutory.cancel")}</Button>
        {run.isChecking ? <Button onClick={() => run.check()}>{t("common.retry")}</Button> : preview ?
          <Button variant="primary" disabled={run.isPending || changed || !latest.isSuccess} onClick={() => run.mutate(undefined)}>{t(action === "NOT_APPLICABLE" ? "statutory.notApplicable" : action === "ASSESS" ? "statutory.assess" : "statutory.complete")}</Button> :
          <Button type="submit" variant="primary" disabled={changed}>{t("statutory.preview")}</Button>}
      </div>
    </Form>}</QueryState>
  </Dialog>;
}
