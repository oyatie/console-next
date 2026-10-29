// REQUESTED CONTRACT. The entity backends (ENT-1 hard/entity-depth, ENT-CAPTURE hard/entity-capture) publish legal
// entities, registrations, workplaces, the setup checklist and go-live, org structure and assignments, documents,
// dated history, the insurance revision, reference lists and address search in the generated ./schema; the aliases
// below name those schemas for the screens. The `Requested` block is typed by hand from the agreed design for the
// reads and commands no backend branch serves yet (the security contact). Each is a backend ask; the screens that
// use one degrade where it is not served. Remove an entry once its path is generated, and a type that then fails to
// match is a contract bug to raise, not to paper over.
import type { PayrollPaths, PayrollModule } from "./payroll";
export type { PayGroup, PayGroups, PayrollRate, PayrollRates, PayrollRun } from "./payroll";
import type { StatutoryPaths } from "./statutory";
export type { FilingTask, FilingPage, RegisterPage, RecordFiling, FilingFacts, FilingReason, FilingCitation } from "./statutory";
import type { components, paths } from "../schema";
export type { ReorderRequest, SetupOp, SetupReceipt, SetupUnitResult, Structure, StructureNode, UnitHead, WorkplaceKind } from "./structure";

type S = components["schemas"];
export type LegalEntity = S["LegalEntity"];
export type LegalEntityState = S["LegalEntityState"];
export type BusinessRegistration = S["BusinessRegistration"];
export type RegistrationState = S["RegistrationState"];
export type Workplace = S["Workplace"];
export type WorkplaceState = S["WorkplaceState"];
export type KrAddress = S["KrAddress"];
export type FormattedValue = S["FormattedValue"];
export type LegalEntityInput = S["LegalEntityInput"];
export type RegistrationInput = S["RegistrationInput"];
/** A further registration of an entity, with the kept certificate it is typed from. */
export type CreateRegistrationRequest = S["CreateBusinessRegistrationRequest"];
export type WorkplaceInput = S["WorkplaceInput"];
export type CreateWorkplaceRequest = S["CreateWorkplaceRequest"];
export type InsurerInput = S["InsurerInput"];
export type WithholdingMode = S["WithholdingMode"];
export type InsuranceShortcut = S["InsuranceShortcut"];
export type InsuranceRelation = S["InsuranceRelation"];
export type WithholdingTarget = S["WithholdingTarget"];
export type EntityFieldWarning = S["EntityFieldWarning"];
export type Checklist = S["SetupChecklist"];
export type ChecklistStep = S["SetupStep"];
export type GoLivePreview = S["GoLivePreview"];
export type GoLiveItem = S["GoLivePreviewItem"];
export type OrgStructure = S["OrgStructure"];
export type OrgStructureNode = S["OrgStructureNode"];
export type EmploymentAssignment = S["EmploymentAssignment"];
export type CodeRef = S["CodeRef"];
export type BizKind = S["EntityBizKind"];
export type NtsTaxType = S["NtsTaxType"];
export type RepresentationMode = S["EntityRepresentationMode"];
export type IssueReasonKind = S["EntityIssueReasonKind"];
export type CorrectionReason = S["EntityCorrectionReason"];
export type VatUnitMode = S["VatUnitMode"];
export type VatUnitBasis = S["VatUnitBasis"];
export type ChangeMode = S["EntityChangeMode"];
export type OperatingStatus = S["OperatingStatus"];
export type Insurer = S["Insurer"];
export type InsuranceStatus = S["InsuranceStatus"];
export type VerificationTier = BusinessRegistration["verification_tier"];
export type Phase = Checklist["phase"];
export type Revision = S["EntityRevision"];
export type EntityDocument = S["EntityDocument"];
/** certificate reissue: the new certificate, why and from when, and the facts it changed. */
export type RegistrationReissue = S["RegistrationReissueRequest"];
export type ReissueReason = RegistrationReissue["reason"];
export type RefList = S["RefList"];
export type RefListKey = paths["/api/v1/ref/lists/{key}/codes"]["get"]["parameters"]["path"]["key"];
export type DirectorRole = S["EntityDirectorRole"];
export type DirectorInput = S["EntityDirectorInput"];
/** The regular headcount (sangsi geunroja su), derived by the server and held (BW-35) until a labor attorney releases the method. */
export type RegularWorkers = S["RegularWorkers"];

// ---- Typed by hand: not served by the backend branch yet --------------------------------------------------

type Ok<R> = { 200: { headers: { [name: string]: unknown }; content: { "application/json": R } } };
type Params<Q, P, H> = { query?: Q; header?: H; path: P; cookie?: never };
type Op<R, B = never, Q = never, P = never, H = never> = {
  parameters: [P] extends [never] ? Omit<Params<Q, P, H>, "path"> & { path?: never } : Params<Q, P, H>;
  responses: Ok<R>;
} & ([B] extends [never] ? { requestBody?: never } : { requestBody: { content: { "application/json": B } } });
type NoOps = { get?: never; put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never };
type Path<Ops> = { parameters: { query?: never; header?: never; path?: never; cookie?: never } } & Omit<NoOps, keyof Ops> & Ops;

export type IdentifierCorrectionReason = S["IdentifierCorrectionReason"];
export type CloseReason = S["EntityCloseReason"];
export type OrgChangeCounts = Record<"open" | "mine" | "approval" | "ready" | "done" | "closed" | "all", number>;

type Requested = {
  /** Pending grouped read; the web count query falls back on older backends. */
  "/api/v1/org-changes/counts": Path<{ get: Op<OrgChangeCounts, never, { effective_from?: string; effective_to?: string }> }>;
  /** The out-of-band security contact (decision #7); recorded only, no mail is sent (decisions #16). */
  "/api/v1/onboarding/security-contact": Path<{ post: Op<Record<string, never>, { role: "REPRESENTATIVE" | "CPO" | "SELF"; name: string; email: string }> }>;
};

/** The generated paths with the requested ones laid over them. */
type PayrollModulesPath = { "/api/v1/onboarding/modules": { get: { parameters: Record<string, never>; responses: { 200: { content: { "application/json": (S["OnboardingModules"][number] | PayrollModule)[] } } } } } };
export type AllPaths = Omit<paths, keyof Requested | keyof StatutoryPaths | keyof PayrollPaths | keyof PayrollModulesPath> & Requested & StatutoryPaths & PayrollPaths & PayrollModulesPath;

// --- lane: CS-BULK (fe/cs-bulk-history): setup batches (MR-12 org-structure, MR-29 entity-setup), named from the
// generated schema. The structure node and tree are the ones ./structure names (kept under their old names here).
export type OrgStructureNodeServed = S["OrgStructureNode"];
export type OrgStructureServed = S["OrgStructure"];
export type OrgSetupOp = S["OrgSetupOp"];
export type OrgSetupUnit = S["OrgSetupUnit"];
export type OrgSetupReceipt = S["OrgSetupReceipt"];
export type OrgSetupBatchView = S["OrgSetupBatchView"];
/** The served create also takes the insurance setup (the Rust input carries it; the published WorkplaceInput omits it). */
export type EntitySetupOp = Omit<S["EntitySetupOp"], "workplace"> & { workplace?: S["WorkplaceInput"] & { insurance?: S["CreateWorkplaceRequest"]["insurance"] } };
export type EntitySetupBatchRequest = Omit<S["EntitySetupBatchRequest"], "ops"> & { ops: EntitySetupOp[] };
export type EntitySetupItem = S["EntitySetupItem"];
export type EntitySetupResult = S["EntitySetupResult"];
export type EntitySetupBatchView = S["EntitySetupBatchView"];
