import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, Link, RouterProvider } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { I18nProvider } from "react-aria-components";
import { configure, session } from "@console/api";
import { webPlatform } from "@console/api/web";
import { i18n, loadCatalog, t } from "@console/i18n";
import { crashed, loaded, started } from "./lib/chunk-guard";
import { CrashScreen } from "./lib/react/crash-screen";
import { STALE_TIME_MS } from "./lib/freshness";
import { queryDefaults } from "./lib/react/query-defaults";
import { closeLive, openLive } from "./lib/live/live";
import { EmptyState } from "./ui/empty-state";
import { initLocale } from "./shell/locale";
import { IDLE_EXPIRED, watchSession } from "./auth/idle";
import { pauseAutofill } from "./auth/sign-in-id";
import { IdleGuard } from "./auth/IdleGuard";
import { app, frame, root } from "./routes/app";
import { orgRoutes } from "./routes/org";
import { peopleRoutes } from "./routes/people";
import { identifierRoutes } from "./routes/identifiers";
import { entityRoutes } from "./routes/entity";
import { onboardingRoutes } from "./routes/onboarding";
import { accessRoutes } from "./routes/access";
import { orgBulkRoutes } from "./routes/org-bulk";
import { requestRoutes } from "./routes/requests";
import { attendanceRoutes } from "./routes/attendance";
import { companyDomainRoute } from "./routes/company-domain";
import { statutoryRoute } from "./routes/statutory";
import "./app.css";

// Every static import is in: from here a failed chunk is a lazy one (public/chunk-guard.js).
started();
configure(webPlatform);

initLocale();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIME_MS,
      // Decision #27: no refresh loops. Shown reads are re-read when the event stream says they changed (lib/live),
      // not on a timer or reconnect. Refusals are answers, not transient faults (lib/react/query-defaults).
      ...queryDefaults,
    },
  },
});

// Screens are lazy route chunks; the entry keeps only the router, shell and sign-in.
const router = createRouter({
  routeTree: root.addChildren([...frame.signIn, app.addChildren([...frame.screens, ...orgRoutes, ...entityRoutes, ...onboardingRoutes, companyDomainRoute, ...peopleRoutes, ...identifierRoutes, ...accessRoutes, ...orgBulkRoutes, ...requestRoutes, ...attendanceRoutes, statutoryRoute])]),
  defaultPreload: "intent",
  defaultNotFoundComponent: () => (
    <main className="page">
      <EmptyState
        title={t("common.notFound.title")}
        reason={t("common.notFound.reason")}
        actions={<Link to="/" className="btn btn--primary">{t("common.notFound.action")}</Link>}
      />
    </main>
  ),
  // A render error, or a lazy chunk still missing after the one reload (lib/chunk-guard). The button fetches
  // index.html afresh: a plain reload may revalidate a stale cached one that names the same missing chunks.
  defaultErrorComponent: ({ error }) => <CrashScreen error={error} />,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Cached data belongs to one principal: a sign-out or another person's sign-in drops it, menu grants
// included. A session that ends in use keeps screens and drafts for re-auth in place (auth/idle.ts).
watchSession(queryClient, () => {
  if (router.state.location.pathname !== "/login") void router.navigate({ to: "/login" });
});

// The shell's one event stream follows the principal (registered after watchSession, so a new principal's
// cache is already dropped when it opens). Full tenant and platform sessions use their own readers.
// An enrollment session does not stream; a lost session keeps its stream until re-auth decides.
let streaming: string | null = null;
// A sign-out (not a session lost in use), or a reload after the server ended the session for inactivity, pauses the
// sign-in field's autofill in this tab (auth/sign-in-id.ts): nobody is signed back in by the first suggestion.
let signedIn = false;
session.subscribe(() => {
  if (session.lost) return;
  if ((signedIn && !session.token) || session.ended === IDLE_EXPIRED) pauseAutofill();
  signedIn = Boolean(session.token);
  const next = session.token ? (session.claims?.sub ?? null) : null;
  const streams = next && session.stage === "app" ? next : null;
  if (streams === streaming) return;
  streaming = streams;
  if (streams) openLive(queryClient);
  else closeLive();
});

/** Re-renders the app when the locale changes; server data is refetched in the new language. */
function Root() {
  const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale);
  return (
    <QueryClientProvider client={queryClient}>
      {/* React Aria's own strings (tree chevrons, dismiss buttons, combobox announcements) follow the app locale. */}
      <I18nProvider locale={locale === "ko" ? "ko-KR" : "en-US"}>
        <RouterProvider router={router} key={locale} />
        <IdleGuard />
      </I18nProvider>
    </QueryClientProvider>
  );
}
i18n.subscribe(() => void queryClient.invalidateQueries());

// The first route resolved and the screen catalog is in: this build loads, so a later deploy may reload once again.
const resolved = new Promise<void>((done) => {
  const off = router.subscribe("onResolved", () => {
    off();
    done();
  });
});
void Promise.all([resolved, loadCatalog()]).then(loaded, () => undefined);

// An error no boundary caught unmounts the whole tree (e.g. the re-auth dialog's chunk, beside the router): the
// static error screen instead of a blank page.
createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    reportError(error);
    crashed();
  },
}).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
