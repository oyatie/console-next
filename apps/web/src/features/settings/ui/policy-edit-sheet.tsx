// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ApiError, assertSettingsChangeStepUp, changeSetting, planSetting } from "../../../reference/settings/api";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { TextInput } from "../../../ui/field/text-input";
import { formatEntryLabel, formatEntryValue, parseSettingInput, type SettingEntry } from "../domain/catalog";
import { type SummaryCopy } from "../domain/summaries";
import { PolicyConsentCheck } from "./overtime-attestation-panel";
import s from "./settings-hub.module.css";

const DOMAIN = "settings_change";
const NOTE_MAX = 1000;
const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));

const own = (code: string) => {
  const id = `settingsHub.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

function normalizeEffectiveFrom(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00+09:00`;
  return trimmed;
}

export function PolicyEditSheet({
  entry,
  scopeEntityId,
  scopeLabel,
  onSaved,
  onClose,
}: {
  entry: SettingEntry;
  scopeEntityId?: string | null;
  scopeLabel?: string;
  onSaved?: (saved: components["schemas"]["SettingChange"]) => void;
  onClose: () => void;
}) {
  const initialRaw = entry.value === null ? "" : String(entry.value);
  const [rawValue, setRawValue] = useState<string>(initialRaw);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [effectiveInput, setEffectiveInput] = useState("");
  const [workerConsent, setWorkerConsent] = useState<string[]>([]);
  const [plan, setPlan] = useState<components["schemas"]["SettingChangePlan"] | null>(null);
  const needsNote = useNeedsNote(DOMAIN, reason);
  const needsConsent = Boolean(plan?.requires.worker_consent);

  const parsed = parseSettingInput(entry, rawValue);
  const unchanged = parsed.ok && entry.value !== null && parsed.value === entry.value;
  const blockedReason = !parsed.ok
    ? t(`settingsHub.policy.${parsed.problem}`)
    : unchanged
      ? t("settingsHub.policy.noChange")
      : !reason
        ? t("settingsHub.experience.problem.reason")
        : needsNote && !note.trim()
          ? t("settingsHub.experience.problem.note")
          : needsConsent && !workerConsent.includes("consent")
            ? t("settingsHub.policy.problem.consent")
            : null;

  const buildRequest = (effectiveOverride?: string): components["schemas"]["SettingChangeRequest"] => ({
    value: parsed.ok ? parsed.value : rawValue,
    reason_code: reason ?? "POLICY_REVIEW",
    ...(scopeEntityId ? { scope_entity_id: scopeEntityId } : {}),
    ...(entry.version != null ? { expected_version: entry.version } : {}),
    ...(needsNote && note.trim() ? { reason_note: note.trim() } : {}),
    ...(effectiveOverride
      ? { effective_from: effectiveOverride }
      : normalizeEffectiveFrom(effectiveInput)
        ? { effective_from: normalizeEffectiveFrom(effectiveInput) }
        : {}),
  });

  const preview = useCommand({
    run: async () => {
      const nextPlan = await planSetting(entry.key, buildRequest());
      setPlan(nextPlan);
      if (!effectiveInput.trim() && nextPlan.path === "step_up_delayed") {
        setEffectiveInput(nextPlan.earliest_effective_from);
      }
      return nextPlan;
    },
  });

  const save = useCommand({
    run: async () => {
      if (!parsed.ok) throw new Error("invalid");
      const req = buildRequest();
      const activePlan = plan ?? (await planSetting(entry.key, req));
      setPlan(activePlan);
      const effectiveFrom = req.effective_from ?? (activePlan.path === "step_up_delayed" ? activePlan.earliest_effective_from : undefined);
      let stepUpAssertionId: string | undefined;
      if (activePlan.requires.step_up) {
        const envelope = await assertSettingsChangeStepUp(entry.key, parsed.value, scopeEntityId);
        stepUpAssertionId = envelope.assertion.ceremony_id;
      }
      try {
        return await changeSetting(entry.key, {
          ...req,
          ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
          ...(stepUpAssertionId ? { step_up_assertion_id: stepUpAssertionId } : {}),
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === "setting_loosening_too_soon") {
          const earliest = typeof err.details.earliest_effective_from === "string" ? err.details.earliest_effective_from : undefined;
          if (earliest) setEffectiveInput(earliest);
        }
        throw err;
      }
    },
    invalidates: ["/api/v1/settings", "/api/v1/settings/{key}/history"],
    awaitFirstRead: true,
    announce: (saved) => t("settingsHub.policy.saved", {
      key: formatEntryLabel(entry, settingsCopy),
      value: formatEntryValue(entry, saved.value, settingsCopy),
      date: fmtDate(saved.effective_from),
    }),
    onSuccess: (saved) => {
      onSaved?.(saved);
      onClose();
    },
  });

  const options = entry.kind.type === "bool"
    ? [
        { value: "true", label: t("settingsHub.on") },
        { value: "false", label: t("settingsHub.off") },
      ]
    : (entry.kind.allowed ?? []).map((code) => ({
        value: code,
        label: settingsCopy(`settingsHub.code.${code}`),
      }));

  const currentError = save.error ?? preview.error;
  const runPreview = () => {
    preview.mutate(undefined);
  };

  const label = formatEntryLabel(entry, settingsCopy);

  return (
    <Composer
      open
      title={label}
      subtitle={scopeLabel ?? t("settingsHub.workplace.tenantScope")}
      action={{ kind: "settingPolicy", mode: "change" }}
      onClose={onClose}
      pending={save.isPending || preview.isPending}
      error={currentError}
      notice={<CommandError error={currentError} own={own} />}
      consequence={plan ? t(`settingsHub.policy.direction.${plan.direction}`) : undefined}
      dirty={rawValue !== initialRaw || reason !== null || note.trim() !== "" || effectiveInput.trim() !== ""}
      blocked={blockedReason ? { reason: blockedReason } : undefined}
      secondary={
        <Button
          size="sm"
          variant="secondary"
          disabled={!parsed.ok || unchanged || preview.isPending}
          onClick={runPreview}
        >
          {t("settingsHub.policy.dryRun")}
        </Button>
      }
      onSubmit={() => {
        save.mutate(undefined);
      }}
    >
      {entry.kind.type === "int" ? (
        <Field
          label={t("settingsHub.policy.valueLabel")}
          required
          hint={[
            entry.kind.min != null ? `min ${entry.kind.min}` : null,
            entry.kind.max != null ? `max ${entry.kind.max}` : null,
          ].filter(Boolean).join(" · ") || undefined}
        >
          {(props) => (
            <TextInput
              {...props}
              type="number"
              min={entry.kind.min ?? undefined}
              max={entry.kind.max ?? undefined}
              value={rawValue}
              onChange={(event) => {
                setRawValue(event.target.value);
                setPlan(null);
              }}
            />
          )}
        </Field>
      ) : (
        <ChoiceField
          label={t("settingsHub.policy.valueLabel")}
          required
          options={options}
          value={rawValue || null}
          onChange={(next) => {
            setRawValue(next);
            setPlan(null);
          }}
        />
      )}

      <ReasonCodeField
        domain={DOMAIN}
        label={t("settingsHub.experience.reason")}
        value={reason}
        onChange={setReason}
      />

      {needsNote && (
        <Field label={t("settingsHub.experience.note")} required>
          {(props) => (
            <TextArea
              {...props}
              value={note}
              maxLength={NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
      )}

      <Field label={t("settingsHub.policy.effectiveFrom")} required={false} hint={t("settingsHub.policy.effectiveFromHint")}>
        {(props) => (
          <TextInput
            {...props}
            placeholder="YYYY-MM-DD"
            value={effectiveInput}
            onChange={(event) => {
              setEffectiveInput(event.target.value);
              setPlan(null);
            }}
          />
        )}
      </Field>

      {plan && (
        <div className={s.stack}>
          <Banner tone={plan.direction === "loosen" ? "warn" : "info"} title={t(`settingsHub.policy.direction.${plan.direction}`)}>
            <div>{t(`settingsHub.policy.path.${plan.path}`, { date: fmtDate(plan.earliest_effective_from) })}</div>
            {plan.requires.step_up && <div>{t("settingsHub.policy.stepUpRequired")}</div>}
            {plan.reaches.keeps_own_value.length > 0 && (
              <div>{t("settingsHub.policy.keepsOwnValue", { count: plan.reaches.keeps_own_value.length })}</div>
            )}
            {plan.reaches.affected_people_count !== undefined && (
              <div>
                {t("settingsHub.policy.impactSummary", {
                  affected: plan.reaches.affected_people_count,
                  outOfScope: plan.reaches.out_of_scope_people_count ?? 0,
                  disfavored: plan.reaches.disfavored_people_count ?? 0,
                })}
              </div>
            )}
          </Banner>
          {plan.requires.worker_consent && (
            <PolicyConsentCheck value={workerConsent} onChange={setWorkerConsent} />
          )}
        </div>
      )}
    </Composer>
  );
}
