#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Enforces modern cryptographic primitives in SQL migrations added after the cutover version.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CUTOVER_VERSION = 20261120143002000n;
const DEFAULT_MIGRATIONS_DIR = "backend/crates/platform/db/migrations";
const MAX_DOLLAR_NEST_DEPTH = 16;

const BANNED_DIRECT_CALLS = new Set([
  "md5", "sha1", "crypt", "gen_salt",
  "encrypt", "decrypt", "encrypt_iv", "decrypt_iv",
  "pgp_sym_encrypt", "pgp_sym_decrypt", "pgp_pub_encrypt", "pgp_pub_decrypt",
  "pgp_sym_encrypt_bytea", "pgp_sym_decrypt_bytea", "pgp_pub_encrypt_bytea", "pgp_pub_decrypt_bytea",
]);

const WEAK_HASH_ALG = /^(?:md5|sha-?1|md4|md2|ripemd160)$/i;
const PUNCT = new Set(["(", ")", ",", ".", ";"]);
const NAMED_ALG_PARAMS = new Set(["type", "alg", "algorithm"]);
const ESCAPE_MAP = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Parse migration filename prefix into a normalized 17-digit-compatible BigInt (null = unrecognized). */
export function parseMigrationVersion(filename) {
  const match = path.basename(filename).match(/^(\d+)_.+\.sql$/);
  if (!match) return null;
  const prefix = match[1];
  if (prefix.length === 4 || prefix.length === 17) return BigInt(prefix);
  if (prefix.length === 14) return BigInt(`${prefix}000`);
  return null;
}

/** Whether a migration file is historical and exempt from scanning. */
export function isExemptMigration(filename, cutover = CUTOVER_VERSION) {
  const version = parseMigrationVersion(filename);
  return version !== null && version <= cutover;
}

function countNewlines(text) {
  let n = 0;
  for (let idx = text.indexOf("\n"); idx !== -1; idx = text.indexOf("\n", idx + 1)) n++;
  return n;
}

function readDelimited(sql, i, quoteChar) {
  let value = "";
  let lines = 0;
  i++;
  while (i < sql.length) {
    const cur = sql[i];
    if (cur === quoteChar) {
      if (sql[i + 1] === quoteChar) {
        value += quoteChar;
        i += 2;
      } else {
        i++;
        break;
      }
    } else {
      if (cur === "\n") lines++;
      value += cur;
      i++;
    }
  }
  return { value, next: i, lines };
}

function readEscapeString(sql, i) {
  let value = "";
  let lines = 0;
  i += 2;
  while (i < sql.length) {
    const cur = sql[i];
    if (cur === "\\") {
      if (i + 1 >= sql.length) { i++; break; }
      const next = sql[i + 1];
      const hexMatch =
        next === "x" || next === "X" ? sql.slice(i + 2, i + 4).match(/^[0-9A-Fa-f]{1,2}/)
          : next === "u" ? sql.slice(i + 2, i + 6).match(/^[0-9A-Fa-f]{4}/)
            : next === "U" ? sql.slice(i + 2, i + 10).match(/^[0-9A-Fa-f]{8}/)
              : null;
      if (hexMatch) {
        const cp = Number.parseInt(hexMatch[0], 16);
        if (cp <= 0x10ffff) value += next === "x" || next === "X" ? String.fromCharCode(cp) : String.fromCodePoint(cp);
        i += 2 + hexMatch[0].length;
        continue;
      }
      if (next >= "0" && next <= "7") {
        const oct = sql.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        value += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
        continue;
      }
      if (next in ESCAPE_MAP) { value += ESCAPE_MAP[next]; i += 2; continue; }
      if (next === "\n") lines++;
      value += next;
      i += 2;
    } else if (cur === "'") {
      if (sql[i + 1] === "'") { value += "'"; i += 2; } else { i++; break; }
    } else {
      if (cur === "\n") lines++;
      value += cur;
      i++;
    }
  }
  return { value, next: i, lines };
}

