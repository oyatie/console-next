export { ApiError } from "@console/api";
import type { components } from "@console/api";
import { get } from "../../lib/query";
export type Outcome = components["schemas"]["CommandOutcome"];
export const outcomeQuery = (key: string) => get("/api/v1/requests/{key}", {params:{path:{key}}});
export const recordHref = (kind: string, id: string): string | undefined => {
  const value = encodeURIComponent(id);
  switch (kind) {
    case "employee": return `/people/${value}`;
    case "statutory": return `/statutory?event=${value}`;
    case "legal_entity": return `/org/entities/${value}?tab=history#history`;
    case "workplace": return `/org?sel=${value}`;
    case "org_unit": return `/org?sel=${value}`;
    case "tenant": return "/";
    case "access_grant_receipts": case "access_grant": return "/access";
    default: return undefined;
  }
};
