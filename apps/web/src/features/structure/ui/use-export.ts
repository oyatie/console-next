import { t } from "@console/i18n";
import { expandedFor, layout, type Depth, type Layout } from "../domain/layout";
import { deptCount, descendants, type ChartNode, type Structure } from "../domain/model";
import { levelText, nodeName } from "../present";

export type Paper = { size: "A3" | "A4"; orient: "landscape" | "portrait" };
const MM = { A3: [420, 297], A4: [297, 210] } as const;
const PT_PER_MM = 72 / 25.4;
/** Box text is 13 px on screen (--text-sm). */
const BASE_PX = 13;

/** The printable area in pt (10 mm margins, a 14 mm footer band). */
export function paperPt(p: Paper) {
  const [long, short] = MM[p.size];
  const [w, h] = p.orient === "landscape" ? [long, short] : [short, long];
  return { w: (w - 20) * PT_PER_MM, h: (h - 34) * PT_PER_MM, mmW: w, mmH: h };
}

/** The type size the chart prints at when fitted to the paper (spec: warn below 9 pt). */
export function printedPt(L: Layout, p: Paper) {
  const area = paperPt(p);
  const scale = Math.min(area.w / L.w, area.h / L.h, 1);
  return Math.round(BASE_PX * scale * 10) / 10;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EDGE = { tenant: "#141a21", entity: "#141a21", site: "#0f766e", dept: "#dbe1e8" } as const;

/** What a printed box carries besides its name (S2-chart-export, the box fields). */
export type BoxField = "head" | "people" | "unplaced" | "code" | "brn";
export const BOX_FIELDS: readonly BoxField[] = ["head", "people", "unplaced", "code", "brn"];

/** A printed box's lines under its name, from the fields chosen; `redact` drops every person's name (outside sharing). */
function boxLines(n: ChartNode, f: ReadonlySet<BoxField>, redact: boolean): string[] {
  const head = f.has("head") && !redact;
  if (n.kind === "entity")
    return [
      f.has("brn") && n.brn ? t("structure.node.entityKicker", { brn: n.brn }) : "",
      head && n.reps ? t("structure.node.reps", { name: n.reps.first, more: n.reps.more }) : "",
      [t("structure.node.entityCounts", { sites: n.children.length, depts: deptCount(n) }), f.has("unplaced") && n.unplaced ? t("structureChart.unplaced", { count: n.unplaced }) : ""].filter(Boolean).join(" · "),
    ];
  if (n.kind === "site") return [levelText(n)];
  if (n.kind === "dept") {
    const who = head ? (n.head ? t("structure.node.head", { name: n.head.name, concurrent: n.head.concurrent ? "yes" : "no" }) : t("structure.node.headVacant")) : "";
    return [[who, f.has("code") ? n.code : ""].filter(Boolean).join(" · ")];
  }
  return [];
}

/**
 * The chart as a standalone SVG for paper and PNG: boxes, connectors and text only (no expanders, toolbars or
 * marks; printed boxes drop every interactive affordance), each box with the fields chosen. Always light: paper is
 * white. text uses system Korean fonts (the webfont is not embedded).
 */
export function chartSvg(L: Layout, o: { redact: boolean; stamp: string; fields: ReadonlySet<BoxField> }): string {
  const foot = 28;
  const boxes = L.boxes.filter((b) => !b.ghost && !b.slot).map((b) => {
    const n = b.node;
    const count = o.fields.has("people") ? t("common.headcount", { count: n.headcount }) : "";
    // The root prints as a plain heading, not a box (decision #29).
    if (n.kind === "tenant") return `<text x="${b.x}" y="${b.y + 22}" font-size="15" font-weight="700">${esc([nodeName(n), count].filter(Boolean).join(" · "))}</text>`;
    const lines = boxLines(n, o.fields, o.redact).filter(Boolean).slice(0, Math.max(1, Math.floor((b.h - 30) / 16)));
    return `<g transform="translate(${b.x},${b.y})"><rect width="${b.w}" height="${b.h}" rx="6" fill="#fff" stroke="#dbe1e8"/><rect width="${b.w}" height="3" fill="${EDGE[n.kind]}"/>
<text x="12" y="22" font-size="${n.kind === "dept" ? 14 : 15}" font-weight="700">${esc(n.name)}</text><text x="${b.w - 12}" y="22" font-size="13" font-weight="700" text-anchor="end">${esc(count)}</text>
${lines.map((l, i) => `<text x="12" y="${40 + i * 16}" font-size="12" fill="#566475">${esc(l)}</text>`).join("")}</g>`;
  });
  const lines = L.lines.map((l) => `<path d="${l.d}" fill="none" stroke="#7b8797"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.w}" height="${L.h + foot}" viewBox="0 0 ${L.w} ${L.h + foot}" font-family="'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" fill="#141a21">
<rect width="100%" height="100%" fill="#fff"/>${lines}${boxes.join("")}
<text x="40" y="${L.h + 14}" font-size="11" fill="#566475">${esc(o.stamp)}</text></svg>`;
}

/** The pages to print: the start fitted on one, or one per workplace under it (each its own chart, S2-chart-export pages). */
export function exportPages(s: Structure, start: ChartNode, depth: Depth, perSite: boolean): Layout[] {
  const roots = perSite ? (start.kind === "site" ? [start] : descendants(start).filter((n) => n.kind === "site")) : [start];
  return (roots.length ? roots : [start]).map((focus) => layout({ s, focus, expanded: expandedFor(focus, depth) }));
}

/** Prints the SVGs one to a page (PDF through the browser's print dialog), never the screen around them. */
export function printSvg(svgs: readonly string[], p: Paper, title: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.className = "print-frame";
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = `@page { size: ${p.size} ${p.orient}; margin: 10mm; } html, body { margin: 0; } svg { display: block; width: 100%; height: auto; max-height: ${paperPt(p).mmH - 20}mm; break-after: page; } svg:last-child { break-after: auto; }`;
  doc.head.append(style);
  doc.body.innerHTML = svgs.join("");
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 1000);
}

/** Saves the SVG as a PNG at 2× (a slide or a message). */
export async function downloadPng(svg: string, name: string) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width * 2;
  canvas.height = img.height * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `${name}.png`;
  a.click();
}