function decodeUnicodeLiteral(raw, escChar) {
  let out = "";
  for (let j = 0; j < raw.length; ) {
    if (raw[j] === escChar) {
      if (raw[j + 1] === escChar) { out += escChar; j += 2; continue; }
      const hex6 = raw[j + 1] === "+" ? raw.slice(j + 2, j + 8).match(/^[0-9A-Fa-f]{6}/) : null;
      if (hex6) {
        const cp = Number.parseInt(hex6[0], 16);
        if (cp <= 0x10ffff) out += String.fromCodePoint(cp);
        j += 8;
        continue;
      }
      const hex4 = raw.slice(j + 1, j + 5).match(/^[0-9A-Fa-f]{4}/);
      if (hex4) { out += String.fromCodePoint(Number.parseInt(hex4[0], 16)); j += 5; continue; }
    }
    out += raw[j++];
  }
  return out;
}

/** Character-level SQL lexer tracking 1-based line numbers and isolating `$tag$...$tag$` literals. */
export function tokenizeSql(sql, lineOffset = 0) {
  const tokens = [];
  let line = 1 + lineOffset;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      if (ch === "\n") line++;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else { if (sql[i] === "\n") line++; i++; }
      }
      continue;
    }
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'") {
      const startLine = line;
      const res = readEscapeString(sql, i);
      line += res.lines;
      i = res.next;
      tokens.push({ type: "string", value: res.value, line: startLine });
      continue;
    }
    if ((ch === "U" || ch === "u") && sql[i + 1] === "&" && sql[i + 2] === "'") {
      const startLine = line;
      const res = readDelimited(sql, i + 2, "'");
      line += res.lines;
      i = res.next;
      let escChar = "\\";
      const uesc = sql.slice(i).match(/^(\s+UESCAPE\s+)'([^'])'/i);
      if (uesc) { escChar = uesc[2]; line += countNewlines(uesc[1]); i += uesc[0].length; }
      tokens.push({ type: "string", value: decodeUnicodeLiteral(res.value, escChar), line: startLine });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      const res = readDelimited(sql, i, ch);
      line += res.lines;
      i = res.next;
      tokens.push(
        ch === "'"
          ? { type: "string", value: res.value, line: startLine }
          : { type: "ident", value: res.value.toLowerCase(), quoted: true, line: startLine },
      );
      continue;
    }
    if (ch === "$") {
      const tagMatch = sql.slice(i, i + 128).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const startLine = line;
        const bodyStart = i + tag.length;
        const closeIdx = sql.indexOf(tag, bodyStart);
        const body = closeIdx === -1 ? sql.slice(bodyStart) : sql.slice(bodyStart, closeIdx);
        line += countNewlines(body);
        tokens.push({ type: "string", value: body, dollarTag: tag, line: startLine });
        i = closeIdx === -1 ? len : closeIdx + tag.length;
        continue;
      }
      tokens.push({ type: "other", value: "$", line });
      i++;
      continue;
    }
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      const startLine = line;
      let end = i + 1;
      while (end < len && /[A-Za-z0-9_$]/.test(sql[end])) end++;
      tokens.push({ type: "ident", value: sql.slice(i, end).toLowerCase(), quoted: false, line: startLine });
      i = end;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === "||" || two === "=>" || two === "::") {
      tokens.push({ type: "op", value: two, line });
      i += 2;
      continue;
    }
    tokens.push({ type: PUNCT.has(ch) ? "punct" : "other", value: ch, line });
    i++;
  }
  return tokens;
}

function collectCallArgs(tokens, openParenIndex) {
  const args = [[]];
  let depth = 1;
  for (let i = openParenIndex + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.value === "(") { depth++; args[args.length - 1].push(tok); }
    else if (tok.type === "punct" && tok.value === ")") { if (--depth === 0) break; args[args.length - 1].push(tok); }
    else if (tok.type === "punct" && tok.value === "," && depth === 1) args.push([]);
    else args[args.length - 1].push(tok);
  }
  return args;
}

