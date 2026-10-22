// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Building2 } from "lucide-react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { FORMATS } from "../../../lib/pure/formats";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { entityName } from "../../../reference/entity/domain/names";
import { changeRegistration, ENTITY_READS } from "../api";
import { registrationOf, workplaceName } from "../domain/view";
import { EntityError } from "./entity-error";
import { FreshEntity } from "./fresh-entity";


/** Host component loading the freshest entity data when mounting the sheet */
export function WorkplaceRegistrationChangeHost({
  entityId,
  workplaceId,
  onClose,
}: {
  entityId: string;
  workplaceId: string;
  onClose: () => void;
}) {
  return (
    <FreshEntity id={entityId}>
      {(e) => {
        const w = e.workplaces.find((x) => x.id === workplaceId);
        return w ? <WorkplaceRegistrationChangeSheet e={e} w={w} onClose={onClose} /> : null;
      }}
    </FreshEntity>
  );
}

/**
 * Change or replace workplace business registration link or sub-serial (REG-b-crud-g11 / MR-18).
 * Provides dated replacement with audit trail.
 */
export function WorkplaceRegistrationChangeSheet(props: {
  e: LegalEntity;
  w: Workplace;
  onClose: () => void;
}) {
  const [{ e, w }] = useState(props);
  const { onClose } = props;
  const today = todayKst();
  const name = workplaceName(w);
  const currentReg = registrationOf(e, w.registration_id);

  const [selectedReg, setSelectedReg] = useState<string>(w.registration_id ?? "");
  const [subSerial, setSubSerial] = useState<string>(w.sub_serial ?? "");
  const [from, setFrom] = useState<string>(today);
  const [reason, setReason] = useState("");

  const chosenReg = e.registrations.find((r) => r.id === selectedReg);
  const isUnitTax = Boolean(chosenReg?.current?.unit_taxation);

  const targetRegId = selectedReg === "" ? null : selectedReg;
  const targetSubSerial = isUnitTax ? subSerial.trim() : null;

  const currentRegId = w.registration_id ?? null;
  const currentSubSerial = w.sub_serial ?? null;

  const changed =
    targetRegId !== currentRegId || (isUnitTax && targetSubSerial !== currentSubSerial);

  const subSerialValid = !isUnitTax || (targetSubSerial !== null && targetSubSerial.length === FORMATS.subSerial.max);
  const dateValid = from !== "" && from <= today;

  const ready = changed && subSerialValid && dateValid && reason.trim() !== "";

  const save = useCommand({
    run: (_: undefined, key: string) =>
      changeRegistration(key, w.id, {
        registration_id: targetRegId,
        sub_serial: targetSubSerial,
        effective_from: from,
        reason_code: reason.trim(),
      }),
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t("workplace.regChange.saved", { name }),
    onSuccess: onClose,
  });

  const hold = !changed
    ? t("workplace.regChange.same")
    : !dateValid
      ? t("workplace.regChange.pickDate")
      : isUnitTax && !subSerialValid
        ? t("workplace.problem.subSerial")
        : !reason.trim() ? t("setup.entityBulk.datedNeeded") : null;

  const regOptions = [
    ...e.registrations
      .filter((r) => !r.closed_on)
      .map((r) => {
        const holder =
          r.holder_workplace_id && r.holder_workplace_id !== w.id
            ? e.workplaces.find((wp) => wp.id === r.holder_workplace_id)?.current?.name
            : undefined;
        const brnDisplay = r.brn?.display ?? r.current?.trade_name ?? entityName(e);
        const tag = r.current?.unit_taxation
          ? t("workplace.regMode.UNIT_TAXATION_SUB")
          : r.id === w.registration_id
            ? t("orgStructure.wp.ownCert")
            : holder
              ? `${t("workplace.regMode.EXISTING")} · ${holder}`
              : t("workplace.regMode.EXISTING");
        return {
          value: r.id,
          label: `${brnDisplay} (${tag})`,
        };
      }),
    {
      value: "",
      label: t("workplace.regChange.none"),
    },
  ];

  return (
    <Sheet
      open
      wide
      kicker={
        <>
          <Building2 size={14} aria-hidden />
          {t("workplace.regChange.kicker", { entity: entityName(e), name })} · {currentReg?.brn?.display ?? t("workplace.noRegistration")}
        </>
      }
      title={t("workplace.regChange.title", { name })}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        ready ? (
          <div>{t(targetRegId ? "workplace.regChange.consequence" : "workplace.regChange.unlinked", { name, date: fmtDate(from) })}</div>
        ) : (
          <div>{hold}</div>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? (
            <Button
              variant="primary"
              onClick={() => save.mutate(undefined)}
              disabled={save.isPending}
            >
              {t("workplace.regChange.save")}
            </Button>
          ) : (
            <DisabledReason reason={hold!} control={(p) => <Button variant="primary" {...p}>{t("workplace.regChange.save")}</Button>} />
          )}
        </>
      }
    >
      <ChoiceField
        label={t("workplace.regChange.target")}
        required
        options={regOptions}
        value={selectedReg}
        onChange={(v) => setSelectedReg(String(v))}
      />

      {isUnitTax && (
        <MaskedField label={t("workplace.field.subSerial")} required format={FORMATS.subSerial} value={subSerial} onChange={setSubSerial} />
      )}

      <DateField
        label={t("workplace.regChange.from")}
        required
        value={from}
        onChange={setFrom}
        today={today}
      />

      <Field label={t("workplace.regChange.reason")} required>{(f) => <TextInput {...f} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
    </Sheet>
  );
}
