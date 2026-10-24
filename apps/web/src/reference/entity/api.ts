// Legal entities and their workplaces as other slices read them (registration, import, the employee record),
// and the setup checklist (whose phase says whether setup-only actions apply).
import { api, unwrap } from "@console/api";
import type { AllPaths } from "@console/api/pending";
import { get } from "../../lib/query";

/**
 * One intent saved in several writes: each write gets its own key, derived from the intent's, so a retry after a
 * lost response replays every step instead of reusing one key for different requests (409 idempotency_key_reused).
 */
export const stepKey = (key: string, step: number) => `${key.slice(0, -2)}${step.toString(16).padStart(2, "0")}`;

export type AsOf = { as_of?: string; known_at?: string };
export const entitiesAt = (query: AsOf) => query.as_of || query.known_at ? get("/api/v1/legal-entities", { params: { query } }) : entitiesRef;
export const orgStructureAt = (query: AsOf) => query.as_of || query.known_at ? get("/api/v1/org-structure", { params: { query } }) : orgStructureRef;

/** Every entity with its registrations and workplaces embedded. */
export const entitiesRef = get("/api/v1/legal-entities");
/** Tenant-wide workplace read, using the same scoped, dated record projection. */
export const workplacesRef = get("/api/v1/workplaces");
export const assignmentsRef = (employeeId: string) => get("/api/v1/employment-assignments", { params: { query: { employee_id: employeeId } } });
export const checklistRef = get("/api/v1/onboarding/checklist");
/** The workplace kind list: platform defaults, then the tenant's own. */
export const kindsRef = get("/api/v1/workplace-kinds");
/** The composed tree entity › workplace › department › team (which workplace each unit sits at). */
export const orgStructureRef = get("/api/v1/org-structure");
/** Binds an employee to a legal entity and workplace from a date; a change of entity is refused (that is a group transfer). */
export const bindAssignment = (key: string, body: AllPaths["/api/v1/employment-assignments"]["post"]["requestBody"]["content"]["application/json"]) =>
  unwrap(api.POST("/api/v1/employment-assignments", { params: { header: { "Idempotency-Key": key } }, body }));
/** Road-name address search through the server (juso.go.kr; the key stays on the server). */
export const addressSearchRef = (q: string) => get("/api/v1/ref/address-search", { params: { query: { q } } });
