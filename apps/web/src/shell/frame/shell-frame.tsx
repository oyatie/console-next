// SPDX-License-Identifier: LicenseRef-Proprietary
import { activeSupportQuery } from "../../reference/support-access/api";
import { ActiveSupportBanner } from "../../features/support-access/ui/support-access-status";
import { DomainNotice } from "../../auth/domain-notice";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { refresh, session } from "@console/api";
import { t } from "@console/i18n";
import { ChangeNotice } from "../../ui/live/change-notice";
import { HeldNotice } from "../../ui/live/held-notice";
import { navigationRead, read } from "../../lib/query";
import { isAnswer } from "../../lib/react/query-defaults";
import { QueryState } from "../../lib/react/query-state";
import { ReadFailureContext } from "../../lib/react/read-failure-context";
import { chunk } from "../../lib/chunk-guard";
import { myAccessQuery } from "../../reference/authz/api";
import { PLATFORM_NAV, rememberedRail, tenantNav } from "../nav";
import { ReadSkeleton } from "../../ui/skeleton/skeleton";
import { PhaseBand } from "../phase-band";
import { SessionRecovery } from "../session-recovery";
import { streamReady } from "../../lib/live/session-stream";
import { RouteGuard } from "../../reference/authz/ui/access-gate";
import { PageMain } from "../../ui/page/page-main";
import { meQuery } from "../../features/account/api";
import { useMainScrollRestoration } from "../scroll-restoration";
import { checklistQuery, modulesQuery } from "../../features/onboarding/api";
import { canReadSetupChecklist } from "../../features/onboarding/domain/phase";
import { fixFor } from "../../features/onboarding/domain/rail";
import { useExperienceSync } from "../../experience/store";
import { useActiveExperienceId } from "../../experience/dom";
import type { NavHub } from "../nav";

// ⌘K: the jump palette loads with its first use, never in the entry bundle.
const JumpPalette = lazy(() => chunk(import("../../features/structure/ui/jump-palette")).then((m) => ({ default: m.JumpPalette })));

export interface ShellLayoutProps {
  children: ReactNode;
  platform: boolean;
  restoring: boolean;
  tenantName?: string;
  tenantPhase?: string;
  userProfile?: {
    display_name?: string | null;
    employee_org_unit?: string | null;
    employee_position?: string | null;
  };
  menu: readonly NavHub[] | undefined;
  navigationState: "loading" | "failed" | "ready";
  navigationNotice: ReactNode;
  onSearch: () => void;
  phoneHeader?: {
    title?: ReactNode;
    context?: ReactNode;
    shellOwnsH1?: boolean;
    hideActions?: boolean;
    phoneNav?: "self-service";
    back?: { label: string; href?: string; onBack?: () => void };
  };
}

