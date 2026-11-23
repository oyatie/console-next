// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { reasonCodesQuery, type ReasonDomain } from "../../../lib/reason-codes";
import { ApiError, addReasonCode, updateReasonCode } from "../../../reference/settings/api";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Checks } from "../../../ui/choice/checks";
import { Field } from "../../../ui/field/field";
import { TextInput } from "../../../ui/field/text-input";
import { Receipt } from "../../../ui/receipt/receipt";
import { SelectField, type SelectOption } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import s from "./settings-hub.module.css";

const ownError = (code: string) => {
  const id = `settingsHub.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

const REASON_DOMAINS: readonly ReasonDomain[] = [
  "settings_change",
  "period_unlock",
  "employee_number_change",
  "exit_reason",
  "exception",
];

type ReasonItem = components["schemas"]["ReasonCatalogEntry"];

export function ReasonCodesPanel() {
  const [domain, setDomain] = useState<ReasonDomain>("settings_change");
  const [labelKo, setLabelKo] = useState("");
  const [labelEn, setLabelEn] = useState("");
  const [requiresNote, setRequiresNote] = useState<string[]>([]);
  const q = useQuery(reasonCodesQuery(domain));

  const add = useCommand({
    run: () =>
      addReasonCode({
        domain,
        label_ko: labelKo.trim(),
        ...(labelEn.trim() ? { label_en: labelEn.trim() } : {}),
        requires_note: requiresNote.includes("requires_note"),
        involuntary: false,
        notice_required: false,
      }),
    invalidates: ["/api/v1/reason-codes"],
    awaitFirstRead: true,
    onSuccess: () => {
      setLabelKo("");
      setLabelEn("");
      setRequiresNote([]);
    },
  });

  const toggle = useCommand({
    run: (item: ReasonItem) =>
      updateReasonCode(domain, item.code, { active: !item.active }),
    invalidates: ["/api/v1/reason-codes"],
    awaitFirstRead: true,
  });

  const domainOptions: SelectOption[] = REASON_DOMAINS.map(d => ({ id: d, label: d }));
  const addError = add.error ?? toggle.error;
  const closedDomain = addError instanceof ApiError && addError.code === "reason_domain_closed";

  return (
    <div className={s.stack}>
      <Card title={t("settingsHub.section.reasons")}>
        <div className={s.scopeBar}>
          <SelectField
            label={t("settingsHub.reasons.domainLabel")}
            options={domainOptions}
            value={domain}
            onChange={next => {
              if ((REASON_DOMAINS as readonly string[]).includes(next)) {
                setDomain(next as ReasonDomain);
              }
            }}
            placeholder={t("settingsHub.reasons.domainLabel")}
          />
        </div>
        <QueryState q={q} inline own={ownError}>
          {data => (
            <Table<ReasonItem>
              label={t("settingsHub.section.reasons")}
              rows={data.items}
              rowId={item => item.code}
              density="compact"
              mobileLayout="compact"
              columns={[
                {
                  header: t("settingsHub.reasons.domainLabel"),
                  card: "title",
                  cell: item => {
                    const labelId = `reason.${domain}.${item.code}`;
                    const display = item.label_ko ?? (isMessageId(labelId) ? t(labelId) : item.code);
                    return `${display} (${item.code})`;
                  },
                },
                {
                  header: t("settingsHub.policy.noun"),
                  card: "fact",
                  cell: item => (item.system ? t("settingsHub.reasons.system") : t("settingsHub.reasons.tenant")),
                },
                {
                  header: t("settingsHub.reasons.stateCol"),
                  card: "status",
                  cell: item => (
                    <Chip tone={item.active ? "ok" : "neutral"}>
                      {t(item.active ? "settingsHub.reasons.active" : "settingsHub.reasons.inactive")}
                    </Chip>
                  ),
                },
                {
                  header: t("settingsHub.reasons.actionsCol"),
                  card: "action",
                  cell: item =>
                    item.system ? (
                      "—"
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(item)}
                      >
                        {t(item.active ? "settingsHub.reasons.deactivate" : "settingsHub.reasons.activate")}
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </QueryState>
      </Card>

      <Card title={t("settingsHub.reasons.addTitle")}>
        {closedDomain && <Banner tone="warn">{t("settingsHub.reasons.closed")}</Banner>}
        <CommandError error={addError} own={ownError} />
        <div className={s.stack}>
          <Field label={t("settingsHub.reasons.labelKo")} required>
            {props => (
              <TextInput
                {...props}
                value={labelKo}
                onChange={event => setLabelKo(event.target.value)}
              />
            )}
          </Field>
          <Field label={t("settingsHub.reasons.labelEn")} required={false}>
            {props => (
              <TextInput
                {...props}
                value={labelEn}
                onChange={event => setLabelEn(event.target.value)}
              />
            )}
          </Field>
          <Checks
            label={t("settingsHub.reasons.requiresNote")}
            items={[{ id: "requires_note", label: t("settingsHub.reasons.requiresNote") }]}
            value={requiresNote}
            onChange={setRequiresNote}
          />
          <div>
            <Button
              variant="primary"
              disabled={!labelKo.trim() || add.isPending}
              onClick={() => add.mutate(undefined)}
            >
              {t("settingsHub.reasons.addButton")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function PolicySavedReceipt({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <Receipt
      state="recorded"
      message={message}
      actions={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("composer.dismiss")}
        </Button>
      }
    />
  );
}
