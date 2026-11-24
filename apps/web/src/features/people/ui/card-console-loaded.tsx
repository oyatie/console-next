// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { ChevronLeft, ChevronRight, FileText, Lock, MoreHorizontal, MoveRight, Pencil, Printer } from "lucide-react";
import { chunk } from "../../../lib/chunk-guard";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, LIFECYCLE_EVENT, label, labeled } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { focusSoon } from "../../../lib/react/announce";
import type { ReadState } from "../../../lib/react/query-view";
import { useKeys } from "../../../lib/react/use-keys";
import { useSingleKeys } from "../../../lib/react/use-single-keys";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { MenuButton, type MenuEntry } from "../../../ui/menu/menu-button";
import { RecordPattern } from "../../../ui/patterns/record";
import { FieldMark } from "../../../ui/record/field-row";
import { Gate, Kbd } from "../../../ui/record/record-section";
import { unitPositionQuery } from "../api/record";
import { serviceSpan } from "../domain/card";
import { retirementDate } from "../domain/employment";
import { cardSections } from "../domain/keys";
import { verbStates } from "../domain/lifecycle";
import { plannedWhat, whyText } from "../present";
import { BindingReviewChip } from "./binding-evidence";
import { CardBar } from "./card-body";
import { CardConsoleNotes } from "./card-console-notes";
import type { CardTab } from "./card-head";
import { CardSpine } from "./card-spine";
import { CardTabs } from "./card-tabs";
import s from "./card.module.css";
import type { ContractEdit } from "./contracts-card";
import { PeopleJump } from "./people-jump";
import type { Done } from "./person-act";
import { RegisterStrip } from "./register-strip";
import { SecContract, SecLeave } from "./sec-contract-leave";
import { SecJob } from "./sec-job";
import { SecDocs, SecFamily, SecRestricted } from "./sec-more";
import { SecPersonal } from "./sec-personal";
import { SecRecords } from "./sec-records";
import { useOwnRecord } from "./use-case-actions";
import { useCard } from "./use-card";
import { useLinkedAccount } from "./use-linked-account";
import { useQuick } from "./use-quick";

const CardActions = lazy(() => chunk(import("./person-act")).then(m => ({ default: m.CardActions })));
type Detail = components["schemas"]["EmployeeDetail"];
type UnitPosition = components["schemas"]["EmployeeUnitPosition"];
const route = getRouteApi("/app/people/$id");
const PATH_SEP = " › ";

