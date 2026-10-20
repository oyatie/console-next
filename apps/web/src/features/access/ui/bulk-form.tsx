import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Card } from "../../../ui/card/card";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ReasonField } from "../../../ui/reason/reason-field";
import type { Reason } from "../../../ui/reason/reason";
import type { DraftLine, Missing } from "../domain/grants";
import type { AccessRole } from "../api";
import { GrantLine } from "./grant-line";
import { useReasons } from "./use-reasons";

export type BulkDraft = { line: DraftLine; when: string | null; reason: Reason };

/** What every picked person gets (mockup M5): one role, one scope, one end, when it applies, and why. */
export function BulkForm({ roles, setup, today, value, onChange, tried, gaps, picked, onPickScope, children }: {
  roles: readonly AccessRole[];
  setup: boolean;
  today: string;
  value: BulkDraft;
  onChange: (d: BulkDraft) => void;
  tried: boolean;
  gaps: readonly Missing[];
  picked: number;
  onPickScope: () => void;
  children: ReactNode;
}) {
  const reasons = useReasons();
  const blockedReason =
    picked === 0
      ? t("access.bulk.pick.missing")
      : gaps[0]
        ? t(`access.grant.missing.${gaps[0]}`)
        : setup && !value.when
          ? t("access.grant.when.missing")
          : !value.reason.code
            ? t("uiReason.pick", { label: t("access.grant.reason") })
            : value.reason.code === "OTHER" && !value.reason.memo.trim()
              ? t("uiReason.memoRequired")
              : null;
  const renderedChildren = Children.map(children, (child) => {
    if (isValidElement<{ variant?: string; className?: string }>(child) && child.props.variant === "primary") {
      if (blockedReason) {
        return (
          <DisabledReason
            control={(p) =>
              cloneElement(child as ReactElement<Record<string, unknown>>, {
                ...p,
                className: `${child.props.className ?? ""} ${p.className ?? ""}`.trim(),
              })
            }
            reason={blockedReason}
          />
        );
      }
    }
    return child;
  });
  return (
    <Card title={t("access.bulk.what")}>
      {tried && !picked && <p className="field__error" role="alert">{t("access.bulk.pick.missing")}</p>}
      <GrantLine n={1} line={value.line} roles={roles} today={today} missing={tried ? gaps : []} stacked onChange={(line) => onChange({ ...value, line })} onPickScope={onPickScope} />
      {setup && (
        <ChoiceField
          label={t("access.grant.when")}
          required
          options={(["GO_LIVE", "SETUP"] as const).map((k) => ({ value: k, label: t(`access.grant.when.${k}`), description: t(`access.grant.when.${k}.hint`) }))}
          value={value.when}
          onChange={(when) => onChange({ ...value, when })}
          error={tried && !value.when ? t("access.grant.when.missing") : undefined}
        />
      )}
      <ReasonField label={t("access.grant.reason")} codes={reasons.codes} other="OTHER" value={value.reason} onChange={(reason) => onChange({ ...value, reason })} memoMax={200} showErrors={tried} />
      {renderedChildren}
    </Card>
  );
}