function findMatchingCloseParen(tokens, openIdx, end) {
  let depth = 0;
  for (let i = openIdx; i < end; i++) {
    if (tokens[i].type === "punct" && tokens[i].value === "(") depth++;
    else if (tokens[i].type === "punct" && tokens[i].value === ")" && --depth === 0) return i;
  }
  return -1;
}

function evalStringExpr(tokens, start = 0, end = tokens.length) {
  while (start + 1 < end && tokens[start].type === "punct" && tokens[start].value === "(" && findMatchingCloseParen(tokens, start, end) === end - 1) {
    start++;
    end--;
  }
  if (start >= end) return null;

  const parts = [];
  let depth = 0;
  let segStart = start;
  let sawConcat = false;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth--;
    else if (depth === 0 && t.type === "op" && t.value === "||") { sawConcat = true; parts.push([segStart, i]); segStart = i + 1; }
  }
  if (sawConcat) {
    parts.push([segStart, end]);
    let joined = "";
    let firstLine = null;
    for (const [s, e] of parts) {
      const evaluated = evalStringExpr(tokens, s, e);
      if (!evaluated) return null;
      if (firstLine === null) firstLine = evaluated.line;
      joined += evaluated.value;
    }
    return { value: joined, line: firstLine ?? tokens[start].line };
  }

  depth = 0;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth--;
    else if (depth === 0 && t.type === "op" && t.value === "::" && i > start) return evalStringExpr(tokens, start, i);
  }

  if (end - start === 1 && tokens[start].type === "string") return { value: tokens[start].value, line: tokens[start].line };

  const fnIdx =
    start + 2 < end && tokens[start].type === "ident" && tokens[start + 1].type === "punct" && tokens[start + 1].value === "." && tokens[start + 2].type === "ident"
      ? start + 2
      : start;
  const fnTok = tokens[fnIdx];
  const openTok = tokens[fnIdx + 1];
  if (fnTok?.type === "ident" && openTok?.type === "punct" && openTok.value === "(" && findMatchingCloseParen(tokens, fnIdx + 1, end) === end - 1) {
    const callArgs = collectCallArgs(tokens, fnIdx + 1);
    if (fnTok.value === "concat") {
      let joined = "";
      let firstLine = fnTok.line;
      for (const arg of callArgs) {
        const evaluated = evalStringExpr(arg);
        if (!evaluated) return null;
        if (firstLine === fnTok.line) firstLine = evaluated.line;
        joined += evaluated.value;
      }
      return { value: joined, line: firstLine };
    }
    if ((fnTok.value === "lower" || fnTok.value === "upper" || fnTok.value === "trim" || fnTok.value === "btrim") && callArgs.length >= 1) {
      const inner = evalStringExpr(callArgs[0]);
      if (!inner) return null;
      if (fnTok.value === "lower") return { value: inner.value.toLowerCase(), line: inner.line };
      if (fnTok.value === "upper") return { value: inner.value.toUpperCase(), line: inner.line };
      if (callArgs.length === 1) return { value: inner.value.trim(), line: inner.line };
    }
  }
  return null;
}

function resolveAlgTokens(args, positionalIndex) {
  for (const arg of args) {
    if (arg.length >= 3 && arg[0].type === "ident" && NAMED_ALG_PARAMS.has(arg[0].value) && arg[1].type === "op" && arg[1].value === "=>") {
      return arg.slice(2);
    }
  }
  const positional = args[positionalIndex] ?? [];
  return positional.some((t) => t.type === "op" && t.value === "=>") ? [] : positional;
}