function buildCardMeta({
  d, c, own, today, certsCount, documents, tab, act, jumpTo, onTab, go, open, pos, dismiss,
}: {
  d: Detail; c: ReturnType<typeof useCard>; own: boolean; today: string; certsCount?: number;
  documents: boolean; tab: CardTab; act?: string; jumpTo: (id: string) => void;
  onTab: (t: CardTab) => void; go: (other: string) => void; open: (next: string, from?: string) => void;
  pos: UnitPosition | null; dismiss: () => void;
}) {
  const { e } = c;
  const singleKeys = useSingleKeys();
  const keys = useRef<{ next?: () => void; prev?: () => void; jump: (n: number) => void; history: () => void }>({ jump: () => {}, history: () => {} });
  useLayoutEffect(() => {
    keys.current.next = pos?.next_id ? () => go(pos.next_id!) : undefined;
    keys.current.prev = pos?.prev_id ? () => go(pos.prev_id!) : undefined;
    keys.current.jump = n => {
      if (!(c.readable ? cardSections(c.records.data?.sections, documents) : [2]).includes(n)) return;
      if (tab !== "card") onTab("card");
      jumpTo(`s${n}`);
    };
    keys.current.history = () => onTab("ledger");
  });
  useKeys({
    "card.section": (_, n) => keys.current.jump(Number(n)),
    "card.next": () => keys.current.next?.(),
    "card.prev": () => keys.current.prev?.(),
    "card.history": () => keys.current.history(),
  });
  useEffect(() => dismiss(), [act, tab, dismiss]);
  const hl = act?.startsWith("fix:") ? act.slice(4) : undefined;
  useEffect(() => {
    const row = hl ? document.getElementById(`f-${hl}`) : null;
    row?.setAttribute("data-edit", "");
    row?.scrollIntoView({ block: "center" });
    return () => row?.removeAttribute("data-edit");
  }, [hl]);

  const status = labeled(EMPLOYEE_STATUS, e.status ?? "UNKNOWN");
  const span = e.hire_date ? serviceSpan(e.hire_date, today) : null;
  const hanja = c.personal.data?.name_hanja;
  const items = c.events.data?.items ?? [];
  const verbs = c.editable && e.status !== "EXITED" ? verbStates(d, items) : [];
  const acts: MenuEntry[] = verbs.map(v => ({
    id: v.verb, text: label(LIFECYCLE_EVENT, v.verb), label: t(`people.lifecycle.action.${v.verb}`),
    why: v.enabled ? undefined : own ? t("common.failed.code.own_record_forbidden") : whyText(v.why, [t(`people.lifecycle.action.${v.verb}`)]),
  }));
  const more: MenuEntry[] = [
    { id: "empno", text: t("empCard.more.empno"), label: t("empCard.more.empno") },
    { id: "identifiers", text: t("person.identifiers"), label: t("person.identifiers") },
    { id: "cancel", text: t("empCard.more.void"), label: t("empCard.more.void") },
    { id: "exit.report", text: t("empCard.more.exit"), label: t("empCard.more.exit") },
  ];
  const k = d.classification;
  const facts = [c.title(k.grade_id) ?? e.position, c.title(k.position_kind_id), e.hire_date && t("empCard.hired", { date: fmtDate(e.hire_date) }), span && t("empCard.tenure", span)].filter(Boolean).join(" · ");
  const p = c.planned;
  const next = p
    ? { date: p.event_type === "TERMINATE" || p.event_type === "OFFBOARD" ? retirementDate(p.effective_date) : p.effective_date, what: plannedWhat(p, c.title), by: p.created_by_name && t("empCard.next.by", { who: p.created_by_name, date: fmtDateTime(p.created_at) }) }
    : e.next_event && { date: e.next_event.event_type === "TERMINATE" ? retirementDate(e.next_event.effective_date) : e.next_event.effective_date, what: label(LIFECYCLE_EVENT, e.next_event.event_type), by: null };
  return {
    status, facts, next, items, verbs, acts,
    head: {
      crumbs: (
        <bdi className={s.crumb}>
          <Link to="/people" search={{}}>{t("empCard.crumb")}</Link>
          <bdi aria-hidden="true">{PATH_SEP}</bdi>
          {e.workplace_id ? [c.place.workplace, ...c.place.path].filter(Boolean).join(" › ") || "—" : t("empCard.unplaced")}
        </bdi>
      ),
      title: e.name,
      titleId: "person",
      meta: (
        <>
          {hanja ? <bdi className={s.hanja}>{hanja}</bdi> : null}
          <bdi className={s.empno}>{t("empCard.empno", { no: e.employee_number ?? t("empCard.empno.none") })}</bdi>
          {c.editable ? <FieldMark kind="inline" field={t("empCard.empno.field")} text={t("empCard.empno.change")} name={t("empCard.empno.change")} onPress={() => open("empno")} /> : null}
          {c.manage ? <FieldMark kind="corTwo" field={t("empCard.empno.field")} onPress={() => open("fix:employee_number")} /> : null}
          <Chip tone={status.tone}>{status.label}</Chip>
          {e.register_review_required ? <Chip tone="warn">{t("roster.review.register")}</Chip> : null}
          {d.employment?.employment_type ? <Chip>{label(EMPLOYMENT_TYPE, d.employment.employment_type)}</Chip> : null}
          {next ? <Chip tone="info">{t("people.nextEvent.chip")}</Chip> : null}
          {c.manage ? <BindingReviewChip subjectId={e.id} required={e.identity_review_required} onOpen={() => open("identity")} /> : e.identity_review_required ? <Chip tone="warn">{t("people.identityReview")}</Chip> : null}
          {certsCount !== undefined ? <Chip tone="outline">{t("people.panel.certsCount", { count: certsCount })}</Chip> : null}
        </>
      ),
      // The walk keys' caps show while single keys are on, as on the Classic card.
      tools: pos || singleKeys ? (
        <div className="row">
          {pos ? (
            <>
              <bdi className={s.pos}><strong className={s.posAt}>{t("empCard.pos.at", { index: pos.index, total: pos.total })}</strong></bdi>
              <Button size="sm" variant="ghost" aria-label={t("empCard.prev")} disabled={!pos.prev_id} onClick={() => pos.prev_id && go(pos.prev_id)}><ChevronLeft size={14} aria-hidden="true" /></Button>
              <Button size="sm" variant="ghost" aria-label={t("empCard.next")} disabled={!pos.next_id} onClick={() => pos.next_id && go(pos.next_id)}><ChevronRight size={14} aria-hidden="true" /></Button>
            </>
          ) : null}
          {singleKeys ? <bdi className={s.pos}><Kbd k="J" /><Kbd k="K" /> {t("empCard.walk")}</bdi> : null}
        </div>
      ) : undefined,
      actions: c.editable ? (
        <div className="row" role="group" aria-label={t("empCard.verbs")}>
          {acts.length > 0 ? <MenuButton primary label={t("empCard.verb.act")} icon={<MoveRight size={14} aria-hidden="true" />} items={acts} onAction={a => open(a)} /> : null}
          <Button size="sm" onClick={() => open("multi")}><Pencil size={14} aria-hidden="true" /> {t("empCard.verb.correct")}</Button>
          <Button size="sm" onClick={() => open("print")}><Printer size={14} aria-hidden="true" /> {t("empCard.verb.print")}</Button>
          <Button size="sm" onClick={() => open("cert")}><FileText size={14} aria-hidden="true" /> {t("empCard.verb.cert")}</Button>
          <MenuButton label={t("empCard.verb.more")} icon={<MoreHorizontal size={14} aria-hidden="true" />} caret={false} items={more} onAction={a => open(a)} />
        </div>
      ) : c.readable ? (
        <div className="row" role="group" aria-label={t("empCard.verbs")}>
          <Button size="sm" onClick={() => open("rehire")}>{t("register.rehire.title")}</Button>
          <Button size="sm" onClick={() => open("multi")}><Pencil size={14} aria-hidden="true" /> {t("empCard.verb.correct")}</Button>
          <Button size="sm" onClick={() => open("print")}><Printer size={14} aria-hidden="true" /> {t("empCard.verb.print")}</Button>
          <Button size="sm" onClick={() => open("cert")}><FileText size={14} aria-hidden="true" /> {t("empCard.verb.cert")}</Button>
        </div>
      ) : !c.manage && e.status !== "EXITED" && c.request ? <Button size="sm" onClick={() => open("request")}>{t("person.request")}</Button> : undefined,
    },
  };
}

