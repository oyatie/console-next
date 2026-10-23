// The tenant's setup phase (design §5, §6): the server-computed checklist, its few direct commands, and the
// one-way start of operations (backend branch hard/entity-depth; packages/api/src/pending).
export { ApiError } from "@console/api";
import { api, assertPasskey, registerPasskey, session, unwrap } from "@console/api";
import { get, type PathPrefix } from "../../lib/query";
import { landed } from "../../lib/react/landed";

export const checklistQuery = get("/api/v1/onboarding/checklist");
/** Re-read whenever the preview opens: a fix made on a record's own screen shows here on return (company-53). */
export const goLivePreviewQuery = { ...get("/api/v1/onboarding/go-live/preview"), refetchOnMount: "always" as const };
/** Exact service terms, read only when the contracting administrator opens the text. */
export const termsQuery = { ...get("/api/v1/onboarding/terms"), staleTime: 0, refetchOnMount: "always" as const };
/** Everything setup may change: the checklist, the entity reads it counts, and the org reads. */
export const SETUP_READS: PathPrefix[] = ["/api/v1/onboarding", "/api/v1/legal-entities", "/api/v1/org-structure", "/api/v1/org-units", "/api/v1/employment-assignments"];

export const skipStep = (step: "org" | "employees" | "roles") => unwrap(api.POST("/api/v1/onboarding/steps/{step}/skip", { params: { path: { step } } }));
/** The contracting admin accepts the service terms for the tenant (decision #3), bound to the exact document reviewed. */
export const acceptTerms = (version: string, sha256: string) => unwrap(api.POST("/api/v1/onboarding/terms", { body: { version, sha256 } }));
export const recordContact = (body: { role: "REPRESENTATIVE" | "CPO" | "SELF"; name: string; email: string }) => unwrap(api.POST("/api/v1/onboarding/security-contact", { body }));
/**
 * Starts operations: bound to the previewed digest and the actor's own passkey (step-up). One way.
 * Contract bug raised with the backend: GoLiveRequest types the WebAuthn credential as an empty object.
 */
export const goLive = async (digest: string, soleHolderAcknowledged: boolean, lineDigests: Record<string, string>, key: string) =>
  unwrap(api.POST("/api/v1/onboarding/go-live", { headers: { "Idempotency-Key": key }, body: { digest, line_digests: lineDigests, sole_holder_acknowledged: soleHolderAcknowledged, step_up: (await assertPasskey()) as never } }));

const passkeys = get("/api/v1/auth/passkeys");
/**
 * A second passkey, from the rail (governance-20): a step-up with one this account holds, then the new one on the device
 * the browser offers. A lost response counts as done when the list grew (registration takes no idempotency key).
 */
export const addPasskey = (before: number) =>
  landed(() => registerPasskey({ stepUp: true }), async () => ({ data: await passkeys.queryFn() }), (d) => d.length > before);
/** Who is signed in, by name: the one who can clear a go-live blocker on this screen. */
export const signedInName = () => session.claims?.name;
