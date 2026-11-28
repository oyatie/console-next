import { useState } from "react";
import { Printer, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { Card as Surface } from "../../../ui/card/card";
import type { Card } from "./use-card";
import { PrintPaper } from "./print-paper";
import { Band } from "../../../ui/band/band";
import { PaperWell } from "../../../ui/paper/paper";
import s from "./card.module.css";

const PARTS = ["register", "personal", "job", "contract", "events", "records"] as const;

/** A masked browser print of the selected record sections. Restricted sections never print. */
export function CardPrint({ c, onClose }: { c: Card; onClose: () => void }) {
  const { e } = c;
  const [parts, setParts] = useState<string[]>(["register", "personal", "job", "contract", "events", "records"]);
  const [at] = useState(() => new Date().toISOString());
  return (
    <div className={s.printPage}>
      <Band className={s.printHead}>
        <div><span className={s.crumb}>{t("empDoc.print.crumb", { name: e.name })}</span><h1 className={s.stateTitle}>{t("empDoc.print.title")}</h1></div>
        <span className="grow" />
        <Button variant="ghost" aria-label={t("empDoc.print.close")} onClick={onClose}><X size={16} aria-hidden /></Button>
      </Band>
      <div className={s.printGrid}>
        <Surface label={t("empDoc.print.options")}>
          <Checks label={t("empDoc.print.parts")} items={PARTS.map((p) => ({ id: p, label: t(`empDoc.print.part.${p}`) }))} value={parts} onChange={setParts} />
          <p className={s.note}>{t("empDoc.print.restricted")}</p>
        </Surface>
        <PaperWell>
          <PrintPaper c={c} parts={parts} at={at} />
        </PaperWell>
      </div>
      <Band edge="top" tone="canvas" className={s.printFoot}>
        <span><b>{t("empDoc.print.ready", { count: parts.length })}</b></span>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>{t("composer.dismiss")}</Button>
        <Button variant="primary" onClick={() => window.print()}><Printer size={16} aria-hidden /> {t("empDoc.print.commit")}</Button>
      </Band>
    </div>
  );
}