export function LoadedConsoleCard(props: {
  d: Detail; q: ReadState; act?: string; back?: string; tab: CardTab; documents: boolean; certsCount?: number;
  actionsOpened: boolean; done: Done | null; setDone: (d: Done | null) => void; current: string;
  contract: ContractEdit; setContract: (c: ContractEdit) => void; open: (next: string, from?: string) => void;
  close: () => void; onTab: (t: CardTab) => void; go: (other: string) => void; jumpTo: (id: string) => void;
  pageActive: () => boolean; baseline: () => React.ReactNode;
}) {
  const { d, q, act, back, tab, documents, certsCount, actionsOpened, done, setDone, current, contract, setContract, open, close, onTab, go, jumpTo, pageActive, baseline } = props;
  const c = useCard(d);
  const quick = useQuick(c);
  const { e } = c;
  const today = todayKst();
  const unitPos = useQuery({ ...unitPositionQuery(e.id), enabled: Boolean(e.org_unit_id) });
  const pos = unitPos.data && unitPos.data.index > 0 ? unitPos.data : null;
  const own = useOwnRecord(e.id);
  const { mine, linked } = useLinkedAccount(e, c.users);
  const navigate = route.useNavigate();
  const recorded = (r: Done) => {
    if (!pageActive()) return;
    setDone(r);
    requestAnimationFrame(() => {
      if (!pageActive()) return;
      void navigate({ search: p => ({ ...p, act: undefined, back: undefined, tab: "events" }), replace: true });
      focusSoon(`ev-${r.eventId}`, "history");
    });
  };
  const m = buildCardMeta({ d, c, own, today, certsCount, documents, tab, act, jumpTo, onTab, go, open, pos, dismiss: quick.dismiss });
  const fix = (field: string) => open(field === "multi" ? "multi" : `fix:${field}`);
  const eligibleInvite = mine.isSuccess && !linked;

  return (
    <RecordPattern
      q={q}
      baseline={baseline}
      head={m.head}
      secNav={tab === "card" && c.manage ? <CardBar c={c} current={current} onJump={jumpTo} /> : undefined}
      notes={<CardConsoleNotes d={d} c={c} facts={m.facts} next={m.next} documents={documents} certsCount={certsCount} eligibleInvite={eligibleInvite} itemsCount={m.items.filter(i => i.state !== "CANCELLED").length} open={open} onTab={onTab} />}
      strip={tab === "card" && c.readable ? <RegisterStrip c={c} onJump={jumpTo} /> : undefined}
      sections={
        tab === "card" ? (
          c.readable ? (
            <>
              <SecPersonal c={c} quick={quick} onFix={fix} />
              <SecJob c={c} calm onFix={fix} onAct={open} onTab={() => onTab("events")} onContract={() => (setContract({ kind: "new" }), focusSoon("contracts"))} />
              <SecContract c={c} onAct={open} open={contract} onOpen={setContract} />
              <SecLeave c={c} act={act} />
              <SecRecords c={c} quick={quick} />
              <SecFamily c={c} />
              <SecRestricted c={c} />
              <SecDocs />
            </>
          ) : (
            <>
              <SecJob c={c} calm onFix={fix} onAct={open} onTab={() => onTab("events")} />
              <Gate icon={<Lock size={16} aria-hidden="true" />}>{t("empCard.reader.locked")}</Gate>
            </>
          )
        ) : (
          <CardTabs c={c} tab={tab} verbs={m.verbs} today={today} done={done} onAct={open} onDismiss={() => setDone(null)} />
        )
      }
      spine={tab === "card" ? <CardSpine c={c} onAct={open} onLedger={() => onTab("ledger")} onHistory={() => onTab("events")} /> : undefined}
      foot={<>{quick.toast}<PeopleJump /></>}
      overlays={actionsOpened ? <Suspense fallback={null}><CardActions c={c} act={act} back={back} onClose={close} onOpen={open} onRecorded={recorded} /></Suspense> : null}
      statusSegments={[
        { id: "person", tone: "strong", content: `${e.name} ${e.employee_number ?? ""}`.trim() },
        { id: "status", content: m.status.label },
        ...(pos ? [{ id: "pos", content: `${pos.index} / ${pos.total}` }] : []),
      ]}
    />
  );
}
