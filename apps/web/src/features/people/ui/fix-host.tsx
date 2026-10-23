import { useEffect, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Sheet } from "../../../ui/sheet/sheet";
import { MissingEmployment } from "./missing-employment";
import { Toast } from "../../../ui/toast/toast";
import type { Correction } from "../api";
import { FIELD_CLASS, type FixField } from "../domain/fix";
import { CardCert } from "./card-cert";
import { FixCorrect } from "./fix-correct";
import { FixEmpno } from "./fix-empno";
import { FixMulti } from "./fix-multi";
import { FixRevise } from "./fix-revise";
import type { Card } from "./use-card";

const FIELDS = new Set(Object.keys(FIELD_CLASS));

/**
 * The personnel card's own sheets, opened by `?act=` (pushed, so Back closes them): `fix:<field>` (edit / correction only), `multi`
 * (multi-field correction), `empno` (employee-number change), `print` (record print), `cert` (certificate); registration cancel is CRUD's CancelHost (`cancel`). Lifecycle acts
 * (TRANSFER…) belong to ActHost; exits to the exit card.
 */
export function FixHost({ c, act, onClose, onAct }: { c: Card; act?: string; onClose: () => void; onAct: (act: string) => void }) {
  const [said, setSaid] = useState<string | null>(null);
  const corrected = (out: Correction) => {
    setSaid(out.pending_request ? t("empFix.done.pending") : out.review_required ? t("empFix.done.review", { count: out.applied.length }) : t("empFix.done", { count: out.applied.length }));
    onClose();
  };
  const changed = (message: string) => {
    setSaid(message);
    onClose();
  };
  // A receipt says what happened and then steps aside (10 s, like the quick-edit receipts); the record keeps the change.
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(null), 10_000);
    return () => clearTimeout(id);
  }, [said]);
  const field = act?.startsWith("fix:") ? (act.slice(4) as FixField) : null;
  return (
    <>
      {said && !act && <Toast state="done" actions={<Button variant="ghost" onClick={() => setSaid(null)}>{t("empCard.quick.dismiss")}</Button>}>{said}</Toast>}
      {field && FIELDS.has(field) && (!c.d.employment && !c.d.pending_employment && ["employment_type", "phone", "base_pay"].includes(field)
        ? <Sheet open title={t("people.employment.missing.title")} onClose={onClose} consequence={null} actions={null}><MissingEmployment number={c.e.employee_number} /></Sheet>
        : FIELD_CLASS[field] === "rev"
        ? <FixRevise key={field} c={c} field={field} onClose={onClose} onCorrected={corrected} onChanged={changed} />
        : <FixCorrect key={field} c={c} field={field} onClose={onClose} onDone={corrected} />)}
      {act === "multi" && <FixMulti c={c} onClose={onClose} onDone={corrected} onAct={onAct} />}
      {act === "empno" && <FixEmpno c={c} onClose={onClose} onCorrect={() => onAct("fix:employee_number")} />}
      {act === "cert" && <CardCert c={c} onClose={onClose} />}
    </>
  );
}
