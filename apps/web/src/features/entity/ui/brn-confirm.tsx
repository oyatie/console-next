import { t } from "@console/i18n";
import { FORMATS } from "../../../lib/pure/formats";
import { Check as Checkbox } from "../../../ui/button/button";
import { brnChecksumOff } from "../domain/brn";

/**
 * A registration number whose check digit does not match is held (worst-case-25) until the user says the certificate
 * prints it so: the check has no primary source, so a real number is never refused outright, but never shown with a ✓.
 */
export function BrnConfirm({ brn, confirmed, onConfirm }: { brn: string; confirmed: string; onConfirm: (brn: string) => void }) {
  if (!brnChecksumOff(brn)) return null;
  return (
    <Checkbox checked={confirmed === brn} onChange={(on) => onConfirm(on ? brn : "")}>
      {t("entityOps.brn.confirm", { brn: FORMATS.bizRegNo.display(brn) })}
    </Checkbox>
  );
}
