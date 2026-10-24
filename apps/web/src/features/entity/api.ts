// Legal entities, business registrations, workplaces and the reference reads they use: query descriptors and
// commands (pending contract, packages/api/src/pending/entity.ts).
import { api, ApiError, assertBoundPasskey, assertBoundPasskeyHash, type components } from "@console/api";
export { ApiError };
import type { CloseReason, CreateRegistrationRequest, CreateWorkplaceRequest, EntityDocument, IdentifierCorrectionReason, InsurerInput, LegalEntityInput, RefListKey, RegistrationInput, RegistrationReissue, WorkplaceInput } from "@console/api/pending";
import type { AsOf } from "../../reference/entity/api";
import { get, type PathPrefix } from "../../lib/query";
import { opsCorrectionLine } from "./domain/ops-cover";

export { correctionRegisterQuery, type IdentifierCorrectionCase } from "../../reference/entity/api";
/** One field the server refused and why (the envelope's `errors`, codes from the entity domain). */
export type FieldIssue = { field: string; code: string };

/**
 * `@console/api`'s unwrap, keeping the refusal's field errors: `ApiError` drops them, so a 422 would read only as the
 * generic failure (lift `errors` into ApiError in packages/api, then this goes).
 */
async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) throw Object.assign(ApiError.fromBody(response, error), { fields: (error as { error?: { errors?: FieldIssue[] } } | null)?.error?.errors ?? [] });
  return data as T;
}
/** The field errors a refused entity command carried (none for anything else). */
/** A save refused because a newer revision was recorded since the one read (409 stale_revision). */
export const isStale = (e: unknown) => e instanceof ApiError && e.code === "stale_revision";
export const fieldIssues = (e: unknown): FieldIssue[] => (e instanceof ApiError && "fields" in e ? (e as ApiError & { fields: FieldIssue[] }).fields : []);

// Counts follow exits and moves; opening the list or a record reads them again.
export const entitiesQuery = { ...get("/api/v1/legal-entities"), refetchOnMount: "always" as const };
export const entityQuery = (entityId: string, query: AsOf = {}) => ({ ...get("/api/v1/legal-entities/{entityId}", { params: { path: { entityId }, query } }), refetchOnMount: "always" as const });
/** Read the current version without redrawing the cached record beneath an open sheet. */
export const readEntity = (entityId: string) => unwrap(api.GET("/api/v1/legal-entities/{entityId}", { params: { path: { entityId } } }));
export const entityHistoryQuery = (entityId: string) => get("/api/v1/legal-entities/{entityId}/revisions", { params: { path: { entityId } } });
export const registrationHistoryQuery = (registrationId: string) => get("/api/v1/business-registrations/{registrationId}/revisions", { params: { path: { registrationId } } });
export const workplaceHistoryQuery = (workplaceId: string) => get("/api/v1/workplaces/{workplaceId}/revisions", { params: { path: { workplaceId } } });
export const entityDocumentsQuery = (entityId: string) => get("/api/v1/legal-entities/{entityId}/documents", { params: { path: { entityId } } });
export const documentQuery = (id: string) => get("/api/v1/entity-documents/{id}", { params: { path: { id } } });
/** One correction case with the actions this viewer can take. */
export const correctionCaseQuery = (id: string) => get("/api/v1/entity-identifier-corrections/{id}", { params: { path: { id } } });
/** One page of an official code list matching `q` (code or label). */
export const codesQuery = (key: RefListKey, q: string) => get("/api/v1/ref/lists/{key}/codes", { params: { path: { key }, query: { q } } });
export const addressQuery = (q: string) => get("/api/v1/ref/address-search", { params: { query: { q } } });

/** Every read an entity or workplace command may change, onboarding's checklist and the org structure included. */
// A workplace brings its default branch (the employee's home branch) and its place in the org tree.
export const ENTITY_READS: PathPrefix[] = ["/api/v1/legal-entities", "/api/v1/business-registrations", "/api/v1/workplaces", "/api/v1/onboarding", "/api/v1/org-structure", "/api/v1/branches", "/api/v1/org-units", "/api/v1/entity-identifier-corrections", "/api/v1/me/action-inbox"];

/**
 * A dated revision: the full new state, when it takes effect (may be in the future) and why, against the newest
 * revision this client read (`readVersion`); one recorded since is refused as stale.
 */
