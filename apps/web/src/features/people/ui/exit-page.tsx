import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { DocumentDecision } from "../../../ui/patterns/document-decision";
import { DocRailBody, DocRailSection } from "../../../ui/patterns/document-decision-parts";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { Receipt } from "../../../ui/receipt/receipt";
import { focusSoon } from "../../../lib/react/announce";
import { usePageActive } from "../../../lib/react/page-active";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { freshOnOpen } from "../../../lib/query";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { EXIT_CASE_STATUS, LIFECYCLE_STATE, labeled } from "../../../lib/labels";
import { EXIT_FEATURES, authzApplies, authzQuery } from "../../../reference/authz/api";
import { useCan } from "../../../reference/authz/ui/use-can";
import { settingsQuery } from "../../../reference/settings/api";
import { caseQuery } from "../api";
import { lifecycleCaseQuery } from "../api/lifecycle-trail";
import { isForward, type BackKey } from "../domain/exits";
import { CaseAxis } from "./exit-axis";
import { CloseForm } from "./exit-close";
import { ExitBoard } from "./exit-board";
import { LinkedCase } from "./lifecycle-trail";
import { lifecycleTrailError } from "../present";
import { CasePanel } from "./exit-facts";
import { useCaseActions } from "./use-case-actions";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
const route = getRouteApi("/app/people/exits/$id");

/**
 * One exit case on its own page, reachable with directory read access, so an HQ confirmer who does not
 * manage employee records can act on it (Home's exit queue links here with `act`). The steps run down the
 * main column with the current step's form under it; the facts the decision rests on sit beside them.
 */
export function ExitCasePage() {
  const { id } = route.useParams();
  const q = useQuery(caseQuery(id));
  const can = useCan();
  // Back to the exit list for anyone it serves (Home and the list both lead here), else Home.
  const toList = EXIT_FEATURES.some((f) => can(f));
  const canReadDirectory = can("employee_directory_read", "all");
  const renderBaseline = () => (
    <div className="page"><PageReadGate q={q} title={t("exit.list.title")} back={{ to: "/people/exits", label: t("exit.list.title") }}>
      {q.data && <>
            <div className="page__head">
              {toList ? <Link to="/people/exits" className="btn btn--ghost">{t("exit.list.title")}</Link> : <Link to="/" className="btn btn--ghost">{t("home.title")}</Link>}
              <h1 id="exit" className="page__title grow" tabIndex={-1}>
                {t("exit.page.title", { name: q.data.employee_name })} <span className="code">{q.data.employee_number ?? ""}</span>
              </h1>
              <StatusChips c={q.data} />
              {/* A settlement a group transfer opened goes back only with it: withdrawn or rescinded from the person's history. */}
              {q.data.exit_reason_code === "GROUP_TRANSFER" && q.data.exit_event_state !== "APPLY_FAILED" && (
                <Link to="/people/$id" params={{ id: q.data.employee_id }} search={{ tab: "events" }} className={buttonClass()}>
                  {t(q.data.exit_event_state === "SCHEDULED" ? "exit.group.cancel" : "exit.group.rescind")}
                </Link>
              )}
              {canReadDirectory && (
                <Link to="/people/$id" params={{ id: q.data.employee_id }} search={{}} className="btn">{t("exit.page.employee", { name: q.data.employee_name })}</Link>
              )}
            </div>
      </>}
      <QueryState q={q} back={{ to: "/people/exits", label: t("exit.list.title") }} layout="record">
        {(c) => (
          <section className={s.stack} aria-labelledby="exit">
            <CaseBody key={c.id} c={c} />
          </section>
        )}
      </QueryState>
    </PageReadGate></div>
  );

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => <ConsoleExitCase key={id} q={q} toList={toList} canReadDirectory={canReadDirectory} />}
    </ExperienceSwitch>
  );
}

