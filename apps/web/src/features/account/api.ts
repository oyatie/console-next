import { api, assertBoundPasskey, assertPasskey, consentDocuments, consentStatus, logout, registerPasskey, session, unwrap } from "@console/api";
import { isMessageId, t } from "@console/i18n";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import type { components } from "@console/api/schema";
import type { InfiniteData } from "@tanstack/react-query";
import { cursorPages, get, read } from "../../lib/query";
import { landed } from "../../lib/react/landed";
import { forgetDomains } from "../../auth/sign-in-id";

export type Me = components["schemas"]["UserSummary"];

export const passkeysQuery = get("/api/v1/auth/passkeys");
export const passkeyLabelPolicyQuery = get("/api/v1/auth/passkeys/policy");
/** Tenant accounts only: a platform token is another world, where this read answers 404. */
export const meQuery = get("/api/v1/users/me");
const kindLabel = (code: string) => { const key = `account.privacy.kind.${code}`; return isMessageId(key) ? t(key) : code; };
const rightsPages = cursorPages("/api/v1/privacy/rights-requests/mine", {});
export const privacyRequestPages = { ...rightsPages, select: (data: InfiniteData<Awaited<ReturnType<typeof rightsPages.queryFn>>>) => ({
  ...data, pages: data.pages.map(page => ({ ...page, items: page.items.map((item): PrivacyRightsReceipt => {
    const kinds = Object.entries(item.kinds);
    const dates = kinds.flatMap(([, state]) => state.due?.on ? [state.due.on] : []).sort();
    const due = item.status === "RECEIVED" ? dates[0] : undefined;
    const days = due ? Math.round((Date.parse(due) - Date.parse(page.as_of)) / 86_400_000) : 0;
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
  }) })),
}) };

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

/** One reach of a grant I hold, as GET /api/v1/access/me lists it (BE-ROLES contract; typed here until generated). */
export type MyReach = { domain: string; level: string; grant_id: string; role_name_ko: string; scope: { kind: string; node_id?: string | null; node_name?: string | null }; valid_to?: string | null; enforcement: string };
export type MyAccess = { is_ops: boolean; entries: MyReach[] };
// the access paths are not in the generated client yet (features/access/api.ts types them by hand too).
const getUntyped = api.GET as unknown as (path: string) => Promise<{ data?: MyAccess; error?: unknown; response: Response }>;
/** What I may do: every grant I hold that counts, by domain and level (My access). */
export const myAccessQuery = read("/api/v1/access/me", () => unwrap(getUntyped("/api/v1/access/me")));

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
