import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { usePageActive } from "../../../lib/react/page-active";
import { freshOnOpen } from "../../../lib/query";
import { todayKst } from "../../../lib/pure/today";
import { editable } from "../../../ui/long-table/row-keys";
import { contractsQuery, employeeQuery, endOptionsQuery, eventsQuery, exitCasesQuery, problemOf } from "../api";
import { assignmentsRef, entitiesRef } from "../../../reference/entity/api";
import { authzApplies, authzQuery, granted } from "../../../reference/authz/api";
import { verbStates } from "../domain/lifecycle";
import { ActHost, type Done } from "./person-act";
import { ProfileHost } from "./profile-host";
import { CancelHost } from "./cancel-sheet";
import { CardBar, CardBody } from "./card-body";
import { CardHead, type CardTab } from "./card-head";
import { CardPrint } from "./card-print";
import { CardDenied, CardSkeleton } from "./card-states";
import { CardTabs } from "./card-tabs";
import { FixHost } from "./fix-host";
import { useCard } from "./use-card";
import { useQuick } from "./use-quick";
import { directorySearch } from "./use-linked-account";
import { PeopleJump } from "./people-jump";
import s from "./card.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
const route = getRouteApi("/app/people/$id");

/** The personnel card route (E2): loading keeps the final geometry, a person outside the reader's grant reads as not found. */
export function EmployeeCard() {
  const { id } = route.useParams();
  const [opened, setOpened] = useState<string | null>(null);
  const record = employeeQuery(id), placement = assignmentsRef(id);
  const detail = useFreshOnArrival(useQuery(record), record);
  // The card's layout depends on the reader's grant (a manager's head carries verbs and field marks): hold the skeleton
  // until /me/authz has answered, so a cold load never draws a reader's head and then grows it under the pointer.
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  // So are the dated facts the record's rows are drawn with (its action history: a field's "since … · promotion" line; its
  // placement history), read alongside the person: a row never grows a line under the pointer when they land.
  const events = freshOnOpen(useQuery({ ...eventsQuery(id), refetchOnMount: "always" }));
  const placed = useFreshOnArrival(useQuery(placement), placement);
  const entities = useFreshOnArrival(useQuery(entitiesRef), entitiesRef);
  const can = granted(authz.data?.capabilities, authz.isError);
  const manage = can("employee_directory_manage", "all");
  const users = can("user_manage");
  // Contracts and end-options change the height of sections and the action row: read them before exposing controls.
  const contracts = freshOnOpen(useQuery({ ...contractsQuery(id), enabled: manage, refetchOnMount: "always" }));
  const ends = freshOnOpen(useQuery({ ...endOptionsQuery(id), enabled: manage, refetchOnMount: "always" }));
  // The key becomes known after the employee read; a cached key must fetch even when this observer was already mounted.
  const account = freshOnOpen(useQuery({ ...directorySearch(detail.data?.employee.employee_number || detail.data?.employee.name || "", true), enabled: users && !!detail.data, staleTime: 0, refetchOnMount: "always" }));
  // The exit block's first answer changes section 4's height, so it settles before the controls appear too.
  const exits = freshOnOpen(useQuery({ ...exitCasesQuery({ employeeId: id }), refetchOnMount: "always" }));
  // Only until each first answers: a read the reader may not make (403) retries behind the card, never behind the skeleton.
  const first = (q: { isPending: boolean; failureCount: number }) => q.isPending && q.failureCount === 0;
  if (problemOf(detail.error)?.status === 404) return <CardDenied />;
  const loading = (authzApplies() && authz.isPending) || first(events) || first(placed) || first(entities) || (manage && (first(contracts) || first(ends) || first(exits))) || (users && !!detail.data && first(account));
  if (detail.isPending || (opened !== id && loading)) return <CardSkeleton />;
  // Later reads keep the mounted card and anything typed into it, including a changed account-search key.
  if (detail.isSuccess && opened !== id) setOpened(id);
  return <div className={s.page}><QueryState q={detail}>{(d) => <Card key={d.employee.id} d={d} />}</QueryState></div>;
}

