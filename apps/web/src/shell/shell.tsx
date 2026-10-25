import { activeSupportQuery } from "../reference/support-access/api";
import { ActiveSupportBanner } from "../features/support-access/ui/support-access";
import { DomainNotice } from "../auth/domain-notice";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Menu, Moon, Search, Sun, UserRound } from "lucide-react";
import { logout, session } from "@console/api";
import { i18n, LOCALES, t, type Locale } from "@console/i18n";
import { Announcer } from "../ui/announcer";
import { ChangeNotice } from "../ui/live/change-notice";
import { HeldNotice } from "../ui/live/held-notice";
import { LiveStatus } from "../ui/live/live-status";
import { bindAnnouncer, focusSoon } from "../lib/react/announce";
import { chunk } from "../lib/chunk-guard";
import { authzQuery } from "../reference/authz/api";
import { setLocale } from "./locale";
import { useTheme } from "./theme";
import { PLATFORM_NAV, activeLink, tenantNav } from "./nav";
import { PhaseBand } from "./phase-band";
import { SessionRecovery } from "./session-recovery";

// ⌘K: the jump palette loads with its first use, never in the entry bundle.
const JumpPalette = lazy(() => chunk(import("../features/structure/ui/jump-palette")).then((m) => ({ default: m.JumpPalette })));

export function Shell() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [theme, toggle] = useTheme();
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = !!claims?.platform;
  // Platform tokens are refused by /me/authz; the vendor menu is fixed.
  const authz = useQuery({ ...authzQuery, enabled: !platform && Boolean(session.token) });
  const support = useQuery({ ...activeSupportQuery, enabled: !platform && Boolean(session.token) });
  const navReady = !authz.isPending && !support.isPending;
  const menu = platform ? PLATFORM_NAV : tenantNav(navReady ? authz.data?.capabilities : undefined, navReady && authz.isError, navReady && support.data?.can_approve);
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
  // One entry lights up across every group: /org/entities is not also the org entry.
  const current = activeLink(pathname, menu.flatMap((g): readonly { to: string }[] => g.links));
  return (
    <div className="shell" data-menu={open ? "open" : undefined}>
      <a className="skip" href="#main">{t("shell.skip")}</a>
      <nav id="rail" ref={rail} className="rail" aria-label={t("shell.nav")}>
        <div className="rail__brand"><span className="rail__mark" aria-hidden>C</span>{t("app.name")}</div>
        {menu.map((g) => (
          <div key={g.hub}>
            <div className="rail__hub">{t(g.hub)}</div>
            {g.links.map((l) => (
              <Link key={l.to} to={l.to} className="rail__link" activeOptions={{ exact: l.to !== current }} onClick={() => setOpen(false)}>
                <l.icon size={16} aria-hidden /> {t(l.label)}
              </Link>
            ))}
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
          <UserRound size={16} aria-hidden /> <span>{session.claims?.name ?? t("shell.account")}</span>
        </Link>
        <button className="btn btn--ghost" onClick={async () => (await logout(), nav({ to: "/login" }))}>
          <LogOut size={16} aria-hidden /> {t("shell.logout")}
        </button>
      </header>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 requires keyboard access to this named scroll container. */}
      <main className="main" id="main" tabIndex={0} aria-label={t("shell.main")}>
        <SessionRecovery>
        <ChangeNotice key={pathname} />
        <HeldNotice />
        {!platform && <DomainNotice />}{!platform && <ActiveSupportBanner />}
        {platform || pathname === "/org/entities/new" || pathname === "/people/new" ? <Outlet /> : <PhaseBand><Outlet /></PhaseBand>}
        </SessionRecovery>
      </main>
      {jump && (
        <Suspense fallback={null}>
          <JumpPalette onClose={() => setJump(false)} />
        </Suspense>
      )}
      <Announcer bind={bindAnnouncer} />
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
