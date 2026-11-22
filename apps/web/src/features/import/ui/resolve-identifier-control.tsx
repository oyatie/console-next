// SPDX-License-Identifier: LicenseRef-Proprietary
import { useRef, useState } from "react";
import { t } from "@console/i18n";
import { FORMATS, complete, parseWith } from "../../../lib/pure/formats";
import { announce } from "../../../lib/react/announce";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import type { ImportDryRun, ImportRow } from "../domain/contract";
import type { Picks } from "../domain/steps";
import { idTypeLabel, importError } from "../present";
import { useRowIdentifierCommand } from "./use-resolve-commands";
import { useExpiry } from "./use-expiry";
import cs from "./import-console.module.css";

const REPAIR_ID_TYPES = ["RRN", "ARC", "DOMESTIC_RESIDENCE"] as const;
type RecordableIdType = (typeof REPAIR_ID_TYPES)[number];

function defaultIdTypeForDigits(digits: string): RecordableIdType | "" {
  const seventh = digits.length >= 7 ? digits[6] : undefined;
  if (seventh && "1234".includes(seventh)) return "RRN";
  if (seventh && "5678".includes(seventh)) return "ARC";
  return "";
}

/** Passkey step-up (`PII_RECORD`) registration number entry for an import row (`PRE_HIRE` `NOT_ISSUED` or invalid RRN/ARC/DOMESTIC_RESIDENCE). */
export function RowIdentifierControl({
  runId,
  row,
  picks,
  busy,
  onDryRun,
  onExpired,
}: {
  runId: string;
  row: ImportRow;
  picks: Picks;
  busy: boolean;
  onDryRun: (d: ImportDryRun) => void;
  onExpired: () => void;
}) {
  const input = useRef("");
  const manualType = useRef(false);
  const [value, setValue] = useState("");
  const [idType, setIdType] = useState<RecordableIdType | "">(() => {
    const existing = row.new_person?.id_type;
    return existing === "RRN" || existing === "ARC" || existing === "DOMESTIC_RESIDENCE" ? existing : "";
  });
  const [derivedSex, setDerivedSex] = useState<"MALE" | "FEMALE" | null>(null);
  const cmd = useRowIdentifierCommand(onDryRun, (sex) => {
    announce(t("importReview.identifier.recorded"));
    setDerivedSex(sex === "MALE" || sex === "FEMALE" ? sex : null);
  });
  useExpiry(cmd.error, onExpired);

  const takeRrn = () => {
    const secret = input.current;
    input.current = "";
    setValue("");
    return secret;
  };

  return (
    <div className="form">
      <Field label={t("importReview.identifier.idType")} required={false}>
        {(p) => (
          <SelectInput
            {...p}
            value={idType}
            onChange={(e) => {
              manualType.current = e.target.value !== "";
              setIdType(e.target.value as RecordableIdType | "");
              cmd.reset();
            }}
          >
            <option value="">{t("importReview.cells.pickOption")}</option>
            {REPAIR_ID_TYPES.map((code) => (
              <option key={code} value={code}>{idTypeLabel(code)}</option>
            ))}
          </SelectInput>
        )}
      </Field>
      <MaskedField
        label={t("importReview.identifier.rrn")}
        required
        format={FORMATS.rrn}
        value={value}
        onChange={(next) => {
          input.current = next;
          setValue(next);
          if (!manualType.current) {
            const inferred = defaultIdTypeForDigits(parseWith(FORMATS.rrn, next));
            if (inferred) setIdType(inferred);
          }
          cmd.reset();
        }}
      />
      {derivedSex && <div className={cs.mutedLine}>{t("import.rows.sexDerived", { sex: t(`import.sex.${derivedSex}`) })}</div>}
      <CommandError error={cmd.error} recover={false} own={importError} />
      <div className="form__actions">
        <Button
          variant="primary"
          disabled={busy || cmd.isPending || !complete(FORMATS.rrn, value)}
          onClick={() =>
            cmd.run({
              runId,
              sourceKey: row.source_key,
              takeRrn,
              ...(idType ? { idType } : {}),
              picks,
            })
          }
        >
          {t("importReview.identifier.save")}
        </Button>
      </div>
    </div>
  );
}
