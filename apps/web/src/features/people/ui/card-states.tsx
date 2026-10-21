import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Lock, Users } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Avatar } from "../../../ui/avatar/avatar";
import { Band } from "../../../ui/band/band";
import { BoneShape } from "../../../ui/skeleton/skeleton";
import { TabNav } from "../../../ui/tabs/tabs";
import s from "./card.module.css";

/**
 * The personnel card while it loads (E12-loading): the head band and the record's two columns in outline, shown only after a
 * short delay (CSS) so a fast load never flashes it; the real card then fills the same geometry.
 */
export function CardSkeleton() {
  return (
    <div className={s.page} role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Band className={`${s.head} ${s.late}`} aria-hidden>
        <div className={s.top}><BoneShape bone="crumb" /></div>
        <div className={s.hdr}><Avatar size="lg" name="" /><div className={s.who}><BoneShape bone="title" /><BoneShape bone="line" /><BoneShape bone="short" /></div></div>
        <TabNav label={t("common.loading")}><BoneShape bone="line" /></TabNav>
      </Band>
      <div className={`${s.rec} ${s.late}`} aria-hidden>
        <div className={s.main}>{[0, 1, 2].map((i) => <BoneShape key={i} bone="block" />)}</div>
        <BoneShape bone="spine" />
      </div>
    </div>
  );
}

const ASKS = ["NEW_DUTY", "STAND_IN", "WRONG_LINK", "OTHER"] as const;

/**
 * A record outside the reader's grant (E12-denied) reads like no record at all: who and where are never shown. The
 * way on is a access request (not served yet: its primary says so) or the list; nothing is a dead end.
 */
export function CardDenied() {
  const [why, setWhy] = useState<string | null>(null);
  return (
    <div className={s.page}>
      <Band className={s.head}><div className={s.top}><span className={s.crumb}><Users size={14} aria-hidden /><Link to="/people" search={{}}>{t("empCard.crumb")}</Link><ChevronRight size={14} aria-hidden />{t("empCard.denied.crumb")}</span></div></Band>
      <div className={s.center}>
        <div className={s.stateCard}>
        <Card label={t("empCard.denied.title")}>
          <div className="row"><Lock size={22} aria-hidden /><h1 id="denied" className={s.stateTitle}>{t("empCard.denied.title")}</h1></div>
          <p className={s.note}>{t("empCard.denied.reason")}</p>
          <ChipChoice id="ask" label={t("empCard.denied.ask")} options={ASKS.map((a) => ({ value: a, label: t(`empCard.denied.ask.${a}`) }))} value={why} onChange={setWhy} />
          <div className="row">
            <Button variant="primary" aria-disabled="true" onClick={() => !why && document.querySelector<HTMLElement>("#ask input")?.focus()}>{t("empCard.denied.send")}</Button>
            <Link className={buttonClass()} to="/people" search={{}}>{t("empCard.denied.list")}</Link>
          </div>
          <p className={s.note}>{why ? t("empCard.denied.unserved") : t("empCard.denied.pick")}</p>
        </Card>
        </div>
      </div>
    </div>
  );
}
