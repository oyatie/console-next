// SPDX-License-Identifier: LicenseRef-Proprietary
export function githubSlug(heading: string): string {
  let out = "";
  for (const ch of heading.trim().toLowerCase()) {
    if (/[\p{L}\p{N}_-]/u.test(ch)) out += ch;
    else if (/\s/.test(ch)) out += "-";
  }
  return out;
}

function stripAngleBracketTags(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "<") {
      const close = input.indexOf(">", i + 1);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    }
    out += input[i] ?? "";
    i += 1;
  }
  return out;
}

export function cleanHeadingText(raw: string): string {
  return stripAngleBracketTags(raw.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, ""));
}

export function extractSafeAnchorIds(line: string): string[] {
  const ids: string[] = [];
  const tagRe = /<a\s+([^>]+)>/gi;
  let match: RegExpExecArray | null = tagRe.exec(line);
  while (match) {
    const attrs = match[1] ?? "";
    const idMatch = /\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    const val = (idMatch?.[1] ?? idMatch?.[2] ?? "").trim();
    if (/^[A-Za-z0-9_.:-]+$/.test(val)) {
      ids.push(val);
    }
    match = tagRe.exec(line);
  }
  return ids;
}

export function stripAnchorTags(line: string): string {
  return line.replace(/<a\s+[^>]*>\s*(?:<\/a>)?/gi, "").replace(/<\/a>/gi, "");
}

function decodePathForSafety(rawPath: string): { decoded: string; segments: string[]; hasPercentTraversal: boolean } {
  const lowered = rawPath.toLowerCase();
  const hasPercentTraversal = /(?:^|[/\\])(?:\.|%2e){2}(?:$|[/\\])/.test(lowered);
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath.replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
  }
  const segments = decoded.split(/[/\\]/);
  return { decoded, segments, hasPercentTraversal };
}

export function isSafeScheme(url: string): "anchor" | "external" | "route" | "relative" | "unsafe" {
  const normalized = [...url]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!normalized) return "unsafe";
  if (normalized.startsWith("//") || normalized.startsWith("/\\") || normalized.startsWith("\\")) {
    return "unsafe";
  }
  if (normalized.startsWith("#")) return "anchor";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    const lower = normalized.toLowerCase();
    if (lower.startsWith("https://") || lower.startsWith("http://")) return "external";
    return "unsafe";
  }
  const pathOnly = normalized.split(/[?#]/, 1)[0] ?? "";
  if (!pathOnly) return "unsafe";
  const { decoded, segments, hasPercentTraversal } = decodePathForSafety(pathOnly);
  if (hasPercentTraversal || decoded.includes("\\") || segments.some((seg) => seg === "..")) {
    return "unsafe";
  }
  if (normalized.startsWith("/")) {
    if (decoded.startsWith("//") || decoded.startsWith("/\\")) return "unsafe";
    const lowerRaw = pathOnly.toLowerCase();
    const lowerDecoded = decoded.toLowerCase();
    if (
      lowerRaw === "/api" ||
      lowerRaw.startsWith("/api/") ||
      lowerDecoded === "/api" ||
      lowerDecoded.startsWith("/api/")
    ) {
      return "unsafe";
    }
    if (lowerRaw.endsWith(".md") || lowerDecoded.endsWith(".md")) return "relative";
    return "route";
  }
  return "relative";
}
