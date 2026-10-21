import { api, unwrap } from "@console/api";
import { COMMAND_NOT_APPLIED } from "../../lib/react/command";
import { get } from "../../lib/query";
export const ownDomainRequest = get("/api/v1/tenant/company-domain/request");
export const requestDomain = (slug: string, key: string) => unwrap(api.POST("/api/v1/tenant/company-domain/request", { params: { header: { "Idempotency-Key": key } }, body: { slug } }));

/** Recheck an uncertain submission without repeating it. */
export const verifyDomainRequest = async (slug: string) => {
  const state = await ownDomainRequest.queryFn();
  if (state.pending_domain !== slug) return COMMAND_NOT_APPLIED;
  return state;
};
