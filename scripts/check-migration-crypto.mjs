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

function skipWsAndComments(sql, i, line) {
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      if (ch === "\n") line++;
      i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else { if (sql[i] === "\n") line++; i++; }
      }
    } else {
      break;
    }
  }
  return { i, line };
}

function pushStringToken(tokens, value, line, endLine, extra = null) {
  const prev = tokens[tokens.length - 1];
  const beforePrev = tokens[tokens.length - 2];
  const prevIsLangName =
    beforePrev?.type === "ident" && !beforePrev.quoted && beforePrev.value === "language";
  if (
    !extra?.dollarTag &&
    prev?.type === "string" &&
    !prev.dollarTag &&
    !prev.unicodeLiteral &&
    !prevIsLangName &&
    line > prev.endLine
  ) {
    prev.value += value;
    prev.endLine = endLine;
    return;
  }
  tokens.push(extra ? { type: "string", value, line, endLine, ...extra } : { type: "string", value, line, endLine });
}

/** Character-level SQL lexer tracking 1-based line numbers and isolating `$tag$...$tag$` literals. */
export function tokenizeSql(sql, lineOffset = 0) {
  const tokens = [];
  let line = 1 + lineOffset;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const skipped = skipWsAndComments(sql, i, line);
    if (skipped.i !== i) {
      i = skipped.i;
      line = skipped.line;
      continue;
    }
    const ch = sql[i];
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'") {
      const startLine = line;
      const res = readEscapeString(sql, i);
      line += res.lines;
      i = res.next;
      pushStringToken(tokens, res.value, startLine, line);
      continue;
    }
    if ((ch === "U" || ch === "u") && sql[i + 1] === "&" && sql[i + 2] === "'") {
      const startLine = line;
      const res = readDelimited(sql, i + 2, "'");
      line += res.lines;
      let endLine = line;
      i = res.next;
      let raw = res.value;
      while (true) {
        const afterWs = skipWsAndComments(sql, i, line);
        if (afterWs.line > endLine && sql[afterWs.i] === "'") {
          const cont = readDelimited(sql, afterWs.i, "'");
          raw += cont.value;
          line = afterWs.line + cont.lines;
          endLine = line;
          i = cont.next;
        } else {
          break;
        }
      }
      let escChar = "\\";
      const afterWs = skipWsAndComments(sql, i, line);
      if (sql.slice(afterWs.i, afterWs.i + 7).toLowerCase() === "uescape") {
        const afterUesc = skipWsAndComments(sql, afterWs.i + 7, afterWs.line);
        if (sql[afterUesc.i] === "'" && afterUesc.i + 2 < len && sql[afterUesc.i + 1] !== "'" && sql[afterUesc.i + 2] === "'") {
          escChar = sql[afterUesc.i + 1];
          i = afterUesc.i + 3;
          line = afterUesc.line;
          endLine = line;
        }
      }
      pushStringToken(tokens, decodeUnicodeLiteral(raw, escChar), startLine, endLine, { unicodeLiteral: true });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      const res = readDelimited(sql, i, ch);
      line += res.lines;
      i = res.next;
      if (ch === "'") {
        pushStringToken(tokens, res.value, startLine, line);
      } else {
        tokens.push({ type: "ident", value: res.value.toLowerCase(), quoted: true, line: startLine });
      }
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
        pushStringToken(tokens, body, startLine, line, { dollarTag: tag });
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
    if (two === "||" || two === "=>" || two === "::" || two === ":=") {
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

function stripTrailingCollate(tokens, start, end) {
  if (
    start <= end - 5 &&
    tokens[end - 4].type === "ident" &&
    !tokens[end - 4].quoted &&
    tokens[end - 4].value === "collate" &&
    tokens[end - 3].type === "ident" &&
    tokens[end - 2].type === "punct" &&
    tokens[end - 2].value === "." &&
    tokens[end - 1].type === "ident"
  ) {
    return end - 4;
  }
  if (
    start <= end - 3 &&
    tokens[end - 2].type === "ident" &&
    !tokens[end - 2].quoted &&
    tokens[end - 2].value === "collate" &&
    tokens[end - 1].type === "ident"
  ) {
    return end - 2;
  }
  return end;
}

function isNullLiteralExpr(tokens, start = 0, end = tokens.length) {
  while (start + 1 < end && tokens[start].type === "punct" && tokens[start].value === "(" && findMatchingCloseParen(tokens, start, end) === end - 1) {
    start++;
    end--;
  }
  if (start >= end) return false;
  let depth = 0;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth--;
    else if (depth === 0 && t.type === "op" && t.value === "::" && i > start) return isNullLiteralExpr(tokens, start, i);
  }
  const withoutCollate = stripTrailingCollate(tokens, start, end);
  if (withoutCollate !== end) return isNullLiteralExpr(tokens, start, withoutCollate);
  if (end - start === 1 && tokens[start].type === "ident" && !tokens[start].quoted && tokens[start].value === "null") {
    return true;
  }
  if (
    tokens[start].type === "ident" &&
    !tokens[start].quoted &&
    tokens[start].value === "cast" &&
    start + 3 < end &&
    tokens[start + 1].type === "punct" &&
    tokens[start + 1].value === "(" &&
    findMatchingCloseParen(tokens, start + 1, end) === end - 1
  ) {
    let castDepth = 0;
    for (let i = start + 2; i < end - 1; i++) {
      const t = tokens[i];
      if (t.type === "punct" && t.value === "(") castDepth++;
      else if (t.type === "punct" && t.value === ")") castDepth--;
      else if (castDepth === 0 && t.type === "ident" && !t.quoted && t.value === "as") {
        return isNullLiteralExpr(tokens, start + 2, i);
      }
    }
  }
  return false;
}

function trimSqlChars(str, chars, mode = "both") {
  if (chars.length === 0) return str;
  const charSet = new Set([...chars]);
  const codePoints = [...str];
  let start = 0;
  let end = codePoints.length;
  if (mode === "both" || mode === "leading") {
    while (start < end && charSet.has(codePoints[start])) start++;
  }
  if (mode === "both" || mode === "trailing") {
    while (end > start && charSet.has(codePoints[end - 1])) end--;
  }
  return codePoints.slice(start, end).join("");
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

  const withoutCollate = stripTrailingCollate(tokens, start, end);
  if (withoutCollate !== end) return evalStringExpr(tokens, start, withoutCollate);

  if (end - start === 1 && tokens[start].type === "string") return { value: tokens[start].value, line: tokens[start].line };

  if (
    tokens[start].type === "ident" &&
    !tokens[start].quoted &&
    tokens[start].value === "cast" &&
    start + 3 < end &&
    tokens[start + 1].type === "punct" &&
    tokens[start + 1].value === "(" &&
    findMatchingCloseParen(tokens, start + 1, end) === end - 1
  ) {
    let castDepth = 0;
    for (let i = start + 2; i < end - 1; i++) {
      const t = tokens[i];
      if (t.type === "punct" && t.value === "(") castDepth++;
      else if (t.type === "punct" && t.value === ")") castDepth--;
      else if (castDepth === 0 && t.type === "ident" && !t.quoted && t.value === "as") {
        return evalStringExpr(tokens, start + 2, i);
      }
    }
    return null;
  }

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
    if (fnTok.value === "concat_ws" && callArgs.length >= 1) {
      const sep = evalStringExpr(callArgs[0]);
      if (!sep) return null;
      const joinedParts = [];
      let firstLine = null;
      for (let a = 1; a < callArgs.length; a++) {
        const arg = callArgs[a];
        if (isNullLiteralExpr(arg)) continue;
        const evaluated = evalStringExpr(arg);
        if (!evaluated) return null;
        if (firstLine === null) firstLine = evaluated.line;
        joinedParts.push(evaluated.value);
      }
      return { value: joinedParts.join(sep.value), line: firstLine ?? sep.line };
    }
    if ((fnTok.value === "lower" || fnTok.value === "upper" || fnTok.value === "trim" || fnTok.value === "btrim") && callArgs.length >= 1) {
      if (fnTok.value === "trim" && callArgs.length === 1) {
        const arg = callArgs[0];
        let fromIdx = -1;
        let argDepth = 0;
        for (let k = 0; k < arg.length; k++) {
          const t = arg[k];
          if (t.type === "punct" && t.value === "(") argDepth++;
          else if (t.type === "punct" && t.value === ")") argDepth--;
          else if (argDepth === 0 && t.type === "ident" && !t.quoted && t.value === "from") {
            fromIdx = k;
            break;
          }
        }
        if (fromIdx !== -1) {
          let mode = "both";
          let charsStart = 0;
          if (
            fromIdx > 0 &&
            arg[0].type === "ident" &&
            !arg[0].quoted &&
            (arg[0].value === "leading" || arg[0].value === "trailing" || arg[0].value === "both")
          ) {
            mode = arg[0].value;
            charsStart = 1;
          }
          let chars = " ";
          if (charsStart < fromIdx) {
            const charsEval = evalStringExpr(arg, charsStart, fromIdx);
            if (!charsEval) return null;
            chars = charsEval.value;
          }
          const targetEval = evalStringExpr(arg, fromIdx + 1, arg.length);
          if (!targetEval) return null;
          return { value: trimSqlChars(targetEval.value, chars, mode), line: targetEval.line };
        }
      }
      const inner = evalStringExpr(callArgs[0]);
      if (!inner) return null;
      if (fnTok.value === "lower") return { value: inner.value.toLowerCase(), line: inner.line };
      if (fnTok.value === "upper") return { value: inner.value.toUpperCase(), line: inner.line };
      if (callArgs.length === 1) return { value: inner.value.trim(), line: inner.line };
      if (callArgs.length === 2) {
        const charsEval = evalStringExpr(callArgs[1]);
        if (!charsEval) return null;
        return { value: trimSqlChars(inner.value, charsEval.value, "both"), line: inner.line };
      }
    }
  }
  return null;
}

