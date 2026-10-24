import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2, CalendarDays, ChevronLeft, ChevronRight, ChevronRight as Sep, FileText, MapPin, MoreHorizontal, MoveRight, Pencil, Printer, UserPlus, Users } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, LIFECYCLE_EVENT, label, labeled } from "../../../lib/labels";
import { focusSoon } from "../../../lib/react/announce";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Avatar } from "../../../ui/avatar/avatar";
import { Band } from "../../../ui/band/band";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { MenuButton, type MenuEntry } from "../../../ui/menu/menu-button";
import { FieldMark } from "../../../ui/record/field-row";
import { Kbd } from "../../../ui/record/record-section";
import { listPosition, serviceSpan } from "../domain/card";
import { verbStates } from "../domain/lifecycle";
import { retirementDate } from "../domain/employment";
import { whyText, plannedWhat } from "../present";
import { useOwnRecord } from "./use-case-actions";
import { unitListQuery } from "../api/record";
import { useLinkedAccount } from "./use-linked-account";
import { EndActions } from "./end-actions";
import { BindingReviewChip } from "./binding-evidence";
import { EmployeeWarnings } from "./employee-warnings";
import type { Card } from "./use-card";
import s from "./card.module.css";

export type CardTab = "card" | "events" | "docs" | "ledger" | "access";

const TABS: CardTab[] = ["card", "events", "docs", "ledger", "access"];

/**
 * The personnel card head (E2): where it sits in its unit's list (J/K), who (photo, name as written, Hanja, employee number with its two
 * verbs), status and type, the path company › workplace › department, the next dated fact, the verbs, then the tabs.
 */
