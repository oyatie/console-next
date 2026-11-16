// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { LogOut, Menu, Moon, Search, Sun, UserRound } from "lucide-react";
import { logout, session } from "@console/api";
import { t } from "@console/i18n";
import { personName } from "../../reference/person/present";
import { SupportAccessIndicator } from "../../features/support-access/ui/support-access-status";
import { LiveStatus } from "../../ui/live/live-status";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { chunk } from "../../lib/chunk-guard";
import { activeLink, TENANT_NAV } from "../nav";
import { useTheme } from "../theme";
import { ShellFrame, LocaleSelect, type ShellLayoutProps } from "../frame/shell-frame";

const NeedsMeMenu = lazy(() => chunk(import("../top-bar/needs-me")).then(m => ({ default: m.NeedsMeMenu })));

export default function Shell(props: { children?: ReactNode; pending?: boolean }) {
  return <ShellFrame layout={BaselineLayout} {...props} />;
}

function BaselineLayout({ children, skipLink, platform, restoring, scope, menu, navigationNotice, onSearch }: ShellLayoutProps) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const router = useRouter();
  const [theme, toggle] = useTheme();
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
  // Sub-views keep their module highlighted without changing the rail.
  const current = activeLink(pathname, menu?.flatMap(g => g.links) ?? []);
  return (
    <div className="shell" data-menu={open ? "open" : undefined} data-console-scope={scope}>
      {skipLink}
      <nav id="rail" ref={rail} className="rail" aria-label={t("shell.nav")}>
        <div className="rail__brand"><span className="rail__mark" aria-hidden>C</span>{t("app.name")}</div>
        {!platform && !menu && <div role="status" aria-busy="true" aria-label={t("common.loading")}>
          {TENANT_NAV.map(g => <div key={g.hub}>
            <div className="rail__hub">{t(g.hub)}</div>
            <ul className="rail__list">{g.links.filter(l => l.to in router.routesByPath).map(l =>
              <li key={l.to} className="rail__link"><Skeleton decorative bones={["line"]} /></li>)}</ul>
          </div>)}
        </div>}
        {menu?.map((g) => (
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
        {navigationNotice}
      </nav>
      <header className="top" data-task-menu={!platform || undefined} aria-busy={restoring || undefined}>
        {!restoring && <>
        <button ref={menuButton} className="btn btn--ghost top__menu" aria-expanded={open} aria-controls="rail" onClick={() => (open ? close() : setOpen(true))}>
          <Menu size={16} aria-hidden /> {t("shell.menu")}
        </button>
        {!platform && (
          <button type="button" className="btn top__jump" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
            <Search size={16} aria-hidden />
            <span className="top__jumpText"><span className="top__jumpHint">{t("shell.jump")}</span><span className="top__jumpLabel">{t("shell.jumpLabel")}</span></span>
            <kbd className="top__kbd" aria-hidden>{t("shell.jumpKey")}</kbd>
          </button>
        )}
        <span className="top__spacer" />
        {!platform && <Suspense fallback={null}><NeedsMeMenu id="top-needs-me" /></Suspense>}
        <LiveStatus />
        {!platform && <SupportAccessIndicator />}
        <LocaleSelect id="top-locale" label />
        <button className="btn btn--ghost" onClick={toggle} aria-label={theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}>
          {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>
        <Link to="/account" className="btn btn--ghost top__name">
          <UserRound size={16} aria-hidden /> <span>{personName(session.claims?.name, t(session.claims?.platform ? "account.name.unset.operator" : "account.name.unset"))}</span>
        </Link>
        <button className="btn btn--ghost top__logout" onClick={async () => (await logout(), nav({ to: "/login" }))}>
          <LogOut size={16} aria-hidden /> {t("shell.logout")}
        </button>
        </>}
      </header>
      {children}
    </div>
  );
}
