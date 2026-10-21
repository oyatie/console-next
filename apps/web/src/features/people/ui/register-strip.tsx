import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { Strip, StripItem } from "../../../ui/record/strip";
import { RecordSection } from "../../../ui/record/record-section";
import { useCardRegister } from "./use-card-register";
import type { Card } from "./use-card";
import s from "./card.module.css";

/**
 * employee register items (Labor Standards Act Decree §20, items 1–9) with what each holds: masked items say only "present, masked", a gap says
 * "missing" and is never a refusal. Each item jumps to its field.
 */
export function RegisterStrip({ c, onJump }: { c: Card; onJump: (id: string) => void }) {
  const { items, gaps, value } = useCardRegister(c);
  const field = { name: "s1", sex: "s1", birth: "s1", address: "s1", history: "s5", job: "s2", contract: "s3", exit: "s4", note: "s1" } as const;
  return (
    <RecordSection
      id="register"
      title={t("empCard.reg.title")}
      meta={t("empCard.reg.law", { workplace: c.place.workplace ?? c.place.entity })}
      tools={gaps ? <span className={s.warn}>{t("empCard.reg.gaps", { count: gaps })}</span> : <span className={s.ok}><Check size={13} aria-hidden /> {t("empCard.reg.all")}</span>}
    >
      <Strip>
        {items.map((i) => (
          <StripItem key={i.no} label={`${i.no} ${t(`empCard.reg.item.${i.key}`)}`} onPress={() => onJump(field[i.key])}>{value(i)}</StripItem>
        ))}
      </Strip>
    </RecordSection>
  );
}
