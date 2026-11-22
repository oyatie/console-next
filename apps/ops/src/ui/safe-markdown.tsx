// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { cleanHeadingText, extractSafeAnchorIds, githubSlug, stripAnchorTags } from "../lib/markdown";
import { InlineMarkdown } from "./safe-markdown-inline";
import s from "./safe-markdown.module.css";

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  return splitTableRow(trimmed).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderHeading(level: number, slug: string, text: string, anchors: string[], onNavigateDoc?: (d: string, a?: string) => void, key?: string) {
  const inner = (
    <>
      {anchors.map((a) => (
        <span key={a} id={a} className={s.anchorTarget} />
      ))}
      <InlineMarkdown text={text} keyPrefix={key ?? slug} onNavigateDoc={onNavigateDoc} />
    </>
  );
  if (level === 1) return <h1 key={key} id={slug} className={s.h1}>{inner}</h1>;
  if (level === 2) return <h2 key={key} id={slug} className={s.h2}>{inner}</h2>;
  if (level === 3) return <h3 key={key} id={slug} className={s.h3}>{inner}</h3>;
  if (level === 4) return <h4 key={key} id={slug} className={s.h4}>{inner}</h4>;
  if (level === 5) return <h5 key={key} id={slug} className={s.h5}>{inner}</h5>;
  return <h6 key={key} id={slug} className={s.h6}>{inner}</h6>;
}

export function SafeMarkdown({
  content,
  onNavigateDoc,
}: {
  content: string;
  onNavigateDoc?: (docPath: string, anchor?: string) => void;
}) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const seenSlugs = new Map<string, number>();
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      idx += 1;
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line.trimStart());
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      const ch = marker[0] ?? "`";
      const len = marker.length;
      const codeLines: string[] = [];
      idx += 1;
      while (idx < lines.length) {
        const next = lines[idx] ?? "";
        const closeMatch = new RegExp(`^\\s*${ch}{${len},}\\s*$`).exec(next);
        if (closeMatch) {
          idx += 1;
          break;
        }
        codeLines.push(next);
        idx += 1;
      }
      blocks.push(<pre key={`pre-${idx}`} className={s.pre}><code>{codeLines.join("\n")}</code></pre>);
      continue;
    }

    const anchorIds = extractSafeAnchorIds(line);
    const cleanedLine = stripAnchorTags(line);

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(cleanedLine.trimStart());
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const rawText = headingMatch[2] ?? "";
      const slugBase = githubSlug(cleanHeadingText(rawText));
      const count = seenSlugs.get(slugBase) ?? 0;
      seenSlugs.set(slugBase, count + 1);
      const slug = count === 0 ? slugBase : `${slugBase}-${count}`;
      blocks.push(renderHeading(level, slug, rawText, anchorIds, onNavigateDoc, `h-${idx}`));
      idx += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${idx}`} className={s.hr} />);
      idx += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (idx < lines.length && (lines[idx] ?? "").trimStart().startsWith(">")) {
        quoteLines.push((lines[idx] ?? "").trimStart().replace(/^>\s?/, ""));
        idx += 1;
      }
      blocks.push(
        <blockquote key={`q-${idx}`} className={s.quote}>
          <InlineMarkdown text={quoteLines.join(" ")} keyPrefix={`q-${idx}`} onNavigateDoc={onNavigateDoc} />
        </blockquote>,
      );
      continue;
    }

    if (trimmed.includes("|") && idx + 1 < lines.length && isTableSeparator(lines[idx + 1] ?? "")) {
      const headers = splitTableRow(trimmed);
      idx += 2;
      const rows: string[][] = [];
      while (idx < lines.length && (lines[idx] ?? "").trim().includes("|")) {
        rows.push(splitTableRow(lines[idx] ?? ""));
        idx += 1;
      }
      blocks.push(
        <div key={`tbl-${idx}`} className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>{headers.map((h, ci) => <th key={ci}><InlineMarkdown text={h} keyPrefix={`th-${idx}-${ci}`} onNavigateDoc={onNavigateDoc} /></th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{headers.map((_, ci) => <td key={ci}><InlineMarkdown text={r[ci] ?? ""} keyPrefix={`td-${idx}-${ri}-${ci}`} onNavigateDoc={onNavigateDoc} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*[-*+]\s+/.test(lines[idx] ?? "")) {
        items.push((lines[idx] ?? "").replace(/^\s*[-*+]\s+/, ""));
        idx += 1;
      }
      blocks.push(
        <ul key={`ul-${idx}`} className={s.list}>
          {items.map((it, li) => <li key={li}><InlineMarkdown text={it} keyPrefix={`ul-${idx}-${li}`} onNavigateDoc={onNavigateDoc} /></li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*\d+\.\s+/.test(lines[idx] ?? "")) {
        items.push((lines[idx] ?? "").replace(/^\s*\d+\.\s+/, ""));
        idx += 1;
      }
      blocks.push(
        <ol key={`ol-${idx}`} className={s.list}>
          {items.map((it, li) => <li key={li}><InlineMarkdown text={it} keyPrefix={`ol-${idx}-${li}`} onNavigateDoc={onNavigateDoc} /></li>)}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    const paraAnchors: string[] = [...anchorIds];
    if (cleanedLine.trim()) paraLines.push(cleanedLine.trim());
    idx += 1;
    while (idx < lines.length) {
      const next = lines[idx] ?? "";
      const nt = next.trim();
      if (!nt || /^(#{1,6}\s|```|~~~|>|[-*+]\s|\d+\.\s|-{3,}$|\*{3,}$)/.test(nt)) break;
      if (nt.includes("|") && idx + 1 < lines.length && isTableSeparator(lines[idx + 1] ?? "")) break;
      paraAnchors.push(...extractSafeAnchorIds(next));
      const cleanedNext = stripAnchorTags(next).trim();
      if (cleanedNext) paraLines.push(cleanedNext);
      idx += 1;
    }
    blocks.push(
      <p key={`p-${idx}`} className={s.para}>
        {paraAnchors.map((a) => <span key={a} id={a} className={s.anchorTarget} />)}
        <InlineMarkdown text={paraLines.join(" ")} keyPrefix={`p-${idx}`} onNavigateDoc={onNavigateDoc} />
      </p>,
    );
  }

  return <article className={s.doc}>{blocks}</article>;
}
