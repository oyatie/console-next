// The one topic → reads map (decision #27): a `change` frame names a topic (`type`) and an id, and this map says
// which reads it can make stale. Features add nothing: a screen's queries are derived from API paths (lib/query.ts),
// so a path listed here covers every screen that reads it. Events are hints; a stale read costs one GET.
//
// `detail`: the collection whose `${detail}/{param}…` reads belong to one record, matched by the frame's id (a
// coalesced frame, `id: null`, matches them all). `paths`: every path prefix the topic can change, lists included.

export type Topic = { detail?: string; paths: readonly string[] };
export type Match = (path: string, params: unknown) => boolean;

const EMPLOYEE_READS = ["/api/v1/employees", "/api/v1/directory", "/api/v1/employment-assignments", "/api/v1/hr/exit-cases", "/api/v1/change-sets", "/api/v1/statutory", "/api/v1/me/action-inbox"];
// Attendance lists entities, workplaces and units in the chart's order: its scope tree and the day board's groups.
const ATTENDANCE_ORG_READS = ["/api/v1/attendance/schedule/tree", "/api/v1/attendance/days"];
const STRUCTURE_READS = ["/api/v1/org-units", "/api/v1/org-structure", "/api/v1/branches", "/api/v1/workplaces", "/api/v1/onboarding", ...ATTENDANCE_ORG_READS];
// A person-day's reads: the grid, the day board and the person cards.
const ATTENDANCE_DAY_READS = ["/api/v1/attendance/month", "/api/v1/attendance/days", "/api/v1/attendance/people"];
const ENTITY_READS = ["/api/v1/org-structure", "/api/v1/legal-entities", "/api/v1/business-registrations", "/api/v1/entity-documents", "/api/v1/workplaces", "/api/v1/onboarding", "/api/v1/me/action-inbox"];

// Keys are the `change` types the hub emits (the BE-RT event contract, "Topics"): a subscriber gets a type only when it
// passes that resource's REST read check, and never an unknown one.
export const TOPICS: Readonly<Record<string, Topic>> = {
  // Go-live, setup steps, terms and renames change what every screen offers.
  ops_recovery: { paths: ["/api/platform/orgs", "/api/v1/tenant/ops-recovery"] },
  inbox: { paths: ["/api/v1/me/action-inbox"] },
  command_outcome: { paths: ["/api/v1/requests"] },
  tenant: { paths: ["/api/v1"] },
  legal_entity: { detail: "/api/v1/legal-entities", paths: [...ENTITY_READS, "/api/v1/employment-assignments", ...ATTENDANCE_ORG_READS] },
  business_registration: { detail: "/api/v1/business-registrations", paths: ENTITY_READS },
  workplace: { detail: "/api/v1/workplaces", paths: [...ENTITY_READS, ...STRUCTURE_READS] },
  org_unit: { detail: "/api/v1/org-units", paths: [...STRUCTURE_READS, ...EMPLOYEE_READS] },
  org_change: { detail: "/api/v1/org-changes", paths: ["/api/v1/org-changes", "/api/v1/legal-entities", "/api/v1/me/action-inbox", ...STRUCTURE_READS] },
  entity_setup_batch: { paths: [...ENTITY_READS, ...STRUCTURE_READS] },
  employee: { detail: "/api/v1/employees", paths: ["/api/v1/org-structure", "/api/v1/legal-entities", ...EMPLOYEE_READS, "/api/v1/org-units", "/api/v1/onboarding", "/api/v1/workplaces", "/api/v1/employee-import-runs"] },
  exit_case: { detail: "/api/v1/hr/exit-cases", paths: [...EMPLOYEE_READS, "/api/v1/org-structure", "/api/v1/legal-entities", "/api/v1/workplaces", "/api/v1/employee-import-runs"] },
  change_request: { paths: ["/api/v1/change-requests", ...EMPLOYEE_READS, "/api/v1/employee-import-runs"] },
  import_run: { paths: [...EMPLOYEE_READS, "/api/v1/employee-import-runs", "/api/v1/org-units", "/api/v1/onboarding"] },
  user: { detail: "/api/v1/users", paths: ["/api/v1/users", "/api/v1/directory", "/api/v1/access", "/api/v1/onboarding", "/api/v1/me/action-inbox"] },
  // A role or its assignment changes who may do what, this user's own grants included.
  role: { paths: ["/api/v1/policy", "/api/v1/access", "/api/v1/me/authz", "/api/v1/users", "/api/v1/directory", "/api/v1/onboarding", "/api/v1/me/action-inbox"] },
  // A lock, its unlock request or the second person's decision: the lock page, Home's unlock queue, and whether a closed
  // attendance month takes writes (its unlock reopens it, its re-lock closes it).
  period_lock: { paths: ["/api/v1/period-locks", "/api/v1/me/action-inbox", ...ATTENDANCE_DAY_READS] },
  // work schedule (patterns, layers, crew, company holiday): one coalesced topic; every attendance read may show a schedule.
  attendance_schedule: { paths: ["/api/v1/attendance"] },
  // A save, batch undo, correction or void of a person-day: the grid, the day board and the person cards re-read.
  attendance_day: { paths: ATTENDANCE_DAY_READS },
};

const under = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + "/");
const pathValues = (params: unknown) => Object.values((params as { path?: Record<string, unknown> } | null)?.path ?? {});

/** Every read: an unmapped topic (or `me`, a changed grant) re-reads what is shown rather than leave it stale. */
export const ALL: Match = () => true;

/** The reads one `change` frame can make stale. */
export function matchChange(type: string, id: string | null): Match {
  const topic = TOPICS[type];
  if (!topic) return ALL;
  return (path, params) => {
    if (!topic.paths.some((p) => under(p, path))) return false;
    if (id === null || !topic.detail || !path.startsWith(topic.detail + "/{")) return true;
    return pathValues(params).includes(id);
  };
}

/** The record-detail reads of one `change` frame (a screen showing that record), or none for a list-only topic. */
export function matchRecord(type: string, id: string | null): Match | null {
  const detail = TOPICS[type]?.detail;
  if (!detail || id === null) return null;
  return (path, params) => path.startsWith(detail + "/{") && pathValues(params).includes(id);
}
