import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, Info, KeyRound, Lock } from "lucide-react";
import type { CloseReason, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { todayKst } from "../../../lib/pure/today";
import { closeGrantsQuery, endGrants, entityPeopleQuery } from "../../../reference/close/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { closeEntity, ENTITY_READS } from "../api";
import { closingGrants, endOps } from "../domain/close-grants";
import { entityName } from "../../../reference/entity/domain/names";
import { EntityExits, OpenEntityExits } from "./close-entity-exits";
import { CloseEntityStaff } from "./close-entity-staff";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * Closing an entity after going live (spec S3-close, MR-15; UX-R3 company-01/14): its reason first, then what must end before
 * it — the people still employed there, by name, each with what remains, and open departments — and the date stays locked
 * until they clear. The people are the live employees read, so the blocker leaves with the last exit (#27). Its open
 * workplaces, certificates and the grants scoped to it end with it; the confirm is the danger action that says so.
 */
export function CloseSheet({ e, depts, onClose }: { e: LegalEntity; depts: number; onClose: () => void }) {
  const today = todayKst();
  const [on, setOn] = useState("");
  const [reason, setReason] = useState<CloseReason | null>(null);
  const [exits, setExits] = useState(false);
  // Never shown from a cached read: a stale list would draw a blocker that a moment later goes (a layout shift).
  const staff = useQuery({ ...entityPeopleQuery(e.id), gcTime: 0 });
  const people = (staff.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }));
  // Until the read answers, nothing is claimed either way: the date waits, the confirm stays off.
  const known = staff.isSuccess;
  const count = people.length;
  const access = useQuery(closeGrantsQuery);
  const grants = closingGrants(access.data?.items ?? [], e.id, e.workplaces.map((w) => w.id));
  type Blocker = { key: string; title: string; why: string; fix: ReactNode; body?: ReactNode };
  const blockers = ([
    known && count > 0 && {
      key: "people",
      title: t("entityRecordClose.people", { count: fmtNumber(count) }),
      why: t("entityRecordClose.peopleWhy"),
      fix: <Button size="sm" aria-expanded={exits} onClick={() => setExits(true)}>{t("entityRecordClose.peopleFix")}</Button>,
      body: <CloseEntityStaff entityId={e.id} people={people} />,
    },
    depts > 0 && { key: "depts", title: t("entityRecordClose.depts", { count: depts }), why: t("entityRecordClose.deptsWhy"), fix: <Link to="/org" className={buttonClass("secondary", { size: "sm" })}>{t("entityRecordClose.deptsFix")}</Link> },
  ] as (Blocker | false)[]).filter((b): b is Blocker => b !== false);
  const open = e.workplaces.filter((w) => !w.closed_on).length;
  const certs = e.registrations.filter((r) => !r.closed_on).length;
  const ready = known && blockers.length === 0 && on !== "" && on <= today && reason !== null;
  const save = useCommand({
    run: async (_: undefined, key: string) => {
      const closed = await closeEntity(key, e.id, { closed_on: on, reason_code: reason! });
      if (grants.length === 0) return { closed, grants: undefined };
      // The grants end once the close is recorded; a refused or interrupted step leaves them for the access screen and says so.
      const out = await endGrants({ operations: endOps(grants), reason_code: "ACCESS_CLEANUP", reason_note: t("entityRecordClose.title") }).catch(() => "refused" as const);
      return { closed, grants: out };
    },
    invalidates: [...ENTITY_READS, "/api/v1/access"],
    announce: (r) => [t("entityRecordClose.done", { name: entityName(e) }), r.grants && t(r.grants === "done" ? "entityRecordClose.grantsDone" : "entityRecordClose.grantsLeft", { count: grants.length })].filter(Boolean).join(" · "),
    onSuccess: onClose,
  });
  return (
    <Sheet
      open
      onClose={onClose}
      pending={save.isPending}
      title={t("entityRecordClose.title")}
      subtitle={entityName(e)}
      notice={<EntityError error={save.error} />}
      consequence={
        !known ? t("entityRecordClose.checking")
        : blockers.length ? t("entityRecordClose.blockedFoot", { count: blockers.length })
        : ready ? t("entityRecordClose.consequence", { date: fmtDate(on), workplaces: open, certs })
        : t("entityRecordClose.pick")
      }
      actions={
        <>
          <Button onClick={onClose}>{t("entityRecordClose.cancel")}</Button>
          <Button variant="danger" aria-disabled={!ready || undefined} disabled={save.isPending} onClick={() => ready && save.mutate(undefined)}>{t("entityRecordClose.save")}</Button>
        </>
      }
    >
      {/* Drawn once the people read answers, so a blocker never appears (or goes) under the user's pointer. */}
      {!known ? <p className="muted" aria-busy>{t("entityRecordClose.checking")}</p> : <>
      <ChoiceField
        label={t("entityRecordClose.reason")}
        required
        options={[{ value: "DISSOLVED", label: t("entityRecordClose.dissolved") }, { value: "BUSINESS_CLOSED", label: t("entityRecordClose.businessClosed") }]}
        value={reason}
        onChange={(r) => setReason(r as CloseReason)}
      />
      {blockers.length > 0 && (
        <section aria-labelledby="blockers-title">
          <h3 id="blockers-title" className={s.subhead}>{t("entityRecordClose.first", { count: blockers.length })}</h3>
          <div className={s.blockers}>
            <p className={s.blockersHead}>{t("entityRecordClose.firstWhy", { count: blockers.length })}</p>
            {blockers.map((b) => (
              <div key={b.key} className={s.blocker}>
                <Ban size={18} aria-hidden className={s.ban} />
                <div><b>{b.title}</b><Muted>{b.why}</Muted>{b.body}</div>
                {b.fix}
              </div>
            ))}
          </div>
          {exits && <EntityExits entityId={e.id} count={count} />}
        </section>
      )}
      <OpenEntityExits entityId={e.id} />
      <section aria-labelledby="after-title">
        <h3 id="after-title" className={s.subhead}>{t("entityRecordClose.after")}</h3>
        {blockers.length ? (
          <p className={s.lockedInput}><span>{t("entityRecordClose.dateLocked", { count: blockers.length })}</span><Lock size={16} aria-hidden /></p>
        ) : (
          <DateField label={t("entityRecordClose.date")} required value={on} onChange={setOn} today={today} max={today} />
        )}
        <p className={s.note}><Info size={14} aria-hidden /> {t("entityRecordClose.effects", { workplaces: open, certs })}</p>
        {grants.length > 0 && <p className={s.note}><KeyRound size={14} aria-hidden /> {t("entityRecordClose.grants", { count: grants.length })}</p>}
      </section>
      <p className="notice">{t("entityRecordClose.whyNotDelete")}</p>
      </>}
    </Sheet>
  );
}
