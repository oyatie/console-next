import { retirementDate } from "../domain/employment";
import { commitLabel } from "../../../ui/composer/actions";
import { exitUndoVerb } from "../domain/exits";
import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Receipt } from "../../../ui/receipt/receipt";
import { Composer } from "../../../ui/composer/composer";
import { focusSoon } from "../../../lib/react/announce";
import { usePageActive } from "../../../lib/react/page-active";
import { QueryState } from "../../../lib/react/query-state";
import { EXIT_CASE_STATUS, LIFECYCLE_STATE, labeled } from "../../../lib/labels";
import { useCan } from "../../../reference/authz/ui/use-can";
import { caseQuery, exitCasesQuery } from "../api";
import { whoLine } from "../present";
import { isClosed, isForward, type BackKey, type ForwardKey } from "../domain/exits";
import { StepForm } from "./exit-axis";
import { CloseForm } from "./exit-close";
import { RelDay } from "./exit-facts";
import { ReportForm } from "./exit-report";
import { useCaseActions, useOwnRecord } from "./use-case-actions";
import s from "./exit.module.css";
import { Muted } from "../../../ui/muted/muted";

type Case = components["schemas"]["EmployeeExitCase"];
type Employee = components["schemas"]["Employee"];
type Key = ForwardKey | BackKey;
const route = getRouteApi("/app/people/$id");

/** `act` on the person page: `exit.report`, or `exit.<step>:<caseId>`. Anything else belongs to another block. */
const parse = (act?: string): { key: "report" } | { key: Key; caseId: string } | null => {
  const m = act?.match(/^exit\.([a-z_]+)(?::(.+))?$/);
  if (!m) return null;
  return m[1] === "report" ? { key: "report" } : m[2] ? { key: m[1] as Key, caseId: m[2] } : null;
};

/**
 * The exit card on the person's record: report an exit, or the open case's state, its date, whose turn it
 * is and the steps this user holds. A step opens in a side sheet (`act`, so Back closes it) with the record
 * still in view; the full case is one link away. Closed cases fold under a disclosure.
 */
