import { ApiError, api, unwrap, type components } from "@console/api";
import { cursorPages, get } from "../../lib/query";
import { addDays, isDate, nextMonday } from "../../ui/date/days";
export { session } from "@console/api";

type S = components["schemas"];
export type Pattern = S["AttendancePattern"];
export type PatternInput = S["AttendancePatternInput"];
export type ScheduleTree = S["AttendanceScheduleTree"];
export type Calendar = S["AttendanceScheduleCalendar"];
export type ScheduleDay = S["AttendanceScheduleDay"];
export type StackEntry = S["AttendanceStackEntry"];
export type Layer = S["AttendanceScheduleLayer"];
export type LayerSummary = S["AttendanceLayerSummary"];
export type AssignInput = S["AttendanceScheduleAssignInput"];
export type AssignPreview = S["AttendanceSchedulePreview"];
export type Crew = S["AttendanceCrew"];
export type HolidayYear = S["AttendanceHolidayYear"];
export type HolidayInput = S["AttendanceHolidayInput"];
export type HolidayPreview = S["AttendanceHolidayPreview"];
export type ContractualHoliday = S["AttendanceContractualHoliday"];
export type ScopeKind = S["AttendanceScopeKind"];

const idem = (key: string) => ({ header: { "Idempotency-Key": key } });

// Reads. Every write under /api/v1/attendance re-reads them (commands invalidate the prefix; the live topic
// `attendance_schedule` does the same for another person's writes).
export const patternsQuery = (includeRetired = false) => get("/api/v1/attendance/patterns", { params: { query: { include_retired: includeRetired || undefined } } });
export const treeQuery = (date?: string) => get("/api/v1/attendance/schedule/tree", { params: { query: { date } } });
export const calendarQuery = (scope_kind: ScopeKind, scope_id: string, month: string) =>
  get("/api/v1/attendance/schedule/calendar", { params: { query: { scope_kind, scope_id, month } } });
export const layersQuery = (scope_kind: ScopeKind, scope_id: string) => get("/api/v1/attendance/schedule/layers", { params: { query: { scope_kind, scope_id } } });
export const crewsQuery = (workplace_id?: string, date?: string) => get("/api/v1/attendance/crews", { params: { query: { workplace_id, date } } });
/** People whose name or employee number matches (a few), for the person pickers. */
export const peopleQuery = (search: string) => get("/api/v1/employees", { params: { query: { search, limit: 8 } } });
export const holidaysQuery = (year: number) => get("/api/v1/attendance/holidays", { params: { query: { year } } });

/** OPEN exceptions use the endpoint's offset contract, not the month grid's cursor contract. */
export const exceptionsQuery = (month: string, branch_id?: string) => ({
  ...get("/api/v1/attendance/exceptions", { params: { query: { month, branch_id, status: "OPEN" } } }),
  queryFn: ({ pageParam }: { pageParam: number }) => get("/api/v1/attendance/exceptions", { params: { query: { month, branch_id, status: "OPEN", offset: pageParam } } }).queryFn(),
  initialPageParam: 0,
  getNextPageParam: (page: S["AttendanceExceptionPage"]) => page.items.length > 0 && page.offset + page.items.length < page.total ? page.offset + page.items.length : undefined,
});
export const closesQuery = (month: string, branch_id?: string) => get("/api/v1/attendance/closes", { params: { query: { month, branch_id } } });
export const week52Query = (date: string, branch_id?: string) => get("/api/v1/attendance/week52", { params: { query: { week_start: isDate(date) ? addDays(nextMonday(date), -7) : date, branch_id } } });
// NEEDS-BACKEND: week52 must report these ledger totals; missing values stay unknown, never inferred from projections.
export type Week52Row = S["AttendanceWeek52Row"] & { recognized_hours?: number; overtime_hours?: number };

// Previews write nothing: they answer what a command would do, and the server re-checks it at commit.
export const previewAssign = (body: AssignInput) => unwrap(api.POST("/api/v1/attendance/schedule/layers/preview", { body }));
export const previewHoliday = (body: HolidayInput) => unwrap(api.POST("/api/v1/attendance/holidays/preview", { body }));

// Commands, one Idempotency-Key per intent (lib/react/command).
export const createPattern = (body: PatternInput, key: string) => unwrap(api.POST("/api/v1/attendance/patterns", { params: idem(key), body }));
export const retirePattern = (pattern_id: string) => unwrap(api.POST("/api/v1/attendance/patterns/{pattern_id}/retire", { params: { path: { pattern_id } } }));
export const assignSchedule = (body: AssignInput, key: string) => unwrap(api.POST("/api/v1/attendance/schedule/layers", { params: idem(key), body }));
export const cancelLayer = (layer_id: string, reason: string) =>
  unwrap(api.POST("/api/v1/attendance/schedule/layers/{layer_id}/cancel", { params: { path: { layer_id } }, body: { reason } }));