type Dated = { effective_from: string; reason_code: string; expected_version: number };

/** Every write carries the user intent's Idempotency-Key: a retry with the same key replays the first result. */
const once = (key: string) => ({ "Idempotency-Key": key });
export { stepKey } from "../../reference/entity/api";
/** The newest revision read: the one in force or a later one already scheduled. */
export const readVersion = (r: { current?: { version: number } | null; scheduled?: readonly { version: number }[] }) =>
  Math.max(r.current?.version ?? 0, ...(r.scheduled ?? []).map((x) => x.version));

export const createEntity = (key: string, body: LegalEntityInput) => unwrap(api.POST("/api/v1/legal-entities", { params: { header: once(key) }, body }));
export const reviseEntity = (key: string, entityId: string, body: LegalEntityInput & Dated) =>
  unwrap(api.PUT("/api/v1/legal-entities/{entityId}", { params: { path: { entityId }, header: once(key) }, body }));
export const addRegistration = (key: string, entityId: string, body: CreateRegistrationRequest) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/registrations", { params: { path: { entityId }, header: once(key) }, body }));
export const reviseRegistration = (key: string, registrationId: string, body: RegistrationInput & Dated & { status: "CONTINUING" | "SUSPENDED" | "CLOSED"; status_since?: string | null; status_until?: string | null }) =>
  unwrap(api.PUT("/api/v1/business-registrations/{registrationId}", { params: { path: { registrationId }, header: once(key) }, body }));
/** certificate reissue: the new certificate and every fact it changed, as one dated change (the old certificate stays, superseded). */
export const reissueRegistration = (key: string, registrationId: string, body: RegistrationReissue) =>
  unwrap(api.POST("/api/v1/business-registrations/{registrationId}/reissues", { params: { path: { registrationId }, header: once(key) }, body }));
/** Settle a one-time legal-name review: without `revision` the legal name stays; with it, the certificate's trade name becomes it by that correction. */
export const settleNameReview = (key: string, entityId: string, reviewId: string, body: { revision?: LegalEntityInput & Dated }) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/name-reviews/{reviewId}/settle", { params: { path: { entityId, reviewId }, header: once(key) }, body }));
/** Which workplace is the representative one and which is the head office (or that the head office is only an office). */
export const setRoles = (key: string, entityId: string, body: { primary_workplace_id?: string | null; head_office_workplace_id?: string | null; head_office_has_no_workplace?: boolean }) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/roles", { params: { path: { entityId }, header: once(key) }, body }));
type OpsStepUp = components["schemas"]["IdentifierCorrectionRequest"]["step_up"];
type CorrectionBody = { value: string; document_id: string; reason_code: IdentifierCorrectionReason; exception_id?: string };

/**
 * After go-live the tenant ops account covers a correction itself (decisions #26 item d): the server answers 428
 * passkey_step_up_required, then an authenticated attempt uses a new key with a passkey bound to this subject and line.
 * Anyone else gets the server's refusal as it is.
 */
async function withOpsStepUp<T>(key: string, subject: string, line: string, send: (key: string, step_up?: OpsStepUp) => Promise<T>) {
  try {
    return await send(key);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 428 && e.code === "passkey_step_up_required")) throw e;
    const proof = (await assertBoundPasskey("EXCEPTION_DECIDE", subject, line)) as unknown as OpsStepUp;
    // The refused admission is terminal; the authenticated attempt is a new intent.
    return send(crypto.randomUUID(), proof);
  }
}

/** Corrects a locked identifier on evidence (a registry extract or a newer certificate): biz_kind or crn of the entity. */
export const correctIdentifier = (key: string, entityId: string, body: CorrectionBody & { field: "biz_kind" | "crn" }) =>
  withOpsStepUp(key, entityId, opsCorrectionLine(body.field, body.value, body.document_id), (intent, step_up) =>
    unwrap(api.POST("/api/v1/legal-entities/{entityId}/identifier-corrections", { params: { path: { entityId }, header: once(intent) }, body: { ...body, step_up } })));
