export { ApiError } from "@console/api";
import { api, assertBoundPasskey, assertPasskey, consentDocuments, consentStatus, logout, meProfileApi, registerPasskey, session, unwrap } from "@console/api";
import { isMessageId, t } from "@console/i18n";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import type { components } from "@console/api/schema";
import { cursorPages, get, read } from "../../lib/query";
import { landed } from "../../lib/react/landed";
import { forgetDomains } from "../../auth/sign-in-id";
import { toDomestic } from "../../lib/pure/formats";

export type Me = components["schemas"]["CurrentUser"];
export type MeProfile = components["schemas"]["MeProfileResponse"];
export type SelfEmergencyContactInput = components["schemas"]["SelfEmergencyContactInput"];
export type SelfEmergencyContactSummary = components["schemas"]["SelfEmergencyContactSummary"];
export type SelfRevealField = components["schemas"]["SelfRevealRequest"]["field"];
type SelfFieldRevealed = components["schemas"]["SelfFieldRevealed"];
export type SelfIssueCertificateRequest = components["schemas"]["SelfIssueCertificateRequest"];
type CreateSelfChangeRequest = components["schemas"]["CreateSelfChangeRequest"];
export type Certificate = components["schemas"]["Certificate"];
export type MyAccessLogEvent = components["schemas"]["MyAccessLogEvent"];
export type InboxDocSummary = components["schemas"]["InboxDocSummary"];

export const passkeysQuery = get("/api/v1/auth/passkeys");
export const passkeyLabelPolicyQuery = get("/api/v1/auth/passkeys/policy");
/** Tenant accounts only: a platform token is another world, where this read answers 404. */
export const meQuery = get("/api/v1/users/me");
export const meProfileQuery = get("/api/v1/me/profile");
export const myCertificatesQuery = (cursor?: string) => get("/api/v1/me/certificates", { params: { query: { cursor } } });
export const myCertificateQuery = (id: string) => get("/api/v1/me/certificates/{id}", { params: { path: { id } } });
export const myAccessLogQuery = get("/api/v1/me/access-log", { params: { query: { limit: 5 } } });
export const myAccessLogPages = cursorPages("/api/v1/me/access-log", { limit: 20 });
export const myLeaveSummaryQuery = get("/api/v2/me/leave", { params: { query: { limit: 1 } } });
export const myPayslipDocsQuery = get("/api/v1/me/inbox-docs", { params: { query: { filter: "pay", limit: 1 } } });
export const myPayslipDocDetailQuery = (id: string) => get("/api/v1/me/inbox-docs/{id}", { params: { path: { id } } });
export const myChangeRequestsQuery = get("/api/v1/change-requests", { params: { query: { requester: "me", status: "OPEN", limit: 10 } } });
const kindLabel = (code: string) => { const key = `account.privacy.kind.${code}`; return isMessageId(key) ? t(key) : code; };
const rightsPages = cursorPages("/api/v1/privacy/rights-requests/mine", {});
export const privacyRequestPages = { ...rightsPages, select: (data: { pages: Awaited<ReturnType<typeof rightsPages.queryFn>>[]; pageParams: unknown[] }) => ({
  ...data, pages: data.pages.map(page => ({ ...page, items: page.items.map(item => privacyReceipt(item, page.as_of)) })),
}) };

export function privacyReceipt(item: components["schemas"]["PrivacyRightsReceipt"], asOf: string): PrivacyRightsReceipt {
  const kinds = Object.entries(item.kinds);
  const dates = kinds.flatMap(([, state]) => state.due?.on ? [state.due.on] : []).sort();
  const due = item.status === "RECEIVED" ? dates[0] : undefined;
  const days = due ? Math.round((Date.parse(due) - Date.parse(asOf)) / 86_400_000) : 0;
  return { id: item.id, receipt_no: item.receipt_no, controller_label: t(`account.privacy.controller.${item.receipt.controller}`),
    kinds: kinds.map(([code]) => ({ code, label: kindLabel(code) })),
    detail: item.detail, received_at: item.receipt.identity_at,
    status: { code: item.status, label: t(`account.privacy.status.${item.status}`), tone: "info" },
    clock: due ? { due_at: due, days_left: days, severity: days < 0 ? "over" : "due" } : null,
    without_delay: item.status === "RECEIVED" && kinds.some(([, state]) => state.due?.without_delay),
    outcomes: kinds.flatMap(([code, state]) => state.decisions.map(({ decision }) => ({ kind_label: kindLabel(code),
      outcome_label: t(`account.privacy.outcome.${decision.outcome}`), reason_label: decision.reason, note: decision.note }))),
    notified_at: null, objection_method: null, retention_notice: null,
  };
}

export const operatorMeQuery = get("/api/platform/users/me");
/** Only this user changes their own consent: no polling of the auth endpoint. */
export const consentDocumentsQuery = read("/api/v1/onboarding/terms", consentDocuments);
export const consentQuery = { ...read("/api/v1/auth/privacy-consent/status", consentStatus), refetchInterval: false } as const;

/** Routing hints from the signed-in token (name, roles, tier). */
export const claims = () => session.claims;
/** Signing out on this device also forgets the domains this browser signed into (auth/sign-in-id.ts). */
export const signOutHere = () => (forgetDomains(), logout());

const list = async () => ({ data: await passkeysQuery.queryFn() });

/** Adds a passkey after a step-up with an existing one. Registration has no idempotency key: a lost response counts as done when the list grew. */
export const addPasskey = (before: number, label?: string) =>
  landed(() => registerPasskey({ stepUp: true, label }), list, (d) => d.length > before);

