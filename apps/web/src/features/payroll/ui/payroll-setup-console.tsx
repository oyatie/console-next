// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { commitLabel } from "../../../ui/composer/actions";
import { EmptyState } from "../../../ui/empty-state";
import { Field, FieldSet, TextInput } from "../../../ui/field/field";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { Receipt } from "../../../ui/receipt/receipt";
import { RecordSection } from "../../../ui/record/record-section";
import { StepLine } from "../../../ui/step-line/step-line";
import { createPayGroup, payGroupsQuery, type CreatePayGroup } from "../api";
import { isPayGroupDirty, payGroupInput, type PayGroupDraft } from "../domain/pay-group-input";
import { Choice, OptionalCutoffFieldSet, PayGroupSetupAside } from "./payroll-setup-console-parts";
import { firstDay, lastDay, payBases, payDate, payDay, periodRuleSchema, rules, startDay } from "./use-pay-group-schema";
import s from "./payroll-console.module.css";

const days = ({ minimum, maximum }: { minimum: number; maximum: number }) =>
  Array.from({ length: maximum - minimum + 1 }, (_, n) => ({
    value: n + minimum,
    label: t("payroll.rule.day", { day: n + minimum }),
  }));

const EMPTY_DRAFT: PayGroupDraft = { pay_date_rule: {}, base_period: {}, variable_period: {} };

