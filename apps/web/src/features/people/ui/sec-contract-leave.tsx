import { EnumValue } from "../../../ui/enum-value";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LEAVE_TYPE } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { RecordSection, SectionLine } from "../../../ui/record/record-section";
import { RecordRows } from "../../../ui/record/rows";
import { ExitCases } from "../ExitCase";
import { contractsQuery, type LifecycleEvent } from "../api";
import { ContractsCard, type ContractEdit } from "./contracts-card";
import type { Card } from "./use-card";
import s from "./card.module.css";

/**
 * 3 contract (E2): the contract history (newest first, the row in force marked; a correction is a new row and the
 * corrected one stays on request), then the renewal, which is a dated action. The onboarding checklist opens its form.
 */
export function SecContract({ c, onAct, open, onOpen }: { c: Card; onAct: (act: string) => void; open: ContractEdit; onOpen: (edit: ContractEdit) => void }) {
  const live = useQuery({ ...contractsQuery(c.e.id), enabled: c.manage, retry: false }).data?.items.filter((x) => !x.superseded_by).length ?? 0;
  return (
    <RecordSection id="s3" no={3} title={t("empCard.sec.contract")}>
      <div data-embed><ContractsCard e={c.e} open={open} onOpen={onOpen} /></div>
      <SectionLine>
        {c.manage && live > 0 && <Button variant="ghost" onClick={() => onAct("CONTRACT_RENEWAL")}><Plus size={14} aria-hidden /> {t("empCard.contract.renew")}</Button>}
      </SectionLine>
    </RecordSection>
  );
}

/** 4 leave and exit (E2): leave periods from the personnel action record, then dismissal and exit and the exit case (exit starts there). */
export function SecLeave({ c, act }: { c: Card; act?: string }) {
  const items = c.events.data?.items ?? [];
  const leaves = items.filter((x) => x.event_type === "LEAVE_OF_ABSENCE" && x.state !== "CANCELLED");
  const back = (x: LifecycleEvent) => items.find((y) => y.event_type === "RETURN_FROM_LEAVE" && y.state !== "CANCELLED" && y.effective_date >= x.effective_date);
  return (
    <RecordSection id="s4" no={4} title={t("empCard.sec.leave")}>
      {leaves.length > 0 && (
        <RecordRows
          label={t("empCard.sec.leave")}
          rows={leaves}
          rowId={(x) => x.id}
          columns={[
            { header: t("empCard.leave.kind"), cell: () => <b>{t("empCard.leave.leave")}</b> },
            { header: t("empCard.leave.from"), cell: (x) => <span className={s.num}>{fmtDate(x.effective_date)}{x.expected_return_date && ` ~ ${fmtDate(x.expected_return_date)}`}</span> },
            { header: t("empCard.leave.reason"), cell: (x) => (x.leave_type ? <EnumValue e={LEAVE_TYPE} value={x.leave_type} /> : "—") },
            { header: t("empCard.leave.back"), cell: (x) => { const r = back(x); return r ? t("empCard.leave.returned", { date: fmtDate(r.effective_date) }) : t("empCard.leave.out"); } },
          ]}
        />
      )}
      {/* Trunk's personal card showed the leave balance once the server sends one: kept here. */}
      {c.e.leave_remaining != null && <SectionLine><span>{t("people.field.leave")} · {t("people.field.leaveLeft", { days: c.e.leave_remaining })}</span></SectionLine>}
      {c.e.status === "EXITED" && <SectionLine>{t("empCard.leave.exited", { date: fmtDate(c.e.exit_date) })}</SectionLine>}
      <ExitCases employee={c.e} act={act} />
    </RecordSection>
  );
}