function collectExecuteExprTokens(tokens, startIdx) {
  const exprTokens = [];
  let parenDepth = 0;
  for (let j = startIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === "punct" && t.value === "(") {
      parenDepth++;
    } else if (t.type === "punct" && t.value === ")") {
      if (parenDepth === 0) break;
      parenDepth--;
    } else if (parenDepth === 0) {
      if (t.type === "punct" && t.value === ";") break;
      if (t.type === "ident" && !t.quoted && (t.value === "into" || t.value === "using")) break;
    }
    exprTokens.push(t);
  }
  return exprTokens;
}

function evalExecuteSqlExpr(tokens, start = 0, end = tokens.length) {
  while (start + 1 < end && tokens[start].type === "punct" && tokens[start].value === "(" && findMatchingCloseParen(tokens, start, end) === end - 1) {
    start++;
    end--;
  }
  if (start >= end) return null;

  let depth = 0;
  let hasConcat = false;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth--;
    else if (depth === 0 && t.type === "op" && t.value === "||") { hasConcat = true; break; }
  }
  if (!hasConcat) {
    depth = 0;
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (t.type === "punct" && t.value === "(") depth++;
      else if (t.type === "punct" && t.value === ")") depth--;
      else if (depth === 0 && t.type === "op" && t.value === "::" && i > start) {
        return evalExecuteSqlExpr(tokens, start, i);
      }
    }
    const withoutCollate = stripTrailingCollate(tokens, start, end);
    if (withoutCollate !== end) return evalExecuteSqlExpr(tokens, start, withoutCollate);
  }

  let fnIdx = start;
  if (
    start + 2 < end &&
    tokens[start].type === "ident" &&
    !tokens[start].quoted &&
    tokens[start].value === "pg_catalog" &&
    tokens[start + 1].type === "punct" &&
    tokens[start + 1].value === "." &&
    tokens[start + 2].type === "ident"
  ) {
    fnIdx = start + 2;
  }
  const fnTok = tokens[fnIdx];
  const openTok = tokens[fnIdx + 1];
  if (
    fnTok?.type === "ident" &&
    !fnTok.quoted &&
    fnTok.value === "format" &&
    openTok?.type === "punct" &&
    openTok.value === "(" &&
    findMatchingCloseParen(tokens, fnIdx + 1, end) === end - 1
  ) {
    const callArgs = collectCallArgs(tokens, fnIdx + 1);
    return callArgs[0]?.length ? evalStringExpr(callArgs[0]) : null;
  }
  return evalStringExpr(tokens, start, end);
}

