// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError, api, unwrap } from "@console/api";
import { COMMAND_NOT_APPLIED } from "../../lib/react/command";
import { get } from "../../lib/query";

export { ApiError };

type RequestDomainInput =
  | string
  | {
      slug: string;
      expectedPendingDomain?: string | null;
    };

export const ownDomainRequest = get("/api/v1/tenant/company-domain/request");

export const requestDomain = (input: RequestDomainInput, key: string) => {
  const slug = typeof input === "string" ? input : input.slug;
  const hasExpected = typeof input !== "string" && input.expectedPendingDomain !== undefined;
  return unwrap(
    api.POST("/api/v1/tenant/company-domain/request", {
      params: { header: { "Idempotency-Key": key } },
      body: hasExpected
        ? { slug, expected_pending_domain: input.expectedPendingDomain ?? null }
        : { slug },
    }),
  );
};

export const cancelDomainRequest = () => unwrap(api.DELETE("/api/v1/tenant/company-domain/request"));

/** Recheck an uncertain submission without repeating it. */
export const verifyDomainRequest = async (input: RequestDomainInput) => {
  const slug = typeof input === "string" ? input : input.slug;
  const state = await ownDomainRequest.queryFn();
  if (state.pending_domain !== slug) return COMMAND_NOT_APPLIED;
  return state;
};
