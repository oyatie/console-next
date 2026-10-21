import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Sheet } from "../../../ui/sheet/sheet";
import type { Card } from "./use-card";
import { tx } from "../present";
import { Paper, PaperHead } from "../../../ui/paper/paper";
import { PaperGrid, type PaperCell } from "../../../ui/paper/paper-table";
import s from "./card.module.css";
import { Who } from "./card-who";

const ITEMS = ["period", "duty", "position", "wage", "birth"] as const;

/**
 * certificate (E2-cert, Labor Standards Act §39): the kind, then only the items the worker asked for (none preselected, §39②), with
 * the paper as it would print. Issuance (issue number, seal, register) is not served yet (ES7–ES10, backend-followups EMP-UI):
 * the primary says so; nothing is issued or logged from here.
 */
export function CardCert({ c, onClose }: { c: Card; onClose: () => void }) {
  const [kind, setKind] = useState<string | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const exited = c.e.status === "EXITED";
  const value = (k: (typeof ITEMS)[number]) =>
    k === "period" ? t("empDoc.cert.periodValue", { from: fmtDate(c.e.hire_date), to: exited ? fmtDate(c.e.exit_date) : t("empDoc.cert.now") })
    : k === "duty" ? c.e.job ?? "—"
    : k === "position" ? [c.e.position, c.place.workplace, c.e.org_unit].filter(Boolean).join(" · ")
    : t("empDoc.cert.onRequest");
  return (
    <Sheet
      open
      kicker={<Who c={c} />}
      title={t("empDoc.cert.title")}
      onClose={onClose}
      consequence={<><span><b>{kind ? t("empDoc.cert.cons", { kind: tx(`empDoc.cert.kind.${kind}`), count: items.length }) : t("empDoc.cert.pick")}</b></span><span className={s.s12}>{t("empDoc.cert.unserved")}</span></>}
      actions={<><Button variant="ghost" onClick={onClose}>{t("empFix.cancel")}</Button><Button variant="primary" aria-disabled="true">{t("empDoc.cert.commit")}</Button></>}
    >
      <ChipChoice label={t("empDoc.cert.kind")} options={(["EMPLOYMENT", "CAREER", "EXIT"] as const).map((k) => ({ value: k, label: t(`empDoc.cert.kind.${k}`), disabled: k === "EXIT" && !exited }))} value={kind} onChange={setKind} />
      <p className={s.note}>{t("empDoc.cert.request")}</p>
      <Checks label={t("empDoc.cert.items")} items={ITEMS.map((k) => ({ id: k, label: t(`empDoc.cert.item.${k}`) }))} value={items} onChange={setItems} />
      <p className={s.note}>{t("empDoc.cert.always", { entity: c.place.entity })}</p>
      <Paper label={t("empDoc.cert.preview")}>
        <PaperHead title={kind ? tx(`empDoc.cert.paper.${kind}`) : t("empDoc.cert.paper.none")} />
        <PaperGrid rows={[[t("empDoc.cert.item.name"), c.e.name], ...ITEMS.filter((k) => items.includes(k)).map((k): PaperCell => [t(`empDoc.cert.item.${k}`), value(k)])]} />
        <span className={s.s12}>{t("empDoc.cert.paperFoot", { entity: c.place.entity })}</span>
      </Paper>
    </Sheet>
  );
}