function Card({ d }: { d: Detail }) {
  const c = useCard(d);
  const quick = useQuick(c);
  const { act, back, tab = "card" } = route.useSearch();
  const navigate = route.useNavigate();
  // The identifiers page is its own route; an exit step opens on the personnel card tab, where the exit card lives.
  const open = (next: string, from?: string) =>
    next === "identifiers" ? void navigate({ to: "/people/$id/identifiers", params: { id: d.employee.id } }) : void navigate({ search: (p) => ({ ...p, act: next, back: from, tab: next.startsWith("exit.") ? undefined : p.tab }) });
  const close = () => void navigate({ search: (p) => ({ ...p, act: undefined, back: undefined }), replace: true });
  const onTab = (x: CardTab) => void navigate({ search: (p) => ({ ...p, tab: x === "card" ? undefined : x }), replace: true });
  const go = (other: string) => void navigate({ to: "/people/$id", params: { id: other }, search: { tab: tab === "card" ? undefined : tab } });
  const [done, setDone] = useState<Done | null>(null);
  const pageActive = usePageActive();
  const [current, setCurrent] = useState("s1");
  const jumpTo = (id: string) => (setCurrent(id), focusSoon(id));
  // The head and the section chips stay in view while the record scrolls (E2/E4: the field being changed shows under
  // them); sections keep their tops clear of it when jumped to.
  const held = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = held.current;
    if (!el) return;
    const page = el.parentElement!;
    const ro = new ResizeObserver(() => page.style.setProperty("--record-sticky", `${el.offsetHeight + 16}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A receipt belongs to the screen it was made on: opening a sheet or another tab closes it.
  const { dismiss } = quick;
  useEffect(() => dismiss(), [act, tab, dismiss]);
  // A recorded action lands where it is recorded: the action history, its receipt on top and focus on its row
  // (a withdrawn record is hidden by default, so the history heading takes focus instead).
  const recorded = (r: Done) => {
    if (!pageActive()) return;
    setDone(r);
    // The receipt is in place before the history mounts, so the history never opens without it and then shifts.
    requestAnimationFrame(() => {
      if (!pageActive()) return;
      void navigate({ search: (p) => ({ ...p, act: undefined, back: undefined, tab: "events" }), replace: true });
      focusSoon(`ev-${r.eventId}`, "history");
    });
  };
  // J/K walk the unit's list, 1–8 jump to a section (outside fields; spec §3, WCAG 2.1.4 single keys only there).
  const keys = useRef<{ next?: () => void; prev?: () => void; jump: (n: number) => void; history: () => void }>({ jump: () => {}, history: () => {} });
  useEffect(() => {
    keys.current.jump = (n) => {
      if (tab !== "card") onTab("card");
      jumpTo(`s${n}`);
    };
    // H: the record's history (change history), where every dated fact and correction of its sections is listed.
    keys.current.history = () => onTab("ledger");
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target) || document.querySelector("[role=dialog]")) return;
      if (/^[1-8]$/.test(e.key)) keys.current.jump(Number(e.key));
      else if (e.key === "j") keys.current.next?.();
      else if (e.key === "k") keys.current.prev?.();
      else if (e.key === "h") keys.current.history();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  if (act === "print") return <CardPrint c={c} onClose={close} />;
  const verbs = c.manage && d.employee.status !== "EXITED" ? verbStates(d, c.events.data?.items ?? []) : [];
  return (
    <>
      <div ref={held} className={s.held}>
        <CardHead c={c} onTab={onTab} onAct={open} onGo={go} onKeys={(next, prev) => Object.assign(keys.current, { next, prev })} />
        {tab === "card" && c.manage && <CardBar c={c} current={current} onJump={jumpTo} />}
      </div>
      <ActHost d={d} act={act} back={back} events={c.events} onClose={close} onOpen={open} onRecorded={recorded} />
      <ProfileHost d={d} act={act} onClose={close} />
      <FixHost c={c} act={act} onClose={close} onAct={open} />
      <CancelHost e={d.employee} act={act} onClose={close} onAct={open} />
      {tab === "card" ? (
        <CardBody c={c} quick={quick} act={act} onAct={open} onTab={onTab} onJump={jumpTo} />
      ) : (
        <CardTabs c={c} tab={tab} verbs={verbs} today={todayKst()} done={done} onAct={open} onDismiss={() => setDone(null)} />
      )}
      {quick.toast}
      <PeopleJump />
    </>
  );
}
