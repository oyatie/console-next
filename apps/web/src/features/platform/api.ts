// Vendor tier: tenant organizations, their usage rollup, and the lifecycle commands on them.
import { ApiError, api, assertPasskey, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { COMMAND_NOT_APPLIED } from "../../lib/react/command";
import { LANDED, landed } from "../../lib/react/landed";
import { get } from "../../lib/query";

export type Org = components["schemas"]["PlatformOrg"];
export type OrgStatus = Org["status"];
export type Health = components["schemas"]["PlatformTenantHealth"];
/** A first-admin code to hand over: from onboarding or a reissue. */
export type Issued = { org: string; otp: string; expiresAt: string };
/** A recorded command's receipt, shown once at the top of the page. */
export type Recorded = { message: string; meta?: string };

/** Every tenant, unpaged (the vendor's own `platform` row included; screens leave it out). */
export const tenantsQuery = get("/api/platform/orgs");
/** Per-tenant usage counts. Optional to every screen: the list still works when it fails. */
export const opsQuery = get("/api/platform/ops");

export const onboard = (name: string, slug: string) => unwrap(api.POST("/api/platform/orgs", { body: { name, slug } }));

/** Minting a sign-in code asks for a fresh assertion of the vendor's own passkey (step-up). */
export const reissueCode = async (org: Org): Promise<Issued> => {
  const r = await unwrap(api.POST("/api/platform/orgs/{id}/admin-otp", { params: { path: { id: org.id } }, body: { step_up: await assertPasskey() } }));
  return { org: org.name, otp: r.otp, expiresAt: r.admin_otp_expires_at };
};

export const setStatus = (id: string, status: OrgStatus) => unwrap(api.PATCH("/api/platform/orgs/{id}", { params: { path: { id } }, body: { status } }));

/** Guarded removal of an empty onboarding shell, or (`force`) the archived tenant with all its data, after a step-up. */
export const removeTenant = async (id: string, force: boolean) => {
  const body = force ? { step_up: await assertPasskey() } : undefined;
  await unwrap(api.DELETE("/api/platform/orgs/{id}", { params: { path: { id }, query: force ? { delete_data: true } : undefined }, body }));
};

/** A fresh read of every tenant, for `landed` (lib/react/landed) when a command's response is lost or refused on a retry. */
export const rereadTenants = () => api.GET("/api/platform/orgs");

/** A 409 refusal with this machine code (`admin_already_enrolled`, `tenant_has_data`, …), or any 409 without `code`. */
export const conflict = (error: unknown, code?: string) => error instanceof ApiError && error.status === 409 && (code === undefined || error.code === code);

/** Onboarding's refusal of the slug it was sent (409 `slug_taken`, 422 `slug_invalid`, both on `errors[].field` slug). */
export const slugRefused = (error: unknown) =>
  error instanceof ApiError && (error.status === 409 || error.errors.some((f) => f.field === "slug")) ? error : undefined;

export const domainQuery = (slug: string) => get("/api/platform/company-domain", { params: { query: { slug } } });
const changeDomain = async (org: Org, slug: string, key: string) => unwrap(api.PATCH("/api/platform/orgs/{id}", {
  params: { path: { id: org.id }, header: { "Idempotency-Key": key } }, body: { slug, step_up: await assertPasskey() },
}));

/** Parse a tenant-supplied website or email locally; this never fetches the address. */
export function websiteHost(raw: string): string | null {
  try {
    const text = raw.trim();
    if (text.includes("@") && !text.includes("://")) {
      const parts = text.split("@");
      return parts.length === 2 && parts[0] && parts[1] && !/[\s/?#]/.test(text) ? new URL(`https://${parts[1]}`).hostname : null;
    }
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.hostname : null;
  } catch { return null; } // Invalid optional references never fill a company domain.
}

/** A lost domain-change answer is resolved by the UUID and desired value, never repeated blindly. */
export const changeDomainSafely = async (org: Org, slug: string, key: string) => {
  let fresh: Org | undefined;
  const result = await landed(() => changeDomain(org, slug, key), rereadTenants, (all) => (fresh = all.find((o) => o.id === org.id))?.slug === slug);
  return result === LANDED ? fresh! : result;
};
export const verifyDomainChange = async (org: Org, slug: string) => {
  const fresh = (await unwrap(rereadTenants())).find((o) => o.id === org.id);
  if (fresh?.slug !== slug) return COMMAND_NOT_APPLIED;
  return fresh;
};
