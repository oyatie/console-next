import { PlacePath } from "./place-path";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { entityNameText } from "../../../reference/entity/present";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import type { Draft, Gap, Where } from "../domain/register";
import { Building2 } from "lucide-react";
import { PathPicker } from "../../../ui/path-picker/path-picker";
import { placeText } from "../present";
import type { PlaceOption, workplaceChoices } from "../domain/register-place";
import s from "./register.module.css";

type Unit = components["schemas"]["OrgUnitHead"];
type Set = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

/**
 * "where does this person go": three chips of equal weight, nothing chosen (spec E3); unplaced can be completed later. Then the
 * place itself, and what placing does to that unit's headcount from the start date and to which workplace's employee register.
 */
export function RegisterPlace({ d, set, units, options, workplaces, shown, hireLabel }: {
  d: Draft;
  set: Set;
  units: Unit[];
  options: PlaceOption[];
  /** The workplaces to pick from when the chosen unit is not under a registered one (else empty). */
  workplaces: ReturnType<typeof workplaceChoices>;
  shown: ReadonlySet<Gap>;
  /** The start date as `MM-DD`, once chosen. */
  hireLabel: string | null;
}) {
  const chosen = options.find((o) => o.unit.id === d.unitId);
  const leaf = chosen?.unit.name ?? "";
  const echo = !chosen
    ? t("register.place.hint")
    : hireLabel
      ? t("register.place.echo", { unit: leaf, n: chosen.unit.headcount, date: hireLabel, after: chosen.unit.headcount + 1, site: chosen.site })
      : t("register.place.echoNoDate", { unit: leaf, n: chosen.unit.headcount, site: chosen.site });
  return (
    <div className={s.block}>
      <ChoiceField
        label={t("register.where")} required={false}
        look="chips"
        options={[
          { value: "unit", label: t("register.where.unit") },
          { value: "site", label: t("register.where.site") },
          { value: "none", label: t("register.where.none") },
        ]}
        value={d.where ?? (chosen ? (chosen.unit.kind === "SITE" ? "site" : "unit") : null)}
        onChange={(v) => {
          set("where", v as Where);
          if (v !== d.where) set("unitId", "");
        }}
        error={shown.has("where") ? t("register.err.where") : undefined}
      />
      {d.where !== "none" && (
        <PathPicker
          options={options.map((o) => ({ id: o.unit.id, text: placeText(units, o), content: <PlacePath option={o} units={units} />, count: t("register.place.count", { n: o.unit.headcount }) }))}
          icon={<Building2 size={16} aria-hidden />}
          openLabel={t("register.place.open")}
          value={d.unitId}
          onChange={(v) => {
            set("unitId", v);
            // A place picked before the chips says which chip it is.
            const kind = options.find((o) => o.unit.id === v)?.unit.kind;
            if (v && !d.where) set("where", kind === "SITE" ? "site" : "unit");
          }}
          placeholder={t(d.where === "site" ? "register.place.sitePlaceholder" : "register.place.unitPlaceholder")}
          label={t("register.place.label")}
          invalid={shown.has("unit")}
        />
      )}
      {d.where !== "none" && <span className={`${s.placeEcho} ${shown.has("unit") ? s.err : s.hint}`}>{shown.has("unit") ? t("register.err.unit") : echo}</span>}
      {d.unitId && workplaces.length > 0 && (
        <ChoiceField
          label={t("register.workplace")}
          required
          note={t("register.workplace.note", { unit: chosen?.unit.name ?? "" })}
          look="chips"
          options={workplaces.map((w) => ({ value: w.workplaceId, label: `${entityNameText(w.entityRecord)} · ${w.site}`, content: <><EntityName entity={w.entityRecord} /> · {w.site}</> }))}
          value={d.workplaceId || null}
          onChange={(v) => set("workplaceId", v)}
          error={shown.has("workplace") ? t("register.err.workplace") : undefined}
        />
      )}
      {d.unitId && workplaces.length === 0 && shown.has("workplace") && <span className={s.err}>{t("register.err.noWorkplace")}</span>}
    </div>
  );
}
