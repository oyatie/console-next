import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { Receipt } from "../../../ui/receipt/receipt";
import { focusSoon } from "../../../lib/react/announce";
import { usePageActive } from "../../../lib/react/page-active";
import { QueryState } from "../../../lib/react/query-state";
import { EXIT_CASE_STATUS, LIFECYCLE_STATE, labeled } from "../../../lib/labels";
import { EXIT_FEATURES, authzApplies, authzQuery } from "../../../reference/authz/api";
import { useCan } from "../../../reference/authz/ui/use-can";
import { caseQuery } from "../api";
import { isForward, type BackKey } from "../domain/exits";
import { CaseAxis } from "./exit-axis";
import { CloseForm } from "./exit-close";
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
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  const can = useCan();
  // Back to the exit list for anyone it serves (Home and the list both lead here), else Home.
  const toList = EXIT_FEATURES.some((f) => can(f));
  return (
    <div className="page">
      <QueryState q={{ ...q, isPending: q.isPending || (authzApplies() && authz.isPending) }}>
        {(c) => (
          <section className={s.stack} aria-labelledby="exit">
            <div className="page__head">
              {toList ? <Link to="/people/exits" className="btn btn--ghost">{t("exit.list.title")}</Link> : <Link to="/" className="btn btn--ghost">{t("home.title")}</Link>}
              <h1 id="exit" className="page__title grow" tabIndex={-1}>
                {t("exit.page.title", { name: c.employee_name })} <span className="code">{c.employee_number ?? ""}</span>
              </h1>
              <StatusChips c={c} />
              {/* A settlement a group transfer opened goes back only with it: withdrawn or rescinded from the person's history. */}
              {c.exit_reason_code === "GROUP_TRANSFER" && c.exit_event_state !== "APPLY_FAILED" && (
                <Link to="/people/$id" params={{ id: c.employee_id }} search={{ tab: "events" }} className={buttonClass()}>
                  {t(c.exit_event_state === "SCHEDULED" ? "exit.group.cancel" : "exit.group.rescind")}
                </Link>
              )}
              {can("employee_directory_read", "all") && (
                <Link to="/people/$id" params={{ id: c.employee_id }} search={{}} className="btn">{t("exit.page.employee", { name: c.employee_name })}</Link>
              )}
            </div>
            <CaseBody key={c.id} c={c} />
          </section>
        )}
      </QueryState>
    </div>
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
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  const ready = authz.isSuccess || authz.isError || !authzApplies();
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
              <Receipt state="recorded" message={receipt} />
            </div>
          )}
          <CaseAxis c={c} onBack={setClosing} onDone={done} />
        </div>
        <CasePanel c={c} />
      </div>
      {closing && <CloseForm c={c} reject={closing === "reject_exit"} onClose={close} onDone={done} />}
    </>
  );
}
