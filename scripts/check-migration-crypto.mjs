#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Enforces modern cryptographic primitives in SQL migrations added after the cutover version.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CUTOVER_VERSION = 20261120143002000n;
const DEFAULT_MIGRATIONS_DIR = "backend/crates/platform/db/migrations";

const BANNED_DIRECT_CALLS = new Set([
  "md5",
  "sha1",
  "crypt",
  "gen_salt",
  "encrypt",
  "decrypt",
  "encrypt_iv",
  "decrypt_iv",
  "pgp_sym_encrypt",
  "pgp_sym_decrypt",
  "pgp_pub_encrypt",
  "pgp_pub_decrypt",
]);

const WEAK_HASH_ALG = /^(?:md5|sha-?1|md4|md2|ripemd160)$/i;
const PUNCT = new Set(["(", ")", ",", ".", ";"]);

/**
 * Parse a SQL migration filename prefix into a normalized 17-digit-compatible BigInt version.
 * Supports 4-digit legacy sequence numbers, 14-digit UTC timestamps (padded with "000"),
 * and 17-digit UTC millisecond timestamps. Returns null for unrecognized filenames (fail-closed).
 */
export function parseMigrationVersion(filename) {
  const base = path.basename(filename);
  const match = base.match(/^(\d+)_.+\.sql$/);
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

/**
 * Character-level SQL lexer tracking 1-based line numbers.
 * Skips `--` line comments and nested block comments, preserves string literals,
 * unescapes quoted identifiers, and emits dollar-quote delimiters as punctuation so
 * PL/pgSQL function and DO blocks remain scanned.
 */
export function tokenizeSql(sql) {
  const tokens = [];
  let line = 1;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      if (ch === "\n") line++;
      i++;
      continue;
    }

    // Line comment -- ...
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
      continue;
    }

    // Nested block comment /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (sql[i] === "\n") line++;
          i++;
        }
      }
      continue;
    }

    // Escape string literal E'...' or e'...'
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'") {
      const startLine = line;
      i += 2;
      let value = "";
      while (i < len) {
        const cur = sql[i];
        if (cur === "\\") {
          if (i + 1 < len) {
            const next = sql[i + 1];
            if (next === "\n") line++;
            value += next;
            i += 2;
          } else {
            i++;
          }
        } else if (cur === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          if (cur === "\n") line++;
          value += cur;
          i++;
        }
      }
      tokens.push({ type: "string", value, line: startLine });
      continue;
    }

    // Standard single-quoted string literal '...'
    if (ch === "'") {
      const startLine = line;
      i++;
      let value = "";
      while (i < len) {
        const cur = sql[i];
        if (cur === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          if (cur === "\n") line++;
          value += cur;
          i++;
        }
      }
      tokens.push({ type: "string", value, line: startLine });
      continue;
    }

    // Double-quoted identifier "..."
    if (ch === '"') {
      const startLine = line;
      i++;
      let value = "";
      while (i < len) {
        const cur = sql[i];
        if (cur === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          if (cur === "\n") line++;
          value += cur;
          i++;
        }
      }
      tokens.push({ type: "ident", value: value.toLowerCase(), quoted: true, line: startLine });
      continue;
    }

    // Dollar-quote delimiter $$ or $tag$
    if (ch === "$") {
      const tagMatch = sql.slice(i, i + 128).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        tokens.push({ type: "punct", value: "$$", line });
        i += tagMatch[0].length;
        continue;
      }
      tokens.push({ type: "other", value: "$", line });
      i++;
      continue;
    }

    // Unquoted identifier
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      const startLine = line;
      let end = i + 1;
      while (end < len) {
        const c = sql[end];
        if (
          (c >= "A" && c <= "Z") ||
          (c >= "a" && c <= "z") ||
          (c >= "0" && c <= "9") ||
          c === "_" ||
          c === "$"
        ) {
          end++;
        } else {
          break;
        }
      }
      tokens.push({ type: "ident", value: sql.slice(i, end).toLowerCase(), quoted: false, line: startLine });
      i = end;
      continue;
    }

    // Punctuation
    if (PUNCT.has(ch)) {
      tokens.push({ type: "punct", value: ch, line });
      i++;
      continue;
    }

    // Numbers, operators, and other characters
    tokens.push({ type: "other", value: ch, line });
    i++;
  }

  return tokens;
}

function collectCallArgs(tokens, openParenIndex) {
  const args = [[]];
  let depth = 1;
  for (let i = openParenIndex + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.value === "(") {
      depth++;
      args[args.length - 1].push(tok);
    } else if (tok.type === "punct" && tok.value === ")") {
      depth--;
      if (depth === 0) break;
      args[args.length - 1].push(tok);
    } else if (tok.type === "punct" && tok.value === "," && depth === 1) {
      args.push([]);
    } else {
      args[args.length - 1].push(tok);
    }
  }
  return args;
}

/** Scan a single SQL migration file for banned or weak cryptographic calls. */
export function scanMigrationSql(file, sql) {
  const tokens = tokenizeSql(sql);
  const violations = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
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
      const algIndex = tok.value === "digest" ? 1 : 2;
      const algTokens = args[algIndex] ?? [];
      for (const argTok of algTokens) {
        if (argTok.type === "string" && WEAK_HASH_ALG.test(argTok.value.trim())) {
          violations.push({
            file,
            line: argTok.line,
            rule: `weak-${tok.value}-algorithm`,
            detail: `Weak hash algorithm "${argTok.value.trim()}" in ${tok.value}(...) (use sha256 or stronger)`,
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

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let checked = 0;
  let exempt = 0;
  const problems = [];

  for (const name of files) {
    if (!scanAll && isExemptMigration(name, cutover)) {
      exempt++;
      continue;
    }
    checked++;
    const relPath = path.posix.join(migrationsDir.split(path.sep).join("/"), name);
    const sql = readFileSync(path.join(dir, name), "utf8");
    for (const v of scanMigrationSql(relPath, sql)) {
      problems.push(`${v.file}:${v.line}: ${v.detail}`);
    }
  }

  return { checked, exempt, problems };
}

/** Check SQL migrations under `root` and return formatted problem strings (`[]` if clean). */
export function checkMigrationCrypto(root, options = {}) {
  return auditMigrationCrypto(root, options).problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
