import { QueryState } from "../../../lib/react/query-state";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { jobTitlesQuery, unitMembersQuery } from "../api";
import { activeTitles, type JobTitle } from "../domain/titles";
import s from "./lifecycle.module.css";

type Employee = components["schemas"]["Employee"];
const SUGGESTIONS = 8;

/**
 * The new position. With a position catalog (BW-13) it is picked from the active titles, most senior first, and the
 * rank decides whether this is a demotion; without one it is typed, and the chips are positions other members of
 * this unit already hold, offered as suggestions, never as a list to choose from.
 */
export function PromoteTarget({ employee, current, value, titleId, onChange, onTitle, missing, note }: {
  employee: Employee;
  /** The employee's catalog title now, when known. */
  current?: JobTitle;
  value: string;
  titleId: string;
  onChange: (position: string) => void;
  onTitle: (title: JobTitle | null) => void;
  missing?: boolean;
  note?: ReactNode;
}) {
  const titles = useQuery(jobTitlesQuery);
  const [query, setQuery] = useState("");
  const members = useQuery({ ...unitMembersQuery(employee.org_unit_id ?? ""), enabled: Boolean(employee.org_unit_id) });
  const catalog = activeTitles(titles.data?.items ?? [], "TITLE");
  const fact = <p className={s.fact}>{t("lifecycle.promote.current", { position: current?.label ?? employee.position ?? "—" })}</p>;
  if (catalog.length > 0)
    return (
      <QueryState q={titles} layout="form">{() => <div className={s.block}>
        {fact}
        <ServerPicker
          label={t("lifecycle.promote.title")}
          isRequired={false}
          query={query}
          onQueryChange={setQuery}
          options={catalog
            .filter((x) => x.id !== current?.id && x.label.includes(query.trim()))
            .map((x) => ({ id: x.id, name: x.label, context: x.grade_rank === null ? undefined : t("lifecycle.promote.rank", { rank: x.grade_rank }) }))}
          value={titleId || null}
          onChange={(id) => onTitle(catalog.find((x) => x.id === id) ?? null)}
          group={t("lifecycle.promote.catalog")}
          empty={t("lifecycle.promote.none")}
        />
        {missing && <p className={s.error}>{t("lifecycle.promote.pickMissing")}</p>}
        {note != null && <p className={s.note}>{note}</p>}
      </div>}</QueryState>
    );
  const used = [...new Set((members.data?.items ?? []).map((m) => m.position?.trim()).filter((p): p is string => Boolean(p) && p !== employee.position))].slice(0, SUGGESTIONS);
  return (
    <QueryState q={titles} layout="form">{() => <div className={s.block}>
      {fact}
      <Field label={t("lifecycle.promote.position")} required={false} hint={t("lifecycle.promote.free")} error={missing ? t("lifecycle.promote.missing") : undefined}>
        {(p) => <TextInput {...p} value={value} maxLength={100} onChange={(e) => onChange(e.target.value)} />}
      </Field>
      {used.length > 0 && (
        <div className={s.chips} role="group" aria-label={t("lifecycle.promote.suggest")}>
          <span className={s.chipsLabel} aria-hidden>{t("lifecycle.promote.suggest")}</span>
          {used.map((pos) => (
            <Button key={pos} variant="ghost" className={s.suggestion} aria-pressed={value.trim() === pos} onClick={() => onChange(pos)}>{pos}</Button>
          ))}
        </div>
      )}
      {note != null && <p className={s.note}>{note}</p>}
    </div>}</QueryState>
  );
}
