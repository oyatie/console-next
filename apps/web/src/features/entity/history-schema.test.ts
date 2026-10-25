// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { i18n, isMessageId, loadCatalog } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { HISTORY_FIELDS, changeLine, historyValue } from "./present";

type Schema = { properties?: Record<string, Schema>; type?: string | string[]; format?: string; anyOf?: Schema[]; $ref?: string };
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (s: string) => Schema };
const schema = (name: string) => yaml.load(readFileSync(`backend/crates/entity/rest/openapi/schemas/${name}.yaml`, "utf8"));
// history.rs serializes these revised states; main_ksic is flattened in revision-row JSON.
const fields = ["LegalEntityState", "RegistrationState", "WorkplaceState", "InsurerInput"].flatMap((name) =>
  Object.entries(schema(name).properties!).filter(([key]) => !["version", "effective_from", "before_first_record", "change_mode", "insurer"].includes(key)).flatMap<readonly [string, Schema]>(([key, value]) =>
    key === "main_ksic" ? ["code", "label", "version"].map((part) => [`main_ksic_${part}`, {}] as const)
    : [[name === "InsurerInput" ? `insurance.${key}` : key, value] as const]),
);

test.each(["ko", "en"] as const)("%s: every served revision field owns a history label and its typed value", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    for (const [field, definition] of fields) {
      expect(isMessageId(`entityHistoryField.${field}`), field).toBe(true);
      const wire = field.startsWith("insurance.") ? field.replace("insurance.", "insurance.NHIS.") : field;
      const variants = [definition, ...(definition.anyOf ?? [])];
      if (variants.some((s) => s.type?.includes("boolean"))) {
        for (const value of ["true", "false"]) {
          const line = changeLine({ field: wire, before: null, after: value });
          expect(line, wire).not.toMatch(/\b(true|false)\b|[a-z]+_[a-z_]+/);
          expect(line).toContain(locale === "ko" ? value === "true" ? "해당" : "아님" : value === "true" ? "Yes" : "No");
        }
      } else if (variants.some((s) => s.format === "date")) {
        expect(historyValue(field, "2026-10-15"), field).toBe(fmtDate("2026-10-15"));
      }
      if (locale === "ko") expect(changeLine({ field: wire, before: null, after: "값" }), wire).not.toContain(field);
    }
  } finally { i18n.set("ko"); }
});

test("a future field never exposes its storage key and booleans share one formatter", async () => {
  await loadCatalog("ko");
  expect(changeLine({ field: "unknown_field", before: null, after: "값" })).not.toContain("unknown_field");
  expect(changeLine({ field: "is_construction_site", before: null, after: "false" })).toBe("건설 사업장 여부: — → 아님");
  expect(changeLine({ field: "unit_taxation", before: null, after: "true" })).toBe("사업자 단위 과세: — → 해당");
  expect(historyValue("phone", "+8225550142")).toBe("02-555-0142");
});

// The actual diff iterates to_jsonb(revision) minus history.rs META, not the UI's input builder.
test("every column the server diff can emit is in the field catalog, including storage-only CodeRef parts", async () => {
  await loadCatalog("ko");
  const root = "backend/crates/platform/db/migrations";
  const history = readFileSync("backend/crates/entity/adapter-postgres/src/history.rs", "utf8");
  const meta = new Set([...history.match(/const META: &str = "([\s\S]*?)";/)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  meta.add("evidence_document_id"); // history.rs removes provenance before diffing.
  const tables = [...history.matchAll(/\b((?:legal_entity|business_registration|workplace|workplace_insurance)_revisions)\b/g)].map((m) => m[1]!);
  expect(new Set(tables).size).toBe(4);
  for (const table of tables) {
    const columns = new Map<string, string>();
    for (const file of readdirSync(root).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(`${root}/${file}`, "utf8");
      const created = sql.match(new RegExp(String.raw`CREATE TABLE (?:public\.)?${table} \(([^]*?)\n\);`))?.[1];
      if (created) for (const col of created.matchAll(/^    ([a-z_]+)\s+(TEXT|BOOLEAN|DATE|UUID|INTEGER|SMALLINT|BIGINT|BYTEA|JSONB|TIMESTAMPTZ)\b/gm)) columns.set(col[1]!, col[2]!);
      for (const alter of sql.matchAll(new RegExp(String.raw`ALTER TABLE (?:public\.)?${table}\b([^]*?);`, "g"))) {
        for (const col of alter[1]!.matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_]+)\s+(\w+)/g)) columns.set(col[1]!, col[2]!);
      }
    }
    expect(columns.size, table).toBeGreaterThan(10);
    for (const [column, type] of columns) {
      if (meta.has(column)) continue;
      const field = table === "workplace_insurance_revisions" ? `insurance.${column}` : column;
      expect(Object.hasOwn(HISTORY_FIELDS, field), field).toBe(true);
      expect(isMessageId(`entityHistoryField.${field}`), field).toBe(true);
      if (type === "BOOLEAN") expect(HISTORY_FIELDS[field]?.kind, field).toBe("bool");
      if (type === "DATE") expect(HISTORY_FIELDS[field]?.kind, field).toBe("date");
    }
  }
});

test("reference-list identifiers in a revision never become value labels", async () => {
  await loadCatalog("ko");
  for (const field of ["not_registered_reason_code", "not_registered_reason_list_key", "not_registered_reason_version"]) {
    const stored = "kr-internal-reference-v1";
    expect(changeLine({ field, before: null, after: stored })).not.toContain(stored);
  }
});
