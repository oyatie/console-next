import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const digest = (s) => createHash("sha256").update(s).digest("hex");
export const generated = (p) => /docs\/plans\/backlog-(?:index|sources|allowlist)/.test(p);
export function sourceFiles(root, folders = ["docs"]) {
  const files = [];
  function walk(p) {
    for (const e of readdirSync(path.join(root, p), { withFileTypes: true })) {
      const f = `${p}/${e.name}`;
      if (e.isDirectory()) walk(f);
      else if (/\.(md|json|xlsx)$/.test(f) && !generated(f)) files.push(f);
    }
  }
  for (const p of folders) {
    if (/\.(md|json)$/.test(p)) files.push(p);
    else walk(p);
  }
  return files.sort();
}

// Preserve prose and table rows; skip headings, separators, and illustrative code.
export function markdownBlocks(text) {
  const lines = text.split(/\r?\n/), blocks = [];
  let headings = [], pending, fence, comment = false;
  const flush = () => {
    if (pending) blocks.push(pending);
    pending = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    const n = i + 1;
    if (!fence) {
      if (comment) {
        const closing = line.indexOf("-->");
        if (closing < 0) { flush(); continue; }
        line = line.slice(closing + 3);
        comment = false;
      }
      line = line.replace(/<!--[\s\S]*?-->/g, "");
      const opening = line.indexOf("<!--");
      if (opening >= 0) { comment = true; line = line.slice(0, opening); }
      line = line.trim();
    }
    const fenced = line.match(/^(`{3,}|~{3,})/);
    if (fenced) {
      flush();
      if (!fence) fence = fenced[1][0];
      else if (fenced[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const head = line.match(/^(#{1,6})\s+(.*)/);
    if (head) { flush(); headings = headings.slice(0, head[1].length - 1); headings[head[1].length - 1] = head[2]; continue; }
    if (!line || /^(?:[-*_]\s*){3,}$/.test(line) || /^\|[\s:|\-]+\|$/.test(line)) { flush(); continue; }
    const separate = /^(?:\||[-*+]\s|\d+[.)]\s|>)/.test(line);
    if (separate) flush();
    if (!pending) pending = { line: n, endLine: n, section: headings.filter(Boolean).join(" / "), summary: line };
    else { pending.summary += ` ${line}`; pending.endLine = n; }
    if (separate) flush();
  }
  flush();
  return blocks;
}

export function jsonBlocks(text, file) {
  const data = JSON.parse(text), lines = text.split("\n"), blocks = [];
  if (file.endsWith("/capabilities.json")) {
    let cursor = 0;
    for (const c of data.capabilities) {
      const line = lines.findIndex((l, i) => i >= cursor && l.includes(`"${c.id}"`));
      cursor = line + 1;
      blocks.push({ line: line + 1, endLine: line + 1, section: c.module, capability: c.id, module: c.module,
        milestone: c.milestone, summary: `${c.title}: ${c.statement} ${c.polish?.text ?? ""} ${c.mvp_slice ?? ""}`.trim() });
    }
    blocks.push(...jsonLeaves(text).filter((b) => !b.section.startsWith("/capabilities/")));
    return blocks;
  }
  if (file === "manifest.json") {
    let cursor = 0;
    for (const frame of data.frames) {
      const line = lines.findIndex((l, i) => i >= cursor && l.includes(JSON.stringify(frame.id)));
      cursor = Math.max(cursor, line + 1);
      blocks.push({ line: Math.max(1, line + 1), endLine: Math.max(1, line + 1), section: frame.vertical,
        summary: `${frame.id}: ${frame.screen_title ?? frame.screen ?? ""}; ${frame.caption ?? frame.name}; ${frame.state}; ${frame.theme}; ${frame.width}×${frame.height}; ${frame.status}; spec ${frame.spec ?? "unspecified"}; lifecycle ${JSON.stringify(frame.lifecycle ?? {})}` });
    }
    return blocks;
  }
  return jsonLeaves(text);
}

// JSON.parse validates grammar; token traversal locates repeated values at their actual lines.
export function jsonLeaves(text) {
  JSON.parse(text);
  let line = 1, previous = 0, cursor = 0;
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)].map((m) => {
    line += (text.slice(previous, m.index).match(/\n/g) ?? []).length;
    previous = m.index;
    return { text: m[0], line };
  });
  const blocks = [], escape = (s) => s.replaceAll("~", "~0").replaceAll("/", "~1");
  function visit(pointer) {
    const token = tokens[cursor++];
    if (token.text === "{") {
      while (tokens[cursor].text !== "}") {
        const key = JSON.parse(tokens[cursor++].text);
        cursor++; // colon
        visit(`${pointer}/${escape(key)}`);
        if (tokens[cursor].text === ",") cursor++;
      }
      cursor++;
    } else if (token.text === "[") {
      let n = 0;
      while (tokens[cursor].text !== "]") {
        visit(`${pointer}/${n++}`);
        if (tokens[cursor].text === ",") cursor++;
      }
      cursor++;
    } else blocks.push({ line: token.line, endLine: token.line, section: pointer, summary: `${pointer}: ${token.text}` });
  }
  visit("");
  return blocks;
}

export function readSource(root, file, repo) {
  const bytes = readFileSync(path.join(root, file));
  if (file.endsWith(".xlsx")) return { repo, file, sha256: digest(bytes), lines: 0, format: "xlsx", blocks: [] };
  const text = bytes.toString("utf8");
  return { repo, file, sha256: digest(bytes), lines: text.split(/\r?\n/).length, format: path.extname(file).slice(1),
    blocks: file.endsWith(".json") ? jsonBlocks(text, file) : markdownBlocks(text) };
}
