import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, Link, RouterProvider, useRouterState } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { I18nProvider } from "react-aria-components";
import { ApiError, configure, session } from "@console/api";
import { webPlatform } from "@console/api/web";
import { i18n, loadCatalog, t } from "@console/i18n";
import { chunk, crashed, loaded, started } from "./lib/chunk-guard";
import { CrashScreen } from "./lib/react/crash-screen";
import { STALE_TIME_MS } from "./lib/freshness";
import { queryDefaults } from "./lib/react/query-defaults";
import { sessionStream } from "./lib/live/session-stream";
import { EmptyState } from "./ui/empty-state";
import { ReadSkeleton } from "./ui/skeleton/skeleton";
import { initLocale } from "./shell/locale";
import { IDLE_EXPIRED, watchSession } from "./auth/idle";
import { pauseAutofill } from "./auth/sign-in-id";
import { login } from "./routes/app";
import { routeTree } from "./routes/tree";
import "./app.css";
import { prepareFonts } from "./lib/fonts";

// Every static import is in: from here a failed chunk is a lazy one (public/chunk-guard.js).
started();
configure(webPlatform);

initLocale();

// Session warning UI loads beside the router without adding to the entry bundle.
const IdleGuard = lazy(() => chunk(import("./auth/IdleGuard")).then((m) => ({ default: m.IdleGuard })));

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
  routeTree: routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Paint resolved parents while a screen chunk loads, retaining the shell and its session observers.
  defaultPendingComponent: ReadSkeleton,
  defaultPendingMs: 0,
  defaultPendingMinMs: 0,
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

const mainPositions = new Map<string, number>();
let stopMainRestore: () => void = () => undefined;
function restoreMain(key: string, top: number) {
  stopMainRestore();
  let main: HTMLElement | null = null;
  const resize = new ResizeObserver(() => apply());
  const mutation = new MutationObserver(() => { observe(); apply(); });
  const events = ["keydown", "pointerdown", "touchstart", "wheel"] as const;
  const timer = window.setTimeout(stop, 3000);
  function stop() {
    window.clearTimeout(timer);
    resize.disconnect();
    mutation.disconnect();
    if (main) for (const event of events) main.removeEventListener(event, stop);
  }
  function observe() {
    resize.disconnect();
    if (main) for (const child of main.children) resize.observe(child);
  }
  function bind() {
    const marker = document.querySelector<HTMLElement>("[data-route-key]");
    if (marker?.dataset.routeKey !== key || !marker.dataset.routeReady) return;
    const next = document.getElementById("main");
    if (!next || next === main) return;
    main = next;
    mutation.disconnect();
    mutation.observe(main, { attributes: true, childList: true });
    for (const event of events) main.addEventListener(event, stop);
    observe();
  }
  function apply() {
    bind();
    if (!main) return;
    main.scrollTop = top;
    if (main.scrollTop === top) stop();
  }
  stopMainRestore = stop;
  mutation.observe(document.body, { attributes: true, attributeFilter: ["data-route-key", "data-route-ready"], childList: true, subtree: true });
  apply();
}
router.subscribe("onBeforeLoad", ({ fromLocation }) => {
  const key = fromLocation?.state["__TSR_key"];
  const main = document.getElementById("main");
  if (key && main) mainPositions.set(key, main.scrollTop);
});
router.subscribe("onRendered", ({ fromLocation, toLocation }) => {
  if (!fromLocation || fromLocation.pathname === toLocation.pathname) return;
  const key = toLocation.state["__TSR_key"];
  if (key) restoreMain(key, mainPositions.get(key) ?? 0);
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
const setStreamActive = sessionStream(queryClient);
let streaming: string | null = null;
// A sign-out (not a session lost in use), or a reload after the server ended the session for inactivity, pauses the
// sign-in field's autofill in this tab (auth/sign-in-id.ts): nobody is signed back in by the first suggestion.
let signedIn = false;
let consentAccepted = false;
session.subscribe(() => {
  if (session.lost) return;
  const needsConsent = consentAccepted && !session.consentAccepted && Boolean(session.token);
  consentAccepted = session.consentAccepted;
  if (needsConsent) void router.invalidate();
  if ((signedIn && !session.token) || session.ended === IDLE_EXPIRED) pauseAutofill();
  signedIn = Boolean(session.token);
  const next = session.token ? (session.claims?.sub ?? null) : null;
  const streams = next && session.stage === "app" && session.consentAccepted ? next : null;
  if (streams === streaming) return;
  streaming = streams;
  if (streams) {
    // A consent refusal must not survive acceptance when failed reads do not retry on mount.
    void queryClient.resetQueries({ predicate: q => q.state.error instanceof ApiError && q.state.error.code === "privacy_consent_required" });
    // Consent review can miss change frames; shown data re-reads after acceptance.
    void queryClient.invalidateQueries({ refetchType: "none" });
  }
  setStreamActive(Boolean(streams));
});

/** Re-renders the app when the locale changes; server data is refetched in the new language. */
function Root() {
  const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale);
  const signingIn = useRouterState({ router, select: state => state.location.pathname === login.fullPath });
  return (
    <QueryClientProvider client={queryClient}>
      {/* React Aria's own strings (tree chevrons, dismiss buttons, combobox announcements) follow the app locale. */}
      <I18nProvider locale={locale === "ko" ? "ko-KR" : "en-US"}>
        <RouterProvider router={router} key={locale} />
        <Suspense fallback={null}>
          <IdleGuard signingIn={signingIn} onCodeSignIn={() => void router.navigate({ to: login.fullPath, search: { code: true } })} />
        </Suspense>
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
void prepareFonts().then(() => createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    reportError(error);
    crashed();
  },
}).render(
  <StrictMode>
    <Root />
  </StrictMode>,
));
