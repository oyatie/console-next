import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { treeQuery } from "../api";
import s from "./records.module.css";

/** The workplace a records view shows (labelled "unit", never a second "scope" beside the topbar's): every workplace in reach. */
export function ScopePicker({ value, onChange }: { value?: string; onChange: (id: string | undefined) => void }) {
  const tree = useQuery(treeQuery());
  const places = (tree.data?.nodes ?? []).filter((n) => n.kind === "WORKPLACE");
  return (
    <div className={s.scopeSelect}>
      <Field label={t("attendanceRecords.scope.label")} required={null}>
        {(p) => (
          <SelectInput {...p} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
            {value && !places.some(n => n.id === value) && <option value={value} disabled>{t(tree.isPending ? "common.loading" : "attendanceRecords.scope.unavailable")}</option>}
            <option value="">{tree.data && !tree.error ? t("attendanceRecords.scope.all", { count: places.length }) : t("attendanceRecords.scope.allUnknown")}</option>
            {places.map((n) => <option key={n.id} value={n.id}>{t("attendanceRecords.scope.place", { name: n.name, count: n.people })}</option>)}
          </SelectInput>
        )}
      </Field>
    </div>
  );
}
