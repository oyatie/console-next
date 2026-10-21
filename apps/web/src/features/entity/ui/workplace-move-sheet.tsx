import { useState } from "react";
import { MapPin } from "lucide-react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { ENTITY_READS, readVersion, reviseWorkplace } from "../api";
import { toAddr, toKr, type Addr } from "../domain/record-values";
import { addressLine, workplaceInput, workplaceName } from "../domain/view";
import { moveChange } from "../domain/workplace-change";
import { AddressEdit } from "./record-address-edit";
import { EntityError } from "./entity-error";

const FOOT = "move-reason";
type Mode = "MOVE" | "CORRECTION";

/**
 * address (catalog company-12): move to a new place from a date (a dated change; it may be ahead), or an address typed wrong
 * from the start (a correction). The people placed there are named, because they work at the new place from that day; the
 * filings an move opens (registration correction, registry move, insurance change filings) are not made here.
 */
export function WorkplaceMoveSheet({ e, w, onClose }: { e: LegalEntity; w: Workplace; onClose: () => void }) {
  const today = todayKst();
  const name = workplaceName(w);
  const [mode, setMode] = useState<Mode | null>(null);
  // A move starts from an empty address (the current one is in the subtitle); a correction starts from the current one.
  const [addr, setAddr] = useState<Addr | null>(null);
  const [on, setOn] = useState("");
  const base = workplaceInput(e, w);
  const next = toKr(addr, w.current?.address);
  const changed = Boolean(next) && addressLine(next) !== addressLine(w.current?.address);
  const ready = mode !== null && changed && (mode === "CORRECTION" || on !== "") && base !== null;
  const save = useCommand({
    run: (_: undefined, key: string) =>
      reviseWorkplace(key, w.id, { ...moveChange(base!, next!, mode!, on, w.current?.effective_from ?? today), expected_version: readVersion(w) }),
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t(mode === "MOVE" ? "entityOps.move.done" : "entityOps.move.fixed", { name }),
    onSuccess: onClose,
  });
  const hold = mode === null ? t("entityOps.move.pickMode") : !changed ? t("entityOps.move.sameAddress") : t("entityOps.move.pickDate");
  return (
    <Sheet
      open
      kicker={<><MapPin size={14} aria-hidden />{name}</>}
      title={t("entityOps.move.title", { name })}
      subtitle={t("entityOps.move.subtitle", { address: addressLine(w.current?.address) || "—" })}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        ready ? (
          <span>{mode === "MOVE" ? t("entityOps.move.consequence", { name, date: fmtDate(on), count: w.headcount }) : t("entityOps.move.consequenceFix", { name })}</span>
        ) : (
          <span id={FOOT}>{hold}</span>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? <Button variant="primary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{t("entityOps.move.save")}</Button> : <Button variant="primary" aria-disabled aria-describedby={FOOT} onClick={() => undefined}>{t("entityOps.move.save")}</Button>}
        </>
      }
    >
      <ChoiceField
        label={t("entityOps.move.mode")}
        required
        options={(["MOVE", "CORRECTION"] as const).map((m) => ({ value: m, label: t(`entityOps.move.mode.${m}`), description: t(`entityOps.move.modeHint.${m}`) }))}
        value={mode}
        onChange={(v) => {
          setMode(v as Mode);
          if (v === "CORRECTION" && !addr) setAddr(toAddr(w.current?.address));
        }}
      />
      <AddressEdit label={t(mode === "CORRECTION" ? "entityOps.move.fixedAddress" : "entityOps.move.newAddress")} v={addr} set={setAddr} />
      {mode === "MOVE" && <DateField label={t("entityOps.move.on")} required value={on} onChange={setOn} today={today}  />}
      {mode === "MOVE" && w.headcount > 0 && <p className="notice">{t("entityOps.move.people", { count: w.headcount })}</p>}
      {mode === "MOVE" && <p className="muted">{t("entityOps.move.filings")}</p>}
    </Sheet>
  );
}
