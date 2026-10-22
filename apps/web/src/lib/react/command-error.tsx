import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { Chip } from "../../ui/chip";
import { failureText } from "../refusal";
import { outcomeUnknown, recoveryOf } from "./command";

/** A command's refusal, uncertainty remedy and authorized latest-change metadata. */
export function CommandError({ error, children, own, historyHref, fieldLabel, live, recover = true }: {
  error: unknown;
  /** False where the screen offers the uncertain command's recovery itself (its own button or its submit). */
  recover?: boolean;
  children?: ReactNode;
  own?: (code: string) => string | undefined;
  /** The caller's record-history route; never shown for redacted metadata. */
  historyHref?: string;
  fieldLabel?: (field: string) => string | null | undefined;
  live?: "polite" | "assertive";
}) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : undefined;
  const checking = outcomeUnknown(error);
  const finish = checking && recover ? recoveryOf(error) : undefined;
  const key = api?.originalOperationId ?? api?.operationId ?? api?.requestKey;
  const change = api?.status === 409 && api.code === "stale_revision" && !checking ? api.lastChange : undefined;
  const fields = change?.fields.map(field => fieldLabel?.(field));
  const knownFields = fields?.filter((label): label is string => Boolean(label)) ?? [];
  const unnamed = (fields?.length ?? 0) - knownFields.length;
  const labels = [...knownFields, ...(unnamed ? [t("requestOutcome.fieldsOther", { count: unnamed })] : [])];
  const actor = change?.actor_kind === "SYSTEM" ? t("timeline.system") : change?.actor_name ?? t("requestOutcome.other");
  return (
    <Banner tone={checking ? "info" : "danger"} live={live ?? (checking ? "polite" : "assertive")} title={checking ? t("requestOutcome.checking") : undefined}
      actions={finish && <Button variant="primary" onClick={finish}>{t("requestOutcome.check")}</Button>}>
      {api?.status === 0 ? t("common.networkError") : failureText(error, own)}
      {checking && <p>{t("requestOutcome.remedy")}</p>}
      {change && (change.redacted ? <p>{t("requestOutcome.other")}</p> : <>
        <p>{t("requestOutcome.changed", { actor, at: fmtDateTime(change.recorded_at) })}
          {change.actor_kind === "OPS_ACCOUNT" && <Chip tone="warn">{t("timeline.state.emergency")}</Chip>}
          {change.actor_kind === "SUPPORT_OPERATOR" && <Chip>{t("timeline.state.operator")}</Chip>}
        </p>
        {change.fields.length > 0 && <p>{t("requestOutcome.fields", { fields: labels.join(", ") })}</p>}
        {historyHref && change.audit_id && <p><Link to={historyHref as "/"}>{t("requestOutcome.history")}</Link></p>}
      </>)}
      {children}
      {key && <p><Link to="/requests/$id" params={{ id: key }}>{t("requestOutcome.open")}</Link></p>}
      {api?.operationId && <div className="muted">{t("common.operationId")} <span className="code">{api.operationId}</span></div>}
    </Banner>
  );
}
