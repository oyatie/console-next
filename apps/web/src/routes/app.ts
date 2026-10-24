// The route frame: sign-in, passkey set-up, the signed-in app and its small screens. Each feature's
// screens hang off `app` in their own file here (routes compose slices; slices never import routes).
import { createRootRoute, createRoute, lazyRouteComponent, Outlet } from "@tanstack/react-router";
import { catalogText, i18n, loadCatalog } from "@console/i18n";
import { chunk } from "../lib/chunk-guard";
import { glyphs } from "../lib/fonts";
import { ensureEnrolling, ensureSession, leaveSignInWhenSignedIn } from "../lib/react/session";
import type { TenantsSearch } from "../features/platform/ui/tenants-page";

/** A non-empty string search param, else absent. */
export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A boolean search param written as `true` or `"true"`, else absent. */
export const flag = (v: unknown) => v === true || v === "true" || undefined;

/**
 * A lazy screen's import: its route chunk, and the active locale's screen catalog with the font glyphs its text
 * needs (lib/fonts), load together. A chunk a deploy removed reloads the page once (lib/chunk-guard).
 */
export const screen = <M,>(load: () => Promise<M>) => () => {
  const l = i18n.locale;
  return chunk(Promise.all([load(), loadCatalog(l).then(() => glyphs(l, () => catalogText(l)))]).then(([m]) => m));
};

export const root = createRootRoute({ component: Outlet });
const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  // `enrolled`: a passkey was just registered but the automatic sign-in with it failed (e.g. rate-limited).
  validateSearch: (s: Record<string, unknown>): { enrolled?: boolean } => ({ enrolled: flag(s.enrolled) }),
  beforeLoad: leaveSignInWhenSignedIn,
  component: lazyRouteComponent(() => chunk(import("../auth/Login")), "Login"),
});
const setupPasskey = createRoute({ getParentRoute: () => root, path: "/setup-passkey", beforeLoad: ensureEnrolling, component: lazyRouteComponent(() => chunk(import("../auth/SetupPasskey")), "SetupPasskey") });
export const app = createRoute({ getParentRoute: () => root, id: "app", beforeLoad: ensureSession, component: lazyRouteComponent(screen(() => import("../shell/shell")), "Shell") });

const tenants = createRoute({
  getParentRoute: () => app,
  path: "/platform",
  // The tenant, the search and the status view live in the URL, so a support ticket can link to them.
  validateSearch: (s: Record<string, unknown>): TenantsSearch => ({
    sel: str(s.sel),
    q: str(s.q),
    view: s.view === "suspended" || s.view === "archived" || s.view === "all" ? s.view : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/platform/Tenants")), "Tenants"),
});
const supportAccess = createRoute({getParentRoute:()=>app,path:"/audit/support-access",validateSearch:(s: Record<string, unknown>): { review?: string } => ({ review: str(s.review) }),component:lazyRouteComponent(screen(()=>import("../features/support-access/ui/support-access")),"SupportAccess")});
// Home with the setup checklist composed in (routes compose slices).
const home = createRoute({ getParentRoute: () => app, path: "/", component: lazyRouteComponent(screen(() => import("./home-screen")), "HomeScreen") });
const account = createRoute({ getParentRoute: () => app, path: "/account", component: lazyRouteComponent(screen(() => import("../features/account/Account")), "Account") });

// Dev-only component gallery, outside the auth guard; the DEV constant drops it (and its chunk)
// from production builds.
const dev = import.meta.env.DEV
  ? [createRoute({ getParentRoute: () => root, path: "/_gallery", component: lazyRouteComponent(screen(() => import("../gallery/gallery")), "Gallery") })]
  : [];

export const frame = { signIn: [login, setupPasskey, ...dev], screens: [tenants, home, account, supportAccess] };