function isNamedArgOp(tok) {
  return tok?.type === "op" && (tok.value === "=>" || tok.value === ":=");
}

function resolveAlgTokens(args, positionalIndex) {
  for (const arg of args) {
    if (arg.length >= 3 && arg[0].type === "ident" && NAMED_ALG_PARAMS.has(arg[0].value) && isNamedArgOp(arg[1])) {
      return arg.slice(2);
    }
  }
  const positional = args[positionalIndex] ?? [];
  return positional.some((t) => isNamedArgOp(t)) ? [] : positional;
}

/** Scan a single SQL migration file for banned or weak cryptographic calls. */
export function scanMigrationSql(file, sql, lineOffset = 0, depth = 0) {
  const tokens = tokenizeSql(sql, lineOffset);
  const violations = [];
  let inDoHeader = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;

    if (tok.type === "string") {
      if (inDoHeader && !tok.dollarTag && prev?.type === "ident" && !prev.quoted && prev.value === "language") {
        continue;
      }
      const isExecBody =
        inDoHeader ||
        (prev?.type === "ident" && !prev.quoted && (prev.value === "as" || prev.value === "do"));
      inDoHeader = false;
      if (isExecBody) {
        if (depth >= MAX_DOLLAR_NEST_DEPTH) {
          violations.push({
            file,
            line: tok.line,
            rule: "excessive-dollar-nesting",
            detail: `Exceeded max nested routine/block scan depth (${MAX_DOLLAR_NEST_DEPTH})`,
          });
        } else {
          violations.push(...scanMigrationSql(file, tok.value, tok.line - 1, depth + 1));
        }
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

    if (
      !tok.quoted &&
      tok.value === "execute" &&
      !(prev?.type === "punct" && prev.value === ".") &&
      !(prev?.type === "ident" && !prev.quoted && (prev.value === "grant" || prev.value === "revoke" || prev.value === "for" || prev.value === "on")) &&
      !(next?.type === "ident" && !next.quoted && (next.value === "function" || next.value === "procedure"))
    ) {
      const exprTokens = collectExecuteExprTokens(tokens, i + 1);
      const evaluated = evalExecuteSqlExpr(exprTokens);
      if (evaluated) {
        if (depth >= MAX_DOLLAR_NEST_DEPTH) {
          violations.push({
            file,
            line: evaluated.line,
            rule: "excessive-dollar-nesting",
            detail: `Exceeded max nested routine/block scan depth (${MAX_DOLLAR_NEST_DEPTH})`,
          });
        } else {
          violations.push(...scanMigrationSql(file, evaluated.value, evaluated.line - 1, depth + 1));
        }
      }
      continue;
    }

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
