import { useContext, useMemo, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { Check as Tick, ChevronLeft, ChevronRight, Download, Printer } from "lucide-react";
import { t } from "@console/i18n";
import { saveFile } from "../../../lib/download";
import { Button, Check, ToggleButton } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import type { Depth } from "../domain/layout";
import { deptCount, type Structure } from "../domain/model";
import { registryCells, registryCsv } from "../domain/registry";
import { whoAmI } from "../api";
import { levelText, nodeName } from "../present";
import { RegistryExportContext } from "./export-scope";
import { BOX_FIELDS, chartSvg, downloadPng, exportPages, paperPt, printedPt, printSvg, type BoxField, type Paper } from "./use-export";
import css from "./chart.module.css";

const GUARD_PT = 9;
const MAX_ENTITY_CHOICES = 13;
const route = getRouteApi("/app/org");
/** The fields a printed box carries until changed: who heads it, how many, and who is not placed yet. */
const DEFAULT_FIELDS: readonly BoxField[] = ["head", "people", "unplaced"];

/**
 * Export (spec S2-chart-export): where to start (the whole, a legal entity, or the unit chosen on the chart), how deep,
 * what each box carries, PDF or PNG, A3/A4 × landscape/portrait, one page fitted or one per workplace, a title, and
 * leaving out personal data (off by default). The preview is the paper itself, paged; the point-size guard warns below
 * 9 pt; a footer stamp carries the as-of date, phase and who printed it. Rendered in the browser from the same layout
 * (no export endpoint is needed, §3).
 */
export function ExportDialog({ s, onClose }: { s: Structure; onClose: () => void }) {
  const listRows = useContext(RegistryExportContext);
  const entities = s.root.children.length <= MAX_ENTITY_CHOICES - (listRows !== null ? 1 : 0) ? s.root.children : [];
  // The unit chosen on the chart is offered as a start of its own (S2-chart-export, the chosen unit).
  const chosen = s.byId.get(route.useSearch().sel ?? "");
  const picked = chosen && chosen.kind !== "tenant" && !entities.includes(chosen) ? chosen : undefined;
  const [start, setStart] = useState<string>(listRows !== null ? "visible" : picked?.id ?? s.root.id);
  const visible = start === "visible" && listRows !== null;
  const [fields, setFields] = useState<ReadonlySet<BoxField>>(new Set(DEFAULT_FIELDS));
  const [perSite, setPerSite] = useState(false);
  const [page, setPage] = useState(0);
  const [depth, setDepth] = useState<Depth>("sites");
  const [format, setFormat] = useState<"pdf" | "png">("pdf");
  const [paper, setPaper] = useState<Paper>({ size: "A3", orient: "landscape" });
  const [redact, setRedact] = useState(false);
  const focus = s.byId.get(start) ?? s.root;
  const [title, setTitle] = useState(t("structure.export.defaultTitle", { name: t("structure.root.word") }));
  const sitePages = focus.kind === "site" ? 1 : focus.kind === "entity" ? focus.children.length : s.counts.sites;
  // A PNG is one picture: one page fitted.
  const paged = perSite && format === "pdf";
  const pages = useMemo(() => visible ? [] : exportPages(s, focus, depth, paged), [s, focus, depth, paged, visible]);
  const at = Math.min(page, pages.length - 1);
  const phase = t(`structure.phase.${s.phase === "OPERATING" ? "operatingChip" : "setupChip"}`);
  const stamp = (s.knownAt ? t("asof.known", { date: s.asOf, known: s.knownAt }) + " · " : "") + t("structure.export.stamp", { date: s.asOf, phase, who: whoAmI() });
  const svgs = useMemo(
    () => pages.map((p, i) => chartSvg(p, { redact, fields, stamp: `${title} · ${stamp}${pages.length > 1 ? ` · ${t("structureChart.export.pager", { at: i + 1, total: pages.length })}` : ""}` })),
    [pages, redact, fields, stamp, title],
  );
  const svg = svgs[at]!;
  const pt = Math.min(...pages.map((p) => printedPt(p, paper)));
  const area = paperPt(paper);
  const sites = focus.kind === "tenant" ? s.counts.sites : focus.kind === "entity" ? focus.children.length : 1;
  const headers = [...(["level", "entity", "site", "dept", "code", "head", "people"] as const).map((key) => t(`structureChart.sheet.${key}`)), t("asof.label"), t("asof.knownAt")];
  const sheetRows = (listRows ?? []).map((n) => ({ id: n.id, cells: registryCells(s, n, levelText) }));
  const go = () => visible
    ? saveFile(new Blob([registryCsv(s, listRows, headers, levelText)], { type: "text/csv;charset=utf-8" }), t("structureChart.sheet.file", { date: s.asOf }))
    : format === "pdf" ? printSvg(svgs, paper, title) : void downloadPng(svg, title);
  const flip = (f: BoxField) => setFields((x) => (x.has(f) ? new Set([...x].filter((y) => y !== f)) : new Set([...x, f])));
  return (
    <Sheet
      open
      wide
      title={t(visible ? "structureChart.list.download" : "structure.export.title")}
      subtitle={visible ? undefined : t("structure.export.subtitle")}
      onClose={onClose}
      consequence={visible ? t("structureChart.export.visible", { count: listRows.length }) : pages.length > 1
        ? t("structureChart.export.consequencePages", { format: format.toUpperCase(), pages: pages.length, sites, depts: deptCount(focus), people: focus.headcount })
        : t("structure.export.consequence", { format: format.toUpperCase(), sites, depts: deptCount(focus), people: focus.headcount })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t("structure.cancel")}</Button>
          <Button variant="primary" onClick={go}>
            {!visible && format === "pdf" ? <Printer size={16} aria-hidden /> : <Download size={16} aria-hidden />}
            {t(visible ? "structureChart.list.download" : format === "pdf" ? "structure.export.print" : "structure.export.png")}
          </Button>
        </>
      }
    >
      <div className={css.exportBody} data-sheet={visible || undefined}>
        <div className={css.exportForm}>
          <ChoiceField
            label={t("structure.export.start")}
            required
            value={visible ? "visible" : focus.id}
            onChange={(v) => (setStart(v), setPage(0))}
            options={[
              ...(listRows !== null ? [{ value: "visible", label: t("structureChart.export.visible", { count: listRows.length }) }] : []),
              { value: s.root.id, label: nodeName(s.root) },
              ...entities.map((e) => ({ value: e.id, label: e.name })),
              ...(picked ? [{ value: picked.id, label: t("structureChart.export.selected", { name: picked.name }) }] : []),
            ]}
          />
          {!visible && <>
          <ChoiceField label={t("structure.export.depth")} required value={depth} onChange={(v) => setDepth(v as Depth)} options={(["sites", "one", "two", "all"] as const).map((d) => ({ value: d, label: t(`structure.depth.${d}`) }))} />
          <div className={css.exportWhat} role="group" aria-label={t("structureChart.export.fields")}>
            <span className={css.exportWhatLabel}>{t("structureChart.export.fields")}</span>
            {BOX_FIELDS.map((f) => (
              <ToggleButton key={f} className={css.pill} pressed={fields.has(f)} onClick={() => flip(f)}>
                {fields.has(f) && <Tick size={14} aria-hidden />}{t(`structureChart.export.field.${f}`)}
              </ToggleButton>
            ))}
          </div>
          <ChoiceField label={t("structure.export.format")} required value={format} onChange={(v) => setFormat(v as "pdf" | "png")} options={[{ value: "pdf", label: "PDF" }, { value: "png", label: "PNG" }]} />
          <ChoiceField label={t("structure.export.size")} required value={paper.size} onChange={(v) => setPaper((p) => ({ ...p, size: v as Paper["size"] }))} options={[{ value: "A3", label: "A3" }, { value: "A4", label: "A4" }]} />
          <ChoiceField label={t("structure.export.orient")} required value={paper.orient} onChange={(v) => setPaper((p) => ({ ...p, orient: v as Paper["orient"] }))} options={[{ value: "landscape", label: t("structure.export.landscape") }, { value: "portrait", label: t("structure.export.portrait") }]} />
          {format === "pdf" && sitePages > 1 && (
            <ChoiceField
              label={t("structureChart.export.pages")}
              required
              value={perSite ? "site" : "one"}
              onChange={(v) => (setPerSite(v === "site"), setPage(0))}
              options={[{ value: "one", label: t("structureChart.export.page.one") }, { value: "site", label: t("structureChart.export.page.site", { count: sitePages }) }]}
            />
          )}
          <p className={pt < GUARD_PT ? css.guardWarn : css.guardOk} role="status">{t("structure.export.pointGuard", { pt })}</p>
          <Field label={t("structure.export.titleLabel")} required hint={t("structure.export.titleHint")}>
            {(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Check checked={redact} onChange={setRedact}>{t("structure.export.redact")}</Check>
          </>}
        </div>
        {visible ? <div className={css.exportPreview}>
          <Table<(typeof sheetRows)[number]> label={t("structureChart.list.download")} rows={sheetRows} rowId={(r) => r.id} columns={headers.map((header, i) => ({ header, cell: (r) => r.cells[i] }))} />
        </div> : <figure className={css.exportPreview}>
          <figcaption className={`${css.exportPager} muted`}>
            {pages.length > 1 && (
              <>
                <Button variant="ghost" className={css.chev} disabled={at === 0} onClick={() => setPage(at - 1)} aria-label={t("structureChart.export.prev")}><ChevronLeft size={16} aria-hidden /></Button>
                <span aria-live="polite">{t("structureChart.export.pager", { at: at + 1, total: pages.length })}</span>
                <Button variant="ghost" className={css.chev} disabled={at === pages.length - 1} onClick={() => setPage(at + 1)} aria-label={t("structureChart.export.next")}><ChevronRight size={16} aria-hidden /></Button>
              </>
            )}
            <span className="grow" />
            {t("structure.export.paper", { size: paper.size, orient: t(`structure.export.${paper.orient}`), w: area.mmW, h: area.mmH })}
          </figcaption>
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={t("structure.export.previewAlt", { title })} />
        </figure>}
      </div>
    </Sheet>
  );
}