function ConsoleExitCase({ q, toList, canReadDirectory }: { q: ReturnType<typeof useQuery<Case>>; toList: boolean; canReadDirectory: boolean }) {
  const { act } = route.useSearch();
  const navigate = route.useNavigate();
  const view = queryView(q);
  const c = view === "denied" || view === "not-found" ? undefined : q.data;
  const authz = freshOnOpen(useQuery({ ...authzQuery, enabled: authzApplies(), refetchOnMount: "always" }));
  const trail = freshOnOpen(useQuery({ ...lifecycleCaseQuery(c?.id ?? ""), enabled: Boolean(c), refetchOnMount: "always" }));
  const settings = useQuery({ ...settingsQuery, enabled: Boolean(c) });
  const dueSoonDays = settings.data?.items.find((item) => item.key === "display.deadline_due_soon_days")?.value;
  const ready = !authz.isPending || !authzApplies();
  const actions = useCaseActions(c ?? ({ employee_id: "", next_actions: [] } as unknown as Case));
  const offered = Boolean(c && act && actions.usable.some((k) => k === act));
  const fromAct = ready && offered && act && !isForward(act as BackKey) ? (act as BackKey) : null;
  const [chosen, setClosing] = useState<BackKey | null>();
  const closing = chosen === undefined ? fromAct : chosen;
  const [receipt, setReceipt] = useState<string | null>(null);
  const pageActive = usePageActive();
  const handled = useRef(false);
  useEffect(() => {
    if (!c || !act || !ready || handled.current) return;
    handled.current = true;
    if (offered && act === actions.forward) focusSoon("exit-now");
  }, [c, act, ready, offered, actions.forward]);
  const clearAct = () => void navigate({ search: {}, replace: true });
  const close = () => { setClosing(null); clearAct(); };
  const done = (message: string) => {
    if (!pageActive()) return;
    setClosing(null);
    setReceipt(message);
    clearAct();
    focusSoon("exit-receipt", "exit");
  };
  const settled = Boolean(c && ready && !trail.isPending);
  const statusChip = c ? labeled(EXIT_CASE_STATUS, c.status) : null;

  return (
    <DocumentDecision
      q={q}
      back={{ to: toList ? "/people/exits" : "/", label: toList ? t("exit.list.title") : t("home.title") }}
      head={{
        title: c ? t("exit.page.title", { name: c.employee_name }) : t("exit.list.title"),
        titleId: "exit",
        meta: c ? <>{c.employee_number ? <bdi className="code">{c.employee_number}</bdi> : null}<StatusChips c={c} /></> : undefined,
        actions: c ? (
          <>
            {toList ? <Link to="/people/exits" className={buttonClass("secondary", { size: "sm" })}>{t("exit.list.title")}</Link> : <Link to="/" className={buttonClass("secondary", { size: "sm" })}>{t("home.title")}</Link>}
            {c.exit_reason_code === "GROUP_TRANSFER" && c.exit_event_state !== "APPLY_FAILED" && (
              <Link to="/people/$id" params={{ id: c.employee_id }} search={{ tab: "events" }} className={buttonClass("secondary", { size: "sm" })}>
                {t(c.exit_event_state === "SCHEDULED" ? "exit.group.cancel" : "exit.group.rescind")}
              </Link>
            )}
            {canReadDirectory && (
              <Link to="/people/$id" params={{ id: c.employee_id }} search={{}} className={buttonClass("secondary", { size: "sm" })}>{t("exit.page.employee", { name: c.employee_name })}</Link>
            )}
          </>
        ) : undefined,
      }}
      notes={
        settled && c ? (
          <>
            {act && !offered && (
              <RecordBannerBand tone="neutral">
                {t("exit.unavailable")} · {t("exit.unavailable.reason")}{" "}
                <Button variant="ghost" size="sm" onClick={clearAct}>{t("uiSheet.close")}</Button>
              </RecordBannerBand>
            )}
            {receipt && (
              <div id="exit-receipt" tabIndex={-1}>
                <Receipt state="recorded" message={receipt} meta={<ReceiptReference value={c.id} />} />
              </div>
            )}
          </>
        ) : undefined
      }
      start={
        settled && c ? (
          <DocRailSection label={t("exit.facts")}>
            <PaneHead title={t("exit.facts")} />
            <DocRailBody>
              <CasePanel c={c} trailUnavailable={trail.isError} consoleMode />
            </DocRailBody>
          </DocRailSection>
        ) : undefined
      }
      document={
        c ? (
          !settled ? (
            <ReadSkeleton layout="record" />
          ) : (
            <section className={s.stack} aria-labelledby="exit">
              <CaseAxis c={c} onBack={setClosing} onDone={done} consoleMode />
              <QueryState q={trail} own={lifecycleTrailError}>
                {(value) => (
                  <>
                    <ExitBoard value={value} lastWorkingDay={c.effective_exit_date} dueSoonDays={typeof dueSoonDays === "number" ? dueSoonDays : null} consoleMode />
                    {value.linked_case_id && <LinkedCase id={value.linked_case_id} />}
                  </>
                )}
              </QueryState>
            </section>
          )
        ) : null
      }
      overlays={settled && c && closing ? <CloseForm c={c} reject={closing === "reject_exit"} onClose={close} onDone={done} /> : undefined}
      statusSegments={
        c && statusChip
          ? [
              { id: "name", tone: "strong", content: c.employee_name },
              { id: "status", content: statusChip.label },
              { id: "date", content: fmtDate(c.effective_exit_date) },
            ]
          : null
      }
    />
  );
}

