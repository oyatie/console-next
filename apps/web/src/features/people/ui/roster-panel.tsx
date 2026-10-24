import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2, X } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtKrw } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Kbd } from "../../../ui/record/record-section";
import { MenuButton, type MenuEntry } from "../../../ui/menu/menu-button";
import { employeeQuery } from "../api";
import { maskedAddress, maskedBirth, type RegisterItem } from "../domain/card";
import { daysBetween, offeredVerbs } from "../domain/roster";
import { retirementDate } from "../domain/employment";
import { EndActions } from "./end-actions";
import { useCardRegister } from "./use-card-register";
import { ExitPeek } from "./exit-peek";
import { StatusChip } from "./roster-table";
import { useCard } from "./use-card";
import { Avatar } from "../../../ui/avatar/avatar";
import { Banner } from "../../../ui/banner/banner";
import s from "./roster.module.css";
import { plannedWhat, relDays } from "../present";

type Detail = components["schemas"]["EmployeeDetail"];

/**
 * The peek beside the roster (E1-peek): where the person sits, who, the next dated fact, the register items said as
 * present or missing (values masked: a peek never reveals), and the ways on: the record (Enter) and the actions the
 * server offers now. Read only; J/K follow the list, Esc closes.
 */
export function RosterPanel({ id, today, onClose }: { id: string; today: string; onClose: () => void }) {
  const detail = useQuery(employeeQuery(id));
  return (
    <aside className={`card ${s.peek}`} aria-label={t("people.panel")}>
      <QueryState q={detail}>{(d) => <Peek d={d} today={today} onClose={onClose} />}</QueryState>
    </aside>
  );
}

function Peek({ d, today, onClose }: { d: Detail; today: string; onClose: () => void }) {
  const c = useCard(d);
  const navigate = useNavigate();
  const e = d.employee;
  const r = c.register.data;
  const { items, gaps, value } = useCardRegister(c);
  const verbs = offeredVerbs(d);
  const m = d.employment ?? d.pending_employment;
  const end = m?.contract_end_date ?? e.contract_end_date;
  const p = c.planned;
  const next = p ? { date: p.event_type === "TERMINATE" || p.event_type === "OFFBOARD" ? retirementDate(p.effective_date) : p.effective_date, what: plannedWhat(p, c.title) } : e.next_event && { date: e.next_event.event_type === "TERMINATE" ? retirementDate(e.next_event.effective_date) : e.next_event.effective_date, what: label(LIFECYCLE_EVENT, e.next_event.event_type) };
  const sub = [c.title(d.classification.grade_id) ?? e.position, d.employment?.employment_type && label(EMPLOYMENT_TYPE, d.employment.employment_type), e.hire_date && t("empCard.hired", { date: fmtDate(e.hire_date) })].filter(Boolean).join(" · ");
  // A peek shows what each register item holds without revealing: birth date and address stay masked.
  const shown = (i: RegisterItem) => (!i.present ? value(i) : i.key === "birth" ? maskedBirth() : i.key === "address" && r?.address ? maskedAddress(r.address) : value(i));
  const acts: MenuEntry[] = verbs.map((v) => ({ id: v, text: t(`people.lifecycle.action.${v}`), label: t(`people.lifecycle.action.${v}`) }));
  return (
    <>
      <div className={s.peekCrumb}><Building2 size={13} aria-hidden /> {[c.place.entity, c.place.workplace, ...c.place.path].filter(Boolean).join(" › ")}</div>
      <div className={s.peekHead}>
        <Avatar name={e.name} />
        <div className="grow">
          <h2 className={s.peekName}>{e.name} <span className="code">{e.employee_number ?? t("people.number.none")}</span></h2>
          <span className={s.peekSub}>{sub}</span>
        </div>
        <StatusChip status={e.status} />
        <Button variant="ghost" onClick={onClose} aria-label={t("roster.panel.close")}><X size={16} aria-hidden /></Button>
      </div>
      <div className="row">
        <Link className="btn btn--primary" to="/people/$id" params={{ id: e.id }}>{t("people.panel.open")} <Kbd k="Enter" /></Link>
        {acts.length > 0 && (
          // One act the server offers is one press; several sit behind the action menu as on the card.
          <nav aria-label={t("people.lifecycle.actions")}>
            {acts.length === 1
              ? <Link className="btn" to="/people/$id" params={{ id: e.id }} search={{ act: acts[0]!.id }}>{acts[0]!.text}</Link>
              : <MenuButton label={t("empCard.verb.act")} items={acts} onAction={(v) => void navigate({ to: "/people/$id", params: { id: e.id }, search: { act: v } })} />}
          </nav>
        )}
        {e.identity_review_required && <Chip tone="warn">{t("people.identityReview")}</Chip>}
      </div>
      {e.status === "EXITED" && e.exit_date && <ExitPeek id={e.id} exitDate={e.exit_date} today={today} />}
      {next && (
        <Banner tone="warn" title={t("roster.peek.next", { days: daysBetween(today, next.date) })}>{t("empCard.next.what", { date: fmtDate(next.date), what: next.what })}</Banner>
      )}
      {/* Trunk's panel rows the peek keeps (job, home branch, contract end, base pay, leave): read with the person, so they land with it. */}
      <dl className={s.peekItems}>
        <div><dt className={s.peekTerm}>{t("people.field.jobPosition")}</dt><dd>{[e.job, e.position].filter(Boolean).join(" · ") || "—"}</dd></div>
        <div><dt className={s.peekTerm}>{t("people.field.homeBranch")}</dt><dd>{e.home_branch_name ?? (e.home_branch_review_required ? <Chip tone="warn">{t("roster.panel.noBranch")}</Chip> : "—")}</dd></div>
        {end && <div><dt className={s.peekTerm}>{t("people.field.contractEnd")}</dt><dd className="num">{fmtDate(end)}{e.status !== "EXITED" && <> · {relDays(daysBetween(today, end))}</>}</dd></div>}
        <div><dt className={s.peekTerm}>{t("people.field.basePay")}</dt><dd className="num">{!m ? t("format.notComputable") : m.base_pay === undefined ? t("people.field.restricted") : fmtKrw(m.base_pay)}</dd></div>
        {e.leave_remaining != null && <div><dt className={s.peekTerm}>{t("people.field.leave")}</dt><dd className="num">{t("people.field.leaveLeft", { days: e.leave_remaining })}</dd></div>}
      </dl>
      {c.manage && (
        <section aria-labelledby="peek-register">
          <h3 id="peek-register" className={s.peekTitle}>
            {t("empCard.reg.title")}
            <span className={gaps ? s.peekGap : s.peekOk}>{c.register.isPending ? t("common.loading") : gaps ? t("roster.peek.gaps", { count: gaps }) : t("roster.peek.whole")}</span>
          </h3>
          <dl className={s.peekItems}>
            {items.map((i) => (
              <div key={i.key}>
                <dt className={s.peekTerm}>{t("roster.peek.item", { no: i.no, item: t(`empCard.reg.item.${i.key}`) })}</dt>
                <dd>{c.register.isPending ? "…" : shown(i)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {/* CRUD: exit and registration cancel from the roster's peek, each opening on the record. */}
      <nav className="row" aria-label={t("crud.person.ends")}><EndActions id={e.id} /></nav>
    </>
  );
}
