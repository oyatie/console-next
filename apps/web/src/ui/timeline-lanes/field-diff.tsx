import { t } from "@console/i18n";
import s from "./timeline-lanes.module.css";
const arrow = " → ";

export type FieldChange = { field: string; label: string } & (
  | { masked: true; before?: never; after?: never }
  | { masked?: false; before: string | null; after: string | null }
);

/** Masking is checked before values enter the DOM, including collapsed text. */
export function FieldDiff({ fields, corrected = false }: { fields: readonly FieldChange[]; corrected?: boolean }) {
  return <dl className={s.diff}>{fields.map((change) => <div key={change.field}>
    <dt>{change.label}</dt>
    <dd>{change.masked ? t("timeline.restricted") : <>
      <span className="sr-only">{t("timeline.before")}</span>
      {corrected ? <del><Value value={change.before} /></del> : <Value value={change.before} />}
      <span aria-hidden="true">{arrow}</span>
      <span className="sr-only">{t("timeline.after")}</span>
      <Value value={change.after} />
    </>}</dd>
  </div>)}</dl>;
}

function Value({ value }: { value: string | null }) {
  if (value === null) return <span>{t("timeline.noValue")}</span>;
  return value.length > 180
    ? <details className={s.long}><summary>{t("timeline.showFull")}</summary><span>{value}</span></details>
    : <span>{value}</span>;
}
