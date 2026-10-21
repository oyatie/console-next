import type { LegalEntity, OrgStructure, OrgStructureNode } from "@console/api/pending";

export const SHEET_COLUMNS = ["level", "entity", "site", "dept", "code", "head", "people"] as const;

const cell = (value: string | number) => {
  // Names from imported records must remain text when opened in a spreadsheet.
  const text = typeof value === "string" && /^[\s]*[=+@-]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The setup download reads the server tree directly, in the org sheet's existing column order. */
export function setupSheet(
  structure: OrgStructure,
  entities: readonly LegalEntity[],
  header: readonly string[],
  level: (node: OrgStructureNode) => string,
): string {
  const representatives = new Map(entities.map((e) => [e.id, e.current?.representatives?.[0] ?? ""]));
  const rows: (string | number)[][] = [];
  const walk = (node: OrgStructureNode, entity: string, site: string, departments: readonly string[]) => {
    if (node.kind === "LEGAL_ENTITY") entity = node.name;
    if (node.kind === "WORKPLACE" || node.kind === "SITE") site = node.name;
    if (node.kind === "DEPARTMENT") departments = [...departments, node.name];
    rows.push([level(node), entity, site, departments.join(" > "), node.kind === "DEPARTMENT" ? node.code ?? "" : "",
      node.kind === "LEGAL_ENTITY" ? representatives.get(node.id) ?? "" : node.kind === "DEPARTMENT" ? node.head?.name ?? "" : "", node.headcount]);
    node.children.forEach((child) => walk(child, entity, site, departments));
  };
  structure.entities.forEach((node) => walk(node, "", "", []));
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
