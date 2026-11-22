import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { ExperienceSwitch } from "../../../ui/patterns/experience-switch";
import { treeQuery } from "../api";
import { ScopePickerConsole } from "./scope-picker-console";
import s from "./records.module.css";

const ALL_KEY = "__all__";

/** The workplace a records view shows (labelled "unit", never a second "scope" beside the topbar's): every workplace in reach. */
export function ScopePicker({ value, onChange, compact }: { value?: string; onChange: (id: string | undefined) => void; compact?: boolean }) {
  const tree = useQuery(treeQuery());
  const places = (tree.data?.nodes ?? []).filter((n) => n.kind === "WORKPLACE");
  const allLabel = tree.data && !tree.error ? t("attendanceRecords.scope.all", { count: places.length }) : t("attendanceRecords.scope.allUnknown");
  const consoleOptions = [
    ...(value && !places.some((n) => n.id === value)
      ? [{ id: value, label: t(tree.isPending ? "common.loading" : "attendanceRecords.scope.unavailable") }]
      : []),
    { id: ALL_KEY, label: allLabel },
    ...places.map((n) => ({ id: n.id, label: t("attendanceRecords.scope.place", { name: n.name, count: n.people }) })),
  ];
  const select = (props: Record<string, unknown>) => (
    <SelectInput {...props} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      {value && !places.some(n => n.id === value) && <option value={value} disabled>{t(tree.isPending ? "common.loading" : "attendanceRecords.scope.unavailable")}</option>}
      <option value="">{allLabel}</option>
      {places.map((n) => <option key={n.id} value={n.id}>{t("attendanceRecords.scope.place", { name: n.name, count: n.people })}</option>)}
    </SelectInput>
  );
  const consoleSelect = (
    <ScopePickerConsole
      compact={compact}
      value={value}
      allKey={ALL_KEY}
      allLabel={allLabel}
      options={consoleOptions}
      onChange={onChange}
    />
  );
  return (
    <ExperienceSwitch
      baseline={() =>
        compact ? (
          <div className={s.scopeCompact}>
            {select({ "aria-label": t("attendanceRecords.scope.label") })}
          </div>
        ) : (
          <div className={s.scopeSelect}>
            <Field label={t("attendanceRecords.scope.label")} required={null}>
              {(p) => select(p)}
            </Field>
          </div>
        )
      }
    >
      {() => <div className={compact ? s.scopeCompact : s.scopeSelect}>{consoleSelect}</div>}
    </ExperienceSwitch>
  );
}