/** Display metadata only; credential changes still require the existing step-up flow. */
export const renamePasskey = (id: string, label: string) =>
  unwrap(api.PATCH("/api/v1/auth/passkeys/{id}", { params: { path: { id } }, body: { label } }));

/** Removes a passkey after a step-up (the server deletes nothing without it); a lost response counts as done when the row is gone. */
export async function removePasskey(id: string) {
  const step_up = await assertPasskey();
  return landed(
    () => unwrap(api.DELETE("/api/v1/auth/passkeys/{id}", { params: { path: { id } }, body: { step_up } })),
    list,
    (d) => !d.some((p) => p.id === id),
  );
}

export const tenantRecoveryQuery = get("/api/v1/tenant/ops-recovery");
export const cancelTenantRecovery = async (orgId: string, id: string, reason: string, key: string) => unwrap(api.POST("/api/v1/tenant/ops-recovery/{rid}/cancel", {
  params: { path: { rid: id }, header: { "Idempotency-Key": key } },
  body: { reason, step_up: await assertBoundPasskey("OPERATOR_RECOVERY", id, JSON.stringify([orgId, id, "cancel", "", "", "", "", reason])) },
}));

/** The same self-profile command in each realm; a lost response is checked by its authoritative read. */
export function updateName(display_name: string) {
  const platform = Boolean(claims()?.platform);
  const body = { display_name };
  return landed(() => unwrap(platform ? api.PATCH("/api/platform/users/me", { body }) : api.PATCH("/api/v1/users/me", { body })),
    async () => ({ data: await (platform ? operatorMeQuery : meQuery).queryFn() }),
    (profile) => profile.display_name === display_name);
}

function maskedPhoneMatches(profilePhone: string, targetDomestic: string): boolean {
  const segments = profilePhone.split(/[•*]+/);
  if (segments.length !== 2) return false;
  const prefix = toDomestic(segments[0]!);
  const suffix = segments[1]!.replace(/\D/g, "");
  return Boolean(
    prefix &&
      suffix &&
      targetDomestic.length >= prefix.length + suffix.length &&
      targetDomestic.startsWith(prefix) &&
      targetDomestic.endsWith(suffix),
  );
}

function phoneLanded(profilePhone: string | null | undefined, normalized: string | null, previous?: string | null): boolean {
  if (normalized === null) return !profilePhone;
  if (!profilePhone) return false;
  if (profilePhone === normalized) return true;
  const target = toDomestic(normalized);
  if (!target) return false;
  if (/[•*]/.test(profilePhone)) {
    return profilePhone !== previous && maskedPhoneMatches(profilePhone, target);
  }
  return toDomestic(profilePhone) === target;
}

/** Self-editable mobile number on the linked employee profile; a lost response is verified against `/me/profile`. */
export function updatePhone(phone: string | null, previous?: string | null) {
  const normalized = phone?.trim() ? phone.trim() : null;
  return landed(
    () => meProfileApi(api).updateProfile({ phone: normalized }),
    async () => ({ data: await meProfileQuery.queryFn() }),
    (profile) => phoneLanded(profile.phone_masked, normalized, previous),
  );
}

/** Replaces the linked employee's emergency contacts immediately (up to 3; notice confirmation required when non-empty). */
export function updateEmergencyContacts(emergency_contacts: SelfEmergencyContactInput[]) {
  return meProfileApi(api).updateProfile({ emergency_contacts });
}

/** Step-up passkey reveal of one self-service profile field, bound to `PII_REVEAL` on `employeeId`. */
export async function revealMyProfileField(employeeId: string, field: SelfRevealField): Promise<SelfFieldRevealed> {
  const step_up = await assertBoundPasskey("PII_REVEAL", employeeId, `SELF_REVEAL:${field}`);
  return meProfileApi(api).revealField({ field, step_up });
}

/** Files an approval-gated correction request (`address` or boolean `bank_account_registered`). */
export function createMyProfileChangeRequest(body: CreateSelfChangeRequest) {
  return meProfileApi(api).createChangeRequest(body);
}

/** Issues a self-service employment/career/exit certificate with an explicit idempotency key. */
export function issueMyCertificate(body: SelfIssueCertificateRequest, key: string) {
  return meProfileApi(api).issueCertificate(body, key);
}

/** Domain-specific error messages for self-service profile edits, reveals, and certificates. */
export function selfEditError(code: string): string | undefined {
  switch (code) {
    case "change_request_already_open":
      return t("account.selfEdit.error.change_request_already_open");
    case "support_session_read_only":
      return t("account.selfEdit.error.support_session_read_only");
    case "employee_unlinked":
      return t("account.selfEdit.error.employee_unlinked");
    case "emergency_contact_notice_unconfirmed":
      return t("account.selfEdit.error.emergency_contact_notice_unconfirmed");
    case "reveal_rate_limited":
      return t("account.selfEdit.error.reveal_rate_limited");
    default: {
      const certKey = `empDoc.certificate.error.${code}`;
      return isMessageId(certKey) ? t(certKey) : undefined;
    }
  }
}

export const privacyFilingOptionsQuery = get("/api/v1/privacy/rights-requests/options");

/** Keep field order identical to the server's canonical Filing serialization. */
export async function filePrivacyRequest(subject: string, input: import("@console/api/pending").PrivacyFiling, key: string) {
  const body = { controller: input.controller, kinds: input.kinds, detail: input.detail ?? "" };
  const step_up = await assertBoundPasskey("PRIVACY_REQUEST", subject, JSON.stringify(body));
  return unwrap(api.POST("/api/v1/privacy/rights-requests", { params: { header: { "Idempotency-Key": key } }, body: { ...body, step_up } }));
}
