// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordSection } from "../../../ui/record/record-section";
import { type CreatePayGroup } from "../api";
import type { PayGroupDraft } from "../domain/pay-group-input";
import { payDateRule, periodRule } from "../present";
import s from "./payroll-console.module.css";

type SetupOption<T> = { value: T; label: string };

export function Choice<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly SetupOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} required>
      {control => (
        <SelectInput
          {...control}
          value={value === undefined ? "" : String(value)}
          onChange={event => {
            const option = options.find(row => String(row.value) === event.target.value);
            if (option) onChange(option.value);
          }}
        >
          <option value="" disabled>
            {t("payroll.setup.choose")}
          </option>
          {options.map(row => (
            <option key={String(row.value)} value={String(row.value)}>
              {row.label}
            </option>
          ))}
        </SelectInput>
      )}
    </Field>
  );
}

export function PayGroupSetupAside({
  entities,
  groupCount,
  draft,
  input,
}: {
  entities: readonly { id: string; name?: string | null }[];
  groupCount: number;
  draft: PayGroupDraft;
  input: CreatePayGroup | null;
}) {
  return (
    <div className={s.asideStack}>
      <RecordSection id="setup-preview" title={t("payroll.setup.previewTitle")}>
        <bdi className="muted">{t("payroll.setup.explicit")}</bdi>
        <KeyValue
          readOnly
          items={[
            {
              key: "count",
              label: t("payroll.setup.group"),
              value: t("payroll.setup.groupCount", { count: groupCount }),
            },
            {
              key: "entity",
              label: t("payroll.entity"),
              value: entities.find(e => e.id === draft.legal_entity_id)?.name ?? t("payroll.setup.choose"),
            },
            {
              key: "payDate",
              label: t("payroll.payDateRule"),
              value: input ? payDateRule(input.pay_date_rule) : t("payroll.setup.choose"),
            },
            {
              key: "base",
              label: t("payroll.basePeriod"),
              value: input ? periodRule(input.base_period) : t("payroll.setup.choose"),
            },
            {
              key: "variable",
              label: t("payroll.variablePeriod"),
              value: input ? periodRule(input.variable_period) : t("payroll.setup.choose"),
            },
          ]}
        />
      </RecordSection>
    </div>
  );
}
