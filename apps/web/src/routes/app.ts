// The route frame: sign-in, passkey set-up, the signed-in app and its small screens. Each feature's
// screens hang off `app` in their own file here (routes compose slices; slices never import routes).
import { createRootRoute, createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { chunk } from "../lib/chunk-guard";
import { screen } from "../lib/fonts";
import { ensureEnrolling, ensureSession, leaveSignInWhenSignedIn } from "../lib/react/session";
import { RouteFrame } from "../lib/react/route-ready";
import type { TenantsSearch } from "../features/platform/ui/tenants-page";
import type { AccessRequirement } from "../reference/authz/domain/access";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    access?: AccessRequirement | "signed-in";
  }
}

/** A non-empty string search param, else absent. */
export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A boolean search param written as `true` or `"true"`, else absent. */
export const flag = (v: unknown) => v === true || v === "true" || undefined;

export { screen };

export const root = createRootRoute({ component: RouteFrame });
const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  // `enrolled`: a passkey was just registered but the automatic sign-in with it failed (e.g. rate-limited).
  validateSearch: (s: Record<string, unknown>): { enrolled?: boolean; cancelled?: 1 } => ({ enrolled: flag(s.enrolled), cancelled: s.cancelled === 1 || s.cancelled === "1" ? 1 : undefined }),
  beforeLoad: leaveSignInWhenSignedIn,
  component: lazyRouteComponent(() => chunk(import("../auth/Login")), "Login"),
});
const setupPasskey = createRoute({ getParentRoute: () => root, path: "/setup-passkey", beforeLoad: ensureEnrolling, component: lazyRouteComponent(() => chunk(import("../auth/SetupPasskey")), "SetupPasskey") });
export const app = createRoute({ getParentRoute: () => root, id: "app", staticData: { access: "signed-in" }, beforeLoad: ensureSession, component: lazyRouteComponent(screen(() => import("../shell/shell")), "Shell") });

const tenants = createRoute({
  getParentRoute: () => app,
  path: "/platform", staticData: { access: "signed-in" },
  beforeLoad: ensureSession,
  // The tenant, the search and the status view live in the URL, so a support ticket can link to them.
  validateSearch: (s: Record<string, unknown>): TenantsSearch => ({
    sel: str(s.sel),
    q: str(s.q),
    view: s.view === "suspended" || s.view === "archived" || s.view === "all" ? s.view : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/platform/Tenants")), "Tenants"),
});
const supportAccess = createRoute({getParentRoute:()=>app,path:"/audit/support-access", staticData: { access: "signed-in" },validateSearch:(s: Record<string, unknown>): { review?: string } => ({ review: str(s.review) }),component:lazyRouteComponent(screen(()=>import("../features/support-access/ui/support-access")),"SupportAccess")});
// Home with the setup checklist composed in (routes compose slices).
const home = createRoute({ getParentRoute: () => app, path: "/", staticData: { access: "signed-in" }, component: lazyRouteComponent(screen(() => import("./home-screen")), "HomeScreen") });
const account = createRoute({ getParentRoute: () => app, path: "/account", staticData: { access: "signed-in" }, component: lazyRouteComponent(screen(() => import("../features/account/Account")), "Account") });

// Dev-only component gallery, outside the auth guard; the DEV constant drops it (and its chunk)
// from production builds.
const dev = import.meta.env.DEV
  ? [createRoute({ getParentRoute: () => root, path: "/_gallery", component: lazyRouteComponent(screen(() => import("../gallery/gallery")), "Gallery") })]
  : [];

export const frame = { signIn: [login, setupPasskey, ...dev], screens: [tenants, home, account, supportAccess] };
