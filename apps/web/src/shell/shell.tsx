import { personName } from "../reference/person/present";
import { activeSupportQuery } from "../reference/support-access/api";
import { ActiveSupportBanner } from "../features/support-access/ui/support-access";
import { DomainNotice } from "../auth/domain-notice";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, Outlet, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Menu, Moon, Search, Sun, UserRound } from "lucide-react";
import { logout, session } from "@console/api";
import { i18n, LOCALES, t, type Locale } from "@console/i18n";
import { ChangeNotice } from "../ui/live/change-notice";
import { HeldNotice } from "../ui/live/held-notice";
import { LiveStatus } from "../ui/live/live-status";
import { focusSoon } from "../lib/react/announce";
import { get, navigationRead } from "../lib/query";
import { chunk } from "../lib/chunk-guard";
import { myAccessQuery } from "../reference/authz/api";
import { setLocale } from "./locale";
import { useTheme } from "./theme";
import { PLATFORM_NAV, activeLink, tenantNav } from "./nav";
import { PhaseBand } from "./phase-band";
import { SessionRecovery } from "./session-recovery";
import { RouteGuard } from "../reference/authz/ui/access-gate";
import { PageMain } from "../ui/page/page-main";
import { meQuery } from "../features/account/api";
import { checklistQuery, modulesQuery } from "../features/onboarding/api";
import { fixFor } from "../features/onboarding/domain/rail";
import type { NavHub } from "./nav";

// ⌘K: the jump palette loads with its first use, never in the entry bundle.
const JumpPalette = lazy(() => chunk(import("../features/structure/ui/jump-palette")).then((m) => ({ default: m.JumpPalette })));
const identityQuery = get("/api/v1/users/me");

