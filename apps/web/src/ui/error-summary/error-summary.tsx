// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { shown } from "../shown";
import { findFieldElement } from "./find-field-element";
import s from "./error-summary.module.css";

export type ErrorSummaryItem = {
  /** The form input field name or id, if the error relates to a specific field. */
  field?: string;
  /** Refusal code from the API contract (e.g. `workplace_required`). */
  code?: string;
  /** Localized human-readable error text. */
  message: string;
  /** Explicit target href override (defaults to `#${field}` when a target element exists). */
  href?: string;
  /** Custom click handler override. */
  onClick?: () => void;
};

type ErrorSummaryProps = {
  /** Summary heading text. Defaults to localized title. */
  title?: ReactNode;
  children?: ReactNode;
  /** List of errors to summarize. */
  errors: ErrorSummaryItem[];
  /** Whether to automatically focus the summary on mount. Defaults to true. */
  autoFocus?: boolean;
  /** Identity of the refusal that owns this summary; the same refusal is focused only once. */
  focusKey?: unknown;
  /** HTML id for the container element. */
  id?: string;
  /** Optional form container id to scope field lookups. */
  formId?: string;
  /** Whitelist of field names present on the form. Server-only fields not in this list render without dead links. */
  formFields?: string[];
  /** Callback invoked when a field receives focus or is chosen from the summary. */
  onFocusField?: (field: string) => void;
  className?: string;
};

/**
 * A genuine Error Summary component (GOV.UK / Polaris pattern).
 * Displays a summary of validation errors at the top of a form or page,
 * links to each invalid field with a valid DOM target, and lands focus
 * on the summary. Server-only fields render without dead anchor targets.
 */
export function ErrorSummary({
  title,
  children,
  errors,
  autoFocus = true,
  focusKey = errors,
  id,
  formId,
  formFields,
  onFocusField,
  className,
}: ErrorSummaryProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedKeyRef = useRef<unknown>(undefined);
  const generatedId = useId();
  const titleId = `${id ?? generatedId}-title`;

  // Determine whether an item points to a field that is actually present on the form.
  const isFieldOnForm = useCallback(
    (field?: string): boolean => {
      if (!field) return false;
      if (formFields) return formFields.includes(field);
      if (typeof document !== "undefined") {
        return Boolean(findFieldElement(field, formId));
      }
      return true;
    },
    [formFields, formId],
  );

  useEffect(() => {
    if (!autoFocus || errors.length === 0 || focusedKeyRef.current === focusKey) return;
    focusedKeyRef.current = focusKey;

    containerRef.current?.focus();
  }, [autoFocus, errors, focusKey]);

  if (!errors || errors.length === 0) return null;

  return (
    <div
      ref={containerRef}
      id={id}
      className={className ? `${s.summary} ${className}` : s.summary}
      role="alert"
      tabIndex={-1}
      aria-labelledby={titleId}
      data-component="error-summary"
    >
      <div className={s.head}>
        <CircleAlert className={s.icon} size={18} aria-hidden />
        <h2 id={titleId} className={s.title}>
          {shown(title) ? title : t("common.validation.title")}
        </h2>
      </div>
      <div className={s.body}>
        <ul className={s.list}>
          {errors.map((item, index) => {
            const hasTarget = isFieldOnForm(item.field);
            const targetHref = item.href ?? (hasTarget && item.field ? `#${item.field}` : undefined);

            const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
              if (item.onClick) {
                e.preventDefault();
                item.onClick();
                return;
              }
              if (item.field) {
                const el = findFieldElement(item.field, formId);
                if (el) {
                  e.preventDefault();
                  el.focus();
                  el.scrollIntoView?.({ behavior: "instant", block: "center" });
                }
                onFocusField?.(item.field);
              }
            };

            return (
              <li key={item.field ? `${item.field}-${index}` : index} className={s.item}>
                {targetHref ? (
                  <a href={targetHref} className={s.link} onClick={handleClick}>
                    {item.message}
                  </a>
                ) : (
                  <div className={s.itemText}>{item.message}</div>
                )}
              </li>
            );
          })}
        </ul>
        {children}
      </div>
    </div>
  );
}
