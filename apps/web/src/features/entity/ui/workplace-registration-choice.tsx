import { t } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { FORMATS } from "../../../lib/pure/formats";
import { Check } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { SectionConfirm } from "../../../ui/section-confirm/section-confirm";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { entityName } from "../../../reference/entity/domain/names";
import type { RegMode, WorkplaceDraft, WpProblem } from "../domain/workplace";
import { sectionTitle } from "../present";
import { AddressSection } from "./address-section";
import { BusinessSection } from "./business-section";
import { KeptCertificates } from "./kept-certificates";
import { CertificateSection } from "./certificate-section";
import { IdentitySection } from "./identity-section";
import { RefPick } from "./ref-pick";
import type { WorkplaceCreate } from "./use-workplace-create";

const REG_SECTIONS = [["identity", IdentitySection], ["address", AddressSection], ["business", BusinessSection], ["certificate", CertificateSection]] as const;
const MODES: readonly RegMode[] = ["NEW", "EXISTING", "UNIT_TAXATION_SUB", "NOT_REQUIRED", "LATER"];
type Picked = Pick<WorkplaceDraft, "regMode" | "registrationId" | "subSerial"> & Partial<Pick<WorkplaceDraft, "notRegisteredReason" | "isAbstract">>;
/** What the choice reads and sets: the add sheet's state, or the attach sheet's (org-03), which has no "later". */
export type RegistrationChoiceState = Pick<WorkplaceCreate, "free" | "unit" | "reg" | "askVat" | "vat" | "setVat"> & {
  w: Picked;
  set<K extends keyof Picked>(k: K, v: Picked[K]): void;
  mode: RegMode | null;
  problems: { subSerial?: WpProblem; notRegisteredReason?: WpProblem };
};

/**
 * business registration (optional): the workplace's own certificate, one already entered that no workplace holds, a sub-workplace of a
 * unit-taxation registration, or later. An impossible way stays visible with its reason.
 */
export function RegistrationChoice({ e, c, modes = MODES, required = false }: { e: LegalEntity; c: RegistrationChoiceState; modes?: readonly RegMode[]; required?: boolean }) {
  const held = e.registrations.find((r) => r.holder_workplace_id && !r.closed_on);
  const holder = held && e.workplaces.find((w) => w.id === held.holder_workplace_id)?.current?.name;
  const why: Record<RegMode, string | null> = {
    NEW: null,
    EXISTING: c.free.length ? null : held ? t("workplace.create.existingHeld", { brn: held.brn?.display ?? "", holder: holder ?? "" }) : t("workplace.create.existingNone"),
    UNIT_TAXATION_SUB: c.unit ? null : t("workplace.create.unitOff", { entity: entityName(e) }),
    NOT_REQUIRED: null,
    LATER: null,
  };
  const hint = (m: RegMode) =>
    why[m] ?? (m === "EXISTING" ? t("workplace.create.existingFree", { brn: c.free.map((r) => r.brn?.display ?? r.current?.trade_name ?? "").join(", ") }) : t(`workplace.create.regHint.${m}`));
  const set = c.set;
  return (
    <>
      <ChoiceField
        label={t("workplace.field.regMode")}
        required={required}
        columns={2}
        options={modes.map((m) => ({ value: m, label: t(`workplace.regMode.${m}`), description: why[m] === null ? hint(m) : undefined, disabled: why[m] ?? undefined }))}
        value={c.w.regMode}
        onChange={(v) => set("regMode", v as RegMode)}
      />
      {c.mode === "EXISTING" && c.free.length > 1 && (
        <PickOne
          label={t("workplace.field.registration")}
          group={t("workplace.field.registration")}
          empty={t("placement.noMatch")}
          required
          options={c.free.map((r) => ({ value: r.id, label: r.brn?.display ?? entityName(e), description: entityName(e) }))}
          value={c.w.registrationId}
          onChange={(v) => set("registrationId", v)}
        />
      )}
      {/* The certificate typed here: one already attached to the entity (e.g. at its creation) is offered first, never uploaded twice. */}
      {c.mode === "NEW" && <KeptCertificates entityId={e.id} doc={c.reg.doc} onDoc={(d) => c.reg.setDocId(d?.id ?? null)} />}
      {c.mode === "NEW" &&
        REG_SECTIONS.map(([key, Body]) => (
          <SectionConfirm key={key} title={sectionTitle(key)} owner={t("entity.owner.certificate")} missing={c.reg.showRequired ? c.reg.missing[key] : 0}>
            <Body s={c.reg} />
          </SectionConfirm>
        ))}
      {c.askVat && (
        <ChoiceField
          label={t("entity.field.vatUnitMode")}
          required
          options={(["PER_WORKPLACE", "CONSOLIDATED_PAYMENT"] as const).map((m) => ({ value: m, label: t(`entity.vat.${m}`), description: t(`workplace.vat.hint.${m}`) }))}
          value={c.vat}
          onChange={(v) => c.setVat(v as typeof c.vat)}
        />
      )}
      {c.mode === "UNIT_TAXATION_SUB" && (
        <MaskedField label={t("workplace.field.subSerial")} required format={FORMATS.subSerial} value={c.w.subSerial} onChange={(v) => set("subSerial", v)} hint={t("workplace.field.subSerialHint")} error={c.problems.subSerial ? t(`workplace.problem.${c.problems.subSerial}`) : undefined} />
      )}
      {c.mode === "NOT_REQUIRED" && (
        <>
          <RefPick
            listKey="workplace_not_registered_reason"
            label={t("workplace.field.notRegisteredReason")}
            required
            value={c.w.notRegisteredReason ?? null}
            onChange={(v) => {
              set("notRegisteredReason", v);
              if (v?.code === "REMOTE_TELEWORK" || v?.code === "DISPATCH_CLIENT_SITE" || v?.code === "PROJECT_SITE_CLUSTER") {
                set("isAbstract", true);
              }
            }}
            error={c.problems.notRegisteredReason ? t(`workplace.problem.${c.problems.notRegisteredReason}`) : undefined}
          />
          <Check checked={c.w.isAbstract ?? false} onChange={(v) => set("isAbstract", v)}>
            {t("workplace.field.isAbstract")}
          </Check>
        </>
      )}
    </>
  );
}
