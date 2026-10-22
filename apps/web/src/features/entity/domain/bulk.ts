// SPDX-License-Identifier: LicenseRef-Proprietary
import { entityBody, entityGaps } from "./create";
import type { BizKind, EntitySetupOp, KrAddress, LegalEntity, RepresentationMode } from "@console/api/pending";
import { emptyDraft, type Draft } from "./draft";
import { krAddress } from "./plan";
import { entityInput, workplaceInput } from "./view";

export const BULK_FIELDS = [
  "name",
  "kind",
  "representatives",
  "mode",
  "crn",
  "road",
  "zip",
  "op",
  "id",
  "version",
  "legalEntityId",
  "workplaceName",
] as const;

export type BulkField = (typeof BULK_FIELDS)[number];
export type BulkColumns = Record<BulkField, number>;

export const BULK_OPERATIONS = [
  "CREATE_ENTITY",
  "REVISE_ENTITY",
  "CREATE_WORKPLACE",
  "REVISE_WORKPLACE",
] as const;
export type BulkOp = (typeof BULK_OPERATIONS)[number];

export type EntityRow = {
  line: number;
  draft: Draft;
  modeUnrecognized?: boolean;
  op?: BulkOp;
  id?: string;
  expectedVersion?: number;
  legalEntityId?: string;
  entityRef?: string;
  workplaceName?: string;
  fields?: BulkField[];
};

export const emptyColumns = (): BulkColumns => ({
  name: -1,
  kind: -1,
  representatives: -1,
  mode: -1,
  crn: -1,
  road: -1,
  zip: -1,
  op: -1,
  id: -1,
  version: -1,
  legalEntityId: -1,
  workplaceName: -1,
});

/** Only exact header matches; the operator chooses unknown columns before preview. */
export function guessEntityColumns(
  headers: string[],
  words: Record<BulkField, string>
): BulkColumns {
  const columns = emptyColumns();
  for (const field of BULK_FIELDS) {
    const word = words[field];
    if (!word) continue;
    columns[field] = headers.findIndex(
      (h) => h.trim().toLocaleLowerCase() === word.toLocaleLowerCase()
    );
  }
  return columns;
}

/** Named source values become typed drafts; supports entity/workplace create and revise. */
export function entityRows(
  grid: string[][],
  header: number,
  columns: BulkColumns,
  kinds: Record<BizKind, string>,
  modes: Record<RepresentationMode, string>,
  ops?: Record<BulkOp, string>
): EntityRow[] {
  return grid.slice(header + 1).flatMap((row, i) => {
    if (!row.some((v) => v.trim())) return [];
    const get = (field: BulkField) => (columns[field] >= 0 ? (row[columns[field]] ?? "").trim() : "");
    const kind =
      (Object.keys(kinds) as BizKind[]).find((k) => k === get("kind") || kinds[k] === get("kind")) ??
      null;
    const mode =
      (Object.keys(modes) as RepresentationMode[]).find(
        (m) => m === get("mode") || modes[m] === get("mode")
      ) ?? null;

    const rawOp = get("op");
    const upperOp = rawOp.toUpperCase();
    let op: BulkOp = "CREATE_ENTITY";
    if (ops) {
      const matched = (Object.keys(ops) as BulkOp[]).find(
        (o) => o === upperOp || ops[o]?.trim().toUpperCase() === upperOp || ops[o]?.trim() === rawOp
      );
      if (matched) {
        op = matched;
      } else if (upperOp === "REVISE" || upperOp === "UPDATE") {
        op = "REVISE_ENTITY";
      } else if (upperOp === "CREATE") {
        op = "CREATE_ENTITY";
      } else if (get("id")) {
        op = get("workplaceName") ? "REVISE_WORKPLACE" : "REVISE_ENTITY";
      } else if (get("legalEntityId") || get("workplaceName")) {
        op = "CREATE_WORKPLACE";
      }
    } else {
      if (upperOp === "REVISE" || upperOp === "REVISE_ENTITY" || upperOp === "UPDATE") {
        op = "REVISE_ENTITY";
      } else if (upperOp === "CREATE_WORKPLACE") {
        op = "CREATE_WORKPLACE";
      } else if (upperOp === "REVISE_WORKPLACE") {
        op = "REVISE_WORKPLACE";
      } else if (upperOp === "CREATE" || upperOp === "CREATE_ENTITY") {
        op = "CREATE_ENTITY";
      } else if (get("id")) {
        op = get("workplaceName") ? "REVISE_WORKPLACE" : "REVISE_ENTITY";
      } else if (get("legalEntityId") || get("workplaceName")) {
        op = "CREATE_WORKPLACE";
      }
    }

    const id = get("id") || undefined;
    const versionVal = get("version");
    const expectedVersion = versionVal ? Number(versionVal) : undefined;
    const legalEntityId = get("legalEntityId") || undefined;
    const workplaceName = get("workplaceName") || undefined;

    return [
      {
        line: header + i + 2,
        fields: BULK_FIELDS.filter((field) => columns[field] >= 0),
        op,
        id,
        expectedVersion,
        legalEntityId,
        workplaceName,
        modeUnrecognized: Boolean(get("mode")) && mode === null,
        draft: {
          ...emptyDraft(),
          name: get("name"),
          bizKind: kind,
          representatives: get("representatives")
            .split("|")
            .map((n) => n.trim())
            .filter(Boolean),
          representationMode: mode,
          crn: get("crn").replace(/[- ]/g, ""),
          headOffice: "OTHER",
          headOfficeAddress: get("road") || get("zip")
            ? { road: get("road"), zip: get("zip"), detail: "", verified: false }
            : null,
        },
      },
    ];
  });
}

