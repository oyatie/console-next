// SPDX-License-Identifier: LicenseRef-Proprietary
import { entityBody, entityGaps } from "./create";
import type { BizKind, EntitySetupOp, RepresentationMode } from "@console/api/pending";
import { emptyDraft, type Draft } from "./draft";
import { krAddress } from "./plan";

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
          headOfficeAddress: get("road")
            ? { road: get("road"), zip: get("zip"), detail: "", verified: false }
            : null,
        },
      },
    ];
  });
}

/** Check required fields and identify missing gaps depending on operation */
export function bulkGaps(row: EntityRow): string[] {
  const op = row.op ?? "CREATE_ENTITY";

  if (op === "REVISE_ENTITY") {
    const gaps: string[] = [];
    if (!row.id) gaps.push("id");
    if (row.expectedVersion == null || isNaN(row.expectedVersion) || row.expectedVersion < 0) {
      gaps.push("version");
    }
    if (!row.draft.name.trim()) gaps.push("name");
    return gaps;
  }

  if (op === "CREATE_WORKPLACE") {
    const gaps: string[] = [];
    const wpName = (row.workplaceName || row.draft.name).trim();
    if (!wpName) gaps.push("workplaceName");
    if (!row.legalEntityId && !row.entityRef) gaps.push("legalEntityId");
    return gaps;
  }

  if (op === "REVISE_WORKPLACE") {
    const gaps: string[] = [];
    if (!row.id) gaps.push("id");
    if (row.expectedVersion == null || isNaN(row.expectedVersion) || row.expectedVersion < 0) {
      gaps.push("version");
    }
    const wpName = (row.workplaceName || row.draft.name).trim();
    if (!wpName) gaps.push("workplaceName");
    return gaps;
  }

  const gaps = entityGaps(row.draft);
  const count = row.draft.representatives.filter((n) => n.trim()).length;
  const mode = row.draft.representationMode;
  if (
    !gaps.includes("representationMode") &&
    ((row.modeUnrecognized && !mode) ||
      (count === 1 && mode && mode !== "SINGLE") ||
      (count > 1 && mode === "SINGLE"))
  ) {
    gaps.push("representationMode");
  }
  return gaps;
}

/** Converts an intake EntityRow to a single-path EntitySetupOp */
export function entityRowOp(r: EntityRow): EntitySetupOp {
  const op = r.op ?? "CREATE_ENTITY";
  const ref = String(r.line);

  if (op === "REVISE_ENTITY") {
    return {
      op: "REVISE_ENTITY",
      ref,
      id: r.id,
      expected_version: r.expectedVersion ?? 1,
      entity: entityBody(r.draft),
    };
  }

  if (op === "CREATE_WORKPLACE") {
    return {
      op: "CREATE_WORKPLACE",
      ref,
      legal_entity_id: r.legalEntityId,
      entity_ref: r.entityRef ?? (r.legalEntityId ? undefined : ref),
      workplace: {
        name: r.workplaceName || r.draft.name,
        opened_on: r.draft.openedOn || "2020-01-01",
        address: r.draft.headOfficeAddress ? krAddress(r.draft.headOfficeAddress) : null,
      },
    };
  }

  if (op === "REVISE_WORKPLACE") {
    return {
      op: "REVISE_WORKPLACE",
      ref,
      id: r.id,
      expected_version: r.expectedVersion ?? 1,
      workplace: {
        name: r.workplaceName || r.draft.name,
        opened_on: r.draft.openedOn || "2020-01-01",
        address: r.draft.headOfficeAddress ? krAddress(r.draft.headOfficeAddress) : null,
      },
    };
  }

  return {
    op: "CREATE_ENTITY",
    ref,
    entity: entityBody(r.draft),
  };
}
