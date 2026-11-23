// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import type { components, paths } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtKrw } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { serviceSpan } from "../domain/card";
import { FieldValue } from "./field-value";
import { RrnValue } from "./rrn-value";
import type { Card } from "./use-card";
import s from "./roster.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type CardData = Pick<Card, "readable" | "register" | "personal">;
type AttMonth = paths["/api/v1/attendance/people/{employee_id}/month"]["get"]["responses"]["200"]["content"]["application/json"];
type PayDraft = paths["/api/v1/payroll/employees/{employeeId}/payslip-draft"]["get"]["responses"]["200"]["content"]["application/json"];
type PanelItem = { key: string; label: string; value: ReactNode };

const SEX_LABEL = { MALE: "empCard.sex.MALE", FEMALE: "empCard.sex.FEMALE" } as const;
const MID_DOT = " · ";
const DASH = "—";

export function buildPanelBasicItems(opts: {
  e: Detail["employee"];
  c: CardData;
  who: string;
  today: string;
  gradeRole: string;
  phone?: string | null;
  rrnRecorded?: boolean;
  rrnMasked?: string | null;
}) {
  const { e, c, who, today, gradeRole, phone, rrnRecorded, rrnMasked } = opts;
  const span = e.hire_date ? serviceSpan(e.hire_date, today) : null;
  const r = c.register.data;
  const p = c.personal.data;

  const employmentItems: PanelItem[] = [
    {
      key: "hire",
      label: t("people.col.hired"),
      value: e.hire_date ? (
        <bdi className="num">
          <strong>{e.hire_date}</strong>
          {span ? <bdi className="muted">{MID_DOT}{t("people.panel.tenure", span)}</bdi> : null}
        </bdi>
      ) : (
        DASH
      ),
    },
    ...(gradeRole ? [{ key: "gradeRole", label: t("people.field.jobPosition"), value: gradeRole }] : []),
    ...(e.worksite_name ? [{ key: "workPattern", label: t("people.panel.workPattern"), value: e.worksite_name }] : []),
  ];

  const personalItems: PanelItem[] = [
    ...(rrnRecorded && rrnMasked ? [{ key: "rrn", label: t("empCard.f.rrn"), value: <RrnValue employeeId={e.id} who={who} masked={rrnMasked} /> }] : []),
    ...(phone ? [{ key: "phone", label: t("empCard.f.phone"), value: <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="PHONE" masked={phone} field={t("empCard.f.phone")} who={who} /> }] : []),
    ...(r?.address
      ? [
          {
            key: "address",
            label: t("empCard.f.address"),
            value: (
              <div className={s.peekInlineRow}>
                <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="ADDRESS" masked={r.address} field={t("empCard.f.address")} who={who} />
                {e.register_review_required ? (
                  <Chip tone="warn">
                    <Clock size={11} aria-hidden="true" />
                    {t("roster.review.register")}
                  </Chip>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    ...(p?.nationality || r?.sex ? [{ key: "natSex", label: t("empCard.f.nationality"), value: [p?.nationality, r?.sex ? t(SEX_LABEL[r.sex]) : null].filter(Boolean).join(MID_DOT) }] : []),
  ];

  const insuranceItems: PanelItem[] = e.hire_date
    ? [
        { key: "np", label: t("people.panel.ins.pension"), value: <bdi className="num">{t("people.panel.ins.enrolled")}{MID_DOT}{e.hire_date}</bdi> },
        { key: "hi", label: t("people.panel.ins.health"), value: <bdi className="num">{t("people.panel.ins.enrolled")}{MID_DOT}{e.hire_date}</bdi> },
        { key: "ei", label: t("people.panel.ins.employment"), value: <bdi className="num">{t("people.panel.ins.enrolled")}{MID_DOT}{e.hire_date}</bdi> },
        { key: "wc", label: t("people.panel.ins.industrial"), value: <bdi className="num">{t("people.panel.ins.covered")}{MID_DOT}{e.hire_date}</bdi> },
      ]
    : [];

  return { employmentItems, personalItems, insuranceItems };
}

export function buildPanelSummaryItems(opts: {
  e: Detail["employee"];
  month: string;
  monthNum: number;
  payDate: string;
  attMonth?: AttMonth;
  payDraft?: PayDraft;
}) {
  const { e, month, monthNum, payDate, attMonth, payDraft } = opts;
  const summaryItems: { key: string; label: ReactNode; value: ReactNode }[] = [];
  if (attMonth) {
    const workedDays = attMonth.days.filter(day => day.recognition.recognised > 0).length;
    const absentDays = attMonth.days.filter(day => day.marks.includes("ABSENT")).length;
    const approvedOtHours = Math.round((attMonth.totals.approved / 60) * 10) / 10;
    summaryItems.push({
      key: "att",
      label: <Link to="/attendance" search={{}}>{t("people.panel.summary.monthAtt", { month: monthNum })}</Link>,
      value: t("people.panel.summary.attDetail", { work: workedDays, leave: absentDays, ot: approvedOtHours }),
    });
  }
  if (e.leave_remaining != null) {
    summaryItems.push({
      key: "leave",
      label: <Link to="/people/$id" params={{ id: e.id }} search={{}}>{t("people.field.leave")}</Link>,
      value: t("people.field.leaveLeft", { days: e.leave_remaining }),
    });
  }
  if (payDraft && payDraft.gross_won != null) {
    const gross = payDraft.gross_won;
    const ded = payDraft.total_employee_insurance_won ?? 0;
    const net = payDraft.remainder_after_insurance_won ?? gross - ded;
    summaryItems.push({
      key: "pay",
      label: (
        <Link to="/payroll/employees/$employeeId" params={{ employeeId: e.id }} search={{ period: month, pay_date: payDate }}>
          {t("people.panel.summary.monthPay", { month: monthNum })}
        </Link>
      ),
      value: t("people.panel.summary.payDetail", { net: fmtKrw(String(net)), gross: fmtKrw(String(gross)), ded: fmtKrw(String(ded)) }),
    });
  }
  return summaryItems;
}
