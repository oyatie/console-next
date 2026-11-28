// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";

type S = components["schemas"];
export type Item = S["BenefitCatalogItem"];
export type Create = S["BenefitCatalogCreateRequest"];
type Edit = S["BenefitCatalogUpdateRequest"];
export type Tier = S["BenefitCatalogTier"];
export type Condition = S["BenefitCatalogCondition"];
const catalog = "/api/v1/benefit-catalog/items";
const detail = "/api/v1/benefit-catalog/items/{benefit_id}";
export const catalogReads = [catalog, detail] as const;
export const itemsQuery = (offset: number, limit: number) => get(catalog, { params: { query: { offset, limit } } });
export const itemQuery = (id: string) => get(detail, { params: { path: { benefit_id: id } } });

export type Change = { kind: "create"; body: Create } | { kind: "edit"; id: string; body: Edit }
  | { kind: "tiers"; id: string; body: S["BenefitCatalogReplaceTiersRequest"] }
  | { kind: "conditions"; id: string; body: S["BenefitCatalogReplaceConditionsRequest"] };

export function writeBenefit(change: Change, key: string): Promise<Item> {
  const headers = { "Idempotency-Key": key };
  if (change.kind === "create") return unwrap(api.POST(catalog, { body: change.body, headers }));
  const params = { path: { benefit_id: change.id } };
  if (change.kind === "edit") return unwrap(api.PATCH(detail, { params, body: change.body, headers }));
  if (change.kind === "tiers") return unwrap(api.PUT("/api/v1/benefit-catalog/items/{benefit_id}/tiers", { params, body: change.body, headers }));
  return unwrap(api.PUT("/api/v1/benefit-catalog/items/{benefit_id}/conditions", { params, body: change.body, headers }));
}