export function ShellFrame({ layout: Layout, children = <Outlet />, pending = false }: {
  layout: ComponentType<ShellLayoutProps>; children?: ReactNode; pending?: boolean;
}) {
  const { pathname } = useLocation();
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const stream = useSyncExternalStore(streamReady.subscribe, streamReady.get);
  const active = Boolean(session.token) && stream;
  const restore = useQuery({ ...read("/api/v1/auth/token/refresh", refresh), enabled: false });
  const restoring = !claims && restore.isPending;
  const principal = session.principal;
  const railKey = principal ? `console.nav.${principal}` : null;
  const [savedRail, setSavedRail] = useState(() => ({ key: railKey, answer: rememberedRail(railKey) }));
  if (savedRail.key !== railKey) setSavedRail({ key: railKey, answer: rememberedRail(railKey) });
  const platform = !!claims?.platform;
  useExperienceSync(!platform && active && !pending);
  const identity = useQuery({ ...meQuery, enabled: !platform && active && !pending });
  const router = useRouter();
  useMainScrollRestoration(router);
  const access = useQuery({ ...myAccessQuery, enabled: !platform && active });
  const support = useQuery({ ...activeSupportQuery, enabled: !platform && active });
  // Keep the rail snapshot separate, but share the identity request with the shell and page.
  // Allow fresh cache reuse on remount so an experience-pack swap on the same route does not duplicate /api/v1/users/me.
  const me = useQuery({ ...navigationRead(meQuery), refetchOnMount: true, queryFn: ({ client }) => client.fetchQuery({ ...meQuery, staleTime: 0, retry: false }), enabled: !platform && active && !pending });
  const phase = me.isSuccess ? me.data?.tenant?.phase : undefined;
  const checklist = useQuery({ ...checklistQuery, enabled: !platform && active && phase === "SETUP" && canReadSetupChecklist(access.data), retry: false });
  const modules = useQuery({ ...modulesQuery, enabled: !platform && active });
  const { refetch: refetchMe, isEnabled: meEnabled } = me;
  const { refetch: refetchChecklist, isEnabled: checklistEnabled } = checklist;
  const { isEnabled: modulesEnabled } = modules;
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    // Reuse a command's pending read so navigation cannot cancel and delay its rail update.
    if (meEnabled) void refetchMe({ cancelRefetch: false });
    if (checklistEnabled) void refetchChecklist({ cancelRefetch: false });
  }, [pathname, meEnabled, refetchMe, checklistEnabled, refetchChecklist]);
  const ready = !access.isPending && !support.isPending && !me.isPending && (!checklistEnabled || !checklist.isPending) && (!modulesEnabled || !modules.isPending);
  const setupTargets = checklist.data?.steps.filter(s => s.state !== "blocked")
    .flatMap(s => { const target = fixFor(s.action); return target ? [target.to] : []; });
  const [railTargets, setRailTargets] = useState<{ key: typeof railKey; pathname: string; phase: typeof phase; value: typeof setupTargets; modules: typeof modules.data | null; access: typeof access.data; supportApproval: boolean }>();
  const modulesFault = modules.isError && !isAnswer(modules.error);
  const supportFault = support.isError && !isAnswer(support.error);
  const checklistFault = checklistEnabled && checklist.isError && !isAnswer(checklist.error);
  const hasSupportNotice = Boolean(support.data && (support.data.sessions?.length || (support.data.can_approve && support.data.pending_count)));
  const [pageFailures, setPageFailures] = useState(0);
  const registerFailure = useMemo(() => () => {
    setPageFailures(count => count + 1);
    return () => setPageFailures(count => count - 1);
  }, []);
  const { refetch: refetchModules } = modules;
  const { refetch: refetchSupport } = support;
  const retryShell = useMemo(() => () => {
    if (modulesFault) void refetchModules({ cancelRefetch: false });
    if (supportFault) void refetchSupport({ cancelRefetch: false });
    if (checklistFault) void refetchChecklist({ cancelRefetch: false });
  }, [modulesFault, refetchModules, supportFault, refetchSupport, checklistFault, refetchChecklist]);
  const recovery = useMemo(() => ({ register: registerFailure, retry: retryShell }), [registerFailure, retryShell]);
  const bannerRecovery = useMemo(() => ({ register: () => () => {}, retry: retryShell }), [retryShell]);
  const answered = ready && access.isSuccess && me.isSuccess && !supportFault;
  // Late readiness reads reveal entries on the next navigation, never between inputs.
  // A cold fault has no readiness snapshot; its first answer can recover immediately after retry.
  if (answered && (railTargets?.key !== railKey || railTargets?.pathname !== pathname || modules.isSuccess && railTargets.modules == null)) setRailTargets({ key: railKey, pathname, phase, value: setupTargets,
    access: access.data, supportApproval: support.isSuccess && !!support.data?.can_approve,
    modules: modules.isSuccess ? modules.data : modulesFault && savedRail.key === railKey ? savedRail.answer?.context.modules : undefined });
  const answer = useMemo(() => answered && railTargets?.access ? { access: railTargets.access, supportApproval: railTargets.supportApproval,
    context: { pathname, phase: railTargets?.phase, setupTargets: railTargets?.value,
      modules: modules.isSuccess ? railTargets?.modules : modulesFault ? railTargets?.modules ?? null : undefined } } : undefined,
  [answered, pathname, railTargets, modules.isSuccess, modulesFault]);
  if (answer && savedRail.answer !== answer) setSavedRail({ key: railKey, answer });
  useEffect(() => {
    if (!railKey || !answer) return;
    try { localStorage.setItem(railKey, JSON.stringify(answer)); } catch { return; /* Storage is optional. */ }
  }, [railKey, answer]);
  // A stored phase can predate go-live; show current entries first, using storage only after a read fault.
  const railFault = [access, support, me].some(q => q.isError && !isAnswer(q.error));
  const railError = [access, support, me].find(q => q.isError);
  const displayed = answer ?? (railFault || railTargets?.key === railKey ? savedRail.answer : undefined);
  const supportOwnsFailure = supportFault && !access.isError && !me.isError && pageFailures === 0 && !hasSupportNotice;
  const menu: readonly NavHub[] = platform ? PLATFORM_NAV : displayed ? tenantNav(displayed.access, router.routesByPath,
    displayed.supportApproval, displayed.context) : [];
  // ⌘K / Ctrl+K opens the jump palette anywhere in the tenant app (a modifier chord, so not a single-key shortcut).
  const [jump, setJump] = useState(false);
  useEffect(() => {
    if (platform) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        setJump(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [platform]);
  const experience = useActiveExperienceId();
  const scope = platform ? t("shell.hub.platform") : identity.data?.tenant?.name ?? (identity.isPending ? "" : undefined);
  const employeeName = identity.data?.employee_name?.trim() || identity.data?.display_name?.trim();
  const employeeUnit = identity.data?.employee_org_unit?.trim();
  const employeeNumber = identity.data?.employee_number?.trim();
  const employeeContext = identity.data?.employee_link_status === "LINKED" && employeeName
    ? [employeeName, employeeUnit].filter(Boolean).join(" · ")
    : identity.data?.tenant?.name;
  const payslipContext = identity.data?.employee_link_status === "LINKED" && employeeName
    ? [employeeName, employeeNumber].filter(Boolean).join(" · ")
    : identity.data?.tenant?.name;
  const hasDeskLinks = menu.some(hub =>
    hub.links.some(link => link.to !== "/" && link.to !== "/people/requests" && link.to !== "/approvals"),
  );
  const isSelfService =
    !platform &&
    identity.data?.employee_link_status === "LINKED" &&
    Boolean(displayed) &&
    !displayed?.access.is_ops &&
    !displayed?.supportApproval &&
    !hasDeskLinks;
  const phoneHeader = pathname === "/account" || pathname.startsWith("/account/")
    ? {
        title: pathname === "/account" ? t(experience === "baseline" ? "shell.account" : "shell.profile") : undefined,
        context: pathname === "/account" && experience !== "baseline" && !platform ? identity.data?.employee_company ?? undefined : undefined,
        shellOwnsH1: pathname === "/account" || pathname === "/account/privacy",
        ...(isSelfService ? { phoneNav: "self-service" as const } : {}),
      }
    : pathname === "/leave"
      ? { title: t("shell.title.leave"), context: employeeContext, shellOwnsH1: true, hideActions: true, phoneNav: "self-service" as const }
      : pathname === "/payslips"
        ? { title: t("shell.title.payslip"), context: payslipContext, shellOwnsH1: true, hideActions: true, phoneNav: "self-service" as const }
        : pathname === "/me/attendance"
          ? { title: t("shell.link.meAttendance"), context: employeeContext, phoneNav: "self-service" as const }
          : pathname === "/me/desk"
            ? { title: t("shell.link.meDesk"), context: employeeContext, phoneNav: "self-service" as const }
            : isSelfService
              ? { phoneNav: "self-service" as const }
              : undefined;
  return (<>
    <a className="skip" href="#main">{t("shell.skip")}</a>
    <Layout platform={platform} restoring={restoring} tenantName={identity.data?.tenant?.name} tenantPhase={identity.data?.tenant?.phase ?? phase} userProfile={identity.data} phoneHeader={phoneHeader} menu={platform || displayed ? menu : undefined}
      navigationState={platform || displayed ? "ready" : supportOwnsFailure || railError ? "failed" : "loading"} onSearch={() => setJump(true)}
      navigationNotice={!platform && !displayed ? (supportOwnsFailure
        ? <p role="status" className="muted">{t("shell.nav.failed")}</p>
        : railError && <ReadFailureContext.Provider value={bannerRecovery}><QueryState<unknown> q={railError} inline loading={null}>{() => null}</QueryState></ReadFailureContext.Provider>) : !platform && answered && modulesFault && (pageFailures > 0
        ? <p role="status" className="muted">{t("shell.nav.failed")}</p>
        : <QueryState q={modules} loading={null} failedTitle={t("shell.nav.failed")}>{() => null}</QueryState>)}>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 requires keyboard access to this named scroll container. */}
      <PageMain className="main" id="main" data-console-scope={scope} tabIndex={0} aria-label={t("shell.main")}>
        <SessionRecovery>
        <ChangeNotice key={pathname} />
        <HeldNotice />
        <ReadFailureContext.Provider value={bannerRecovery}>
          {!platform && <DomainNotice />}{!platform && !((access.isError || me.isError || pageFailures > 0) && supportFault && !hasSupportNotice) && <ActiveSupportBanner />}
        </ReadFailureContext.Provider>
        <ReadFailureContext.Provider value={recovery}>
          <RouteGuard>{platform || pathname === "/org/entities/new" || pathname === "/people/new" ? children : <PhaseBand key={principal}><Suspense fallback={<ReadSkeleton layout="list" />}>{children}</Suspense></PhaseBand>}</RouteGuard>
        </ReadFailureContext.Provider>
        </SessionRecovery>
      </PageMain>
      {jump && (
        <Suspense fallback={null}>
          <JumpPalette onClose={() => setJump(false)} />
        </Suspense>
      )}
    </Layout>
  </>);
}
