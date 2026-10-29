import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { Chip } from "../../ui/chip";
import { ErrorSummary, type ErrorSummaryItem } from "../../ui/error-summary";
import { failureText, readFailureText } from "../refusal";
import { SupportReference } from "./support-reference";
import { outcomeUnknown, recoveryOf } from "./command";
import { OutcomeLink } from "./outcome-link";

type FieldRefusal = {
  field: string;
  code: string;
};

function CommandReference({ requestKey, api }: { requestKey?: string; api?: ApiError }) {
  return (
    <>
      {requestKey && <p><OutcomeLink id={requestKey} /></p>}
      {api && <div className="muted"><code>{api.code}</code></div>}
      <SupportReference reference={api?.supportRef ?? api?.operationId} at={api?.supportRefAt} compact={Boolean(api?.supportRef)} />
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
  fieldReason,
  live,
  recover = true,
  read = false,
  onFocusField,
  formId,
  formFields,
}: {
  error: unknown;
  /** False where the screen offers the uncertain command's recovery itself (its own button or its submit). */
  recover?: boolean;
  /** Reads can be retried directly; they never have an uncertain write outcome. */
  read?: boolean;
  children?: ReactNode;
  own?: (code: string) => string | undefined;
  /** The caller's record-history route; never shown for redacted metadata. */
  historyHref?: string;
  fieldLabel?: (field: string) => string | null | undefined;
  fieldReason?: (field: string, code: string) => string | undefined;
  live?: "polite" | "assertive";
  onFocusField?: (field: string) => void;
  formId?: string;
  formFields?: string[];
}) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : undefined;
  // The transport and useCommand attach intent keys to commands; a read's operation ID is only a support reference.
  const uncertain = outcomeUnknown(error);
  const readFailure = read || (uncertain && !api?.requestKey);
  const checking = !readFailure && uncertain;
  const finish = checking && recover ? recoveryOf(error) : undefined;
  // An authentication refusal happens before the operation and has no command outcome to inspect.
  const key = readFailure || api?.status === 401 ? undefined : api?.originalOperationId ?? api?.operationId ?? api?.requestKey;
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
      const fallback = fieldReason?.(fe.field, fe.code) ?? t("common.failed.code.validation");
      const codeText = mine ?? (isMessageId(byCode) ? t(byCode) : isMessageId(outcome) ? t(outcome) : fallback);
      const message = label && !codeText.includes(label) ? `${label}: ${codeText}` : codeText;
      return {
        field: fe.field,
        code: fe.code,
        message,
      };
    });

    return (
      <ErrorSummary
        errors={summaryItems}
        title={t("common.validation.title")}
        focusKey={error}
        formId={formId}
        formFields={formFields}
        onFocusField={onFocusField}
      >
        {children}
        <CommandReference requestKey={key} api={api} />
      </ErrorSummary>
    );
  }

  return (
    <Banner tone={checking ? "info" : "danger"} live={live ?? (checking ? "polite" : "assertive")} title={checking ? t("requestOutcome.checking") : undefined}
      actions={finish && <Button variant="primary" onClick={finish}>{t("requestOutcome.check")}</Button>}>
      {readFailure ? readFailureText(error, own) : api?.status === 0 ? t("common.networkError") : failureText(error, own)}
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
      <CommandReference requestKey={key} api={api} />
    </Banner>
  );
}

