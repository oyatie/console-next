// The route frame: sign-in, passkey set-up, the signed-in app and its small screens. Each feature's
// screens hang off `app` in their own file here (routes compose slices; slices never import routes).
import { PERSONAL_LOCATION_MODULE } from "../reference/onboarding/api";
import { createRootRoute, createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { chunk } from "../lib/chunk-guard";
import { bootScreen, screen } from "../lib/fonts";
import { streamReady } from "../lib/live/session-stream";
import { RootShell } from "./root-shell";
import type { TenantsSearch } from "../features/platform/ui/tenants-page";
import type { AccessRequirement } from "../reference/authz/domain/access";
import type { ModuleKey } from "../reference/onboarding/api";
import { FLOORPLANS, type Floorplan } from "../ui/page/floorplan";
import type { PatternId } from "../ui/patterns/patterns";

export { FLOORPLANS as ROUTE_FLOORPLANS };

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    access?: AccessRequirement | "signed-in";
    preloadUserCapabilities?: boolean;
    floorplan?: Floorplan;
    pattern?: PatternId;
    module?: ModuleKey;
  }
}

/** A non-empty string search param, else absent. */
export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A boolean search param written as `true` or `"true"`, else absent. */
export const flag = (v: unknown) => v === true || v === "true" || undefined;

export { screen };

let loadedGuards: typeof import("../lib/react/session") | undefined;
const guards = () => chunk(import("../lib/react/session")).then(module => (loadedGuards = module));
// Deferring an already-loaded guard loses consecutive keyboard navigations.
const ensureSession: typeof import("../lib/react/session").ensureSession = context => loadedGuards
  ? loadedGuards.ensureSession(context) : guards().then(module => module.ensureSession(context));
export const root = createRootRoute({ shellComponent: RootShell });
export const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  staticData: { pattern: "sign-in" },
  // `enrolled`: a passkey was just registered but the automatic sign-in with it failed (e.g. rate-limited).
  validateSearch: (s: Record<string, unknown>): { enrolled?: boolean; cancelled?: 1; code?: boolean } => ({ enrolled: flag(s.enrolled), code: flag(s.code), cancelled: s.cancelled === 1 || s.cancelled === "1" ? 1 : undefined }),
  beforeLoad: async () => (await guards()).leaveSignInWhenSignedIn(),
  component: lazyRouteComponent(bootScreen(() => import("../auth/Login")), "Login"),
});
const setupPasskey = createRoute({ getParentRoute: () => root, path: "/setup-passkey", staticData: { pattern: "sign-in" }, beforeLoad: async () => (await guards()).ensureEnrolling(), component: lazyRouteComponent(bootScreen(() => import("../auth/SetupPasskey")), "SetupPasskey") });
export const app = createRoute({ getParentRoute: () => root, id: "app", staticData: { access: "signed-in" }, beforeLoad: async context => { await ensureSession(context); await streamReady(); } });

