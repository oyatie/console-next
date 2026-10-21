import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Dialog } from "../../../ui/dialog";
import { Button, Form } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { SelectField } from "../../../ui/select/select-field";
import { Receipt } from "../../../ui/receipt/receipt";
import { FILINGS, requestFiling, type FilingTask } from "../../../reference/statutory/api";
import { filingLabel } from "../present";
export function FilingRequest({ task, onClose }: { task: FilingTask; onClose: () => void }) {
  const [kind, setKind] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [tried, setTried] = useState(false);
  const run = useCommand({ run: (_: void, key) => requestFiling(task.event_id, kind!, date, key),
    invalidates: [FILINGS, "/api/v1/me/action-inbox"], settle: true, onSuccess: onClose });
  const submit = () => { setTried(true); if (kind && isDate(date)) run.mutate(undefined); };
  return <Dialog open title={t("statutory.requestTitle", { name: task.name })} onClose={onClose} dismissable={!run.isPending}>
    <Form className="form" noValidate onSubmit={submit}>
      {run.isPending ? <dl className="facts"><dt>{t("statutory.requestKind")}</dt><dd>{kind && filingLabel(kind)}</dd><dt>{t("statutory.requestOn")}</dt><dd>{fmtDate(date)}</dd></dl> : <>
      <SelectField label={t("statutory.requestKind")} placeholder={t("statutory.pickResolution")} value={kind} onChange={setKind}
        options={(task.kind === "LOSE" ? ["SEPARATION_CERTIFICATE"] : ["ACQUIRE_REQUESTED", "WORK_CONFIRMATION", "MONTHLY_REMUNERATION"]).map((id) => ({ id, label: filingLabel(id) }))} />
      <DateField label={t("statutory.requestOn")} required value={date} onChange={setDate} today={todayKst()} error={tried && (!kind || !isDate(date)) ? t("statutory.requestRequired") : undefined} />
      </>}
      <CommandError error={run.error} recover={false} />
      {run.isChecking && <Receipt state="checking" />}
      <div className="row"><Button onClick={onClose} disabled={run.isPending}>{t("statutory.cancel")}</Button>{run.isChecking ? <Button onClick={() => run.check()}>{t("common.retry")}</Button> : <Button type="submit" variant="primary" disabled={run.isPending}>{t("statutory.requestSave")}</Button>}</div>
    </Form>
  </Dialog>;
}
