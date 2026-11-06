import { buttonClass } from "../../../ui/button/button-class";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Receipt } from "../../../ui/receipt/receipt";
import { FILING_READS, filingsQuery, recordFiling, type FilingTask } from "../../../reference/statutory/api";
import { chunk } from "../../../lib/chunk-guard";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { FilingRequest } from "./filing-request";
import { FilingComplete } from "./filing-complete";
import { filingLabel } from "../present";

const FilingTable = lazy(() => chunk(import("./filing-table")).then(m => ({ default: m.FilingTable })));

export function FilingList({ site, event, filing, workplaces }: { site?: string; event?: string; filing?: string; workplaces: ReadState }) {
  const [state, setState] = useState("PENDING");
  const [search, setSearch] = useState("");
  const [findSlot, setFindSlot] = useState<HTMLDivElement | null>(null);
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<FilingTask>();
  const [request, setRequest] = useState<FilingTask>();
  const [receipt, setReceipt] = useState<FilingTask>();
  const [scope, setScope] = useState(`${site ?? "all"}:${filing ?? ""}`);
  if (scope !== `${site ?? "all"}:${filing ?? ""}`) {
    setScope(`${site ?? "all"}:${filing ?? ""}`); setAfter(undefined); setState("PENDING"); setSearch("");
    setSelected(undefined); setRequest(undefined); setReceipt(undefined);
  }
  const tasks = useQuery({ ...filingsQuery({ workplace_id: site, event_id: event, filing_id: filing, state: filing ? undefined : state, search, after }), placeholderData: keepPreviousData });
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    const linked = filing && tasks.data?.items.find((task) => task.filing_obligation_id === filing);
    if (linked && linked.state !== "LEGAL_REVIEW" && opened.current !== filing) { opened.current = filing; setSelected(linked); }
  }, [filing, tasks.data]);
  const undo = useCommand({
    run: (task: FilingTask, key) => recordFiling(task, { expected_version: task.version, action: "UNDO" }, key),
    invalidates: FILING_READS, settle: true,
    onSuccess: setReceipt,
  });
  const done = (task: FilingTask) => { setSelected(undefined); setReceipt(task); };
  return <>
    <div className="row">
      {event && <Link to="/statutory" className={buttonClass()}>{t("statutory.all")}</Link>}
      <ToggleButton pressed={state === "PENDING"} onClick={() => { setState("PENDING"); setAfter(undefined); }}>{t("statutory.pending")}</ToggleButton>
      <ToggleButton pressed={state === "DONE"} onClick={() => { setState("DONE"); setAfter(undefined); }}>{t("statutory.done")}</ToggleButton>
      <div ref={setFindSlot} />
    </div>
    <QueryState q={readGroup([workplaces, tasks])} layout="list">{() => {
      const page = tasks.data!;
      return <>
      <Suspense fallback={<ReadSkeleton layout="list" />}><FilingTable rows={page.items} total={page.total} search={search} findSlot={findSlot}
        onFind={value => { setSearch(value.trim()); setAfter(undefined); }} onRecord={setSelected} onRequest={setRequest}
        onUndo={task => undo.mutate(task)} undoing={undo.isPending} /></Suspense>
      <div className="row">{after && <Button onClick={() => setAfter(undefined)}>{t("common.back")}</Button>}{page.next && <Button onClick={() => setAfter(page.next!)}>{t("statutory.more")}</Button>}</div>
    </>; }}</QueryState>
    <CommandError error={undo.error} recover={false}>{undo.isChecking && <Button onClick={() => undo.check()}>{t("common.retry")}</Button>}</CommandError>
    {receipt && <Receipt placement="docked" state="applied" message={receipt.record_action === "UNDO" ? t("statutory.undone") : receipt.record_action === "ASSESS" ? t("statutory.assessed") : receipt.state === "NOT_APPLICABLE" ? t("statutory.notApplicableSaved", { name: receipt.name, insurer: filingLabel(receipt.insurer), kind: filingLabel(receipt.kind) }) : receipt.completed_on ? t("statutory.saved", { name: receipt.name, insurer: filingLabel(receipt.insurer), kind: filingLabel(receipt.kind) }) : t("statutory.undone")}
      onDismiss={() => setReceipt(undefined)} onUndo={receipt.record_action === "COMPLETE" || receipt.record_action === "NOT_APPLICABLE" ? () => undo.mutate(receipt) : undefined} undoing={undo.isPending} />}
    {request && <FilingRequest task={request} onClose={() => setRequest(undefined)} />}
    {selected && <FilingComplete task={selected} onClose={() => setSelected(undefined)} onDone={done} />}
  </>;
}
