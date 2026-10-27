import { FileText, Lock } from "lucide-react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { workplaceName } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { EntityError } from "./entity-error";
import { FreshEntity } from "./fresh-entity";
import { useWorkplaceAttach, ATTACH_MODES, type WorkplaceAttach } from "./use-workplace-attach";
import { RegistrationChoice } from "./workplace-registration-choice";

const FOOT_ID = "workplace-attach-reason";

/** 「attach a registration」 for one workplace, from the entity as read when the sheet opens (the choices depend on it). */
export function AttachHost({ entityId, workplaceId, onClose }: { entityId: string; workplaceId: string; onClose: () => void }) {
  return (
    <FreshEntity id={entityId}>
      {(e) => {
        const w = e.workplaces.find((x) => x.id === workplaceId);
        return w ? <WorkplaceAttachSheet e={e} w={w} onClose={onClose} /> : null;
      }}
    </FreshEntity>
  );
}

/**
 * Attach a certificate to a workplace that has none (org-03, catalog company-18): its own, typed beside the kept original,
 * one the entity already holds free, or a sub-workplace serial of the unit-taxation one; then from when it files under it.
 */
export function WorkplaceAttachSheet({ e, w, onClose }: { e: LegalEntity; w: Workplace; onClose: () => void }) {
  const c = useWorkplaceAttach(e, w, onClose);
  const name = workplaceName(w);
  return (
    <Sheet
      open
      size="lg"
      kicker={<><FileText size={14} aria-hidden />{t("entityOps.attach.kicker", { entity: entityName(e), name })}</>}
      title={t("entityOps.attach.title", { name })}
      onClose={onClose}
      pending={c.save.isPending}
      notice={<EntityError error={c.save.error} />}
      consequence={<Foot c={c} name={name} />}
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {c.ready ? (
            <Button variant="primary" onClick={() => c.save.mutate(undefined)} disabled={c.save.isPending}>{t(c.mode === "NOT_REQUIRED" ? "entity.edit.save" : "entityOps.attach.save")}</Button>
          ) : (
            <Button variant="primary" aria-disabled aria-describedby={FOOT_ID} onClick={() => undefined}>{t(c.mode === "NOT_REQUIRED" ? "entity.edit.save" : "entityOps.attach.save")}</Button>
          )}
        </>
      }
    >
      <RegistrationChoice e={e} c={c} modes={ATTACH_MODES} required />
      {c.mode !== null && (
        <DateField label={t("entityOps.attach.from")} required value={c.from || c.since} onChange={c.setFrom} today={c.today}  />
      )}
    </Sheet>
  );
}

function Foot({ c, name }: { c: WorkplaceAttach; name: string }) {
  if (!c.ready)
    return (
      <span id={FOOT_ID}>
        <Lock size={14} aria-hidden /> {t(c.mode === null ? "entityOps.attach.pickWay" : c.since > c.today ? "entityOps.attach.future" : "entityOps.attach.fillFirst")}
      </span>
    );
  return <span>{t(c.mode === "NOT_REQUIRED" ? "workplace.answer.consequence" : "entityOps.attach.consequence", { name, date: fmtDate(c.since) })}</span>;
}
