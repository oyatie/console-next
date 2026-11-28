// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";

export type MyDispatchOffer = components["schemas"]["MyDispatchOffer"];
export type DispatchResponseKind = components["schemas"]["DispatchResponseKind"];

export const myDispatchOffersQuery = get("/api/v1/me/dispatch-offers");

export function respondDispatchOffer(dispatchId: string, response: DispatchResponseKind) {
  return unwrap(
    api.POST("/api/v1/p1-dispatches/{dispatchId}/responses", {
      params: { path: { dispatchId } },
      body: { response },
    }),
  );
}
