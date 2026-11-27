// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordSection } from "../../../ui/record/record-section";
import { StepLine } from "../../../ui/step-line/step-line";
import {
  createPayrollRun,
  payGroupSchemas,
  payGroupsQuery,
  payrollRunPreviewQuery,
  type CreatePayrollRun,
} from "../api";
import { payDateRule, periodRule } from "../present";
import s from "./payroll-console.module.css";

const kinds = payGroupSchemas.PayrollRunKind.enum.filter(kind => kind === "REGULAR");
const refusal = (code: string) =>
  ({
    payroll_preview_changed: t("payroll.create.refuse.payroll_preview_changed"),
    regular_run_exists: t("payroll.create.refuse.regular_run_exists"),
    forbidden: t("payroll.create.refuse.forbidden"),
    run_kind_unsupported: t("payroll.create.refuse.run_kind_unsupported"),
    phase_not_operating: t("payroll.create.refuse.phase_not_operating"),
  })[code];

export function PayrollRunCreateConsole({ baseline }: { baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <PayrollRunCreateConsoleContent baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function PayrollRunCreateConsoleContent({ baseline }: { baseline: () => ReactNode }) {
  const groups = useQuery(payGroupsQuery);
  const navigate = useNavigate();
  const [payGroupId, setPayGroupId] = useState<string | null>(null);
  const [kind, setKind] = useState<CreatePayrollRun["kind"] | null>(null);
  const input: CreatePayrollRun | null = payGroupId && kind ? { pay_group_id: payGroupId, kind } : null;

  const preview = useQuery({
    ...(input ? payrollRunPreviewQuery(input) : payrollRunPreviewQuery({ pay_group_id: "", kind: "REGULAR" })),
    enabled: Boolean(input),
    retry: false,
  });

  const create = useCommand({
    run: createPayrollRun,
    invalidates: ["/api/v1/payroll/runs"],
    announce: () => t("payroll.create.saved"),
    onSuccess: run => navigate({ to: "/payroll/runs/$id", params: { id: run.id } }),
  });

  const canSubmit = input && preview.isSuccess && preview.fetchStatus === "idle" && !preview.isPlaceholderData && !create.isPending;
  const items = groups.data?.items ?? [];
  const entities = groups.data?.legal_entities ?? [];
  const selectedGroup = items.find(g => g.id === payGroupId);

  const body =
    items.length === 0 ? (
      <EmptyState
        title={t("payroll.create.noGroups")}
        reason={t("payroll.create.noGroupsReason")}
        actions={
          <Link to="/payroll/setup" className={buttonClass("primary", { size: "sm", className: s.nowrap })}>
            {t("payroll.setup.add")}
          </Link>
        }
      />
    ) : (
      <div className={s.sectionStack}>
        <RecordSection id="run-create-select" title={t("payroll.group")}>
          <div className={s.sectionStack}>
            <ChoiceField
              label={t("payroll.group")}
              required
              columns={2}
              options={items.map(group => ({
                value: group.id,
                label: group.name,
                description: `${entities.find(entity => entity.id === group.legal_entity_id)?.name ?? t("payroll.entityUnnamed")} · ${payDateRule(group.pay_date_rule)}`,
              }))}
              value={payGroupId}
              onChange={setPayGroupId}
            />
            <ChoiceField
              label={t("payroll.create.kind")}
              required
              options={kinds.map(value => ({ value, label: t(`payroll.create.kind.${value}`) }))}
              value={kind}
              onChange={value => setKind(value as CreatePayrollRun["kind"])}
            />
          </div>
        </RecordSection>

        {input ? (
          <RecordSection id="run-create-preview" title={t("payroll.create.preview")}>
            <QueryState q={preview} layout="form">
              {facts => (
                <KeyValue
                  readOnly
                  label={t("payroll.create.preview")}
                  items={[
                    { key: "month", label: t("payroll.create.month"), value: facts.attribution_month },
                    { key: "payDate", label: t("payroll.create.payDate"), value: fmtDate(facts.pay_date) },
                    {
                      key: "base",
                      label: t("payroll.basePeriod"),
                      value: `${fmtDate(facts.period_start)} – ${fmtDate(facts.period_end)}`,
                    },
                    {
                      key: "variable",
                      label: t("payroll.variablePeriod"),
                      value: `${fmtDate(facts.variable_period_start)} – ${fmtDate(facts.variable_period_end)}`,
                    },
                    ...(facts.attendance_cutoff_date
                      ? [{ key: "cutoff", label: t("payroll.cutoffDate"), value: fmtDate(facts.attendance_cutoff_date) }]
                      : []),
                  ]}
                />
              )}
            </QueryState>
          </RecordSection>
        ) : null}
      </div>
    );

  const aside = selectedGroup ? (
    <RecordSection id="run-create-rules" title={t("payroll.home.rulesTitle")}>
      <KeyValue
        readOnly
        items={[
          { key: "payDateRule", label: t("payroll.payDateRule"), value: payDateRule(selectedGroup.pay_date_rule) },
          { key: "basePeriod", label: t("payroll.basePeriod"), value: periodRule(selectedGroup.base_period) },
          {
            key: "variablePeriod",
            label: t("payroll.variablePeriod"),
            value: periodRule(selectedGroup.variable_period),
          },
          { key: "proration", label: t("payroll.proration"), value: t(`payroll.rule.${selectedGroup.proration}`) },
          { key: "channel", label: t("payroll.channel"), value: t(`payroll.rule.${selectedGroup.channel}`) },
        ]}
      />
    </RecordSection>
  ) : items.length > 0 ? (
    <RecordSection id="run-create-rules" title={t("payroll.home.rulesTitle")}>
      <EmptyState compact title={t("payroll.create.preview")} reason={t("payroll.create.reason")} />
    </RecordSection>
  ) : undefined;

  return (
    <WizardPattern
      q={groups}
      head={{
        title: t("payroll.create.title"),
        titleId: "payroll-run-create-title",
        actions: (
          <Link to="/payroll" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
            {t("payroll.title")}
          </Link>
        ),
      }}
      steps={
        items.length > 0 ? (
          <StepLine
            label={t("payroll.create.title")}
            steps={[
              { key: "select", label: t("payroll.group"), state: input ? "done" : "current" },
              { key: "confirm", label: t("payroll.create.preview"), state: input ? "current" : "waiting" },
            ]}
          />
        ) : undefined
      }
      body={body}
      aside={aside}
      asideLabel={t("payroll.home.rulesTitle")}
      consequence={<bdi className="muted">{t("payroll.create.reason")}</bdi>}
      notice={<CommandError error={create.error} own={refusal} recover={false} />}
      actions={
        items.length > 0 ? (
          <Button
            variant="primary"
            className={s.nowrap}
            disabled={!canSubmit}
            onClick={() => canSubmit && create.mutate({ ...input, expected_attribution_month: preview.data.attribution_month })}
          >
            {t("payroll.create.submit")}
          </Button>
        ) : (
          <Link to="/payroll/setup" className={buttonClass("primary", { size: "sm", className: s.nowrap })}>
            {t("payroll.setup.add")}
          </Link>
        )
      }
      statusSegments={
        selectedGroup
          ? [
              { id: "group", tone: "strong", content: selectedGroup.name },
              ...(preview.data ? [{ id: "month", content: preview.data.attribution_month }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