export const createCrew = (body: S["AttendanceCrewInput"], key: string) => unwrap(api.POST("/api/v1/attendance/crews", { params: idem(key), body }));
export const placeCrewMembers = (crew_id: string, body: S["AttendanceCrewMembersInput"], key: string) =>
  unwrap(api.POST("/api/v1/attendance/crews/{crew_id}/members", { params: { path: { crew_id }, ...idem(key) }, body }));
export const createHoliday = (body: HolidayInput, key: string) => unwrap(api.POST("/api/v1/attendance/holidays", { params: idem(key), body }));
export const retireHoliday = (holiday_id: string, from_year: number) =>
  unwrap(api.POST("/api/v1/attendance/holidays/{holiday_id}/retire", { params: { path: { holiday_id } }, body: { from_year } }));

/** The refusal code a command or preview failed with (views may not import ApiError). */
export const refusalCode = (e: unknown) => (e instanceof ApiError ? e.code : undefined);
/** True for a failed request the server answered with `status`. */
export const failedWith = (e: unknown, status: number) => e instanceof ApiError && e.status === status;

// --- records (S2): the day board, the month grid, one person's month, and the save path.
export type DayBoard = S["AttendanceDayBoard"];
export type BoardRow = S["AttendanceBoardRow"];
export type Day = S["AttendanceDay"];
export type Entry = S["AttendanceEntry"];
export type Mark = S["AttendanceMark"];
export type GridRow = S["AttendanceGridRow"];
export type CellInput = S["AttendanceCellInput"];
export type Evidence = S["AttendanceEvidence"];
type SaveInput = S["AttendanceSaveInput"];
export type SaveReceipt = S["AttendanceSaveReceipt"];
export type Conflict = S["AttendanceConflict"];
type CellPreview = S["AttendanceCellPreview"];


// Reads. A save, undo, correction or void anywhere re-reads them (the prefix is invalidated; the live topic
// `attendance_day` does the same for another HR worker's writes).
export const dayBoardQuery = (date: string, workplace_id?: string, unit_id?: string, issues_only?: boolean, no_schedule_only?: boolean, rows?: "all") => {
  const query = { date, workplace_id, unit_id, issues_only: issues_only || undefined, no_schedule_only: no_schedule_only || undefined, rows };
  const board = get("/api/v1/attendance/days", { params: { query } });
  return { ...board, queryFn: async () => {
    try { return await board.queryFn(); }
    catch (error) {
      // N-1 servers reject unknown query fields; retry once with their existing request shape.
      if (!rows || !(error instanceof ApiError) || error.status !== 400 || error.code !== "invalid_query") throw error;
      return get("/api/v1/attendance/days", { params: { query: { ...query, rows: undefined } } }).queryFn();
    }
  } };
};
/** The month grid, 100 people a page by keyset (useInfiniteQuery). */
export const monthGridPages = (month: string, workplace_id?: string, unit_id?: string) => cursorPages("/api/v1/attendance/month", { month, workplace_id, unit_id, limit: 100 });
export const personMonthQuery = (employee_id: string, month: string) => get("/api/v1/attendance/people/{employee_id}/month", { params: { path: { employee_id }, query: { month } } });

// The preview writes nothing; it answers what the save would do, and the save re-checks every cell.
export const previewEntries = (cells: CellInput[]) => unwrap(api.POST("/api/v1/attendance/entries/preview", { body: { cells } }));

export const saveEntries = (body: SaveInput, key: string) => unwrap(api.POST("/api/v1/attendance/entries", { params: idem(key), body }));
export const undoBatch = (batch_id: string, reason: string) => unwrap(api.POST("/api/v1/attendance/batches/{batch_id}/undo", { params: { path: { batch_id } }, body: { reason } }));
export const correctEntry = (entry_id: string, body: S["AttendanceCorrectInput"], key: string) =>
  unwrap(api.POST("/api/v1/attendance/entries/{entry_id}/correct", { params: { path: { entry_id }, ...idem(key) }, body }));
export const voidEntry = (entry_id: string, body: S["AttendanceVoidInput"], key: string) =>
  unwrap(api.POST("/api/v1/attendance/entries/{entry_id}/void", { params: { path: { entry_id }, ...idem(key) }, body }));

/** The conflicts of a 409 entry_conflict (error.details.conflicts), or none. */
export const conflictsOf = (e: unknown): Conflict[] =>
  e instanceof ApiError && e.code === "entry_conflict" ? ((e.details.conflicts as Conflict[] | undefined) ?? []) : [];
/** The refused cells of a 422 cells_refused (error.details.refused), or none. */
export const refusedOf = (e: unknown): CellPreview[] =>
  e instanceof ApiError && e.code === "cells_refused" ? ((e.details.refused as CellPreview[] | undefined) ?? []) : [];