/** Revisions must have a readable full state; partial or restricted reads cannot be written back. */
export function bulkGaps(row: EntityRow, records?: readonly LegalEntity[]): string[] {
  const op = row.op ?? "CREATE_ENTITY";
  if (op === "CREATE_WORKPLACE") return ["workplaceFlow"];
  if (op === "REVISE_ENTITY" || op === "REVISE_WORKPLACE") {
    const gaps: string[] = [];
    if (!row.id) gaps.push("id");
    if (row.expectedVersion != null && (!Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 1)) gaps.push("version");
    if (records && !revisionBase(row, records)) gaps.push("record");
    return gaps;
  }
  const gaps: string[] = entityGaps(row.draft);
  if (row.draft.bizKind === "CORPORATION" && !row.draft.headOfficeAddress?.road.trim() && !gaps.includes("headOffice")) gaps.push("headOffice");
  const count = row.draft.representatives.filter((n) => n.trim()).length;
  const mode = row.draft.representationMode;
  if (!gaps.includes("representationMode") && ((row.modeUnrecognized && !mode) ||
    (count === 1 && mode && mode !== "SINGLE") || (count > 1 && mode === "SINGLE"))) gaps.push("representationMode");
  return gaps;
}

function revisionBase(row: EntityRow, records: readonly LegalEntity[]) {
  if (row.op === "REVISE_ENTITY") {
    const entity = records.find((e) => e.id === row.id && !e.read_only && !e.closed_on);
    const input = entity && entityInput(entity);
    return input && entity ? { entity: input, version: Math.max(entity.current!.version, ...(entity.scheduled ?? []).map((s) => s.version)) } : null;
  }
  const entity = records.find((e) => e.workplaces.some((site) => site.id === row.id) && !e.read_only && !e.closed_on);
  const w = entity?.workplaces.find((site) => site.id === row.id && !site.read_only && !site.closed_on);
  const input = entity && w && workplaceInput(entity, w);
  return input && w ? { workplace: input, version: w.current!.version } : null;
}

/** Each mapped address column replaces only that part; unmapped detail stays with the record. */
function rowAddress(row: EntityRow, before?: KrAddress | null) {
  const fields = row.fields ?? ["name", "workplaceName"];
  if (!fields.includes("road") && !fields.includes("zip")) return before;
  const draft = row.draft.headOfficeAddress;
  const road = fields.includes("road") ? draft?.road ?? "" : before?.road_addr_part1 ?? "";
  return road ? krAddress({ road, zip: fields.includes("zip") ? draft?.zip ?? "" : before?.zip_no ?? "", detail: before?.detail ?? "", verified: false }) : null;
}

/** Merge only mapped columns over the record read for this preview, pinning that read's version. */
export function entityRowOp(row: EntityRow, records: readonly LegalEntity[] = []): EntitySetupOp {
  const op = row.op ?? "CREATE_ENTITY";
  const ref = String(row.line);
  if (op === "CREATE_WORKPLACE") throw new Error("workplaceFlow");
  if (op === "CREATE_ENTITY") return { op, ref, entity: entityBody(row.draft) };
  const base = revisionBase(row, records);
  if (!base) throw new Error("record");
  const has = (field: BulkField) => (row.fields ?? ["name", "workplaceName"]).includes(field);
  const pin = { op, ref, id: row.id, expected_version: row.expectedVersion ?? base.version };
  const d = row.draft;
  if (base.entity) return { ...pin, entity: {
    ...base.entity,
    ...(has("name") ? { name: d.name.trim() } : {}),
    ...(has("kind") ? { biz_kind: d.bizKind! } : {}),
    ...(has("representatives") ? { representatives: d.representatives.map((n) => n.trim()).filter(Boolean) } : {}),
    ...(has("mode") ? { representation_mode: d.representationMode! } : {}),
    ...(has("crn") ? { crn: d.crn || null } : {}),
    head_office_address: rowAddress(row, base.entity.head_office_address),
  } };
  return { ...pin, workplace: {
    ...base.workplace!,
    ...(has("workplaceName") || has("name") ? { name: (row.workplaceName ?? d.name).trim() } : {}),
    address: rowAddress(row, base.workplace!.address),
    ...(has("road") || has("zip") ? { same_address_as_registration: false } : {}),
  } };
}
