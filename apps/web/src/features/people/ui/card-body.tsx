import { useEffect, useState } from "react";
import { focusSoon } from "../../../lib/react/announce";
import { Info, Lock } from "lucide-react";
import { t } from "@console/i18n";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { FieldMark } from "../../../ui/record/field-row";
import { Gate, Kbd } from "../../../ui/record/record-section";
import { SecNav } from "../../../ui/record/sec-nav";
import { Band } from "../../../ui/band/band";
import type { CardTab } from "./card-head";
import { CardSpine } from "./card-spine";
import { RegisterStrip } from "./register-strip";
import type { ContractEdit } from "./contracts-card";
import { SecContract, SecLeave } from "./sec-contract-leave";
import { SecJob } from "./sec-job";
import { SecDocs, SecFamily, SecRestricted } from "./sec-more";
import { SecPersonal } from "./sec-personal";
import { SecRecords } from "./sec-records";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import s from "./card.module.css";

const SECTIONS = ["personal", "job", "contract", "leave", "records", "family", "restricted", "docs"] as const;

/** Section chips 1–8 and the legend (E2): held under the card head while the sections scroll. */
export function CardBar({ c, current, onJump }: { c: Card; current: string; onJump: (id: string) => void }) {
  const entries = c.records.data?.items.filter((x) => !x.voided) ?? [];
  const n = (...secs: string[]) => entries.filter((x) => secs.includes(x.section)).length;
  const counts: Partial<Record<(typeof SECTIONS)[number], number>> = {
    records: n("EDUCATION", "QUALIFICATION", "MILITARY", "LANGUAGE", "TRAINING") + (c.register.data?.careers?.length ?? 0),
    family: n("AWARD", "FAMILY"),
    leave: (c.events.data?.items ?? []).filter((x) => x.event_type === "LEAVE_OF_ABSENCE" && x.state !== "CANCELLED").length || undefined,
  };
  return (
    <Band className={s.bar}>
      <SecNav items={SECTIONS.map((k, i) => ({ id: `s${i + 1}`, title: t(`empCard.sec.${k}`), count: counts[k] }))} current={current} onJump={onJump} />
      <PopoverButton label={t("empCard.legend.open")} trigger={<><Info size={14} aria-hidden /> {t("empCard.legend.open")} <Kbd k="?" /></>} title={t("empCard.legend.title")}>
        {() => (
          <dl className={s.legendList}>
            {(["rc", "cor", "corTwo", "first", "inline", "verb", "lock"] as const).map((k) => (
              <div key={k}>
                <dt><FieldMark kind={k === "verb" || k === "lock" ? "lock" : k} field={t("empCard.legend.sample")} text={t(`uiRecord.mark.${k}`)} /></dt>
                <dd className={s.legendText}>{t(`empCard.legend.${k}`)}</dd>
              </div>
            ))}
          </dl>
        )}
      </PopoverButton>
    </Band>
  );
}

/** The personnel card tab (E2): the register strip, the eight sections and the spine. */
export function CardBody({ c, quick, act, onAct, onTab, onJump }: { c: Card; quick: Quick; act?: string; onAct: (act: string) => void; onTab: (t: CardTab) => void; onJump: (id: string) => void }) {
  const [contract, setContract] = useState<ContractEdit>(null);
  // A sheet over the record (G5): the record reflows to one column beside it and the field being changed is in view, tinted.
  const sheet = Boolean(act) && !act!.startsWith("exit.");
  const hl = act?.startsWith("fix:") ? act.slice(4) : undefined;
  useEffect(() => {
    const row = hl ? document.getElementById(`f-${hl}`) : null;
    row?.setAttribute("data-edit", "");
    row?.scrollIntoView({ block: "center" });
    return () => row?.removeAttribute("data-edit");
  }, [hl]);
  const jump = onJump;
  const fix = (field: string) => onAct(field === "multi" ? "multi" : `fix:${field}`);
  if (!c.manage)
    // A reader (BW-17): placement and its history, the rest said to be closed to them, never shown as empty.
    return (
      <div className={s.rec}>
        <div className={s.main}>
          <SecJob c={c} onFix={fix} onAct={onAct} onTab={() => onTab("events")} />
          <Gate icon={<Lock size={16} aria-hidden />}>{t("empCard.reader.locked")}</Gate>
        </div>
        <CardSpine c={c} onAct={onAct} onLedger={() => onTab("ledger")} onHistory={() => onTab("events")} />
      </div>
    );
  return (
    <>
      <div className={s.rec} data-one={sheet || undefined}>
        <div className={s.main}>
          <RegisterStrip c={c} onJump={jump} />
          <SecPersonal c={c} quick={quick} onFix={fix} />
          <SecJob c={c} onFix={fix} onAct={onAct} onTab={() => onTab("events")} onContract={() => (setContract({ kind: "new" }), focusSoon("contracts"))} />
          <SecContract c={c} onAct={onAct} open={contract} onOpen={setContract} />
          <SecLeave c={c} act={act} />
          <SecRecords c={c} quick={quick} />
          <SecFamily c={c} />
          <SecRestricted c={c} />
          <SecDocs />
        </div>
        {!sheet && <CardSpine c={c} onAct={onAct} onLedger={() => onTab("ledger")} onHistory={() => onTab("events")} />}
      </div>
    </>
  );
}
