import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { startProblem, type Start } from "../domain/grants";
import { grantsQuery, type PreviewItem } from "../api";
import { periodText, scopeText } from "../present";
import { useOrgRoots } from "./use-org-roots";
import s from "./access.module.css";

/** What the person holds now, before anything is added (ROL-M4-grant-op: the current grant shows before preview). */
export function CurrentGrants({ accountId }: { accountId: string }) {
  const roots = useOrgRoots();
  const held = useQuery(grantsQuery({ account_id: accountId }));
  const items = held.data?.items ?? [];
  return (
    <div className={s.stack} role="group" aria-labelledby="ac-current">
      <strong id="ac-current">{t("accessGrants.current")}</strong>
      {held.isPending ? <span className="muted" role="status">{t("common.loading")}</span>
        : items.length ? (
          <ul className="list-plain">
            {items.map((g) => <li key={g.id}><strong>{g.role_name_ko}</strong> · {scopeText(roots, g.scope)} · {periodText(g)}</li>)}
          </ul>
        ) : <span className="muted">{t("accessGrants.current.none")}</span>}
    </div>
  );
}

/** Read-only composed lines; the confirmation footer states their activation deadline. */
export function GrantPreviewSummary({ items, named }: { items: readonly PreviewItem[]; named: readonly string[] }) {
  return (
    <ul className="list-plain">
      {items.map((item) => (
        <li key={item.index} className={s.stack}>
          <strong>{named[item.index]}</strong>
        </li>
      ))}
    </ul>
  );
}

/** When an operating grant starts: on save, or from a chosen later day (ROL-M4-grant-op). Nothing is preselected. */
export function StartPick({ value, onChange, today, tried }: { value: Start; onChange: (v: Start) => void; today: string; tried: boolean }) {
  return (
    <div className={s.when}>
      <ChoiceField
        label={t("accessGrants.start")}
        required
        options={(["NOW", "DATE"] as const).map((k) => ({ value: k, label: t(`accessGrants.start.${k}`), description: t(`accessGrants.start.${k}.hint`) }))}
        value={value.when}
        onChange={(when) => onChange({ ...value, when })}
        error={tried && !value.when ? t("accessGrants.start.missing") : undefined}
      />
      {value.when === "DATE" && (
        <DateField
          label={t("accessGrants.start.date")}
          required
          value={value.date}
          onChange={(date) => onChange({ ...value, date })}
          today={today}
          min={today}
          error={tried && startProblem(value, today) ? t("accessGrants.start.date.missing") : undefined}
        />
      )}
    </div>
  );
}
