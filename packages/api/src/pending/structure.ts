// The company-structure editor's contract (S5 workplace, S6 department, S8 bulk move): the setup department batch, move,
// dissolve and details (ENT-ORG MR-12, CS-BE), the versioned structure read with codes, heads and counts (CS-BE), the
// workplace kind list (ENT-KIND MR-19) and the sibling order (CS-BE), named from the generated ./schema for the screens.
import type { components } from "../schema";

type S = components["schemas"];

/** tenant → legal entity → workplace → department (one department kind, any depth; decision 18). `version` is sent back as expected_version. */
export type StructureNode = S["OrgStructureNode"];
export type Structure = S["OrgStructure"];
/** One setup op. CREATE: name + one parent (workplace_id, parent_org_unit_id or parent_ref). RENAME/MOVE/DISSOLVE/SET_DETAILS: org_unit_id + expected_version. */
export type SetupOp = S["OrgSetupOp"];
export type SetupReceipt = S["OrgSetupReceipt"];
export type SetupUnitResult = S["SetupOrgUnitResult"];
/** A workplace kind: a platform default (HEAD_OFFICE … STORE) or a tenant kind; a label only, never a rule. */
export type WorkplaceKind = S["WorkplaceKind"];
/** A department's head as of today (dated; concurrent when concurrent). */
export type UnitHead = S["OrgUnitHeadRef"];
/** Exactly one parent and every current child once, in the new order. */
export type ReorderRequest = S["ReorderStructureRequest"];
