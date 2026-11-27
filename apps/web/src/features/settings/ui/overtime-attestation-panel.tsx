// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { overtimeAttestationsQuery, recordOvertimeAttestation } from "../../../reference/settings/api";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { Checks } from "../../../ui/choice/checks";
import { Chip } from "../../../ui/chip";
import { Field } from "../../../ui/field/field";
import { TextInput } from "../../../ui/field/text-input";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { formatEntryValue, type SettingEntry } from "../domain/catalog";
import type { SummaryCopy } from "../domain/summaries";
import s from "./settings-hub.module.css";

const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));

export function PolicyConsentCheck({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Checks
      label={t("settingsHub.policy.workerConsentRequired")}
      items={[{ id: "consent", label: t("settingsHub.policy.workerConsentRequired") }]}
      value={value}
      onChange={onChange}
    />
  );
}

export function PolicyBoundsSection({ entry }: { entry: SettingEntry }) {
  if (entry.kind.type !== "int" || (entry.kind.min == null && entry.kind.max == null)) return null;
  const minText = entry.kind.min != null ? formatEntryValue(entry, entry.kind.min, settingsCopy) : null;
  const maxText = entry.kind.max != null ? formatEntryValue(entry, entry.kind.max, settingsCopy) : null;
  const caption =
    minText && maxText
      ? t("settingsHub.inspector.boundsRange", { min: minText, max: maxText })
      : minText
        ? t("settingsHub.inspector.boundsFloor", { min: minText })
        : t("settingsHub.inspector.boundsCap", { max: maxText ?? "" });

  return (
    <RecordPaneSection title={t("settingsHub.inspector.bounds")}>
      <div className={s.row}>
        <span>{caption}</span>
        {typeof entry.value === "number" && (
          <Chip tone="info">{formatEntryValue(entry, entry.value, settingsCopy)}</Chip>
        )}
      </div>
    </RecordPaneSection>
  );
}

export function OvertimeAttestationPanel({
  scopeEntityId,
  canChange,
}: {
  scopeEntityId: string | null;
  canChange: boolean;
}) {
  const q = useQuery(overtimeAttestationsQuery(scopeEntityId));
  const [confirmedOn, setConfirmedOn] = useState("");
  const [ruleRef, setRuleRef] = useState("");
  const [noticeMethod, setNoticeMethod] = useState("");

  const create = useCommand({
    run: () =>
      recordOvertimeAttestation({
        ...(scopeEntityId ? { scope_entity_id: scopeEntityId } : {}),
        confirmed_on: confirmedOn.trim(),
        rule_reference: ruleRef.trim(),
        worker_notice_method: noticeMethod.trim(),
      }),
    invalidates: ["/api/v1/settings/overtime-attestations", "/api/v1/onboarding/checklist"],
    awaitFirstRead: true,
    announce: () => t("settingsHub.attestation.saved"),
    onSuccess: () => {
      setConfirmedOn("");
      setRuleRef("");
      setNoticeMethod("");
    },
  });

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(confirmedOn.trim()) && Boolean(ruleRef.trim()) && Boolean(noticeMethod.trim());

  return (
    <RecordPaneSection title={t("settingsHub.attestation.title")}>
      <div className={s.stack}>
        {(q.data?.items.length ?? 0) === 0 ? (
          <Banner tone="info">{t("settingsHub.attestation.empty")}</Banner>
        ) : (
          q.data!.items.map((item) => (
            <div key={item.id} className={s.row}>
              <div>
                <div>{item.rule_reference}</div>
                <div className="muted">
                  {[item.confirmed_on, item.worker_notice_method, item.recorded_by_name].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Chip tone="ok">{item.confirmed_on}</Chip>
            </div>
          ))
        )}

        {canChange && (
          <div className={s.stack}>
            <CommandError error={create.error} />
            <Field label={t("settingsHub.attestation.confirmedOn")} required>
              {(props) => (
                <TextInput
                  {...props}
                  placeholder="YYYY-MM-DD"
                  value={confirmedOn}
                  onChange={(e) => setConfirmedOn(e.target.value)}
                />
              )}
            </Field>
            <Field label={t("settingsHub.attestation.ruleReference")} required>
              {(props) => (
                <TextInput
                  {...props}
                  value={ruleRef}
                  onChange={(e) => setRuleRef(e.target.value)}
                />
              )}
            </Field>
            <Field label={t("settingsHub.attestation.noticeMethod")} required>
              {(props) => (
                <TextInput
                  {...props}
                  value={noticeMethod}
                  onChange={(e) => setNoticeMethod(e.target.value)}
                />
              )}
            </Field>
            <div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!valid || create.isPending}
                onClick={() => create.mutate(undefined)}
              >
                {t("settingsHub.attestation.recordAction")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </RecordPaneSection>
  );
}
