import { useId } from "react";
import { Lock, MapPin } from "lucide-react";
import type { LegalEntity, WorkplaceKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { EntityError } from "./entity-error";
import { AddressField } from "../../../ui/address-field/address-field";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { addressLine, workplaceName } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { DistrictPick } from "./district-pick";
import { useAddressSearch } from "./use-ref";
import { KindChoice } from "./workplace-kind-choice";
import { RegistrationChoice } from "./workplace-registration-choice";
import { StatutoryChoices } from "./workplace-statutory-choices";
import { useWorkplaceCreate, type WorkplaceCreate } from "./use-workplace-create";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * add workplace (S5-create): one wide sheet over the chart. The legal entity is where it was opened; nothing is preselected,
 * and the foot says what is still missing until name, kind, withholding and social insurance are answered.
 */
export function WorkplaceCreateSheet({ e, kinds, setup, onClose, onSaved }: { e: LegalEntity; kinds?: readonly WorkplaceKind[]; setup: boolean; onClose: () => void; onSaved: (id: string, another: boolean) => void }) {
  // the kind list is ENT-KIND (MR-19); a server without it (or a failed read) saves without a kind and the section is not drawn.
  const kindsServed = kinds !== undefined;
  const c = useWorkplaceCreate(e, { kinds: kindsServed, onSaved });
  const search = useAddressSearch();
  const head = e.workplaces.find((w) => w.id === e.head_office_workplace_id);
  const own = c.mode === "NEW" || c.mode === "EXISTING";
  // org-18: a sibling with the same name is named as it is typed (two identical names cannot be told apart in pickers).
  const typed = c.w.name.trim();
  const twin = typed ? e.workplaces.find((x) => !x.closed_on && x.current?.name.trim() === typed) : undefined;
  return (
    <Sheet
      open
      wide
      kicker={<><MapPin size={14} aria-hidden />{t("workplace.create.kicker", { entity: entityName(e) })}</>}
      title={t("workplace.add")}
      onClose={onClose}
      pending={c.save.isPending}
      notice={<EntityError error={c.save.error} />}
      consequence={<Foot c={c} e={e} setup={setup} />}
      actions={<Actions c={c} onClose={onClose} />}
    >
      <div className={css.two}>
        <Field label={t("workplace.field.name")} required warning={twin ? t("entityOps.create.twin", { name: typed, address: addressLine(twin.current?.address) || "—" }) : undefined}>
          {(p) => <TextInput {...p} maxLength={200} placeholder={t("workplace.create.namePlaceholder")} value={c.w.name} onChange={(x) => c.set("name", x.target.value)} />}
        </Field>
        {!own && <DateField label={t("workplace.field.openedOn")} required={false} value={c.w.openedOn} onChange={(v) => c.set("openedOn", v)} today={c.today}  />}
      </div>
      {kinds && <KindChoice kinds={kinds} value={c.kind} onChange={c.setKind} headOffice={head ? workplaceName(head) : undefined} />}
      <RegistrationChoice e={e} c={c} />
      {!own && (
        <AddressField label={t("workplace.create.address")} required value={c.w.address} onChange={(v) => c.set("address", v && search.withCodes(v))} query={search.query} onQueryChange={search.setQuery} hits={search.hits} loading={search.loading} problem={search.problem}>
          <DistrictPick a={c.w.address} onChange={(a) => c.set("address", a)} />
        </AddressField>
      )}
      <StatutoryChoices e={e} c={c} />
    </Sheet>
  );
}

const FOOT_ID = "workplace-create-reason";

function Foot({ c, e, setup }: { c: WorkplaceCreate; e: LegalEntity; setup: boolean }) {
  if (!c.ready) {
    // company-38: the foot names exactly what is still open, so it never disagrees with the subtitle.
    const open = [
      c.missing.name && t("workplace.field.name"),
      c.missing.kind && t("workplace.create.kind"),
      c.missing.withholding && t("workplace.create.withholding"),
      c.missing.insurance && t("workplace.field.insurance"),
      c.problems.headOffice && t(e.biz_kind === "CORPORATION" ? "workplace.field.headOffice" : "workplace.field.mainPlace"),
      c.problems.address && t("workplace.create.address"),
    ].filter(Boolean);
    return (
      <span id={FOOT_ID} className={css.footReason}>
        <Lock size={14} aria-hidden />
        {open.length ? t("entityOps.create.open", { items: open.join(" · ") }) : t("workplace.create.fixFirst")}
      </span>
    );
  }
  const future = c.w.openedOn && c.w.openedOn > c.today && !(c.mode === "NEW" || c.mode === "EXISTING");
  const todo = [
    c.mode === "LATER" && t("workplace.create.todo.registration"),
    c.mode === "LATER" && c.w.address && !c.w.address.verified && t("workplace.create.todo.addressVerify"),
    c.ins === "ALL_ESTABLISHED_NUMBERS_LATER" && t("workplace.create.todo.numbers"),
    c.mode === "LATER" && !c.w.openedOn && t("workplace.create.todo.opened", { date: c.today }),
  ].filter(Boolean);
  return (
    <>
      <span>{future ? t("workplace.create.consequenceFuture", { entity: entityName(e), name: c.w.name.trim(), date: fmtDate(c.w.openedOn) }) : t("workplace.create.consequence", { entity: entityName(e), name: c.w.name.trim() })}</span>
      <span className="muted">
        {todo.length > 0 && t("workplace.create.todo", { items: todo.join(" · ") })}
        {setup && ` ${t("workplace.create.undoable")}`}
      </span>
    </>
  );
}

function Actions({ c, onClose }: { c: WorkplaceCreate; onClose: () => void }) {
  const id = useId();
  return (
    <>
      <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
      {c.ready && <Button id={`${id}-another`} onClick={() => c.save.mutate(true)}>{t("workplace.create.another")}</Button>}
      {c.ready ? (
        <Button variant="primary" onClick={() => c.save.mutate(false)}>{t("workplace.add")}</Button>
      ) : (
        <Button variant="primary" aria-disabled aria-describedby={FOOT_ID} onClick={() => undefined}>{t("workplace.add")}</Button>
      )}
    </>
  );
}
