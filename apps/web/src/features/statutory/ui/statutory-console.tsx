// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import {
  FILING_READS,
  exportRegister,
  filingsQuery,
  recordFiling,
  registerQuery,
  workplacesQuery,
  type FilingTask,
} from "../../../reference/statutory/api";
import { saveFile } from "../../../lib/download";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Segmented } from "../../../ui/button/segmented";
import { isDate } from "../../../ui/date/days";
import { NO_SELECTION, type Selection } from "../../../ui/long-table/selection";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { SearchField } from "../../../ui/search/search-field";
import { TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { isEdiEligible } from "../domain/edi-export";
import { downloadStatutoryEdi, printRegisterConsole, taskKey } from "./statutory-console-columns";
import { buildFilingSidePane } from "./statutory-console-detail";
import { RegisterExportTools, StatutoryFilters } from "./statutory-console-filters";
import { InsuranceTabMain } from "./statutory-console-insurance";
import { StatutoryConsoleOverlays } from "./statutory-console-overlays";
import { RegisterTabMain } from "./statutory-console-register";
import s from "./statutory-console.module.css";

function selectedTasksFrom(rows: FilingTask[], sel: Selection): FilingTask[] {
  if (sel.kind === "all") return rows.filter((r) => !sel.excluded.has(taskKey(r)));
  return rows.filter((r) => sel.ids.has(taskKey(r)));
}

export function StatutoryConsole({ baseline }: { baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <StatutoryConsoleContent baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function StatutoryConsoleContent({ baseline }: { baseline: () => ReactNode }) {
  const search = useSearch({ from: "/app/statutory" });
  const navigate = useNavigate({ from: "/statutory" });
  const tab = search.tab ?? "insurance";
  const today = todayKst();
  const date = search.date && isDate(search.date) ? search.date : today;
  const validDate = date <= today;
  const workplaces = useQuery({ ...workplacesQuery(validDate ? date : today), placeholderData: keepPreviousData });

  const [state, setState] = useState<"PENDING" | "DONE">("PENDING");
  const [insurer, setInsurer] = useState<string>("ALL");
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [findText, setFindText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [after, setAfter] = useState<string>();
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [recordTask, setRecordTask] = useState<FilingTask>();
  const [requestTask, setRequestTask] = useState<FilingTask>();
  const [receipt, setReceipt] = useState<FilingTask>();
  const [ediNotice, setEdiNotice] = useState<{ count: number; empty: boolean } | null>(null);

  const scopeKey = `${tab}:${search.site ?? "all"}:${search.filing ?? ""}:${search.event ?? ""}`;
  const [lastScope, setLastScope] = useState(scopeKey);
  if (lastScope !== scopeKey) {
    setLastScope(scopeKey);
    setAfter(undefined);
    setInspectedId(null);
    setSelection(NO_SELECTION);
    setRecordTask(undefined);
    setRequestTask(undefined);
    setEdiNotice(null);
  }

  const tasks = useQuery({
    ...filingsQuery({
      workplace_id: search.site,
      event_id: search.event,
      filing_id: search.filing,
      state: search.filing ? undefined : state,
      insurer: insurer === "ALL" ? undefined : insurer,
      search: appliedSearch,
      after,
    }),
    enabled: tab === "insurance",
    placeholderData: keepPreviousData,
  });

  const openedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const linked = search.filing && tasks.data?.items.find((task) => task.filing_obligation_id === search.filing);
    if (linked && linked.state !== "LEGAL_REVIEW" && openedRef.current !== search.filing) {
      openedRef.current = search.filing;
      setInspectedId(taskKey(linked));
    }
  }, [search.filing, tasks.data]);

  const undo = useCommand({
    run: (task: FilingTask, key) => recordFiling(task, { expected_version: task.version, action: "UNDO" }, key),
    invalidates: FILING_READS,
    settle: true,
    onSuccess: (next) => { setEdiNotice(null); setReceipt(next); },
  });

  const allItems = tasks.data?.items ?? [];
  const visibleRows = urgentOnly ? allItems.filter((r) => r.due_in_days != null && r.due_in_days <= 7) : allItems;
  const inspectedTask = visibleRows.find((r) => taskKey(r) === inspectedId) ?? allItems.find((r) => taskKey(r) === inspectedId) ?? null;

  const [regAfter, setRegAfter] = useState<string>();
  const [purpose, setPurpose] = useState<string | null>(null);
  const [triedExport, setTriedExport] = useState(false);
  const [exportedCount, setExportedCount] = useState<number | null>(null);

  const registerScopeKey = `${search.site ?? ""}:${date}`;
  const [lastRegScope, setLastRegScope] = useState(registerScopeKey);
  if (lastRegScope !== registerScopeKey) {
    setLastRegScope(registerScopeKey);
    setRegAfter(undefined);
    setPurpose(null);
    setTriedExport(false);
    setExportedCount(null);
  }

  const registerRead = useQuery({
    ...registerQuery(search.site ?? "", date, regAfter),
    enabled: tab === "register" && validDate && Boolean(search.site),
    placeholderData: keepPreviousData,
  });

  const exportCmd = useCommand({
    run: (format: "xlsx" | "pdf") => exportRegister(search.site!, date, format, purpose!),
    onSuccess: async (file) => {
      if (file instanceof Blob) saveFile(file, t("statutory.file", { site: registerRead.data?.workplace_name ?? "", date }));
      else printRegisterConsole(file);
      setExportedCount(registerRead.data?.total ?? 0);
    },
  });

  const runExport = (format: "xlsx" | "pdf") => {
    setTriedExport(true);
    if (purpose && search.site) exportCmd.mutate(format);
  };

  const handleEdiExport = () => {
    const picked = selectedTasksFrom(visibleRows, selection).filter(isEdiEligible);
    if (!picked.length) {
      setEdiNotice({ count: 0, empty: true });
      return;
    }
    downloadStatutoryEdi(picked, today);
    setReceipt(undefined);
    setEdiNotice({ count: picked.length, empty: false });
  };

  const workplaceOptions = [
    ...(tab === "insurance" ? [{ id: "all", label: t("statutory.all") }] : []),
    ...(workplaces.data ?? []).map((w) => ({ id: w.id, label: [w.entity_name, w.name].filter(Boolean).join(" · ") })),
  ];

  const mainQuery: ReadState = tab === "register" && search.site && validDate ? readGroup([workplaces, registerRead]) : workplaces;
  const sidePane =
    tab === "insurance" && inspectedTask
      ? buildFilingSidePane({
          task: inspectedTask,
          onClose: () => setInspectedId(null),
          onRecord: setRecordTask,
          onRequest: setRequestTask,
          onUndo: (task) => undo.mutate(task),
          undoing: undo.isPending,
        })
      : undefined;

  return (
    <ListRecord
      baseline={baseline}
      q={mainQuery}
      tabs={
        <div className={s.tabStrip}>
          <TabNav label={t("statutory.title")} overflow="scroll">
            <Link className={tabClass} to="/statutory" search={{ site: search.site, date: search.date }} aria-current={tab === "insurance" ? "page" : undefined}>
              {t("statutory.insurance")}
            </Link>
            <Link className={tabClass} to="/statutory" search={{ tab: "register", site: search.site, date: search.date }} aria-current={tab === "register" ? "page" : undefined}>
              {t("statutory.register")}
            </Link>
          </TabNav>
        </div>
      }
      head={{
        title: t("statutory.title"),
        actions: tab === "insurance" && search.event ? (
          <Link to="/statutory" className={buttonClass("ghost", { size: "sm" })}>{t("statutory.all")}</Link>
        ) : undefined,
      }}
      views={
        tab === "insurance" ? (
          <Segmented
            label={t("statutory.action")}
            value={state}
            onChange={(next) => { setState(next); setAfter(undefined); setSelection(NO_SELECTION); }}
            items={[
              { id: "PENDING", label: t("statutory.pending"), count: tasks.data?.pending },
              { id: "DONE", label: t("statutory.done") },
            ]}
          />
        ) : undefined
      }
      filters={
        <StatutoryFilters
          tab={tab}
          site={search.site}
          workplaceOptions={workplaceOptions}
          onSiteChange={(site) => void navigate({ search: { ...search, site }, replace: true })}
          insurer={insurer}
          onInsurerChange={(next) => { setInsurer(next); setAfter(undefined); setSelection(NO_SELECTION); }}
          urgentOnly={urgentOnly}
          onToggleUrgent={() => setUrgentOnly((v) => !v)}
          date={date}
          today={today}
          onDateChange={(d) => void navigate({ search: { ...search, date: d }, replace: true })}
        />
      }
      find={
        tab === "insurance" ? (
          <SearchField
            label={t("statutory.search")}
            value={findText}
            onChange={(value) => { setFindText(value); if (!value) { setAppliedSearch(""); setAfter(undefined); } }}
            onKeyDown={(e) => { if (e.key === "Enter") { setAppliedSearch(findText.trim()); setAfter(undefined); } }}
          />
        ) : undefined
      }
      tools={
        tab === "register" && search.site ? (
          <RegisterExportTools
            purpose={purpose}
            onPurposeChange={setPurpose}
            triedExport={triedExport}
            pending={exportCmd.isPending}
            onExport={runExport}
          />
        ) : undefined
      }
      notes={
        <>
          <CommandError error={undo.error} recover={false}>
            {undo.isChecking ? <Button onClick={() => undo.check()}>{t("common.retry")}</Button> : null}
          </CommandError>
          <CommandError error={exportCmd.error} />
        </>
      }
      list={
        tab === "insurance" ? (
          <InsuranceTabMain
            workplaces={workplaces}
            tasks={tasks}
            visibleRows={visibleRows}
            urgentOnly={urgentOnly}
            state={state}
            inspectedTask={inspectedTask}
            setInspectedId={setInspectedId}
            selection={selection}
            setSelection={setSelection}
            onEdiExport={handleEdiExport}
            after={after}
            setAfter={setAfter}
          />
        ) : (
          <RegisterTabMain site={search.site} date={date} validDate={validDate} workplaces={workplaces} registerRead={registerRead} regAfter={regAfter} setRegAfter={setRegAfter} />
        )
      }
      record={sidePane}
      overlays={
        <StatutoryConsoleOverlays
          ediNotice={ediNotice}
          onDismissEdi={() => setEdiNotice(null)}
          receipt={receipt}
          onDismissReceipt={() => setReceipt(undefined)}
          onUndo={(task) => undo.mutate(task)}
          undoing={undo.isPending}
          exportedCount={exportedCount}
          onDismissExport={() => setExportedCount(null)}
          requestTask={requestTask}
          onCloseRequest={() => setRequestTask(undefined)}
          recordTask={recordTask}
          onCloseRecord={() => setRecordTask(undefined)}
          onDoneRecord={(done) => { setRecordTask(undefined); setReceipt(done); }}
        />
      }
      statusSegments={
        tab === "insurance"
          ? [
              { id: "count", content: t("statutory.count", { count: urgentOnly ? visibleRows.length : tasks.data?.total ?? 0 }) },
              ...(tasks.data?.pending != null ? [{ id: "pending", tone: "strong" as const, content: `${t("statutory.pending")} ${fmtNumber(tasks.data.pending)}` }] : []),
            ]
          : registerRead.data
            ? [{ id: "people", content: t("statutory.people", { count: registerRead.data.total }) }]
            : undefined
      }
    />
  );
}
