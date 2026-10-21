import { useState } from "react";
import type { CloseReason, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { correctClose, ENTITY_READS, withdrawClose } from "../api";
import { entityName } from "../../../reference/entity/domain/names";
import { EntityError } from "./entity-error";

const REASONS: readonly CloseReason[] = ["DISSOLVED", "BUSINESS_CLOSED"];
const FOOT = "close-correct-reason";

/**
 * A recorded close, fixed (catalog company-19): one verb with two modes. Correct: the right close date and reason, and why the first
 * record was wrong; its workplaces and certificates move with it and nothing reopens. Withdraw (company-15): the business goes on; the
 * preview names what reopens (the workplaces and certificates that closed with it) and that ended grants do not come back.
 */
export function CloseCorrectSheet({ e, onClose }: { e: LegalEntity; onClose: () => void }) {
  const today = todayKst();
  const [on, setOn] = useState(e.closed_on ?? "");
  const [reason, setReason] = useState<CloseReason | null>(e.close_reason_code ?? null);
  const [why, setWhy] = useState("");
  const [mode, setMode] = useState<"fix" | "withdraw">("fix");
  const same = on === e.closed_on && reason === e.close_reason_code;
  const withdraw = mode === "withdraw";
  const ready = why.trim() !== "" && (withdraw || (on !== "" && on <= today && reason !== null && !same));
  const save = useCommand({
    run: (_: undefined, key: string) => (withdraw ? withdrawClose(key, e.id, why.trim()) : correctClose(key, e.id, { closed_on: on, reason_code: reason!, why: why.trim() })),
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t(withdraw ? "entityOps.closeFix.withdrawDone" : "entityOps.closeFix.done", { name: entityName(e) }),
    onSuccess: onClose,
  });
  const hold = withdraw ? t("entityOps.closeFix.needWhy") : same ? t("entityOps.closeFix.same") : why.trim() === "" ? t("entityOps.closeFix.needWhy") : t("entityOps.closeFix.pick");
  const reopens = e.workplaces.filter((w) => w.closed_on === e.closed_on);
  const certs = e.registrations.filter((r) => r.closed_on === e.closed_on).length;
  const label = t(withdraw ? "entityOps.closeFix.withdrawSave" : "entityOps.closeFix.save");
  return (
    <Sheet
      open
      title={t("entityOps.closeFix.title", { name: entityName(e) })}
      subtitle={t("entityOps.closeFix.subtitle", { date: fmtDate(e.closed_on ?? "") })}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        !ready ? <span id={FOOT}>{hold}</span>
        : withdraw ? <span>{t("entityOps.closeFix.withdrawConsequence", { count: reopens.length, certs })}</span>
        : <span>{t("entityOps.closeFix.consequence", { date: fmtDate(on), count: reopens.length })}</span>
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? (
            <Button variant="primary" onClick={() => !save.isPending && save.mutate(undefined)} disabled={save.isPending}>{label}</Button>
          ) : (
            <Button variant="primary" aria-disabled aria-describedby={FOOT} onClick={() => undefined}>{label}</Button>
          )}
        </>
      }
    >
      <ChoiceField
        label={t("entityOps.closeFix.mode")}
        required
        options={[{ value: "fix", label: t("entityOps.closeFix.modeFix") }, { value: "withdraw", label: t("entityOps.closeFix.modeWithdraw") }]}
        value={mode}
        onChange={(v) => setMode(v as "fix" | "withdraw")}
      />
      {withdraw ? (
        <section aria-labelledby="close-reopens">
          <h3 id="close-reopens">{t("entityOps.closeFix.reopens")}</h3>
          <ul>
            {reopens.map((w) => <li key={w.id}>{w.current?.name ?? "—"}</li>)}
            {certs > 0 && <li>{t("entityOps.closeFix.reopensCerts", { count: certs })}</li>}
          </ul>
          <p className="muted">{t("entityOps.closeFix.grantsStay")}</p>
        </section>
      ) : (
        <>
          <DateField label={t("entityRecordClose.date")} required value={on} onChange={setOn} today={today} />
          <ChoiceField
            label={t("entityRecordClose.reason")}
            required
            options={REASONS.map((r) => ({ value: r, label: t(r === "DISSOLVED" ? "entityRecordClose.dissolved" : "entityRecordClose.businessClosed") }))}
            value={reason}
            onChange={(v) => setReason(v as CloseReason)}
          />
        </>
      )}
      <Field label={t(withdraw ? "entityOps.closeFix.withdrawWhy" : "entityOps.closeFix.why")} required>
        {(p) => <TextInput {...p} maxLength={200} value={why} onChange={(x) => setWhy(x.target.value)} />}
      </Field>
    </Sheet>
  );
}
