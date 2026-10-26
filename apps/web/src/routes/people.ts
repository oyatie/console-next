import { readRequirement } from "./route-reads";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { PeopleSearch } from "../features/people/People";
import type { ExitFilter } from "../features/people/api";
import { accountsSearch, type AccountsSearch } from "../features/people/domain/accounts";
import { app, screen, str } from "./app";

const unplaced = createRoute({ getParentRoute: () => app, path: "/people/unplaced", staticData: { access: readRequirement("/people/unplaced") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/unplaced-page")), "UnplacedPage") });
const bulk = createRoute({ getParentRoute: () => app, path: "/people/bulk", staticData: { access: readRequirement("/people/bulk") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/bulk-page")), "BulkPage") });
const run = createRoute({ getParentRoute: () => app, path: "/people/run", staticData: { access: readRequirement("/people/run") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/register-run-page")), "RegisterRunPage") });
// Appointment notices (spec E5-notice): made from a bulk batch (or named events), then read and printed as a document.
const notices = createRoute({ getParentRoute: () => app, path: "/people/notices", staticData: { access: readRequirement("/people/notices") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/notice-list-page")), "NoticeListPage") });
const noticeNew = createRoute({
  getParentRoute: () => app,
  path: "/people/notices/new", staticData: { access: readRequirement("/people/notices/new") },
  validateSearch: (s: Record<string, unknown>): { batch?: string; events?: string; count?: number } => ({ batch: str(s.batch), events: str(s.events), count: typeof s.count === "number" ? s.count : undefined }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/notice-new-page")), "NoticeNewPage"),
});
const notice = createRoute({ getParentRoute: () => app, path: "/people/notices/$noticeId", staticData: { access: "signed-in" }, component: lazyRouteComponent(screen(() => import("../features/people/ui/notice-page")), "NoticePage") });
const certificates = createRoute({ getParentRoute: () => app, path: "/people/certificates", staticData: { access: readRequirement("/people/certificates") }, validateSearch: (s: Record<string, unknown>): { employee?: string } => ({ employee: str(s.employee) }), component: lazyRouteComponent(screen(() => import("../features/people/ui/certificates-page")), "CertificatesPage") });
const certificate = createRoute({ getParentRoute: () => app, path: "/people/certificates/$certificateId", staticData: { access: "signed-in" }, remountDeps: ({ params }) => params.certificateId, component: lazyRouteComponent(screen(() => import("../features/people/ui/certificate-page")), "CertificatePage") });
const renew = createRoute({ getParentRoute: () => app, path: "/people/renew", staticData: { access: readRequirement("/people/renew") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/renew-page")), "RenewPage") });
const grid = createRoute({ getParentRoute: () => app, path: "/people/grid", staticData: { access: readRequirement("/people/grid") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/grid-page")), "GridPage") });
const CARD_TABS = ["events", "docs", "ledger", "access"] as const;
type CardTab = (typeof CARD_TABS)[number];

// BW-15: the unlock request under review lives in the URL (Home's unlock queue opens it); `unlock` opens one lock's
// unlock (a closed attendance month links to the lock behind its close).
const periodLocks = createRoute({ getParentRoute: () => app, path: "/people/period-locks", staticData: { access: readRequirement("/people/period-locks") }, validateSearch: (s: Record<string, unknown>): { review?: string; unlock?: string } => ({ review: str(s.review), unlock: str(s.unlock) }), component: lazyRouteComponent(screen(() => import("../features/periods/ui/period-lock-page")), "PeriodLockPage") });
const peopleImport = createRoute({ getParentRoute: () => app, path: "/people/import", staticData: { access: readRequirement("/people/import") }, validateSearch: (s: Record<string, unknown>): { mode?: "paste"; run?: string } => ({ mode: s.mode === "paste" ? "paste" : undefined, run: str(s.run) }), component: lazyRouteComponent(screen(() => import("../features/import/ui/import-page")), "ImportPage") });
// The registration sheet opens over the roster (spec E3): a child of /people, drawn in its outlet.
const registerEmployee = createRoute({
  getParentRoute: () => people,
  path: "new", staticData: { access: readRequirement("/people/new") },
  component: lazyRouteComponent(screen(() => import("../features/people/ui/register-route")), "RegisterRoute"),
});
const employee = createRoute({
  getParentRoute: () => app,
  path: "/people/$id", staticData: { access: "signed-in" },
  remountDeps: ({ params }) => params.id,
  // `act` opens an HR action's sheet (a queue on Home links straight to it); the server's allowed events still decide.
  // `back` is the sheet a detour started from (a refusal's "cancel that reservation"): its receipt offers the way back.
  // `tab` is the record's tab (personnel card when absent): action history, documents, change history, access.
  validateSearch: (s: Record<string, unknown>): { act?: string; back?: string; tab?: CardTab } => ({ act: str(s.act), back: str(s.back), tab: CARD_TABS.find((x) => x === s.tab) }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/card-page")), "EmployeeCard"),
});
const REQUEST_LANES = ["all", "me", "role"] as const;
const REQUEST_STATUSES = ["OPEN", "APPLIED", "DECLINED", "WITHDRAWN", "ALL"] as const;
const changeRequests = createRoute({
  getParentRoute: () => app,
  // Named handlers can read their own requests without a directory grant.
  path: "/people/requests", staticData: { access: "signed-in" },
  // BW-17: HR's lane, the status view, the open request and the page live in the URL (Home links to a lane).
  validateSearch: (s: Record<string, unknown>): { lane?: (typeof REQUEST_LANES)[number]; status?: (typeof REQUEST_STATUSES)[number]; sel?: string; page?: number } => ({
    lane: REQUEST_LANES.find((l) => l === s.lane),
    status: REQUEST_STATUSES.find((x) => x === s.status),
    sel: str(s.sel),
    page: typeof s.page === "number" && s.page > 0 ? Math.floor(s.page) : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/requests-page")), "RequestsPage"),
});
const jobTitles = createRoute({ getParentRoute: () => app, path: "/people/job-titles", staticData: { access: readRequirement("/people/job-titles") }, component: lazyRouteComponent(screen(() => import("../features/people/ui/job-titles-page")), "JobTitlesPage") });
const EXIT_FILTERS = ["open", "closed", "REPORTED", "HR_CONFIRMED", "HQ_CONFIRMED", "SETTLEMENT_READY", "APPROVAL_DRAFTED", "SUBMITTED", "REJECTED", "CANCELLED"] as const satisfies readonly ExitFilter[];
const exitCases = createRoute({
  getParentRoute: () => app,
  path: "/people/exits", staticData: { access: readRequirement("/people/exits") },
  // The status filter lives in the URL so Home can link to the open cases.
  validateSearch: (s: Record<string, unknown>): { status?: ExitFilter } => ({ status: EXIT_FILTERS.find((f) => f === s.status) }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/exit-list")), "ExitCaseList"),
});
const exitCase = createRoute({
  getParentRoute: () => app,
  path: "/people/exits/$id", staticData: { access: "signed-in" },
  validateSearch: (s: Record<string, unknown>): { act?: string } => ({ act: str(s.act) }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/exit-page")), "ExitCasePage"),
});
const people = createRoute({
  getParentRoute: () => app,
  path: "/people", staticData: { access: readRequirement("/people") },
  // The search term (a person's name) stays out of the URL and so out of history; only ids, filters and the view go here.
  // The accounts view adds its role chip, inactive toggle, open sheet (`act`) and the person to invite.
  validateSearch: (s: Record<string, unknown>): PeopleSearch & AccountsSearch => ({
    ...accountsSearch(s),
    sel: str(s.sel),
    view: s.view === "accounts" ? "accounts" : undefined,
    unit: str(s.unit),
    status: str(s.status),
    // The list's order (domain/roster.ts parseSort drops what it does not know).
    sort: str(s.sort),
    // Comma-joined attention chips; the roster drops tokens it does not know (domain/roster.ts parseReview).
    review: str(s.review),
    // `bulk=paste` opens the bulk appointment sheet from a paste (pushed: Back closes it).
    bulk: s.bulk === "paste" ? "paste" : undefined,
    // Keep the existing export options; the dated register is also available in /statutory.
    export: s.export === "register" ? "register" : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/people/ui/people-route")), "PeopleRoute"),
});

export const peopleRoutes = [people.addChildren([registerEmployee]), peopleImport, unplaced, bulk, run, renew, notices, noticeNew, notice, certificates, certificate, grid, periodLocks, exitCases, exitCase, changeRequests, jobTitles, employee];
