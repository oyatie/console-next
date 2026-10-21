// The workplace close job (UX-R2 ENDS): what a close must plan for, the plan itself and its withdrawal.
import { api, ApiError, assertPasskey, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get, read, type PathPrefix } from "../../lib/query";
import type { ClosePlanRequest } from "./domain/plan";

export type { CloseJob, ClosePerson, ClosePlanRequest, ClosePlanView, CloseUnit } from "./domain/plan";

/** Everyone and every department still at the workplace, their open exit cases, and the open (or last) close job. */
export const closePlanQuery = (workplaceId: string) => get("/api/v1/workplaces/{workplaceId}/close-plan", { params: { path: { workplaceId } } });

/** A close moves people, department and the workplace itself: every read that shows them. */
export const CLOSE_READS: PathPrefix[] = ["/api/v1/workplaces", "/api/v1/org-structure", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/employees", "/api/v1/hr", "/api/v1/onboarding"];

const once = (key: string) => ({ "Idempotency-Key": key });

/** Plans the close: applied now when the closing date is today (and the plan is small enough), else on its day. */
export const planClose = (key: string, workplaceId: string, body: ClosePlanRequest) =>
  unwrap(api.POST("/api/v1/workplaces/{workplaceId}/close-plan", { params: { path: { workplaceId }, header: once(key) }, body }));

/** Withdraws the planned close; exit cases it opened stay open. */
export const cancelClose = (key: string, workplaceId: string) =>
  unwrap(api.POST("/api/v1/workplaces/{workplaceId}/close-plan/cancel", { params: { path: { workplaceId }, header: once(key) } }));

/** The lines a refused plan names (a person or a department, and why), none for any other failure. */
export const refusalsOf = (e: unknown): { employee_id?: string; org_unit_id?: string; code: string }[] => (e instanceof ApiError ? e.refusals : []);

/** A legal entity's end options: its open exit cases among them (company-52). */
export const entityEndQuery = (entityId: string) => get("/api/v1/legal-entities/{entityId}/end-options", { params: { path: { entityId } } });
/** Who is still employed at the legal entity (not exited): the people its close must see leave first. */
export const entityPeopleQuery = (entityId: string) =>
  get("/api/v1/employees", { params: { query: { legal_entity_id: entityId, status: ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"], limit: 1000 } } });

/** One exit report per person (the record's own report, same server checks), each with its own intent key. */
export async function reportCloseExits(people: readonly { id: string; name: string }[], body: { date: string; reason: string; note: string }, keys: Map<string, string>) {
  const out: { id: string; name: string; code?: string }[] = [];
  for (const p of people) {
    const key = keys.get(p.id) ?? crypto.randomUUID();
    keys.set(p.id, key);
    const { error, response } = await api.POST("/api/v1/hr/exit-cases", {
      params: { header: once(key) },
      body: { employee_id: p.id, effective_exit_date: body.date, site_manager_note: body.note, exit_reason_code: body.reason },
    });
    out.push({ id: p.id, name: p.name, code: response.ok ? undefined : (ApiError.fromBody(response, error).code) });
  }
  return out;
}

/**
 * The live grants a close ends with it (access-model §5.2, UX-R3 company-13/14), held as `{ items }` under the key the
 * access and org screens use, so one cache entry keeps one shape.
 */
export const closeGrantsQuery = { ...read("/api/v1/access/grants", async () => ({ items: await unwrap(api.GET("/api/v1/access/grants")) })), refetchOnMount: "always" as const };
/** Ends grants as one batch: server preview, then apply with the actor's passkey; "refused" writes nothing. */
export async function endGrants(body: components["schemas"]["AccessGrantBatchRequest"]) {
  const p = await unwrap(api.POST("/api/v1/access/grants/preview", { body }));
  if (p.refused) return "refused" as const;
  await unwrap(api.POST("/api/v1/access/grants/apply", { body: { receipt_id: p.receipt_id, step_up: await assertPasskey() } }));
  return "done" as const;
}
