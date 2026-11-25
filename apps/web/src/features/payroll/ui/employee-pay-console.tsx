// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import type { ReadState } from "../../../lib/react/query-view";
import { Button, Form } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { DateInput } from "../../../ui/date/date-input";
import { EmptyState } from "../../../ui/empty-state";
import { Field, FieldSet } from "../../../ui/field/field";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
import { RecordPattern } from "../../../ui/patterns/record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordSection } from "../../../ui/record/record-section";
import { SecNav } from "../../../ui/record/sec-nav";
import { payslipDraftQuery } from "../api";
import {
  blockerText,
  contractCited,
  draftBlockers,
  instrumentCited,
  type PayslipDraft,
} from "../present";
import { ContractWageForm } from "./contract-wage-form";
import { EmployeePayDeductionsSection, SourceConsole } from "./employee-pay-console-parts";
import s from "./payroll-console.module.css";

const route = getRouteApi("/app/payroll/employees/$employeeId");
const won = (amount: number) => t("payroll.employee.won", { amount: fmtNumber(amount) });
const IDLE_READ: ReadState<true> = { isPending: false, error: null, data: true, refetch: () => undefined };

export function EmployeePayConsole({ baseline }: { baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <EmployeePayConsoleContent baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function EmployeePayConsoleContent({ baseline }: { baseline: () => ReactNode }) {
  const { employeeId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [period, setPeriod] = useState(search.period ?? "");
  const [payDate, setPayDate] = useState(search.pay_date ?? "");
  const [recordOpen, setRecordOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("emp-pay-contract");

  const hasQuery = Boolean(search.period && search.pay_date);
  const draft = useQuery({
    ...payslipDraftQuery(employeeId, search.period ?? "", search.pay_date ?? ""),
    enabled: hasQuery,
  });

  const data: PayslipDraft | undefined = hasQuery ? draft.data : undefined;
  const contract = data?.contract;
  const blockers = data ? draftBlockers(data) : [];
  const minimum = data?.minimum_wage_check;
  const minimumCited = Boolean(minimum && instrumentCited(minimum.instrument));
  const earningsCited = Boolean(
    data &&
      contractCited(contract ?? null) &&
      data.earnings?.length &&
      data.earnings.every(row => row.code === "BASE_PAY" && Number.isSafeInteger(row.amount_won)),
  );
  const amount = (value: number | null | undefined, sourced: boolean) =>
    sourced && Number.isSafeInteger(value) ? won(value!) : t("payroll.reference.held");

  const filterForm = (
    <Form
      className={s.filterRow}
      aria-label={t("payroll.employee.preview")}
      onSubmit={() => void navigate({ search: { period: period || todayKst().slice(0, 7), pay_date: payDate } })}
    >
      <FieldSet label={t("payroll.period")} required>
        <PeriodStepper
          unit="month"
          variant="boxed"
          showCurrent={false}
          label={t("payroll.period")}
          value={period || todayKst().slice(0, 7)}
          onChange={setPeriod}
        />
      </FieldSet>
      <Field label={t("payroll.setup.day")} required>
        {control => <DateInput {...control} value={payDate} onChange={setPayDate} />}
      </Field>
      <Button type="submit" size="sm" variant="primary" className={s.nowrap}>
        {t("payroll.employee.preview")}
      </Button>
    </Form>
  );

  const navSections = data
    ? [
        { id: "emp-pay-contract", no: 1, title: t("payroll.employee.contract") },
        ...(data.earnings ? [{ id: "emp-pay-earnings", no: 2, title: t("payroll.employee.earnings") }] : []),
        ...(minimum ? [{ id: "emp-pay-minwage", no: 3, title: t("payroll.employee.minimumWage") }] : []),
        { id: "emp-pay-deductions", no: 4, title: t("payroll.employee.deductions") },
      ]
    : undefined;

  const strip = data ? (
    <StatRow
      label={data.employee_name}
      items={[
        { key: "name", label: t("payroll.run.col.name"), value: data.employee_name },
        {
          key: "period",
          label: t("payroll.period"),
          value: `${fmtDate(data.period.start)} – ${fmtDate(data.period.end)}`,
        },
        { key: "payDate", label: t("payroll.setup.day"), value: fmtDate(data.pay_date) },
        {
          key: "gross",
          label: t("payroll.employee.gross"),
          value: amount(data.gross_won, earningsCited),
        },
        {
          key: "status",
          label: t("payroll.employee.net"),
          value: t("payroll.employee.incomplete"),
          tone: "warn",
        },
      ]}
    />
  ) : undefined;

  const sections = !hasQuery ? (
    <EmptyState title={t("payroll.employee.pick")} reason={t("payroll.employee.pickReason")} />
  ) : data ? (
    <div className={s.sectionStack}>
      {blockers.length > 0 ? (
        <RecordSection
          id="emp-pay-blockers"
          title={t("payroll.employee.blockers")}
          tools={<Chip tone="warn">{t("payroll.employee.incomplete")}</Chip>}
        >
          <ul className={`list-plain ${s.blockerList}`} aria-label={t("payroll.employee.blockers")}>
            {blockers.map(code => (
              <li key={code}>
                <bdi>{blockerText(code)}</bdi>
                {(code === "MINIMUM_WAGE_BELOW_FLOOR" || code === "MINIMUM_WAGE_NOT_COMPARABLE") && minimum ? (
                  <SourceConsole instrument={minimum.instrument} />
                ) : null}
              </li>
            ))}
          </ul>
        </RecordSection>
      ) : null}

      <RecordSection
        id="emp-pay-contract"
        title={t("payroll.employee.contract")}
        tools={
          !recordOpen ? (
            <Button size="sm" variant="secondary" className={s.nowrap} onClick={() => setRecordOpen(true)}>
              {t("payroll.employee.record")}
            </Button>
          ) : undefined
        }
      >
        <div className={s.sectionStack}>
          {contract ? (
            <KeyValue
              readOnly
              items={[
                { key: "kind", label: t("payroll.employee.kind"), value: t(`payroll.rule.${contract.wage_kind}`) },
                {
                  key: "amount",
                  label: t("payroll.employee.amount"),
                  value: contractCited(contract) ? won(contract.amount_won) : t("payroll.reference.held"),
                },
                {
                  key: "source",
                  label: t("payroll.employee.source"),
                  value: contract.source_note || t("payroll.reference.held"),
                },
                { key: "effective", label: t("payroll.employee.effective"), value: fmtDate(contract.effective_from) },
              ]}
            />
          ) : (
            <EmptyState
              compact
              title={t("payroll.employee.noContract")}
              reason={t("payroll.employee.noContractReason")}
            />
          )}
          {recordOpen ? <ContractWageForm employeeId={employeeId} onClose={() => setRecordOpen(false)} /> : null}
        </div>
      </RecordSection>

      {data.earnings ? (
        <RecordSection id="emp-pay-earnings" title={t("payroll.employee.earnings")}>
          <KeyValue
            readOnly
            items={[
              ...data.earnings.flatMap(row => [
                { key: row.code, label: row.label_ko, value: amount(row.amount_won, earningsCited) },
                { key: `${row.code}:basis`, label: t("payroll.employee.earningsNote"), value: row.note_ko },
              ]),
              { key: "gross", label: t("payroll.employee.gross"), value: amount(data.gross_won, earningsCited) },
              {
                key: "source",
                label: t("payroll.employee.source"),
                value: contractCited(contract ?? null) ? contract!.source_note : t("payroll.reference.held"),
              },
            ]}
          />
        </RecordSection>
      ) : null}

      {minimum ? (
        <RecordSection
          id="emp-pay-minwage"
          title={t("payroll.employee.minimumWage")}
          tools={
            <Chip tone={!minimumCited || minimum.passes === null ? "warn" : minimum.passes ? "ok" : "danger"}>
              {!minimumCited
                ? t("payroll.reference.held")
                : minimum.passes === null
                  ? t("payroll.employee.minimumIncomparable")
                  : minimum.passes
                    ? t("payroll.employee.minimumPass")
                    : t("payroll.employee.minimumBelow")}
            </Chip>
          }
        >
          <div className={s.sectionStack}>
            <KeyValue
              readOnly
              items={[
                { key: "floor", label: t("payroll.employee.hourlyFloor"), value: amount(minimum.hourly_floor_won, minimumCited) },
                {
                  key: "monthlyFloor",
                  label: t("payroll.employee.monthlyFloor"),
                  value: amount(minimum.monthly_209h_floor_won, minimumCited),
                },
                {
                  key: "hourly",
                  label: t("payroll.employee.effectiveHourly"),
                  value:
                    minimum.effective_hourly_won === null
                      ? t("payroll.employee.unavailable")
                      : amount(minimum.effective_hourly_won, minimumCited),
                },
              ]}
            />
            <SourceConsole instrument={minimum.instrument} />
          </div>
        </RecordSection>
      ) : null}

      <EmployeePayDeductionsSection data={data} earningsCited={earningsCited} amount={amount} />

      {data.not_computed?.map(row => (
        <RecordSection
          key={row.code}
          id={`emp-pay-nc-${row.code}`}
          title={row.label_ko}
          tools={<Chip>{t("payroll.employee.notComputed")}</Chip>}
        >
          <SourceConsole instrument={row.instrument} provenance={row.reason_ko} />
        </RecordSection>
      ))}
    </div>
  ) : null;

  return (
    <RecordPattern
      q={hasQuery ? draft : IDLE_READ}
      // A refused draft still names whose pay it was: the way back is that person's card, not home.
      back={{ to: "/people", search: { sel: employeeId }, label: t("payroll.employee.person") }}
      head={{
        title: t("payroll.employee.title"),
        titleId: "employee-pay-title",
        filters: filterForm,
        actions: (
          <Link
            to="/people"
            search={{ sel: employeeId }}
            className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
          >
            {t("payroll.employee.person")}
          </Link>
        ),
      }}
      secNav={
        navSections ? (
          <SecNav
            items={navSections}
            current={activeSection}
            onJump={(id) => {
              setActiveSection(id);
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        ) : undefined
      }
      strip={strip}
      sections={sections}
      statusSegments={
        data
          ? [
              { id: "employee", tone: "strong", content: data.employee_name },
              { id: "period", content: `${fmtDate(data.period.start)} – ${fmtDate(data.period.end)}` },
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