const tenants = createRoute({
  getParentRoute: () => app,
  path: "/platform", staticData: { access: "signed-in", floorplan: "P-01" },
  beforeLoad: ensureSession,
  // The tenant, the search and the status view live in the URL, so a support ticket can link to them.
  validateSearch: (s: Record<string, unknown>): TenantsSearch => ({
    sel: str(s.sel),
    q: str(s.q),
    view: s.view === "suspended" || s.view === "archived" || s.view === "all" ? s.view : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/platform/Tenants")), "Tenants"),
});
// Home with the setup checklist composed in (routes compose slices).
const home = createRoute({ getParentRoute: () => app, path: "/", validateSearch: (s: Record<string, unknown>): { sel?: string } => ({ sel: str(s.sel) }), staticData: { access: "signed-in", floorplan: "P-03", pattern: "worklist" }, component: lazyRouteComponent(screen(() => import("./home-screen")), "HomeScreen") });
const loadAccount = () => import("../features/account/Account");
const loadPrivacy = () => import("../features/account/ui/privacy-page");
const account = createRoute({ getParentRoute: () => app, path: "/account", staticData: { access: "signed-in", floorplan: "P-05", pattern: "phone-hub" }, validateSearch: (s: Record<string, unknown>): { sheet?: "certificates" } => ({ sheet: s.sheet === "certificates" ? "certificates" : undefined }), component: lazyRouteComponent(screen(loadAccount), "Account") });
const accountLocation = createRoute({
  getParentRoute: () => app,
  path: "/account/location",
  staticData: { access: "signed-in", module: PERSONAL_LOCATION_MODULE, floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(loadPrivacy), "LocationConsent"),
});
const privacyIntake = createRoute({ getParentRoute: () => app, path: "/account/privacy/intake/$id", staticData: { access: "signed-in", floorplan: "P-01", pattern: "record" }, component: lazyRouteComponent(screen(loadPrivacy), "PrivacyIntake") });
const privacy = createRoute({
  getParentRoute: () => app,
  path: "/account/privacy",
  staticData: { access: "signed-in", floorplan: "P-01", pattern: "settings" },
  validateSearch: (s: Record<string, unknown>): { view?: "intake" } => ({ view: s.view === "intake" ? "intake" : undefined }),
  component: lazyRouteComponent(screen(loadPrivacy), "PrivacyRequests"),
});

// Test builds keep the gallery for the preview suite; normal production builds drop its route and chunk.
const dev = import.meta.env.DEV || import.meta.env.MODE === "test"
  ? [createRoute({ getParentRoute: () => root, path: "/_gallery", component: lazyRouteComponent(screen(() => import("../gallery/gallery")), "Gallery") })]
  : [];
const reviewSearch = (s: Record<string, unknown>): { state?: "refused" } => ({ state: s.state === "refused" ? "refused" : undefined });
const signInReviewSearch = (s: Record<string, unknown>): { state?: "refused" | "loading" } => ({
  state: s.state === "refused" || s.state === "loading" ? s.state : undefined,
});
// Mock-state builds keep unserved screens testable without publishing their routes.
const reviewStates = import.meta.env.VITE_REVIEW_STATE_ROUTES === "1" ? [
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/worklist", staticData: { access: "signed-in", floorplan: "P-03", pattern: "worklist" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/worklist-review")), "WorklistReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/list-record", staticData: { access: "signed-in", floorplan: "P-01", pattern: "list-record" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/list-record-review")), "ListRecordReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/record", staticData: { access: "signed-in", floorplan: "P-02", pattern: "record" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/record-review")), "RecordReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/document-decision", staticData: { access: "signed-in", floorplan: "P-02", pattern: "document-decision" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/document-decision-review")), "DocumentDecisionReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/month-grid", staticData: { access: "signed-in", floorplan: "P-03", pattern: "month-grid" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/month-grid-review")), "MonthGridReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/register-totals", staticData: { access: "signed-in", floorplan: "P-02", pattern: "register-totals" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/register-totals-review")), "RegisterTotalsReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/form", staticData: { access: "signed-in", floorplan: "P-04", pattern: "form" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/form-review")), "FormReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/wizard", staticData: { access: "signed-in", floorplan: "P-04", pattern: "wizard" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/wizard-review")), "WizardReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/settings", staticData: { access: "signed-in", floorplan: "P-05", pattern: "settings" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/settings-review")), "SettingsReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/canvas", staticData: { access: "signed-in", floorplan: "canvas", pattern: "canvas" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/canvas-review")), "CanvasReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/phone-hub", staticData: { access: "signed-in", floorplan: "P-05", pattern: "phone-hub" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/phone-hub-review")), "PhoneHubReview") }),
  createRoute({ getParentRoute: () => app, path: "/_review/patterns/phone-statement", staticData: { access: "signed-in", floorplan: "P-02", pattern: "phone-statement" }, validateSearch: reviewSearch, component: lazyRouteComponent(screen(() => import("../review/phone-statement-review")), "PhoneStatementReview") }),
] : [];
const reviewSignIn = import.meta.env.VITE_REVIEW_STATE_ROUTES === "1" ? [
  createRoute({ getParentRoute: () => root, path: "/_review/patterns/sign-in", staticData: { pattern: "sign-in" }, validateSearch: signInReviewSearch, component: lazyRouteComponent(bootScreen(() => import("../review/sign-in-review")), "SignInReview") }),
] : [];

export const frame = { signIn: [login, setupPasskey, ...reviewSignIn, ...dev], screens: [tenants, home, account, accountLocation, privacy, privacyIntake, ...reviewStates] };