export function Shell() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [theme, toggle] = useTheme();
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = !!claims?.platform;
  const identity = useQuery({ ...identityQuery, enabled: !platform && Boolean(session.token) });
  const router = useRouter();
  const access = useQuery({ ...myAccessQuery, enabled: !platform && Boolean(session.token) });
  const support = useQuery({ ...activeSupportQuery, enabled: !platform && Boolean(session.token) });
  const me = useQuery({ ...navigationRead(meQuery), enabled: !platform && Boolean(session.token) });
  const phase = me.data?.tenant?.phase;
  const checklist = useQuery({ ...checklistQuery, enabled: !platform && phase === "SETUP", retry: false });
  const modules = useQuery({ ...modulesQuery, enabled: !platform && Boolean(session.token) });
  const { refetch: refetchMe, isEnabled: meEnabled } = me;
  const { refetch: refetchChecklist, isEnabled: checklistEnabled } = checklist;
  const { refetch: refetchModules, isEnabled: modulesEnabled } = modules;
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    // Reuse a command's pending read so navigation cannot cancel and delay its rail update.
    if (meEnabled) void refetchMe({ cancelRefetch: false });
    if (checklistEnabled) void refetchChecklist({ cancelRefetch: false });
    if (modulesEnabled) void refetchModules({ cancelRefetch: false });
  }, [pathname, meEnabled, refetchMe, checklistEnabled, refetchChecklist, modulesEnabled, refetchModules]);
  const ready = !access.isPending && !support.isPending && !me.isPending && (phase !== "SETUP" || !checklist.isPending) && (!modulesEnabled || !modules.isPending);
  const setupTargets = checklist.data?.steps.filter(s => s.state !== "blocked")
    .flatMap(s => { const target = fixFor(s.action); return target ? [target.to] : []; });
  const [railTargets, setRailTargets] = useState<{ pathname: string; value: typeof setupTargets; modules: typeof modules.data }>();
  // Late readiness reads reveal entries on the next navigation, never between inputs.
  if (ready && railTargets?.pathname !== pathname) setRailTargets({ pathname, value: setupTargets, modules: modules.data });
  const menu: readonly NavHub[] = platform ? PLATFORM_NAV : tenantNav(ready ? access.data : undefined, router.routesByPath,
    ready && support.data?.can_approve, { pathname, phase, setupTargets: railTargets?.value, modules: railTargets?.modules });
  // Phone widths hide the rail; the top bar's menu button discloses it.
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    menuButton.current?.focus();
  };
  // Open: focus moves into the menu, and Esc closes it back to the button.
  useEffect(() => {
    if (!open) return;
    rail.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
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
  // Sub-views keep their module highlighted without changing the rail.
  const current = activeLink(pathname, menu.flatMap(g => g.links));
  return (
    <div className="shell" data-menu={open ? "open" : undefined} data-console-scope={platform ? t("shell.hub.platform") : identity.data?.tenant?.name ?? (identity.isPending ? "" : undefined)}>
      <a className="skip" href="#main">{t("shell.skip")}</a>
      <nav id="rail" ref={rail} className="rail" aria-label={t("shell.nav")}>
        <div className="rail__brand"><span className="rail__mark" aria-hidden>C</span>{t("app.name")}</div>
        {menu.map((g) => (
          <div key={g.hub}>
            <div className="rail__hub">{t(g.hub)}</div>
            <ul className="rail__list">{g.links.map((l) => (
              <li key={l.to}>
                <Link to={l.to} className="rail__link" activeOptions={{ exact: l.to !== current }}
                  aria-current={l.to === current ? "page" : undefined} data-status={l.to === current ? "active" : undefined} onClick={() => setOpen(false)}>
                  <l.icon size={16} aria-hidden /> {t(l.label)}
                </Link>
              </li>
            ))}</ul>
          </div>
        ))}
      </nav>
      <header className="top">
        <button ref={menuButton} className="btn btn--ghost top__menu" aria-expanded={open} aria-controls="rail" onClick={() => (open ? close() : setOpen(true))}>
          <Menu size={16} aria-hidden /> {t("shell.menu")}
        </button>
        {!platform && (
          <button type="button" className="btn top__jump" onClick={() => setJump(true)} aria-label={t("shell.jumpLabel")} aria-keyshortcuts="Meta+K Control+K">
            <Search size={16} aria-hidden />
            <span className="top__jumpText">{t("shell.jump")}</span>
            <kbd className="top__kbd">{t("shell.jumpKey")}</kbd>
          </button>
        )}
        <span className="top__spacer" />
        <LiveStatus />
        <LocaleSelect id="top-locale" label />
        <button className="btn btn--ghost" onClick={toggle} aria-label={theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}>
          {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>
        <Link to="/account" className="btn btn--ghost top__name">
          <UserRound size={16} aria-hidden /> <span>{personName(session.claims?.name, t(session.claims?.platform ? "account.name.unset.operator" : "account.name.unset"))}</span>
        </Link>
        <button className="btn btn--ghost" onClick={async () => (await logout(), nav({ to: "/login" }))}>
          <LogOut size={16} aria-hidden /> {t("shell.logout")}
        </button>
      </header>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 requires keyboard access to this named scroll container. */}
      <PageMain className="main" id="main" tabIndex={0} aria-label={t("shell.main")}>
        <SessionRecovery>
        <ChangeNotice key={pathname} />
        <HeldNotice />
        {!platform && <DomainNotice />}{!platform && <ActiveSupportBanner />}
        <RouteGuard>{platform || pathname === "/org/entities/new" || pathname === "/people/new" ? <Outlet /> : <PhaseBand><Outlet /></PhaseBand>}</RouteGuard>
        </SessionRecovery>
      </PageMain>
      {jump && (
        <Suspense fallback={null}>
          <JumpPalette onClose={() => setJump(false)} />
        </Suspense>
      )}
    </div>
  );
}

/**
 * The UI language; the choice is kept on this device (shell/locale). The switch re-renders every
 * screen, which replaces this select: focus is put back on it (`id` names it), never dropped to the body.
 * `label` names it itself when no visible <label> does.
 */
export function LocaleSelect({ id, label }: { id: string; label?: boolean }) {
  return (
    <select
      id={id}
      className="field__input"
      aria-label={label ? t("shell.locale") : undefined}
      value={i18n.locale}
      onChange={(e) => void setLocale(e.target.value as Locale).then(() => focusSoon(id), () => undefined)}
    >
      {LOCALES.map((l) => <option key={l} value={l}>{t(`shell.locale.${l}`)}</option>)}
    </select>
  );
}
