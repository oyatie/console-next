// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { isSafeScheme } from "../lib/markdown";
import { ExternalUrl } from "./external-url";
import s from "./safe-markdown.module.css";

function parseRouteSearch(query: string): Record<string, string | string[]> | undefined {
  if (!query) return undefined;
  const params = new URLSearchParams(query);
  const out: Record<string, string | string[]> = {};
  let hasEntries = false;
  for (const [key, val] of params.entries()) {
    hasEntries = true;
    const prev = out[key];
    if (prev === undefined) {
      out[key] = val;
    } else if (Array.isArray(prev)) {
      prev.push(val);
    } else {
      out[key] = [prev, val];
    }
  }
  return hasEntries ? out : undefined;
}

function buildUrlParenMap(text: string): Int32Array {
  const matchClose = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < text.length; k += 1) {
    const c = text.charCodeAt(k);
    if (c === 40) {
      stack.push(k);
    } else if (c === 41) {
      const open = stack.pop();
      if (open !== undefined) {
        matchClose[open] = k;
      }
    } else if (c === 32 || (c >= 9 && c <= 13) || (c >= 160 && /\s/.test(text.charAt(k)))) {
      stack.length = 0;
    }
  }
  return matchClose;
}

function RouteLink({
  to,
  query,
  hash,
  className,
  children,
}: {
  to: string;
  query?: string;
  hash?: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter({ warn: false });
  if (!router) {
    const href = `${to}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  const search = parseRouteSearch(query ?? "");
  return (
    <Link to={to as "/"} search={search as never} hash={hash} className={className}>
      {children}
    </Link>
  );
}

export function InlineMarkdown({
  text,
  keyPrefix,
  onNavigateDoc,
}: {
  text: string;
  keyPrefix: string;
  onNavigateDoc?: (docPath: string, anchor?: string) => void;
}) {
  const nodes: ReactNode[] = [];
  const hasLinkMid = text.includes("](");
  const urlParenClose = hasLinkMid ? buildUrlParenMap(text) : null;
  let plainStart = 0;
  let i = 0;
  let partIdx = 0;
  let noBacktick = false;
  let noDoubleStar = false;
  let noStar = false;
  let noLink = !hasLinkMid;
  let nextMid = -2;
  let failedBracketUntil = -1;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      nodes.push(<Fragment key={`${keyPrefix}-t-${partIdx++}`}>{text.slice(plainStart, end)}</Fragment>);
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`" && !noBacktick) {
      const close = text.indexOf("`", i + 1);
      if (close === -1) {
        noBacktick = true;
        i += 1;
        continue;
      }
      if (close > i + 1) {
        flushPlain(i);
        nodes.push(
          <code key={`${keyPrefix}-c-${partIdx++}`} className={s.inlineCode}>
            {text.slice(i + 1, close)}
          </code>,
        );
        i = close + 1;
        plainStart = i;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "[" && !noLink && i > failedBracketUntil) {
      if (nextMid < i + 2) {
        nextMid = text.indexOf("](", i + 2);
        if (nextMid === -1) {
          noLink = true;
          i += 1;
          continue;
        }
      }
      const closeBr = text.indexOf("]", i + 1);
      if (closeBr === -1) {
        noLink = true;
        i += 1;
        continue;
      }
      if (closeBr === i + 1 || text[closeBr + 1] !== "(") {
        if (closeBr < nextMid) failedBracketUntil = closeBr;
        i += 1;
        continue;
      }

      const openParen = closeBr + 1;
      const closeParen = urlParenClose ? (urlParenClose[openParen] ?? -1) : -1;

      if (closeParen > openParen + 1) {
        const j = closeParen;
        const label = text.slice(i + 1, closeBr);
        const href = text.slice(openParen + 1, j).trim();
        const kind = isSafeScheme(href);
        flushPlain(i);

        if (kind === "anchor") {
          nodes.push(
            <a key={`${keyPrefix}-a-${partIdx++}`} href={href} className={s.anchorLink}>
              {label}
            </a>,
          );
          i = j + 1;
        } else if (kind === "route") {
          const hashIdx = href.indexOf("#");
          const beforeHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
          const hashPart = hashIdx >= 0 ? href.slice(hashIdx + 1) : "";
          const qIdx = beforeHash.indexOf("?");
          const pathname = (qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash) || "/";
          const queryPart = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : "";
          nodes.push(
            <RouteLink
              key={`${keyPrefix}-r-${partIdx++}`}
              to={pathname}
              query={queryPart || undefined}
              hash={hashPart || undefined}
              className={s.anchorLink}
            >
              {label}
            </RouteLink>,
          );
          i = j + 1;
        } else if (kind === "external") {
          const after = text[j + 1] ?? "";
          const after2 = text[j + 2] ?? "";
          const hasTrailPunct = /^[.,;:!?]$/.test(after) && (after2 === "" || /\s/.test(after2));
          const punct = hasTrailPunct ? after : "";
          nodes.push(
            <Fragment key={`${keyPrefix}-e-${partIdx++}`}>
              <span>{label}</span>
              {" "}
              <span className={s.externalTail}>
                <ExternalUrl value={href} />
                {punct ? <span className={s.externalPunct}>{punct}</span> : null}
              </span>
            </Fragment>,
          );
          i = j + 1 + punct.length;
        } else if (kind === "relative" && onNavigateDoc) {
          const [docPart, hashPart] = href.split("#");
          nodes.push(
            <button
              key={`${keyPrefix}-d-${partIdx++}`}
              type="button"
              className={s.docLinkBtn}
              onClick={() => onNavigateDoc(docPart ?? "", hashPart || undefined)}
            >
              {label}
            </button>,
          );
          i = j + 1;
        } else {
          nodes.push(<span key={`${keyPrefix}-u-${partIdx++}`}>{label}</span>);
          i = j + 1;
        }
        plainStart = i;
        continue;
      }

      failedBracketUntil = Math.max(failedBracketUntil, closeBr);
      i += 1;
      continue;
    }

    if (ch === "*" && text[i + 1] === "*" && !noDoubleStar) {
      let k = i + 2;
      let closed = -1;
      while (k < text.length) {
        if (text[k] === "*" && text[k + 1] === "*" && k > i + 2) {
          closed = k;
          break;
        }
        k += 1;
      }
      if (closed !== -1) {
        flushPlain(i);
        nodes.push(<strong key={`${keyPrefix}-b-${partIdx++}`}>{text.slice(i + 2, closed)}</strong>);
        i = closed + 2;
        plainStart = i;
        continue;
      }
      noDoubleStar = true;
      i += 2;
      continue;
    }

    if (ch === "*" && !noStar) {
      const close = text.indexOf("*", i + 1);
      if (close === -1) {
        noStar = true;
        i += 1;
        continue;
      }
      if (close > i + 1) {
        flushPlain(i);
        nodes.push(<em key={`${keyPrefix}-i-${partIdx++}`}>{text.slice(i + 1, close)}</em>);
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushPlain(text.length);
  return <>{nodes}</>;
}
