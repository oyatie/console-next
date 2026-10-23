#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// N-1 projections stay current while this inventory of legacy fact readers only shrinks.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atBase, baselineGrowth, digest, ratchet } from "./quality/ratchet.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = "scripts/person-reads-baseline.json";
const FACTS = { employees: ["name", "birth_date"], users: ["display_name"] };
const RESERVED = new Set(["where", "join", "left", "right", "inner", "outer", "on", "order", "group", "limit", "offset", "union", "for", "set", "returning"]);

export function rawReads(source) {
  const reads = [];
  // Rust's regular and raw SQL literals, including query_as!, QueryBuilder and format!.
  const literals = source.match(/r(#+)?"[\s\S]*?"\1|"(?:\\[\s\S]|[^"\\])*"/g) ?? [];
  const clean = (literal) => literal.replace(/\\\r?\n\s*/g, " ").replace(/\\"/g, '"').replace(/--[^\n]*/g, " ");
  const tablesIn = (sql) => [...sql.matchAll(/\b(?:from|join)\s+(?:public\.)?([a-z_]\w*)\b(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)]
    .map(([, table, rawAlias]) => ({ table: table.toLowerCase(), alias: rawAlias && !RESERVED.has(rawAlias.toLowerCase()) ? rawAlias : table }));
  const sqls = literals.map(clean), context = sqls.flatMap(tablesIn);
  for (const sql of sqls) {
    if (/^"\s*(?:update|insert|delete)\b/i.test(sql) && !/\bselect\b/i.test(sql)) continue;
    const local = tablesIn(sql);
    const tables = [...local, ...context.filter((c) => !local.some((l) => l.alias === c.alias))];
    const columns = new Set();
    for (const { table, alias } of tables.filter((t) => t.table in FACTS)) {
      for (const field of FACTS[table]) {
        const qualified = new RegExp(`\\b(?:${alias}|${table})\\s*\\.\\s*${field}\\b`, "i");
        const unqualified = new RegExp(`(?<![.\\w])${field}\\b`, "i");
        const wildcard = new RegExp(`\\bselect\\s+(?:(?:${alias}|${table})\\s*\\.\\s*)?\\*`, "i");
        if (qualified.test(sql) || (local.some((t) => t.table === table) && (wildcard.test(sql) || (local.length === 1 && unqualified.test(sql))))) columns.add(`${table}.${field}`);
      }
    }
    if (columns.size) reads.push(`${[...columns].sort().join(",")}:${digest(sql.replace(/\s+/g, " ").trim())}`);
  }
  return reads;
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return ["tests", "migrations", "fixtures"].includes(e.name) ? [] : files(file);
    return e.name.endsWith(".rs") && !/(_tests|\.test)\.rs$/.test(e.name) ? [file] : [];
  });
}
export function findings(root) {
  const found = {};
  for (const file of [...files(path.join(root, "backend/app/src")), ...files(path.join(root, "backend/crates"))]) {
    const source = readFileSync(file, "utf8").split(/#\[cfg\(test\)\]/)[0];
    for (const read of rawReads(source)) {
      const key = `${path.relative(root, file)}:${read}`;
      found[key] = (found[key] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findings(ROOT);
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(path.join(ROOT, BASELINE), `${JSON.stringify(found, null, 2)}\n`);
  } else {
    const baseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf8"));
    const previous = atBase(ROOT, process.env.QUALITY_BASE ?? "dev", BASELINE);
    const problems = [...ratchet(found, baseline), ...(previous ? baselineGrowth(baseline, JSON.parse(previous)) : [])];
    if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
    else console.log(`person-reads: ${Object.values(found).reduce((a, b) => a + b, 0)} inherited SQL readers; no new or stale entries`);
  }
}
