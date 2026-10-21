import { useState } from "react";
import { Printer, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Card as Surface } from "../../../ui/card/card";
import type { Card } from "./use-card";
import { PrintPaper } from "./print-paper";
import { Band } from "../../../ui/band/band";
import { PaperWell } from "../../../ui/paper/paper";
import s from "./card.module.css";

const PARTS = ["register", "personal", "job", "contract", "events", "records"] as const;
const PURPOSES = ["SELF_REQUEST", "COMMITTEE", "INTERNAL", "OTHER"] as const;

/**
 * record print (E10-print): which sections, how masked values print (no default), why; the A4 paper beside it as it
 * prints, always light. Restricted sections never print. The server-rendered print with its access log (MR-36) is not
 * served: printing here is the browser's print of what the screen already shows (masked), said in the foot.
 */
export function CardPrint({ c, onClose }: { c: Card; onClose: () => void }) {
  const { e } = c;
  const [parts, setParts] = useState<string[]>(["register", "personal", "job", "contract", "events", "records"]);
  const [mode, setMode] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [at] = useState(() => new Date().toISOString());
  const missing = !mode ? "print-mode" : !why ? "print-why" : null;
  const print = () => (missing ? document.getElementById(missing)?.querySelector<HTMLElement>("input")?.focus() : window.print());
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
          <div id="print-mode"><ChoiceField label={t("empDoc.print.mode")} required value={mode} onChange={setMode} options={[{ value: "masked", label: t("empDoc.print.mode.masked"), description: t("empDoc.print.mode.masked.d") }, { value: "open", label: t("empDoc.print.mode.open"), description: t("empDoc.print.mode.open.d"), disabled: t("empDoc.print.mode.open.unserved") }]} /></div>
          <div id="print-why"><ChipChoice label={t("empDoc.print.why")} options={PURPOSES.map((p) => ({ value: p, label: t(`empDoc.print.purpose.${p}`) }))} value={why} onChange={setWhy} /></div>
        </Surface>
        <PaperWell>
          <PrintPaper c={c} parts={parts} why={why} at={at} />
        </PaperWell>
      </div>
      <Band edge="top" tone="canvas" className={s.printFoot}>
        <span>{missing ? <b>{t("empDoc.print.pick")}</b> : <b>{t("empDoc.print.ready", { count: parts.length })}</b>} {t("empDoc.print.unserved")}</span>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>{t("empFix.cancel")}</Button>
        <Button variant="primary" aria-disabled={missing ? true : undefined} onClick={print}><Printer size={16} aria-hidden /> {t("empDoc.print.commit")}</Button>
      </Band>
    </div>
  );
}