export function CardHead({ c, onTab, onAct, onGo, onKeys }: { c: Card; onTab: (t: CardTab) => void; onAct: (act: string) => void; onGo: (id: string) => void; onKeys: (next?: () => void, prev?: () => void) => void }) {
  const { e, d } = c;
  const today = todayKst();
  const list = useQuery({ ...unitListQuery(e.org_unit_id ?? ""), enabled: Boolean(e.org_unit_id) });
  const rows = list.data?.items ?? [];
  const pos = listPosition(rows.map((r) => r.id), e.id);
  const nextId = pos?.next;
  const prevId = pos?.prev;
  useEffect(() => {
    onKeys(nextId ? () => onGo(nextId) : undefined, prevId ? () => onGo(prevId) : undefined);
  }, [nextId, prevId, onKeys, onGo]);
  const preHire = rows.filter((r) => r.status === "PRE_HIRE").length;
  const status = labeled(EMPLOYEE_STATUS, e.status ?? "UNKNOWN");
  const span = e.hire_date ? serviceSpan(e.hire_date, today) : null;
  const photo = c.personal.data?.photo?.url;
  const hanja = c.personal.data?.name_hanja;
  const items = c.events.data?.items ?? [];
  const verbs = c.manage && e.status !== "EXITED" ? verbStates(d, items) : [];
  // people-self-33: on one's own record each personnel action stays listed, refused with the platform rule (the server offers none).
  const own = useOwnRecord(e.id);
  const acts: MenuEntry[] = verbs.map((v) => ({
    id: v.verb,
    text: label(LIFECYCLE_EVENT, v.verb),
    label: t(`people.lifecycle.action.${v.verb}`),
    why: v.enabled ? undefined : own ? t("common.failed.code.own_record_forbidden") : whyText(v.why, [t(`people.lifecycle.action.${v.verb}`)]),
  }));
  const more: MenuEntry[] = [
    { id: "empno", text: t("empCard.more.empno"), label: t("empCard.more.empno") },
    { id: "identifiers", text: t("person.identifiers"), label: t("person.identifiers") },
    // Registration cancel is CRUD's sheet (`?act=cancel`): the server's end-options decide the setup delete or the governed void.
    { id: "cancel", text: t("empCard.more.void"), label: t("empCard.more.void") },
    { id: "exit.report", text: t("empCard.more.exit"), label: t("empCard.more.exit") },
  ];
  const k = d.classification;
  const facts = [c.title(k.grade_id) ?? e.position, c.title(k.position_kind_id), e.hire_date && t("empCard.hired", { date: fmtDate(e.hire_date) }), span && t("empCard.tenure", span)].filter(Boolean).join(" · ");
  const p = c.planned;
  // What the reservation does, in the words of the field it changes (duty title: foreman), else the act's name.
  const next = p
    ? { date: p.event_type === "TERMINATE" || p.event_type === "OFFBOARD" ? retirementDate(p.effective_date) : p.effective_date, what: plannedWhat(p, c.title), by: p.created_by_name && t("empCard.next.by", { who: p.created_by_name, date: fmtDateTime(p.created_at) }) }
    : e.next_event && { date: e.next_event.event_type === "TERMINATE" ? retirementDate(e.next_event.effective_date) : e.next_event.effective_date, what: label(LIFECYCLE_EVENT, e.next_event.event_type), by: null };
  return (
    <Band as="header" className={s.head}>
      <div className={s.top}>
        <span className={s.crumb}>
          <Users size={14} aria-hidden />
          <Link to="/people" search={{}}>{t("empCard.crumb")}</Link>
          <Sep size={14} aria-hidden />
          {e.org_unit ?? t("empCard.unplaced")}
        </span>
        <span className="grow" />
        {pos && (
          <span className={s.pos}>
            {t("empCard.pos.unit", { unit: e.org_unit ?? "" })} <b className={s.posAt}>{t("empCard.pos.at", { index: pos.index, total: pos.total })}</b>
            {preHire > 0 && <> {t("empCard.pos.preHire", { count: preHire })}</>}
          </span>
        )}
        <Button variant="ghost" aria-label={t("empCard.prev")} disabled={!pos?.prev} onClick={() => pos?.prev && onGo(pos.prev)}><ChevronLeft size={16} aria-hidden /></Button>
        <Button variant="ghost" aria-label={t("empCard.next")} disabled={!pos?.next} onClick={() => pos?.next && onGo(pos.next)}><ChevronRight size={16} aria-hidden /></Button>
        <span className={s.pos}><Kbd k="J" /><Kbd k="K" /> {t("empCard.walk")}</span>
      </div>
      <div className={s.hdr}>
        <Avatar size="lg" name={e.name} src={photo ?? undefined} alt={t("empCard.photo", { name: e.name })} fallbackAlt={t("empCard.photo.none")} />
        <div className={s.who}>
          <div className={s.nameRow}>
            <h1 id="person" className={s.name} tabIndex={-1}>{e.name}</h1>
            {hanja && <span className={s.hanja}>{hanja}</span>}
            <span className={s.empno}>{t("empCard.empno", { no: e.employee_number ?? t("empCard.empno.none") })}</span>
            {c.manage && <FieldMark kind="inline" field={t("empCard.empno.field")} text={t("empCard.empno.change")} name={t("empCard.empno.change")} onPress={() => onAct("empno")} />}
            {c.manage && <FieldMark kind="corTwo" field={t("empCard.empno.field")} onPress={() => onAct("fix:employee_number")} />}
            <Chip tone={status.tone}>{status.label}</Chip>
            {e.register_review_required && <Chip tone="warn">{t("roster.review.register")}</Chip>}
            {d.employment?.employment_type && <Chip>{label(EMPLOYMENT_TYPE, d.employment.employment_type)}</Chip>}
            {next && <Chip tone="info">{t("people.nextEvent.chip")}</Chip>}
            {c.manage ? <BindingReviewChip subjectId={e.id} required={e.identity_review_required} onOpen={() => onAct("identity")} /> : e.identity_review_required && <Chip tone="warn">{t("people.identityReview")}</Chip>}
          </div>
          <div className={s.path} role="group" aria-label={t("empCard.place")}>
            {/* The legal entity and the workplace are links (no dead end from a person to where they are employed and work). */}
            <Building2 className={s.pathIcon} size={14} aria-hidden />{e.legal_entity_id ? <Link to="/org/entities/$id" params={{ id: e.legal_entity_id }}>{c.place.entity}</Link> : c.place.entity}
            {c.place.workplace && (
              <>
                <Sep className={s.pathIcon} size={14} aria-hidden /><MapPin className={s.pathIcon} size={14} aria-hidden />
                {e.workplace_id && e.legal_entity_id ? <Link to="/org/entities/$id" params={{ id: e.legal_entity_id }} search={{ wp: e.workplace_id }}>{c.place.workplace}</Link> : c.place.workplace}
              </>
            )}
            {c.place.path.map((x, i) => <span key={x + i} className={s.path}><Sep className={s.pathIcon} size={14} aria-hidden />{i === c.place.path.length - 1 ? <b className={s.pathLast}>{x}</b> : x}</span>)}
            {facts && <span className={s.facts} title={facts}>{facts}</span>}
          </div>
          <div className={s.next} role="group" aria-label={t("empCard.next.label")}>
            <CalendarDays size={13} aria-hidden />
            {next ? <>{t("empCard.next.label")} <b className={s.nextWhat}>{t("empCard.next.what", { date: fmtDate(next.date), what: next.what })}</b>{next.by && <span>· {next.by}</span>}</> : t("empCard.next.none")}
            <span>· {t(c.setup ? "empCard.phase.setup" : "empCard.phase.op")}</span>
          </div>
        </div>
        {e.status === "EXITED" && (
          // Trunk's head said when the person left and led to the exit case: the card keeps both.
          <p className={s.readOnly}>
            {t("person.exited", { date: fmtDate(e.exit_date ? retirementDate(e.exit_date) : e.exit_date) })}
            <Button variant="ghost" onClick={() => (onTab("card"), focusSoon("exit"))}>{t("person.exit.open")}</Button>
          </p>
        )}
        {!c.manage && e.status !== "EXITED" && (
          <p className={s.readOnly}>
            {t(c.request ? "person.readOnly.request" : "person.readOnly")}
            {c.request && <Button onClick={() => onAct("request")}>{t("person.request")}</Button>}
          </p>
        )}
        {c.manage && (
          <div className={s.verbs} role="group" aria-label={t("empCard.verbs")}>
            {acts.length > 0 && <MenuButton primary label={t("empCard.verb.act")} icon={<MoveRight size={16} aria-hidden />} items={acts} onAction={onAct} />}
            <Button onClick={() => onAct("multi")}><Pencil size={16} aria-hidden /> {t("empCard.verb.correct")}</Button>
            <Button onClick={() => onAct("print")}><Printer size={16} aria-hidden /> {t("empCard.verb.print")}</Button>
            <Button onClick={() => onAct("cert")}><FileText size={16} aria-hidden /> {t("empCard.verb.cert")}</Button>
            <MenuButton label={t("empCard.verb.more")} icon={<MoreHorizontal size={16} aria-hidden />} caret={false} items={more} onAction={onAct} />
          </div>
        )}
        {(c.manage || c.users) && (
          // CRUD: exit and registration cancel where the person is (the server says which applies and why not the other); an account invite
          // for someone with none yet.
          <div className={`${s.verbs} ${s.ends}`} role="group" aria-label={t("person.record.actions")}>
            {c.manage && <EndActions id={e.id} onAct={onAct} onOpenCase={() => (onTab("card"), focusSoon("exit"))} />}
            {c.users && <span className={s.invite}><InviteEntry c={c} /></span>}
          </div>
        )}
      </div>
      <EmployeeWarnings warnings={d.warnings} />
      {/* The record's tabs are URLs (?tab=): route tabs, so Back returns to the tab and each one can be linked. */}
      <TabNav label={t("empCard.tabs")}>
        {TABS.map((x) => (
          // Active is this URL exactly: the other tabs' links keep the open sheet and differ only in `tab`.
          <Link key={x} to="/people/$id" params={{ id: e.id }} search={(prev) => ({ ...prev, tab: x === "card" ? undefined : x })} replace className={tabClass} activeOptions={{ exact: true, includeSearch: true }}>
            {t(`empCard.tab.${x}`)}
            {x === "events" && <TabCount>{items.filter((i) => i.state !== "CANCELLED").length}</TabCount>}
          </Link>
        ))}
      </TabNav>
    </Band>
  );
}

/** The account invite for a person with no sign-in account yet: the accounts view's invite sheet, this person already chosen. */
function InviteEntry({ c }: { c: Card }) {
  const navigate = useNavigate();
  const { mine, linked } = useLinkedAccount(c.e);
  const eligible = mine.isSuccess && !linked;
  return (
    <Button className={eligible ? undefined : s.hiddenInvite} disabled={!eligible} onClick={() => void navigate({ to: "/people", search: { view: "accounts", act: "invite", employee: c.e.id } })}>
      <UserPlus size={16} aria-hidden /> {t("people.account.invite")}
    </Button>
  );
}
