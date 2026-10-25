import { PlacePath } from "./place-path";
import { entityNames } from "../../../reference/entity/domain/names";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Lock } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { PAY_UNIT, label } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { FORMATS, phoneE164 } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { unitsQuery } from "../../../reference/org/api";
import { entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { Checks } from "../../../ui/choice/checks";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { PathPicker } from "../../../ui/path-picker/path-picker";
import { Composer } from "../../../ui/composer/composer";
import { rehireEmployee } from "../api";
import { retirementDate } from "../domain/employment";
import { EMPLOYMENT_TYPES, type EmploymentType, type Where } from "../domain/register";
import { PAY_UNITS, type PayUnit } from "../domain/facts";
import { placeOptions } from "../domain/register-place";
import { placeText } from "../present";
import { useTrailPreview } from "./lifecycle-trail-preview";
import s from "./register.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };
const NEEDED = ["hire", "unit", "type", "position", "end"] as const;

/**
 * Rehire (spec E3-rehire): from a retained exit, a new period of the same person. The earlier period is named and
 * not changed; start date, place, type and title are picked, nothing in advance. The server keeps the same employee
 * number and history and has no service-continuity choice yet (both said, never faked).
 */
export function RehireSheet({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (message: string) => void }) {
  const e = d.employee;
  const today = todayKst();
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const [where, setWhere] = useState<Where | null>(null);
  const options = placeOptions(units, roots, entities, where);
  const [f, setF] = useState({ hire: "", unit: "", type: null as EmploymentType | null, position: e.position ?? "", end: "", phone: "", pay: "", payUnit: null as PayUnit | null });
  const preview = useTrailPreview(["REHIRE"], { effective_date: f.hire || undefined });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [acknowledged, setAcknowledged] = useState(false);
  const [tried, setTried] = useState(false);
  const minHire = e.exit_date ? retirementDate(e.exit_date) : undefined;
  const dateRefusal = e.exit_date ? t("people.refusal.rehire_date_not_after_exit", { date: fmtDate(retirementDate(e.exit_date)) }) : undefined;
  const gaps: (typeof NEEDED[number] | "phone" | "pay" | "payUnit")[] = NEEDED.filter((k) => (k === "end" ? f.type === "CONTRACT" && !f.end : k === "type" ? !f.type : k === "hire" ? !f.hire || Boolean(minHire && f.hire < minHire) : !f[k]));
  if (!d.employment) {
    if (!phoneE164(f.phone)) gaps.push("phone");
    if (!f.pay) gaps.push("pay");
    if (!f.payUnit) gaps.push("payUnit");
  }
  const place = options.find((o) => o.unit.id === f.unit);
  const run = useCommand({
    run: (_: void, key: string) =>
      rehireEmployee(e.id, {
        hire_date: f.hire,
        employment_type: f.type!,
        org_unit_id: f.unit,
        position: f.position.trim(),
        company: place?.entityRecord ? entityNames(place.entityRecord).name : undefined,
        contract_end_date: f.type === "CONTRACT" ? f.end : undefined,
        phone: f.phone ? (phoneE164(f.phone) ?? FORMATS.phone.display(f.phone)) : undefined,
        base_pay_won: f.pay ? Number(f.pay) : undefined,
        pay_unit: f.payUnit ?? undefined,
        acknowledge_open_exit_case: acknowledged,
        idempotency_key: key,
      }),
    invalidates: ["/api/v1/employees/{id}/lifecycle-events", "/api/v1/employees", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/org-structure"],
    awaitFirstRead: true,
    onSuccess: () => onDone(t("register.rehire.done", { name: e.name, date: f.hire })),
  });
  const submit = () => (setTried(true), gaps.length === 0 && (!d.rehire_exit_case?.acknowledgement_required || acknowledged) && run.mutate());
  const status = f.hire > today ? t("register.foot.statusFuture") : t("register.foot.statusNow");
  return (
    <Composer
      wide
      kicker={<><Lock size={12} aria-hidden />{t("register.rehire.kicker", { name: e.name, number: e.employee_number ?? "—" })}</>}
      title={t("register.rehire.title")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={(code) => code === "rehire_date_not_after_exit" ? dateRefusal : undefined} />}
      consequence={
        gaps.length > 0 ? (
          <b className={tried ? s.err : undefined}>{t("register.foot.todo", { n: gaps.length, list: gaps.map((g) => g === "payUnit" ? t("facts.payUnit") : t(`register.field.${g === "unit" ? "unit" : g === "end" ? "contractEnd" : g}`)).join(" · ") })}</b>
        ) : (
          <b>{t("register.rehire.foot", { name: e.name, place: place ? placeText(units, place).split(" › ").slice(1).join(" › ") : "", type: label(TYPE, f.type!), status, date: fmtDate(f.hire), number: e.employee_number ?? "—" })}</b>
        )
      }
      sections={preview}
      action={{ kind: "rehire", mode: f.hire > today || !f.hire ? "schedule" : "apply", count: 1 }}
      onSubmit={() => { submit(); }}

    >
      <div className={s.form}>
        {d.rehire_exit_case?.acknowledgement_required && <>
          <ul>{d.rehire_exit_case.open_legs.map((leg) => <li key={leg}>{t(`exit.rehire.leg.${leg}` as "exit.rehire.leg.settlement")}</li>)}</ul>
          <Checks label={t("exit.rehire.acknowledge")} items={[{id:"open",label:t("exit.rehire.acknowledge")}]} value={acknowledged ? ["open"] : []} onChange={(v) => setAcknowledged(v.includes("open"))} error={tried && !acknowledged ? t("exit.error.rehire_exit_case_open") : undefined} />
        </>}

        <div className={s.before}>
          <span>{t("register.rehire.before", { name: e.name, number: e.employee_number ?? "—", place: [e.company, e.org_unit].filter(Boolean).join(" › "), from: fmtDate(e.hire_date), to: fmtDate(e.exit_date) })}</span>
          <Chip>{t("register.rehire.kept")}</Chip>
          <span className={s.hint}>{t("register.rehire.same")}</span>
        </div>
        <div className={s.block}>
          {/* The same three answers as a first registration (spec E3-rehire); unplaced is closed with why. */}
          <ChoiceField
            label={t("register.where")}
            required
            look="chips"
            options={[
              { value: "unit", label: t("register.where.unit") },
              { value: "site", label: t("register.where.site") },
              { value: "none", label: t("register.where.none"), disabled: t("register.where.noneClosed") },
            ]}
            value={where}
            onChange={(v) => (setWhere(v as Where), set("unit", ""))}
          />
          <PathPicker options={options.map((o) => ({ id: o.unit.id, text: placeText(units, o), content: <PlacePath option={o} units={units} />, count: t("register.place.count", { n: o.unit.headcount }) }))} icon={<Building2 size={16} aria-hidden />} value={f.unit} onChange={(v) => set("unit", v)} placeholder={t(where === "site" ? "register.place.sitePlaceholder" : "register.place.unitPlaceholder")} label={t("register.place.label")} openLabel={t("register.place.open")} invalid={tried && !f.unit} />
          {tried && !f.unit && <span className={s.err}>{t("register.err.unit")}</span>}
        </div>
        <div className={s.termsRow}>
          <DateField label={t("register.hire")} required today={today} min={minHire} presets={datePresets(today, ["nextMonday", "nextMonthFirst"])} value={f.hire} onChange={(v) => set("hire", v)} echo={f.hire ? t(f.hire > today ? "register.hire.future" : "register.hire.past") : undefined} error={tried && !f.hire ? t("register.err.hire") : tried && minHire && f.hire < minHire ? dateRefusal : undefined} showErrors={tried} />
          <ChoiceField label={t("register.type")} required look="chips" options={EMPLOYMENT_TYPES.map((v) => ({ value: v, label: label(TYPE, v) }))} value={f.type} onChange={(v) => set("type", v as EmploymentType)} error={tried && !f.type ? t("register.err.type") : undefined} />
        </div>
        {f.type === "CONTRACT" && <DateField label={t("register.contractEnd")} required today={today} min={f.hire || undefined} value={f.end} onChange={(v) => set("end", v)} error={tried && !f.end ? t("register.err.contractEnd") : undefined} />}
        <Field label={t("register.position")} required error={tried && !f.position.trim() ? t("register.err.position") : undefined}>
          {(p) => <TextInput {...p} value={f.position} onChange={(x) => set("position", x.target.value)} />}
        </Field>
        <div className={s.block}>
          <span className={s.flabel}>{t("register.rehire.service")}</span>
          <span className={s.hint}>{t("register.rehire.serviceClosed")}</span>
        </div>
        {!d.employment && <fieldset className={s.extra}>
          <legend className={s.flabel}>{t("register.rehire.profile")}</legend>
          <div className={s.extraRow}>
            <MaskedField label={t("register.phone")} required format={FORMATS.phone} value={f.phone} onChange={(v) => set("phone", v)} />
            <Field label={t("register.field.pay")} required>
              {(p) => <TextInput {...p} className="num" inputMode="numeric" value={f.pay ? fmtNumber(Number(f.pay)) : ""} onChange={(x) => set("pay", x.target.value.replace(/[^\d]/g, ""))} />}
            </Field>
          </div>
          <ChoiceField label={t("facts.payUnit")} required options={PAY_UNITS.map((u) => ({ value: u, label: label(PAY_UNIT, u) }))} value={f.payUnit} onChange={(u) => set("payUnit", u as PayUnit)} />
        </fieldset>}
      </div>
    </Composer>
  );
}