/** Corrects a certificate's registration number on evidence. */
export const correctRegistrationNumber = (key: string, registrationId: string, body: CorrectionBody) =>
  withOpsStepUp(key, registrationId, opsCorrectionLine("brn", body.value, body.document_id), (intent, step_up) =>
    unwrap(api.POST("/api/v1/business-registrations/{registrationId}/identifier-corrections", { params: { path: { registrationId }, header: once(intent) }, body: { field: "brn", ...body, step_up } })));
/** A second person decides the exact fingerprint they reviewed; only approval needs their passkey. */
export const decideCorrection = async (id: string, decision: "APPROVE" | "DECLINE", note: string, payloadHash: string) => {
  const step_up = decision === "APPROVE" ? await assertBoundPasskeyHash("EXCEPTION_DECIDE", id, payloadHash) : undefined;
  return unwrap(api.POST("/api/v1/governed-exceptions/{id}/decide", { params: { path: { id } }, body: { decision, reason_code: decision === "APPROVE" ? "SECOND_PERSON_VERIFIED" : "DOCUMENT_MISMATCH", note, step_up } }));
};
/** The controller's review of a correction already recorded through the sole-holder fallback. */
export const reviewCorrection = (id: string, note: string) => unwrap(api.POST("/api/v1/entity-identifier-corrections/{id}/review", { params: { path: { id } }, body: { note } }));
/** Closes the entity (dissolved or business closed) on a date no later than today; its open workplaces and certificates close with it. */
export const closeEntity = (key: string, entityId: string, body: { closed_on: string; reason_code: CloseReason }) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/close", { params: { path: { entityId }, header: once(key) }, body }));
/** Corrects a closed entity's close date or reason (catalog company-19); nothing reopens. */
export const correctClose = (key: string, entityId: string, body: { closed_on: string; reason_code: CloseReason; why: string }) =>
  unwrap(api.PUT("/api/v1/legal-entities/{entityId}/close", { params: { path: { entityId }, header: once(key) }, body }));
/** Close withdrawal (company-15): the business goes on; what closed with the entity reopens. */
export const withdrawClose = (key: string, entityId: string, why: string) =>
  unwrap(api.DELETE("/api/v1/legal-entities/{entityId}/close", { params: { path: { entityId }, header: once(key) }, body: { why } }));
/** Removes a mistaken record during setup only (the server refuses it once operations start or anything depends on it). */
export const voidEntity = (key: string, entityId: string, reason_code: string) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/void", { params: { path: { entityId }, header: once(key) }, body: { reason_code } }));
export const voidWorkplace = (key: string, workplaceId: string, reason_code: string) =>
  unwrap(api.POST("/api/v1/workplaces/{workplaceId}/void", { params: { path: { workplaceId }, header: once(key) }, body: { reason_code } }));
export const voidRegistration = (key: string, registrationId: string, reason_code: string) =>
  unwrap(api.POST("/api/v1/business-registrations/{registrationId}/void", { params: { path: { registrationId }, header: once(key) }, body: { reason_code } }));
export const createWorkplace = (key: string, entityId: string, body: CreateWorkplaceRequest) =>
  unwrap(api.POST("/api/v1/legal-entities/{entityId}/workplaces", { params: { path: { entityId }, header: once(key) }, body }));
export const reviseWorkplace = (key: string, workplaceId: string, body: WorkplaceInput & Dated) =>
  unwrap(api.PUT("/api/v1/workplaces/{workplaceId}", { params: { path: { workplaceId }, header: once(key) }, body }));
/**
 * Links a workplace to a certificate from a date (catalog company-18): its own certificate recorded just before, one of the
 * entity's that no workplace holds, or a unit-taxation one with its sub-workplace serial. The first link of a workplace added
 * with "link later" is this same change, from none.
 */
export const changeRegistration = (key: string, workplaceId: string, body: { registration_id: string | null; sub_serial?: string | null; effective_from: string; reason_code: string }) =>
  unwrap(api.POST("/api/v1/workplaces/{workplaceId}/registration-changes", { params: { path: { workplaceId }, header: once(key) }, body }));
/** A dated change to the listed insurers; `expected_version` is the highest insurance revision read (0 when none). */
export const reviseInsurance = (key: string, workplaceId: string, body: Dated & { insurers: InsurerInput[] }) =>
  unwrap(api.PUT("/api/v1/workplaces/{workplaceId}/insurance", { params: { path: { workplaceId }, header: once(key) }, body }));

