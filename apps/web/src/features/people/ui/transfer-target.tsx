import { PlacePath } from "./place-path";
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Marker } from "../../../ui/field/field";
import { PathPicker } from "../../../ui/path-picker/path-picker";
import type { PlaceOption } from "../domain/register-place";
import { placeText } from "../present";
import s from "./lifecycle.module.css";

type Unit = components["schemas"]["OrgUnitHead"];

/** One unit out of `options`, searched by its full path with its headcount (the transfer and group transfer sheets). */
export function UnitTarget({ label, icon, options, units, value, onChange, error, note }: {
  label: string;
  icon: ReactNode;
  options: readonly PlaceOption[];
  units: Unit[];
  value: string;
  onChange: (unitId: string) => void;
  error?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className={s.block} data-invalid={error != null || undefined}>
      <span className={s.flabel}>{label}<Marker required /></span>
      <PathPicker
        options={options.map((o) => ({ id: o.unit.id, text: placeText(units, o), content: <PlacePath option={o} units={units} />, count: t("register.place.count", { n: o.unit.headcount }) }))}
        icon={icon}
        value={value}
        onChange={onChange}
        placeholder={t("register.place.unitPlaceholder")}
        label={label}
        openLabel={t("register.place.open")}
        invalid={error != null}
      />
      {note != null && <p className={s.note}>{note}</p>}
      {error != null && <p className={s.error}>{error}</p>}
    </div>
  );
}
