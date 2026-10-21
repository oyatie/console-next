import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { Chip } from "../../ui/chip";
import { ErrorSummary, type ErrorSummaryItem } from "../../ui/error-summary";
import { failureText } from "../refusal";
import { outcomeUnknown, recoveryOf } from "./command";
import { OutcomeLink } from "./outcome-link";

type FieldRefusal = {
  field: string;
  code: string;
};

function CommandReference({ requestKey, operationId }: { requestKey?: string; operationId?: string }) {
  return (
    <>
      {requestKey && <p><OutcomeLink id={requestKey} /></p>}
      {operationId && <div className="muted">{t("common.operationId")} <span className="code">{operationId}</span></div>}
    </>
  );
}

/** Extracts field-level validation refusals from an API or boundary error. */
function extractFieldErrors(error: unknown): FieldRefusal[] {
  return error instanceof ApiError && error.status === 422
    ? error.errors.filter((item) => Boolean(item.field))
    : [];
}

/** A command's refusal, uncertainty remedy and authorized latest-change metadata. */
export function CommandError({
  error,
  children,
  own,
  historyHref,
  fieldLabel,
  live,
  recover = true,
  onFocusField,
  formId,
  formFields,
}: {
  error: unknown;
  /** False where the screen offers the uncertain command's recovery itself (its own button or its submit). */
  recover?: boolean;
  children?: ReactNode;
  own?: (code: string) => string | undefined;
  /** The caller's record-history route; never shown for redacted metadata. */
  historyHref?: string;
  fieldLabel?: (field: string) => string | null | undefined;
  live?: "polite" | "assertive";
  onFocusField?: (field: string) => void;
  formId?: string;
  formFields?: string[];
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

  const fieldErrors = extractFieldErrors(error);
  if (fieldErrors.length > 0) {
    const summaryItems: ErrorSummaryItem[] = fieldErrors.map((fe) => {
      const mine = own?.(fe.code);
      const label = fe.field ? fieldLabel?.(fe.field) : undefined;
      const byCode = `common.failed.code.${fe.code}`;
      const outcome = `requestOutcome.code.${fe.code}`;
      const fallback = fe.code;
      const codeText = mine ?? (isMessageId(byCode) ? t(byCode) : isMessageId(outcome) ? t(outcome) : fallback);
      const message = label && !codeText.includes(label) ? `${label}: ${codeText}` : codeText;
      return {
        field: fe.field,
        code: fe.code,
        message,
      };
    });

    return (
      <div className="command-error-summary">
        <ErrorSummary
          errors={summaryItems}
          title={t("requestOutcome.title")}
          focusKey={error}
          formId={formId}
          formFields={formFields}
          onFocusField={onFocusField}
        />
        {children}
        <CommandReference requestKey={key} operationId={api?.operationId} />
      </div>
    );
  }

  return (
    <Banner
      tone={checking ? "info" : "danger"}
      live={live ?? (checking ? "polite" : "assertive")}
      title={checking ? t("requestOutcome.checking") : undefined}
      actions={finish && <Button variant="primary" onClick={finish}>{t("requestOutcome.check")}</Button>}
    >
      {api?.status === 0 ? t("common.networkError") : failureText(error, own)}
      {checking && <p>{t("requestOutcome.remedy")}</p>}
      {change && (
        change.redacted ? <p>{t("requestOutcome.other")}</p> : (
          <>
            <p>
              {t("requestOutcome.changed", { actor, at: fmtDateTime(change.recorded_at) })}
              {change.actor_kind === "OPS_ACCOUNT" && <Chip tone="warn">{t("timeline.state.emergency")}</Chip>}
              {change.actor_kind === "SUPPORT_OPERATOR" && <Chip>{t("timeline.state.operator")}</Chip>}
            </p>
            {change.fields.length > 0 && <p>{t("requestOutcome.fields", { fields: labels.join(", ") })}</p>}
            {historyHref && change.audit_id && (
              <p>
                <Link to={historyHref as "/"}>{t("requestOutcome.history")}</Link>
              </p>
            )}
          </>
        )
      )}
      {children}
      <CommandReference requestKey={key} operationId={api?.operationId} />
    </Banner>
  );
}

