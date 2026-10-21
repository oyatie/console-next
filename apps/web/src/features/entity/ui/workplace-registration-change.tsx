// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { Building2 } from "lucide-react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
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

type Reason = "CHANGE" | "CORRECTION" | "MISTAKE";

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
export function WorkplaceRegistrationChangeSheet({
  e,
  w,
  onClose,
}: {
  e: LegalEntity;
  w: Workplace;
  onClose: () => void;
}) {
  const footId = useId();
  const today = todayKst();
  const name = workplaceName(w);
  const currentReg = registrationOf(e, w.registration_id);

  const [selectedReg, setSelectedReg] = useState<string>(w.registration_id ?? "");
  const [subSerial, setSubSerial] = useState<string>(w.sub_serial ?? "");
  const [from, setFrom] = useState<string>(today);
  const [reason, setReason] = useState<Reason>("CHANGE");

  const chosenReg = e.registrations.find((r) => r.id === selectedReg);
  const isUnitTax = Boolean(chosenReg?.current?.unit_taxation);

  const targetRegId = selectedReg === "" ? null : selectedReg;
  const targetSubSerial = isUnitTax ? subSerial.trim() : null;

  const currentRegId = w.registration_id ?? null;
  const currentSubSerial = w.sub_serial ?? null;

  const changed =
    targetRegId !== currentRegId || (isUnitTax && targetSubSerial !== currentSubSerial);

  const subSerialValid = !isUnitTax || (targetSubSerial !== null && targetSubSerial.length === 4);
  const dateValid = from !== "" && from <= today;

  const ready = changed && subSerialValid && dateValid;

  const save = useCommand({
    run: (_: undefined, key: string) =>
      changeRegistration(key, w.id, {
        registration_id: targetRegId,
        sub_serial: targetSubSerial,
        effective_from: from,
        reason_code: reason,
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
        : null;

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
            ? t("workplace.regChange.current")
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
      label: `${t("workplace.regChange.none")} (${t("workplace.noRegistration")})`,
    },
  ];

  const reasonOptions = (["CHANGE", "CORRECTION", "MISTAKE"] as const).map((code) => ({
    value: code,
    label: t(`workplace.regChange.reason.${code}`),
  }));

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
          <div>{t("workplace.regChange.consequence", { name, date: fmtDate(from) })}</div>
        ) : (
          <div id={footId}>{hold}</div>
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
            <Button
              variant="primary"
              aria-disabled
              aria-describedby={footId}
              onClick={() => undefined}
            >
              {t("workplace.regChange.save")}
            </Button>
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
        <Field
          label={t("workplace.field.subSerial")}
          required
        >
          {(f) => (
            <TextInput
              {...f}
              value={subSerial}
              maxLength={4}
              placeholder="0001"
              onChange={(evt) => setSubSerial(evt.target.value.replace(/\D/g, ""))}
            />
          )}
        </Field>
      )}

      <DateField
        label={t("workplace.regChange.from")}
        required
        value={from}
        onChange={setFrom}
        today={today}
      />

      <ChoiceField
        label={t("workplace.regChange.reason")}
        required
        columns={3}
        options={reasonOptions}
        value={reason}
        onChange={(v) => setReason(v as Reason)}
      />
    </Sheet>
  );
}