function StatusChips({ c }: { c: Case }) {
  const st = labeled(EXIT_CASE_STATUS, c.status);
  const pending = c.exit_event_state === "SCHEDULED" || c.exit_event_state === "APPLY_FAILED" ? labeled(LIFECYCLE_STATE, c.exit_event_state) : null;
  return (
    <>
      <Chip tone={st.tone}>{st.label}</Chip>
      {pending && <Chip tone={pending.tone}>{pending.label}</Chip>}
    </>
  );
}

/**
 * `act` from a link: a forward step this user holds focuses its inline form; a back decision opens its sheet;
 * anything the case no longer offers says so (once the grants have loaded, never before). The link's `act`
 * is dropped once acted on, so a reload does not reopen it.
 */
function CaseBody({ c }: { c: Case }) {
  const { act } = route.useSearch();
  const navigate = route.useNavigate();
  const authz = freshOnOpen(useQuery({ ...authzQuery, enabled: authzApplies(), refetchOnMount: "always" }));
  const trail = freshOnOpen(useQuery({ ...lifecycleCaseQuery(c.id), refetchOnMount: "always" }));
  const settings = useQuery(settingsQuery);
  const dueSoonDays = settings.data?.items.find(item => item.key === "display.deadline_due_soon_days")?.value;
  const ready = !authz.isPending || !authzApplies();
  const { usable, forward } = useCaseActions(c);
  const offered = Boolean(act) && usable.some((k) => k === act);
  // A back decision named by the link opens its sheet until the user closes it or picks another.
  const fromAct = ready && offered && act && !isForward(act as BackKey) ? (act as BackKey) : null;
  const [chosen, setClosing] = useState<BackKey | null>();
  const closing = chosen === undefined ? fromAct : chosen;
  const [receipt, setReceipt] = useState<string | null>(null);
  const pageActive = usePageActive();
  const handled = useRef(false);
  // A forward step the link names is the inline form: focus it once.
  useEffect(() => {
    if (!act || !ready || handled.current) return;
    handled.current = true;
    if (offered && act === forward) focusSoon("exit-now");
  }, [act, ready, offered, forward]);
  const clearAct = () => void navigate({ search: {}, replace: true });
  const close = () => {
    setClosing(null);
    clearAct();
  };
  const done = (message: string) => {
    if (!pageActive()) return;
    setClosing(null);
    setReceipt(message);
    clearAct();
    focusSoon("exit-receipt", "exit");
  };
  if (!ready || trail.isPending) return <ReadSkeleton layout="record" />;
  return (
    <>
      {act && ready && !offered && (
        <div className="notice row" role="status">
          <span className="grow">{t("exit.unavailable")} · {t("exit.unavailable.reason")}</span>
          <Button variant="ghost" onClick={clearAct}>{t("uiSheet.close")}</Button>
        </div>
      )}
      <div className={`card ${s.layout}`}>
        <div>
          {receipt && (
            <div id="exit-receipt" tabIndex={-1} className={s.column}>
              <Receipt state="recorded" message={receipt} meta={<ReceiptReference value={c.id} />} />
            </div>
          )}
          <CaseAxis c={c} onBack={setClosing} onDone={done} />
        </div>
        <CasePanel c={c} trailUnavailable={trail.isError} />
      </div>
      <QueryState q={trail} own={lifecycleTrailError}>{(value) => <><ExitBoard value={value} lastWorkingDay={c.effective_exit_date} dueSoonDays={typeof dueSoonDays === "number" ? dueSoonDays : null} />{value.linked_case_id && <LinkedCase id={value.linked_case_id} />}</>}</QueryState>
      {closing && <CloseForm c={c} reject={closing === "reject_exit"} onClose={close} onDone={done} />}
    </>
  );
}