/** Scan a single SQL migration file for banned or weak cryptographic calls. */
export function scanMigrationSql(file, sql, lineOffset = 0, depth = 0) {
  const tokens = tokenizeSql(sql, lineOffset);
  const violations = [];
  let inDoHeader = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;

    if (tok.type === "string" && tok.dollarTag) {
      const isExecBody =
        inDoHeader ||
        (prev?.type === "ident" && !prev.quoted && (prev.value === "as" || prev.value === "do" || prev.value === "execute"));
      inDoHeader = false;
      if (isExecBody && depth < MAX_DOLLAR_NEST_DEPTH) {
        violations.push(...scanMigrationSql(file, tok.value, tok.line - 1, depth + 1));
      }
      continue;
    }

    if (tok.type === "ident" && !tok.quoted && tok.value === "do") {
      inDoHeader = true;
    } else if (inDoHeader) {
      const afterDoLang = prev?.type === "ident" && !prev.quoted && prev.value === "do" && tok.type === "ident" && !tok.quoted && tok.value === "language";
      const langName = prev?.type === "ident" && !prev.quoted && prev.value === "language" && (tok.type === "ident" || (tok.type === "string" && !tok.dollarTag));
      if (!afterDoLang && !langName) inDoHeader = false;
    }

    if (tok.type !== "ident") continue;
    const next = tokens[i + 1];
    if (!next || next.type !== "punct" || next.value !== "(") continue;

    if (BANNED_DIRECT_CALLS.has(tok.value)) {
      violations.push({
        file,
        line: tok.line,
        rule: `banned-${tok.value}`,
        detail: `Banned legacy or unauthenticated SQL crypto call "${tok.value}(...)" (use digest(..., 'sha256'), sha256(...), or application-layer AEAD)`,
      });
      continue;
    }

    if (tok.value === "digest" || tok.value === "hmac") {
      const args = collectCallArgs(tokens, i + 1);
      const algTokens = resolveAlgTokens(args, tok.value === "digest" ? 1 : 2);
      const evaluated = evalStringExpr(algTokens);
      const candidates = evaluated ? [evaluated] : algTokens.filter((t) => t.type === "string").map((t) => ({ value: t.value, line: t.line }));
      for (const c of candidates) {
        if (WEAK_HASH_ALG.test(c.value.trim())) {
          violations.push({
            file,
            line: c.line,
            rule: `weak-${tok.value}-algorithm`,
            detail: `Weak hash algorithm "${c.value.trim()}" in ${tok.value}(...) (use sha256 or stronger)`,
          });
        }
      }
    }
  }

  return violations;
}

/** Audit SQL migrations under `root` and return counts plus formatted problem strings. */
export function auditMigrationCrypto(
  root,
  { cutover = CUTOVER_VERSION, scanAll = false, migrationsDir = DEFAULT_MIGRATIONS_DIR } = {},
) {
  const dir = path.resolve(root, migrationsDir);
  if (!existsSync(dir)) return { checked: 0, exempt: 0, problems: [] };

  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  let checked = 0;
  let exempt = 0;
  const problems = [];

  for (const name of files) {
    if (!scanAll && isExemptMigration(name, cutover)) { exempt++; continue; }
    checked++;
    const relPath = path.posix.join(migrationsDir.split(path.sep).join("/"), name);
    const sql = readFileSync(path.join(dir, name), "utf8");
    for (const v of scanMigrationSql(relPath, sql)) problems.push(`${v.file}:${v.line}: ${v.detail}`);
  }
  return { checked, exempt, problems };
}

/** Check SQL migrations under `root` and return formatted problem strings (`[]` if clean). */
export function checkMigrationCrypto(root, options = {}) {
  return auditMigrationCrypto(root, options).problems;
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const rootArgIdx = process.argv.indexOf("--root");
  const root =
    rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
      ? path.resolve(process.argv[rootArgIdx + 1])
      : path.resolve(import.meta.dirname, "..");
  const scanAll = process.argv.includes("--all");
  const { checked, exempt, problems } = auditMigrationCrypto(root, { scanAll });
  for (const problem of problems) console.error(problem);
  console.log(`migration crypto: ${checked} migration(s) checked (${exempt} historical exempt), ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}
