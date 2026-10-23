import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Lock, X } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { saveFile } from "../../../lib/download";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { SiteRail } from "./register-sites";
import { usePreviewFacts, useSites } from "./use-register-sites";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { RecordRows } from "../../../ui/record/rows";
import { Card } from "../../../ui/card/card";
import { EXPORT_PURPOSES, exportRoster, type ExportPurpose } from "../api";
import { registerPreviewQuery } from "../api/record";
import { Band } from "../../../ui/band/band";
import { Paper, PaperFoot, PaperHead, PaperWell } from "../../../ui/paper/paper";
import s from "./card.module.css";

const ITEMS = ["name", "sex", "birth", "address", "history", "job", "contract", "exit", "note"] as const;

/**
 * employee register export (E10-register): one workplace's register (Labor Standards Act §41: per workplace), the nine items of Decree §20 always,
 * the people it holds counted by the server, a purpose and a privacy mode (no defaults), and the paper as a preview
 * that stays masked. The server writes the file (export.csv, layout register) and logs it with its purpose.
 */
export function RegisterExport({ onClose }: { onClose: () => void }) {
  const groups = useSites();
  const sites = groups.flatMap((g) => g.sites);
  const [site, setSite] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<ExportPurpose | null>(null);
  const [privacy, setPrivacy] = useState<string | null>(null);
  const preview = useQuery({ ...registerPreviewQuery(site ?? ""), enabled: Boolean(site) }).data?.items ?? [];
  const facts = usePreviewFacts(preview.map((e) => e.id));
  const chosen = sites.find((x) => x.id === site);
  const counted = chosen?.workers !== undefined && chosen.exited !== undefined;
  const workers = chosen?.workers ?? 0;
  const exited = chosen?.exited ?? 0;
  const run = useCommand({
    run: () => exportRoster({ workplace_id: site, status: ["ACTIVE", "ON_LEAVE", "EXITED"], layout: "register" }, purpose!),
    onSuccess: (blob) => saveFile(blob, t("empDoc.reg.file", { site: chosen?.name ?? "", date: todayKst() })),
    announce: () => t("empDoc.reg.done", { count: workers + exited }),
  });
  const missing = !site ? "reg-site" : !purpose ? "reg-purpose" : !privacy ? "reg-privacy" : null;
  const press = () => (missing ? document.getElementById(missing)?.querySelector<HTMLElement>("input")?.focus() : run.mutate(undefined));
  return (
    <div className={s.printPage}>
      <Band className={s.printHead}>
        <div><span className={s.crumb}>{t("empDoc.reg.crumb")}</span><h1 className={s.stateTitle}>{t("empDoc.reg.title")}</h1></div>
        <span className="grow" />
        <Button variant="ghost" aria-label={t("empDoc.reg.close")} onClick={onClose}><X size={16} aria-hidden /></Button>
      </Band>
      <div className={s.printGrid}>
        <Card label={t("empDoc.reg.options")}>
          <SiteRail groups={groups} value={site} onChange={setSite} />
          <div>
            <ChipChoice label={t("empDoc.reg.asOf")} value="today" onChange={() => undefined} options={[{ value: "today", label: t("empDoc.reg.asOf.today", { date: fmtDate(todayKst()) }) }, { value: "monthEnd", label: t("empDoc.reg.asOf.monthEnd"), disabled: true }, { value: "typed", label: t("empDoc.reg.asOf.typed"), disabled: true }]} />
            <p className={s.s12}><Lock size={11} aria-hidden /> {t("empDoc.reg.asOfLocked")}</p>
          </div>
          <Card look="outline">
            <b>{t("empDoc.reg.people")}</b>
            {!site ? <span className={s.s12}>{t("empDoc.reg.pickSite")}</span> : counted ? <span>{t("empDoc.reg.peopleCount", { workers: fmtNumber(workers), exited: fmtNumber(exited) })}</span> : <span className={s.s12}>{t("empDoc.reg.counting")}</span>}
          </Card>
          <Card look="outline"><b>{t("empDoc.reg.items")} <Lock size={12} aria-hidden /></b><span className={s.s12}>{ITEMS.map((i) => t(`empCard.reg.item.${i}`)).join(" · ")}</span></Card>
          <div id="reg-purpose"><ChipChoice label={t("empDoc.reg.purpose")} options={EXPORT_PURPOSES.map((p) => ({ value: p, label: t(`roster.export.purpose.${p}`) }))} value={purpose} onChange={(v) => setPurpose(v as ExportPurpose)} /></div>
          <div id="reg-privacy"><ChoiceField label={t("empDoc.reg.privacy")} required value={privacy} onChange={setPrivacy} options={[{ value: "all", label: t("empDoc.reg.privacy.all"), description: t("empDoc.reg.privacy.all.d") }, { value: "mask", label: t("empDoc.reg.privacy.mask"), description: t("empDoc.reg.privacy.mask.d"), disabled: t("empDoc.reg.privacy.mask.unserved") }]} /></div>
          <p className={s.note}>{t("empDoc.reg.format")}</p>
        </Card>
        <PaperWell>
          <Paper size="wide" label={t("empDoc.reg.preview")}>
            <PaperHead title={t("empDoc.reg.paperTitle")}><span>{chosen ? `${chosen.entity} · ${chosen.name}` : ""}</span><span className="grow" /><span>{t("empDoc.reg.paperAsOf", { date: fmtDate(todayKst()) })}</span></PaperHead>
            <RecordRows
              label={t("empDoc.reg.preview")}
              rows={preview}
              rowId={(e) => e.id}
              columns={[
                { header: t("empDoc.reg.col.no"), cell: (e) => preview.indexOf(e) + 1 },
                ...ITEMS.slice(0, 8).map((i, n) => ({
                  header: `${n + 1}. ${t(`empCard.reg.item.${i}`)}`,
                  cell: (e: (typeof preview)[number]) => {
                    const f = facts(e.id);
                    return i === "name" ? e.name : i === "job" ? e.job ?? "—" : i === "contract" ? fmtDate(e.hire_date) : i === "exit" ? (e.exit_date ? fmtDate(e.exit_date) : "") : i === "sex" ? f.sex : i === "birth" ? f.birth : i === "address" ? f.address : f.history;
                  },
                })),
              ]}
            />
            <PaperFoot>{t("empDoc.reg.paperFoot")}</PaperFoot>
          </Paper>
        </PaperWell>
      </div>
      <Band edge="top" tone="canvas" className={s.printFoot}>
        <span>{site ? <b>{t("empDoc.reg.cons", { site: chosen?.name ?? "", count: workers + exited, workers, exited })}</b> : <b>{t("empDoc.reg.pickSite")}</b>} {missing ? t("empDoc.reg.pick") : t("empDoc.reg.logged")}</span>
        {run.isError && <CommandError error={run.error} />}
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>{t("composer.dismiss")}</Button>
        <Button variant="primary" aria-disabled={missing ? true : undefined} onClick={press}><Download size={16} aria-hidden /> {t("empDoc.reg.commit")}</Button>
      </Band>
    </div>
  );
}
