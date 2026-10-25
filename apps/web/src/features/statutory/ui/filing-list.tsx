import { buttonClass } from "../../../ui/button/button-class";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Field, TextInput } from "../../../ui/field/field";
import { Button, ToggleButton } from "../../../ui/button/button";
import { RecordRows } from "../../../ui/record/rows";
import { Receipt } from "../../../ui/receipt/receipt";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { FILINGS, filingsQuery, recordFiling, type FilingTask } from "../../../reference/statutory/api";
import { FilingWindow } from "./filing-deadline";
import { FilingRequest } from "./filing-request";
import { FilingComplete } from "./filing-complete";
import { filingLabel } from "../present";
import s from "./statutory.module.css";

export function FilingList({ site, event, workplaces }: { site?: string; event?: string; workplaces: ReadState }) {
  const [state, setState] = useState("PENDING");
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<FilingTask>();
  const [request, setRequest] = useState<FilingTask>();
  const [receipt, setReceipt] = useState<FilingTask>();
  const [scope, setScope] = useState(site);
  if (scope !== site) {
    setScope(site); setAfter(undefined); setState("PENDING"); setSearch("");
    setSelected(undefined); setRequest(undefined); setReceipt(undefined);
  }
  const tasks = useQuery({ ...filingsQuery({ workplace_id: site, event_id: event, state, search, after }), placeholderData: keepPreviousData });
  const undo = useCommand({
    run: (task: FilingTask, key) => recordFiling(task, { expected_version: task.version, action: "UNDO" }, key),
    invalidates: [FILINGS, "/api/v1/me/action-inbox"], settle: true,
    onSuccess: setReceipt,
  });
  const done = (task: FilingTask) => { setSelected(undefined); setReceipt(task); };
  return <>
    <div className="row">
      {event && <Link to="/statutory" className={buttonClass()}>{t("statutory.all")}</Link>}
      <ToggleButton pressed={state === "PENDING"} onClick={() => { setState("PENDING"); setAfter(undefined); }}>{t("statutory.pending")}</ToggleButton>
      <ToggleButton pressed={state === "DONE"} onClick={() => { setState("DONE"); setAfter(undefined); }}>{t("statutory.done")}</ToggleButton>
      <Field label={t("statutory.search")} required={null}>{(p) => <TextInput {...p} value={search} onChange={(e) => { setSearch(e.target.value); setAfter(undefined); }} />}</Field>
    </div>
    <QueryState q={readGroup([workplaces, tasks])} layout="list">{() => {
      const page = tasks.data!;
      return <>
      <Chip>{t("statutory.count", { count: page.total })}</Chip>
      {page.items.length ? (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll this wide table.
        <div className={s.scroll} tabIndex={0} role="region" aria-label={t("statutory.insurance")}><RecordRows label={t("statutory.insurance")} rows={page.items} rowId={(r) => `${r.event_id}:${r.kind}:${r.insurer}`}
        columns={[
          { header: t("statutory.employee"), cell: (r) => <Link to="/people/$id" params={{ id: r.employee_id }}>{r.name}</Link> },
          { header: t("statutory.employeeNumber"), cell: (r) => r.employee_number },
          { header: t("statutory.workplace"), cell: (r) => r.workplace_name },
          { header: t("statutory.event"), cell: (r) => <>{filingLabel(r.insurer)} · {filingLabel(r.kind)}</> },
          { header: t("statutory.date"), cell: (r) => fmtDate(r.effective_date) },
          { header: t("statutory.deadline"), cell: (r) => <FilingWindow task={r} /> },
          { header: t("statutory.evidence"), cell: (r) => r.completed_on ? <dl className="facts">
            <dt>{t("statutory.completedOn")}</dt><dd>{fmtDate(r.completed_on)}</dd>
            {r.receipt_number && <><dt>{t("statutory.receiptNumber")}</dt><dd>{r.receipt_number}</dd></>}
            {r.loss_code && <><dt>{t("statutory.lossCode")}</dt><dd>{r.loss_code} · {r.loss_options.find((o) => o.code === r.loss_code)?.label}</dd></>}
            {r.detail && <><dt>{t("statutory.detail")}</dt><dd>{r.detail}</dd></>}
          </dl> : r.state === "NOT_APPLICABLE" ? <><Chip>{t("statutory.notApplicable")}</Chip> {r.not_applicable_reason && filingLabel(r.not_applicable_reason)}{r.detail && <dl className="facts"><dt>{t("statutory.reasonEvidence")}</dt><dd>{r.detail}</dd></dl>}</> : r.state === "COVERED" ? t("statutory.covered") : t("statutory.pending") },
          { header: t("statutory.action"), end: true, cell: (r) => <div className="row">{r.record_action === "COMPLETE" || r.record_action === "NOT_APPLICABLE" ? <Button onClick={() => undo.mutate(r)} disabled={undo.isPending}>{t("statutory.undo")}</Button> : <Button onClick={() => setSelected(r)}>{t("statutory.record")}</Button>}
            {!r.is_request && ["ACQUIRE", "LOSE"].includes(r.kind) && r.insurer === "EI" && <Button onClick={() => setRequest(r)}>{t("statutory.futureRequest")}</Button>}</div> },
        ]} /></div>) : <EmptyState title={t("statutory.empty")} reason={t("statutory.emptyReason")} actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>} />}
      <div className="row">{after && <Button onClick={() => setAfter(undefined)}>{t("common.back")}</Button>}{page.next && <Button onClick={() => setAfter(page.next!)}>{t("statutory.more")}</Button>}</div>
    </>; }}</QueryState>
    <CommandError error={undo.error} recover={false}>{undo.isChecking && <Button onClick={() => undo.check()}>{t("common.retry")}</Button>}</CommandError>
    {receipt && <Receipt placement="docked" state="applied" message={receipt.record_action === "UNDO" ? t("statutory.undone") : receipt.record_action === "ASSESS" ? t("statutory.assessed") : receipt.state === "NOT_APPLICABLE" ? t("statutory.notApplicableSaved", { name: receipt.name, insurer: filingLabel(receipt.insurer), kind: filingLabel(receipt.kind) }) : receipt.completed_on ? t("statutory.saved", { name: receipt.name, insurer: filingLabel(receipt.insurer), kind: filingLabel(receipt.kind) }) : t("statutory.undone")}
      onDismiss={() => setReceipt(undefined)} onUndo={receipt.record_action === "COMPLETE" || receipt.record_action === "NOT_APPLICABLE" ? () => undo.mutate(receipt) : undefined} undoing={undo.isPending} />}
    {request && <FilingRequest task={request} onClose={() => setRequest(undefined)} />}
    {selected && <FilingComplete task={selected} onClose={() => setSelected(undefined)} onDone={done} />}
  </>;
}
