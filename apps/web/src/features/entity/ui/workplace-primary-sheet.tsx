import { useState } from "react";
import { Building2, Lock } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { Sheet } from "../../../ui/sheet/sheet";
import { setRoles } from "../api";
import { FreshEntity } from "./fresh-entity";
import { addressLine, workplaceName } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { STRUCTURE_READS } from "../../../reference/org/api";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

const OFFICE_ONLY = "office-only";

/**
 * representative-workplace change (S5-primary): one operation that names the current holder, so a legal entity never has none or two
 * (I-1). head office stays apart, with its own "set head office" (I-2). Nothing is preselected.
 */
export function WorkplacePrimarySheet({ entityId, setup, onClose }: { entityId: string; setup: boolean; onClose: () => void }) {
  return <FreshEntity id={entityId}>{(e) => <Body e={e} setup={setup} onClose={onClose} />}</FreshEntity>;
}

function Body({ e, setup, onClose }: { e: LegalEntity; setup: boolean; onClose: () => void }) {
  const open = e.workplaces.filter((w) => !w.closed_on);
  const current = open.find((w) => w.is_primary);
  const head = open.find((w) => w.id === e.head_office_workplace_id);
  const [to, setTo] = useState<string | null>(null);
  const [headTo, setHeadTo] = useState<string | null>(null);
  const [designating, setDesignating] = useState(false);
  const chosen = open.find((w) => w.id === to);
  const newHead = headTo === OFFICE_ONLY ? null : open.find((w) => w.id === headTo);
  const describe = (w: (typeof open)[number]) => [addressLine(w.current?.address).split(" ").slice(0, 2).join(" "), t("orgStructure.peopleCount", { count: w.headcount })].filter(Boolean).join(" · ");
  const save = useCommand({
    run: (_: undefined, key: string) =>
      // The server sets the head office as sent (absent = none), so the current one is always sent back.
      setRoles(key, e.id, {
        primary_workplace_id: to ?? current?.id ?? null,
        head_office_workplace_id: headTo === OFFICE_ONLY ? null : (headTo ?? e.head_office_workplace_id ?? null),
        head_office_has_no_workplace: headTo === OFFICE_ONLY ? true : headTo ? false : e.head_office_has_no_workplace,
      }),
    invalidates: STRUCTURE_READS,
    announce: () => t("workplace.primary.done", { name: chosen ? workplaceName(chosen) : newHead ? workplaceName(newHead) : "" }),
    onSuccess: onClose,
  });
  const ready = Boolean(to || headTo);
  const reasonId = "primary-reason";
  return (
    <Sheet
      open
      kicker={<><Building2 size={14} aria-hidden />{entityName(e)}</>}
      title={t("workplace.primary.title")}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        ready ? (
          <>
            {chosen && <span>{t("workplace.primary.consequence", { from: current ? workplaceName(current) : "—", to: workplaceName(chosen) })}</span>}
            {headTo && <span>{newHead ? t("workplace.primary.headConsequence", { name: workplaceName(newHead) }) : t("workplace.primary.headOfficeOnly")}</span>}
            <Muted>{chosen ? t("workplace.primary.effect", { name: workplaceName(chosen) }) : t("workplace.primary.headEffect")}{setup && ` ${t("workplace.primary.undoable")}`}</Muted>
          </>
        ) : (
          <span id={reasonId} className={css.footReason}><Lock size={14} aria-hidden />{t("workplace.primary.pick")}</span>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? (
            <Button variant="primary" onClick={() => save.mutate(undefined)}>{t(to ? "workplace.primary.title" : "workplace.primary.headSave")}</Button>
          ) : (
            <Button variant="primary" aria-disabled aria-describedby={reasonId}>{t("workplace.primary.title")}</Button>
          )}
        </>
      }
    >
      <ChoiceField
        label={t("workplace.primary.new")}
        required
        options={open.map((w) => ({ value: w.id, label: workplaceName(w), description: w.is_primary ? undefined : describe(w), disabled: w.is_primary ? t("workplace.primary.now") : undefined }))}
        value={to}
        onChange={setTo}
      />
      <section className={css.stack} aria-labelledby="head-office-h">
        <h3 id="head-office-h" className="field__label">{t("workplace.headOffice")}</h3>
        <div className="card card__body">
          <p className="row">
            <Chip>{t("workplace.headOffice")}</Chip>
            <b>{head ? workplaceName(head) : e.head_office_has_no_workplace ? t("workplace.primary.officeOnly") : t("workplace.primary.headUnset")}</b>
            <Muted>{t("workplace.primary.headStays")}</Muted>
          </p>
          {designating ? (
            <ChoiceField
              label={t("workplace.primary.headPick")}
              required
              options={[...open.map((w) => ({ value: w.id, label: workplaceName(w), disabled: w.id === head?.id ? t("workplace.primary.headNow") : undefined })), { value: OFFICE_ONLY, label: t("workplace.primary.officeOnly") }]}
              value={headTo}
              onChange={setHeadTo}
            />
          ) : (
            <Button variant="ghost" id="head-office-designate" onClick={() => setDesignating(true)}>{t("workplace.primary.designate")}</Button>
          )}
        </div>
        <p className={css.note}>{t("workplace.primary.officeHint")}</p>
      </section>
    </Sheet>
  );
}
