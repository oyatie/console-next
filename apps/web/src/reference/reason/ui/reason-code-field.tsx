import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { reasonCodesQuery, reasonOptions, type ReasonDomain } from "../../../lib/reason-codes";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { MAX_CHIPS } from "../../../ui/choice/limits";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import s from "./reason-code-field.module.css";

const MAX_CHOICES = 15;

/**
 * One reason code from the server's list for `domain` (BW-07), nothing chosen until the user picks. `only` narrows
 * the list to the codes a rule leaves (a demotion takes only disciplinary demotion). The note stays the form's own field.
 */
export function ReasonCodeField({ domain, label, value, onChange, error, hint, only, noteless, look, required = true }: {
  domain: ReasonDomain;
  label: string;
  value: string | null;
  onChange: (code: string) => void;
  error?: ReactNode;
  hint?: ReactNode;
  only?: readonly string[];
  /** The command takes no note: codes that require one (OTHER) are left out. */
  noteless?: boolean;
  /** Draw the codes as chips (ui/choice look) instead of a segmented control or a select. */
  look?: "chips";
  /** False for a reason that may be left for later (the exit report's reason): no required marker. */
  required?: boolean;
}) {
  const q = useQuery(reasonCodesQuery(domain));
  const options = reasonOptions(domain, q.data?.items).filter((o) => (!only || only.includes(o.value)) && !(noteless && o.requiresNote));
  const [query, setQuery] = useState("");
  if (q.isError) return <p className={s.warn} role="status">{t("reason.field.unavailable")}</p>;
  if (options.length <= (look === "chips" ? MAX_CHIPS : MAX_CHOICES)) return <ChoiceField label={label} required={required} options={options} value={value} onChange={onChange} error={error} hint={hint} look={look} />;
  // More codes than a list shows (a tenant's own): searched by name, still from the server's list only.
  return (
    <>
      <ServerPicker
        label={label}
        isRequired={required}
        query={query}
        onQueryChange={setQuery}
        options={options.filter((o) => o.label.includes(query.trim())).map((o) => ({ id: o.value, name: o.label }))}
        value={value}
        onChange={(code) => code && onChange(code)}
        group={label}
        empty={t("reason.field.none")}
      />
      {hint != null && <p className={`muted ${s.hint}`}>{hint}</p>}
      {error != null && <p className={s.error}>{error}</p>}
    </>
  );
}