export function PayrollSetupConsole({ baseline }: { baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <PayrollSetupConsoleContent baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function PayrollSetupConsoleContent({ baseline }: { baseline: () => ReactNode }) {
  const navigate = useNavigate();
  const groups = useQuery(payGroupsQuery);
  const [draft, setDraft] = useState<PayGroupDraft>(EMPTY_DRAFT);
  const [attempted, setAttempted] = useState(false);
  const [unsavedWarn, setUnsavedWarn] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const input = payGroupInput(draft);

  const change = <K extends keyof PayGroupDraft>(key: K, value: PayGroupDraft[K]) => {
    setUnsavedWarn(false);
    setDraft(current => ({ ...current, [key]: value }));
  };

  const save = useCommand({
    run: createPayGroup,
    invalidates: ["/api/v1/payroll/pay-groups"],
    settle: true,
    announce: group => t("payroll.setup.saved", { name: group.name }),
    onSuccess: group => {
      setReceipt(t("payroll.setup.saved", { name: group.name }));
      setDraft(EMPTY_DRAFT);
      setAttempted(false);
    },
  });

  const entities = groups.data?.legal_entities ?? [];
  const step1Done = Boolean(draft.legal_entity_id && draft.name?.trim());
  const step2Done = Boolean(
    draft.pay_date_rule.month_offset !== undefined && draft.pay_date_rule.day !== undefined && draft.pay_date_rule.non_business_day &&
      draft.base_period.month_offset !== undefined && draft.base_period.start_day !== undefined &&
      draft.variable_period.month_offset !== undefined && draft.variable_period.start_day !== undefined,
  );
  const step3Done = Boolean(
    draft.proration && draft.channel && draft.sensitive !== undefined && draft.pay_basis_allowed && draft.pay_basis_allowed.length > 0,
  );

  const periodFields = (key: "base_period" | "variable_period") => (
    <FieldSet label={t(key === "base_period" ? "payroll.basePeriod" : "payroll.variablePeriod")} required>
      <div className={s.fieldGrid}>
        <Choice
          label={t("payroll.setup.month")}
          value={draft[key].month_offset}
          options={periodRuleSchema.month_offset.enum.map(value => ({ value, label: t(`payroll.rule.periodMonth.${value}`) }))}
          onChange={month_offset => change(key, { ...draft[key], month_offset })}
        />
        <Choice<CreatePayGroup["base_period"]["start_day"]>
          label={t("payroll.setup.startDay")}
          value={draft[key].start_day}
          options={[...firstDay.enum.map(value => ({ value, label: t("payroll.rule.day", { day: startDay.minimum }) })), ...days(startDay).slice(1)]}
          onChange={start_day => change(key, { ...draft[key], start_day })}
        />
      </div>
    </FieldSet>
  );

  const body =
    entities.length === 0 ? (
      <EmptyState title={t("payroll.setup.noEntities")} reason={t("payroll.setup.entityDetail")} />
    ) : (
      <div className={s.sectionStack}>
        {Boolean(groups.data?.manageable_group_ids?.length) &&
          <Link to="/payroll/setup/members" className={buttonClass("secondary", { size: "sm" })}>{t("payroll.members.title")}</Link>}
        <RecordSection id="setup-step-basics" title={t("payroll.setup.stepBasics")}>
          <div className={s.fieldGrid}>
            <Choice
              label={t("payroll.entity")}
              value={draft.legal_entity_id}
              options={entities.map(row => ({ value: row.id, label: row.name ?? t("payroll.entityUnnamed") }))}
              onChange={value => change("legal_entity_id", value)}
            />
            <Field label={t("payroll.setup.name")} required>
              {control => (
                <TextInput
                  {...control}
                  value={draft.name ?? ""}
                  minLength={rules.name.minLength}
                  maxLength={rules.name.maxLength}
                  onChange={event => change("name", event.target.value)}
                />
              )}
            </Field>
          </div>
        </RecordSection>

        <RecordSection id="setup-step-dates" title={t("payroll.setup.stepDates")}>
          <div className={s.sectionStack}>
            <FieldSet label={t("payroll.payDateRule")} required>
              <div className={s.fieldGrid}>
                <Choice
                  label={t("payroll.setup.month")}
                  value={draft.pay_date_rule.month_offset}
                  options={payDate.month_offset.enum.map(value => ({
                    value,
                    label: t(`payroll.rule.payMonth.${value}`),
                  }))}
                  onChange={month_offset => change("pay_date_rule", { ...draft.pay_date_rule, month_offset })}
                />
                <Choice<CreatePayGroup["pay_date_rule"]["day"]>
                  label={t("payroll.setup.day")}
                  value={draft.pay_date_rule.day}
                  options={[
                    ...days(payDay),
                    ...lastDay.enum.map(value => ({ value, label: t("payroll.rule.lastDay") })),
                  ]}
                  onChange={day => change("pay_date_rule", { ...draft.pay_date_rule, day })}
                />
                <Choice
                  label={t("payroll.setup.holiday")}
                  value={draft.pay_date_rule.non_business_day}
                  options={payDate.non_business_day.enum.map(value => ({
                    value,
                    label: t(`payroll.rule.${value}`),
                  }))}
                  onChange={non_business_day => change("pay_date_rule", { ...draft.pay_date_rule, non_business_day })}
                />
              </div>
            </FieldSet>
            {periodFields("base_period")}
            {periodFields("variable_period")}
            <OptionalCutoffFieldSet
              cutoff={draft.attendance_cutoff_rule}
              onChange={next => change("attendance_cutoff_rule", next)}
            />
          </div>
        </RecordSection>

        <RecordSection id="setup-step-rules" title={t("payroll.setup.stepRules")}>
          <div className={s.sectionStack}>
            <div className={s.fieldGrid}>
              <Choice
                label={t("payroll.proration")}
                value={draft.proration}
                options={rules.proration.enum.map(value => ({ value, label: t(`payroll.rule.${value}`) }))}
                onChange={value => change("proration", value)}
              />
              <Choice
                label={t("payroll.channel")}
                value={draft.channel}
                options={rules.channel.enum.map(value => ({ value, label: t(`payroll.rule.${value}`) }))}
                onChange={value => change("channel", value)}
              />
              <Choice
                label={t("payroll.sensitive")}
                value={draft.sensitive}
                options={[true, false].map(value => ({
                  value,
                  label: t(value ? "payroll.rule.sensitive.true" : "payroll.rule.sensitive.false"),
                }))}
                onChange={value => change("sensitive", value)}
              />
            </div>
            <bdi className="muted">{t("payroll.setup.sensitiveHint")}</bdi>
            <Checks
              label={t("payroll.payBasisAllowed")}
              items={payBases.map(id => ({ id, label: t(`payroll.rule.${id}`) }))}
              value={draft.pay_basis_allowed ?? []}
              onChange={values => change("pay_basis_allowed", payBases.filter(value => values.includes(value)))}
              error={attempted && !draft.pay_basis_allowed?.length ? t("payroll.setup.basisRequired") : undefined}
            />
          </div>
        </RecordSection>
      </div>
    );

  const aside =
    entities.length > 0 ? (
      <PayGroupSetupAside
        entities={entities}
        groupCount={groups.data?.items.length ?? 0}
        draft={draft}
        input={input}
      />
    ) : undefined;

  return (
    <WizardPattern
      q={groups}
      head={{
        title: t("payroll.setup.page"),
        titleId: "payroll-setup-title",
        actions: (
          <Link to="/payroll" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
            {t("payroll.title")}
          </Link>
        ),
      }}
      steps={
        entities.length > 0 ? (
          <StepLine
            label={t("payroll.setup.page")}
            steps={[
              { key: "basics", label: t("payroll.setup.stepBasics"), state: step1Done ? "done" : "current" },
              {
                key: "dates",
                label: t("payroll.setup.stepDates"),
                state: step2Done ? "done" : step1Done ? "current" : "waiting",
              },
              {
                key: "rules",
                label: t("payroll.setup.stepRules"),
                state: step3Done ? "done" : step1Done && step2Done ? "current" : "waiting",
              },
            ]}
          />
        ) : undefined
      }
      body={body}
      aside={aside}
      asideLabel={t("payroll.setup.previewTitle")}
      consequence={
        input
          ? t("payroll.setup.consequence", {
              entity: entities.find(row => row.id === input.legal_entity_id)?.name ?? t("payroll.entityUnnamed"),
              name: input.name,
            })
          : undefined
      }
      notice={
        <>
          {receipt ? <Receipt state="applied" message={receipt} onDismiss={() => setReceipt(null)} /> : null}
          {unsavedWarn ? <div role="status">{t("composer.unsaved")}</div> : null}
          <CommandError error={save.error} />
          {attempted && !input ? <div role="alert">{t("payroll.setup.required")}</div> : null}
        </>
      }
      actions={
        entities.length > 0 ? (
          <>
            <Button variant="secondary" className={s.nowrap} onClick={() => (isPayGroupDirty(draft) && !unsavedWarn ? setUnsavedWarn(true) : void navigate({ to: "/payroll" }))}>
              {t("uiSheet.close")}
            </Button>
            <Button variant="primary" className={s.nowrap} disabled={save.isPending} onClick={() => (setAttempted(true), input && save.mutate(input))}>
              {commitLabel({ kind: "payGroup", mode: "save" })}
            </Button>
          </>
        ) : (
          <Link to="/payroll" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
            {t("payroll.title")}
          </Link>
        )
      }
      statusSegments={
        groups.data
          ? [
              { id: "count", content: t("payroll.setup.groupCount", { count: groups.data.items.length }) },
              ...(draft.name?.trim() ? [{ id: "draft", tone: "strong" as const, content: draft.name.trim() }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