export function ExitCases({ employee, act }: { employee: Employee; act?: string }) {
  const cases = useQuery(exitCasesQuery({ employeeId: employee.id }));
  const can = useCan();
  const own = useOwnRecord(employee.id);
  const navigate = route.useNavigate();
  const [receipt, setReceipt] = useState<{ message: string; reference?: string } | null>(null);
  const pageActive = usePageActive();
  const open = cases.data?.items.find((c) => !isClosed(c) && c.status !== "SUBMITTED");
  const past = cases.data?.items.filter((c) => c !== open) ?? [];
  const reportable = can("exit_case_report") && employee.status !== "EXITED" && cases.isSuccess && !open;
  // people-self-33: one's own record keeps the verb in place, with the rule and who records it instead.
  const canReport = reportable && !own;
  const want = parse(act);
  const target = want && want.key !== "report" ? cases.data?.items.find((c) => c.id === want.caseId) : undefined;
  const show = (next?: string) => void navigate({ search: next ? { act: next } : {}, replace: !next });
  const done = (message: string, reference?: string) => {
    if (!pageActive()) return;
    setReceipt({ message, reference });
    show();
    focusSoon("exit");
  };
  if (cases.isSuccess && cases.data.items.length === 0 && !reportable && !want) return null;
  return (
    <section className="card panel" aria-labelledby="exit">
      <div className="row">
        <h2 id="exit" className="panel__title grow" tabIndex={-1}>{t("exit.title")}</h2>
        {canReport && <Button onClick={() => show("exit.report")}>{t("exit.report")}</Button>}
        {reportable && own && <DisabledReason layout="inline" control={(p) => <Button {...p}>{t("exit.report")}</Button>} reason={t("common.failed.code.own_record_forbidden")} />}
      </div>
      {/* Reserve the report's receipt before its read lands so the next step stays under the pointer. */}
      {(want?.key === "report" || receipt) && <div className={s.receiptSlot}>
        <div className={s.receiptReserve} aria-hidden="true">
          <Receipt state="recorded" message={t("exit.reported", { name: employee.name })} meta={<ReceiptReference value={employee.id} />} />
        </div>
        {receipt && <Receipt state="recorded" message={receipt.message} meta={receipt.reference && <ReceiptReference value={receipt.reference} />} />}
      </div>}
      <QueryState q={cases}>
        {() => (
          <>
            {open && <OpenCase c={open} name={employee.name} onAct={(k) => show(`exit.${k}:${open.id}`)} />}
            {past.length > 0 && (
              <details className={s.past}>
                <summary>{t("exit.block.past", { count: past.length })}</summary>
                <ul className="list-plain">
                  {past.map((c) => {
                    const st = labeled(EXIT_CASE_STATUS, c.status);
                    return (
                      <li key={c.id} className="row">
                        <Link to="/people/exits/$id" params={{ id: c.id }} search={{}} className="grow">{t("exit.case.summary", { date: fmtDate(retirementDate(c.effective_exit_date)) })}</Link>
                        <Chip tone={st.tone}>{st.label}</Chip>
                        {c.closed_reason && <Muted>{c.closed_reason}</Muted>}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </>
        )}
      </QueryState>
      <ActSheet act={act} want={want} target={target} employee={employee} canReport={canReport} loaded={cases.isSuccess} onClose={() => show()} onDone={done} />
    </section>
  );
}

/** The open case at a glance: status, exit date and distance, what happens on that date, whose turn it is, and my steps. */
function OpenCase({ c, name, onAct }: { c: Case; name: string; onAct: (k: Key) => void }) {
  const { next, forward, back, sameActor } = useCaseActions(c);
  const st = labeled(EXIT_CASE_STATUS, c.status);
  const pending = c.exit_event_state === "SCHEDULED" || c.exit_event_state === "APPLY_FAILED" ? c.exit_event_state : null;
  const date = fmtDate(retirementDate(c.effective_exit_date));
  const step = next && t(`exit.step.${next === "confirm_exit" ? "HR_CONFIRMED" : next === "confirm_exit_hq" ? "HQ_CONFIRMED" : "SETTLEMENT_READY"}`);
  return (
    <div className="form">
      <div className="row">
        <span className="grow num">{t("exit.case.summary", { date })} · <RelDay date={retirementDate(c.effective_exit_date)} /></span>
        <Chip tone={st.tone}>{st.label}</Chip>
        {pending && <Chip tone={labeled(LIFECYCLE_STATE, pending).tone}>{labeled(LIFECYCLE_STATE, pending).label}</Chip>}
      </div>
      {pending && <Muted>{t(`exit.eventState.${pending}`, { name, date })}</Muted>}
      {step && <Muted>{t("exit.next", { step })} · {forward ? t("exit.next.mine") : next === "confirm_exit_hq" ? t("exit.next.otherHq") : t("exit.next.others")}</Muted>}
      <div className="row" role="group" aria-label={t("exit.actions")}>
        {forward && <Button variant="primary" onClick={() => onAct(forward)}>{t(`exit.action.${forward}`)}</Button>}
        {sameActor && <DisabledReason control={(p) => <Button variant="primary" {...p}>{t("exit.action.confirm_exit_hq")}</Button>} reason={t("exit.hq.sameActor")} />}
        <span className="grow" />
        {back.map((k) => <Button key={k} variant="ghost-danger" onClick={() => onAct(k)}>{commitLabel({ kind: "exit", mode: exitUndoVerb(c, k === "reject_exit") })}</Button>)}
      </div>
      <Link to="/people/exits/$id" params={{ id: c.id }} search={{}}>{t("exit.block.open")}</Link>
    </div>
  );
}

/**
 * The sheet `act` names, checked once, when the cases have loaded: a step the case does not offer this user
 * says so instead of opening nothing. A later refresh never swaps an open form for that notice (the server
 * still decides at commit).
 */
function ActSheet({ act, want, target, employee, canReport, loaded, onClose, onDone }: {
  act?: string;
  want: ReturnType<typeof parse>;
  target?: Case;
  employee: Employee;
  canReport: boolean;
  loaded: boolean;
  onClose: () => void;
  onDone: (message: string, reference?: string) => void;
}) {
  const actions = useCaseActionsOrNone(target);
  const [checked, setChecked] = useState<{ act?: string; offered: boolean } | null>(null);
  const report = want?.key === "report";
  const key = !want || report ? null : want.key;
  const now = report ? canReport : Boolean(target && key && (key === actions.forward || actions.back.includes(key as BackKey)));
  // Adjusting state while rendering (React's pattern for a changed prop): the first verdict per `act` sticks.
  if (want && loaded && checked?.act !== act) setChecked({ act, offered: now });
  if (!want || !loaded || !checked || checked.act !== act) return null;
  const offered = checked.offered && (report || Boolean(target));
  if (!offered)
    return (
      <Composer
        action={{ kind: "exit", mode: "apply" }} onSubmit={() => false} locked
        title={report ? t("exit.report.title", { name: employee.name }) : t(`exit.action.${key!}`)}
        subtitle={whoLine(employee)}
        onClose={onClose}
        consequence={<p role="status">{t("exit.unavailable")} · {t("exit.unavailable.reason")}</p>}
        recovery={<Button onClick={onClose}>{t("composer.dismiss")}</Button>}
      >
        {null}
      </Composer>
    );
  if (report) return <ReportForm employee={employee} onClose={onClose} onDone={onDone} />;
  const sheet = { title: t(`exit.action.${key!}`), subtitle: whoLine(employee), onClose };
  if (key && isForward(key)) return <CaseStep k={key} c={target!} sheet={sheet} onDone={onDone} />;
  return <CloseForm c={target!} reject={key === "reject_exit"} onClose={onClose} onDone={onDone} />;
}

function CaseStep({ c, ...props }: { c: Case; k: ForwardKey; sheet: { title: string; subtitle: string; onClose: () => void }; onDone: (message: string) => void }) {
  const detail = useQuery({ ...caseQuery(c.id), placeholderData: c });
  return <StepForm {...props} c={detail.data ?? c} sheet={{ ...props.sheet, loading: detail.isPlaceholderData || !detail.isSuccess }} aside={detail.isError && <QueryState q={detail}>{() => null}</QueryState>} />;
}

const NONE = { forward: null, back: [] as BackKey[] };
/** The case's actions for this user, or none when the sheet names no case (hooks cannot be conditional). */
function useCaseActionsOrNone(c?: Case) {
  const a = useCaseActions(c ?? ({ next_actions: [], exit_event_state: null } as unknown as Case));
  return c ? a : NONE;
}