/** The kept original of an evidence document, as a file. */
export const documentContent = (id: string) => unwrap(api.GET("/api/v1/entity-documents/{id}/content", { params: { path: { id } }, parseAs: "blob" }));

/** Uploads a certificate or registry extract as tenant-owned evidence (kept, never read: decisions #16). */
export const uploadDocument = (file: File, kind: EntityDocument["kind"]) =>
  unwrap(
    api.POST("/api/v1/entity-documents", {
      // Multipart: the typed body is replaced by the FormData the endpoint expects.
      body: { file: "", kind },
      bodySerializer: () => {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", kind);
        return form;
      },
    }),
  );

/** A requested path this server does not serve yet (no route): the screen says so instead of failing. */
export const unserved = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

/** Accepted certificate files (design §4.1): PDF or a photo or scan. The server checks again. */
export const CERT_FILES = [
  { mime: "application/pdf", ext: "PDF" },
  { mime: "image/jpeg", ext: "JPG" },
  { mime: "image/png", ext: "PNG" },
] as const;
// the 10 MB ceiling mirrors the server's; read it from the settings registry once that key is served.
export const CERT_MAX_BYTES = 10 * 1048576;

export { kindsRef as kindsQuery } from "../../reference/entity/api";
export const addKind = (key: string, label: string) => unwrap(api.POST("/api/v1/workplace-kinds", { params: { header: once(key) }, body: { label } }));
/** Relabel a kind (null puts a default back to its catalog label) or hide / show it in the picker. */
export const updateKind = (key: string, code: string, body: { label?: string | null; active?: boolean }) =>
  unwrap(api.PATCH("/api/v1/workplace-kinds/{code}", { params: { header: once(key), path: { code } }, body }));
/** A workplace's kind (a label, direct in both phases). */
export const setKind = (key: string, workplaceId: string, kind_code: string | null) =>
  unwrap(api.PUT("/api/v1/workplaces/{workplaceId}/kind", { params: { header: once(key), path: { workplaceId } }, body: { kind_code } }));
/** A workplace's code (unique among open workplaces; a code a closed one held comes back with the warning code_reused). */
export const setWorkplaceCode = (key: string, workplaceId: string, code: string | null) =>
  unwrap(api.PUT("/api/v1/workplaces/{workplaceId}/code", { params: { header: once(key), path: { workplaceId } }, body: { code } }));

// --- lane: CRUD ---
/** Whether a legal entity or workplace is deleted (never used) or closed, and why not the other (the server decides by use). */
export const entityEndQuery = (id: string) => get("/api/v1/legal-entities/{entityId}/end-options", { params: { path: { entityId: id } } });
export const workplaceEndQuery = (id: string) => get("/api/v1/workplaces/{workplaceId}/end-options", { params: { path: { workplaceId: id } } });

export const registrationEndQuery = (id: string) => get("/api/v1/business-registrations/{registrationId}/end-options", { params: { path: { registrationId: id } } });

export type CheckEvidence = components["schemas"]["RegistrationCheckEvidence"];
export type CheckHistory = components["schemas"]["RegistrationCheckHistory"];
export type CheckAvailability = components["schemas"]["RegistrationCheckAvailability"];
export type CheckAnswer = components["schemas"]["RegistrationCheckAnswer"];
export const registrationChecksQuery = (registrationId: string) => get("/api/v1/business-registrations/{registrationId}/checks", { params: { path: { registrationId } } });
export const registrationCheckAvailabilityQuery = get("/api/v1/registration-checks/availability");
export const checkRegistration = (registrationId: string, kind: "STATUS" | "VALIDATE", key: string, expected?: { brn: string; opened_on: string; representative: string }) => unwrap(api.POST("/api/v1/business-registrations/{registrationId}/checks", { params: { path: { registrationId }, header: once(key) }, body: { kind, ...(expected ? { expected } : {}) } }));
export const previewRegistrationCheck = (key: string, body: components["schemas"]["RegistrationCheckPreview"]) => unwrap(api.POST("/api/v1/registration-checks/preview", { params: { header: once(key) }, body }));

export type CheckPreview = { answer: CheckAnswer; command_id: string; values: { brn: string; opened_on: string; representative: string }; acknowledged: boolean; status_since?: string };
